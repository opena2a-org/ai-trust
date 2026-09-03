#!/usr/bin/env node
/**
 * release-artifact-review.mjs — the blocking review of the packed tarball,
 * run BETWEEN `build` and `publish`.
 *
 * ## Why it sits where it sits
 *
 * `consumer-audit` asks a question about the dependency CLOSURE the manifest
 * resolves to. Nothing in the release path asked a question about the BYTES —
 * which files are in the tarball, whether they run on a clean machine, whether
 * a secret rode along in `dist/`. Those are properties of the artifact, not of
 * the manifest, and the only place they can be measured is after `npm pack`
 * and before `npm publish`. Once `publish` has run there is no undo: npm
 * unpublish is unavailable for a package with dependents past 72 hours, and
 * the tarball is already on every mirror.
 *
 * So this runs in its own job, `review`, with `contents: read` and no publish
 * identity, and `publish` needs it. A red review means the tag does not ship.
 *
 * ## The rule this file is built around
 *
 * UNKNOWN IS NOT A PASS. Every check reports exactly one of three outcomes:
 *
 *   pass          the check ran and the artifact satisfied it
 *   fail          the check ran and the artifact violated it
 *   precondition  the check could NOT run, and what was missing is named
 *
 * `precondition` exits non-zero, exactly like `fail`. This is the whole point.
 * The failure mode this script exists to avoid is the one `audit-consumer-
 * resolution.mjs` documents at length: a gate that cannot take its measurement
 * — no network, no scanner, no advisory database — quietly reporting zero
 * findings and reading as green. A gate that goes green when it is blind is
 * worse than no gate, because it also stops anyone from looking.
 *
 * Every check name is printed in the census whatever its outcome, so "which
 * checks even exist" is answerable from the log rather than from this file.
 *
 * ## What it does NOT do
 *
 * It never executes anything out of the tarball except through one deliberate,
 * named check (`global-install-smoke`), which installs with `--ignore-scripts`
 * into a throwaway global prefix and runs only `--version` and `--help`. The
 * tarball is read with a tar parser in this file rather than by shelling out
 * to `tar`, so listing and extraction cannot be turned into a command by a
 * crafted entry name, and there is no dependency on which `tar` the runner has.
 *
 * ## Usage
 *
 *   node scripts/release-artifact-review.mjs --tarball <path-to.tgz> \
 *     [--advisory-states published|all]
 *
 * `--advisory-states` scopes the consumer-closure check's GitHub advisory
 * reads (default `all`; the release workflow passes `published` — draft and
 * triage advisories of other repositories are not readable by its token).
 *
 * Exit 0 only when every check passed. Any fail or any precondition exits 1,
 * and the closing block NAMES the checks responsible.
 */
import { spawnSync } from 'node:child_process';
import { request as httpRequest } from 'node:http';
import { request as httpsRequest } from 'node:https';
import { connect as tlsConnect } from 'node:tls';
import { gunzipSync } from 'node:zlib';
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { ACCEPTED_ADVISORIES } from './lib/accepted-advisories.mjs';

const SELF = fileURLToPath(import.meta.url);
const REPO_ROOT = path.resolve(path.dirname(SELF), '..');

/**
 * The census, in the order it prints.
 *
 * This list is the contract. A check may not be added by writing a `record()`
 * call somewhere — it has to be named here, and a run that finishes without an
 * outcome for every name is itself a failure (see `Census.settle`). That is
 * what stops a check from being silently dropped by an early `return` and
 * leaving a shorter, greener census behind.
 */
const CHECK_NAMES = [
  'entry-allowlist',
  'no-dotfiles',
  'no-test-material',
  'no-install-scripts',
  'pinned-first-party-deps',
  'global-install-smoke',
  'dependency-advisories',
  'credential-scan',
  'consumer-closure',
];

/**
 * `files` in package.json is ["dist", "README.md"]; npm adds package.json and
 * LICENSE unconditionally. Anything else in the tarball is something nobody
 * declared, which is the interesting case — that is how test fixtures, editor
 * backups and stray keys reach the registry.
 */
const ALLOWED_EXACT = new Set(['package/package.json', 'package/README.md', 'package/LICENSE']);
const ALLOWED_PREFIX = 'package/dist/';

/** Path fragments that mean "this was never meant to ship". */
const TEST_MATERIAL = ['__tests__', 'fixtures', 'test/'];

/** Lifecycle hooks that execute on a CONSUMER's machine at install time. */
const INSTALL_HOOKS = ['preinstall', 'install', 'postinstall'];

/**
 * Dependency-spec prefixes that let a consumer's install float.
 *
 * Only `@opena2a/` is held to this. These are our own packages: a caret on one
 * of them means a release of a sibling repo silently changes what this
 * published version resolves to, with no tag, no review and no test run here.
 * Third-party ranges are a different argument and are not made by this check.
 */
const FLOATING_RANGE = /^[\^~]/;

/**
 * Dependency blocks a CONSUMER resolves. `devDependencies` is deliberately not
 * in this list: it is carried in the published manifest but npm never installs
 * it for a consumer, so a caret there cannot move anything a user runs.
 */
const CONSUMER_DEP_BLOCKS = ['dependencies', 'optionalDependencies', 'peerDependencies'];

/**
 * Written into a SCRATCH COPY of `dist/`, never into the tarball.
 *
 * A credential scan that reports zero findings is indistinguishable from a
 * credential scan that did not look — a wrong config, a scanner whose check
 * ids moved, an empty directory. So a known-bad file goes in beside the real
 * ones, and "zero findings" is only accepted as an answer when the control was
 * found. If the control is missed the outcome is `precondition`, not `pass`:
 * the instrument is not reading.
 *
 * The control is a single credential-named `const` whose VALUE is assembled
 * at runtime from parts — the OpenAI-shaped prefix `sk-` + `proj-` followed
 * by 48 repeated `A` characters — so no credential-shaped literal exists in
 * this repository; only the planted scratch file ever carries the assembled
 * form, which is what the shipped scanner's canonical credential walk keys
 * on (AST-CRED-001/AST-CRED-003, measured on hackmyagent 0.25.0). The AWS
 * documentation example pair the first revision planted is INADMISSIBLE:
 * 0.25.0 does not flag it, so it proved nothing about the instrument.
 */
const CONTROL_BASENAME = 'zz-planted-credential-control.js';

function buildControlSource() {
  const value = ['sk-', 'proj-'].join('') + 'A'.repeat(48);
  return [
    '// Planted by scripts/release-artifact-review.mjs into a scratch copy of',
    '// dist/. It is never packed, never published, and never executed. Its only',
    '// job is to prove the credential scanner was actually looking.',
    `const OPENAI_API_KEY = "${value}";`,
    '',
  ].join('\n');
}

/**
 * A credential-class finding: `checkId` matching `CRED` (AST-CRED-*, CRED-*,
 * WEBCRED-*, AGENT-CRED-*, …) or the config-file credential check CONFIG-004.
 */
function isCredentialClassFinding(finding) {
  const id = String(finding.checkId ?? '');
  return /CRED/i.test(id) || id === 'CONFIG-004';
}

/**
 * The own-package roster the consumer-closure check holds to account: the
 * FLOOR of `todo/scripts/own-package-census.mjs`, plus the `@opena2a/` scope,
 * plus the packed package itself. A lockfile package is "own" when its
 * alias-aware `name` is one of these or starts with the scope prefix.
 */
const OWN_PACKAGE_ROSTER = [
  'hackmyagent',
  'secretless-ai',
  'ai-trust',
  'opena2a-cli',
  'arp-guard',
  'damn-vulnerable-ai-agent',
  'cryptoserve',
];
const OWN_SCOPE_PREFIX = '@opena2a/';

/**
 * The deprecation instrument's self-test subject. hackmyagent@0.25.0 is
 * deprecated on the registry (measured at ruling time, and it is this repo's
 * own pinned copy). If `npm view` reads its deprecation as EMPTY, the
 * instrument is not reading deprecations and every "not deprecated" answer in
 * the same run would be untrustworthy — so that reads as `precondition`.
 */
const KNOWN_DEPRECATED_OWN_VERSION = 'hackmyagent@0.25.0';

function isOwnPackageName(name) {
  return OWN_PACKAGE_ROSTER.includes(name) || name.startsWith(OWN_SCOPE_PREFIX);
}

// ---------------------------------------------------------------------------
// Census
// ---------------------------------------------------------------------------

class Census {
  constructor(names) {
    this.names = names;
    this.outcomes = new Map();
  }

  #record(name, status, detail) {
    if (!this.names.includes(name)) {
      throw new Error(`internal: "${name}" is not a declared check (add it to CHECK_NAMES)`);
    }
    if (this.outcomes.has(name)) {
      throw new Error(`internal: "${name}" reported twice`);
    }
    this.outcomes.set(name, { name, status, detail });
  }

  pass(name, detail) {
    this.#record(name, 'pass', detail);
  }

  fail(name, detail) {
    this.#record(name, 'fail', detail);
  }

  /** @param missing what is absent, phrased so a reader knows what to install. */
  precondition(name, missing) {
    this.#record(name, 'precondition', missing);
  }

  /** True once `name` has an outcome — used to skip work that is already moot. */
  has(name) {
    return this.outcomes.has(name);
  }

  /**
   * Fill in anything a crash skipped, so the census is always complete and
   * always reads as un-measured rather than as absent.
   */
  settle(why) {
    for (const name of this.names) {
      if (!this.outcomes.has(name)) this.precondition(name, why);
    }
  }

  by(status) {
    return this.names.map((n) => this.outcomes.get(n)).filter((o) => o && o.status === status);
  }

  report() {
    console.log('');
    console.log('Checks:');
    for (const name of this.names) {
      const outcome = this.outcomes.get(name);
      const status = outcome.status.padEnd(12);
      const label = name.padEnd(24);
      const detail = outcome.status === 'precondition' ? `precondition: ${outcome.detail}` : outcome.detail;
      console.log(`  ${status} ${label} ${detail}`);
    }
    // One machine-readable line carrying EVERY check name and its outcome,
    // whatever that outcome was. A reader (or a test) can answer "which checks
    // exist and what did each one say" from this line alone.
    console.log('');
    console.log(`census: ${this.names.map((n) => `${n}=${this.outcomes.get(n).status}`).join(' ')}`);
  }
}

// ---------------------------------------------------------------------------
// tar
// ---------------------------------------------------------------------------

/**
 * Entries of a gzipped tar, parsed in-process.
 *
 * Deliberately not `tar -tzf`: the input is the thing under review, so it does
 * not get to influence a command line, and the result does not depend on which
 * tar the runner ships. Handles the three name-carrying header types npm's
 * packer emits — plain ustar name/prefix, GNU long name ('L'), and pax
 * extended headers ('x') — because a path this parser silently mis-read would
 * be a path the allowlist never checked.
 */
function readTarEntries(tgzPath) {
  let raw;
  try {
    raw = gunzipSync(readFileSync(tgzPath));
  } catch (e) {
    throw new Error(`${tgzPath} is not a readable gzip archive: ${e?.message ?? e}`);
  }

  const entries = [];
  let offset = 0;
  let overrideName = null;

  while (offset + 512 <= raw.length) {
    const header = raw.subarray(offset, offset + 512);
    if (header.every((b) => b === 0)) break;

    const field = (start, len) => header.toString('utf8', start, start + len).replace(/\0[\s\S]*$/, '');
    const size = parseInt(field(124, 12).trim() || '0', 8) || 0;
    const typeRaw = header.toString('utf8', 156, 157);
    const type = typeRaw === '' || typeRaw === '\0' ? '0' : typeRaw;
    const name = field(0, 100);
    const prefix = field(345, 155);

    const dataStart = offset + 512;
    const body = raw.subarray(dataStart, Math.min(dataStart + size, raw.length));
    offset = dataStart + Math.ceil(size / 512) * 512;

    if (type === 'x') {
      const record = body.toString('utf8').match(/\d+ path=([^\n]*)\n/);
      if (record) overrideName = record[1];
      continue;
    }
    if (type === 'g') continue;
    if (type === 'L') {
      overrideName = body.toString('utf8').replace(/\0[\s\S]*$/, '');
      continue;
    }

    const full = overrideName ?? (prefix ? `${prefix}/${name}` : name);
    overrideName = null;
    entries.push({
      path: full.replace(/\/+$/, ''),
      isDirectory: type === '5' || full.endsWith('/'),
      type,
      body: type === '0' ? Buffer.from(body) : null,
    });
  }

  if (entries.length === 0) throw new Error(`${tgzPath} contains no tar entries`);
  return entries;
}

/** Every path component of `p`, with the empty ones dropped. */
function components(p) {
  return p.split('/').filter((c) => c.length > 0);
}

/**
 * Write the tarball's regular files under `package/dist/` into `destDir`.
 *
 * Only regular files, only under the one prefix, and every destination is
 * re-checked to be inside `destDir` after resolution — a tar entry is
 * attacker-controlled text and `../` in one of them is the oldest trick there
 * is. Nothing written here is ever executed.
 */
function extractDist(entries, destDir) {
  let written = 0;
  for (const entry of entries) {
    if (entry.isDirectory || entry.type !== '0' || !entry.path.startsWith(ALLOWED_PREFIX)) continue;
    const relative = entry.path.slice(ALLOWED_PREFIX.length);
    if (components(relative).some((c) => c === '..')) continue;
    const target = path.resolve(destDir, relative);
    if (target !== destDir && !target.startsWith(destDir + path.sep)) continue;
    mkdirSync(path.dirname(target), { recursive: true });
    writeFileSync(target, entry.body ?? Buffer.alloc(0));
    written += 1;
  }
  return written;
}

// ---------------------------------------------------------------------------
// helpers
// ---------------------------------------------------------------------------

function npm(args, opts = {}) {
  return spawnSync('npm', args, {
    encoding: 'utf8',
    maxBuffer: 64 * 1024 * 1024,
    timeout: 15 * 60 * 1000,
    ...opts,
  });
}

/**
 * True when npm's complaint is about reaching the registry rather than about
 * the artifact.
 *
 * The distinction decides `precondition` versus `fail`, and it has to be made
 * from npm's own error text because there is nothing else to go on. Erring
 * toward `precondition` is safe: both exit non-zero, and the difference is
 * only whether the log blames the tarball or the network.
 */
function looksLikeNetworkTrouble(text) {
  return /ENOTFOUND|EAI_AGAIN|ECONNREFUSED|ECONNRESET|ETIMEDOUT|ERR_SOCKET|network|socket hang up|request to https?:\/\/|429 Too Many Requests|503 Service Unavailable|registry\.npmjs\.org/i.test(
    text,
  );
}

/** Output that carries a JavaScript stack trace, however it got there. */
function looksLikeStackTrace(text) {
  return /^\s+at\s+\S/m.test(text) || /node:internal\/|UnhandledPromiseRejection|ERR_UNHANDLED_REJECTION/.test(text);
}

function firstMeaningfulLine(text) {
  const line = String(text ?? '')
    .split('\n')
    .map((l) => l.trim())
    .find((l) => l.length > 0);
  return (line ?? '(no output)').slice(0, 300);
}

/**
 * One GET against the GitHub REST API, dependency-free.
 *
 * Honors `HTTPS_PROXY`/`https_proxy` (with `NO_PROXY`) via a CONNECT tunnel,
 * because the release runner may sit behind a corporate egress proxy and
 * node's global fetch does not read those variables. Resolves — never
 * rejects — with `{ status, text }`; a transport failure is `status: 0` and
 * the caller reports it as a precondition, not as a clean feed.
 */
function githubGet(url) {
  return new Promise((resolve) => {
    const target = new URL(url);
    const headers = {
      accept: 'application/vnd.github+json',
      'x-github-api-version': '2022-11-28',
      'user-agent': 'ai-trust-release-artifact-review',
    };
    const token = process.env.GH_TOKEN ?? process.env.GITHUB_TOKEN;
    if (token) headers.authorization = `Bearer ${token}`;

    const done = (status, text) => resolve({ status, text });
    const fail = (e) => resolve({ status: 0, text: String(e?.message ?? e) });
    const onResponse = (res) => {
      const chunks = [];
      res.on('data', (c) => chunks.push(c));
      res.on('end', () => done(res.statusCode ?? 0, Buffer.concat(chunks).toString('utf8')));
      res.on('error', fail);
    };

    const noProxy = (process.env.NO_PROXY ?? process.env.no_proxy ?? '')
      .split(',')
      .map((s) => s.trim())
      .filter(Boolean);
    const bypass = noProxy.some(
      (p) => p === '*' || target.hostname === p || target.hostname.endsWith(`.${p.replace(/^\./, '')}`),
    );
    const proxyValue = process.env.HTTPS_PROXY ?? process.env.https_proxy;

    if (!proxyValue || bypass) {
      const req = httpsRequest(url, { headers, timeout: 30_000 }, onResponse);
      req.on('timeout', () => req.destroy(new Error(`request to ${target.hostname} timed out`)));
      req.on('error', fail);
      req.end();
      return;
    }

    let proxy;
    try {
      proxy = new URL(proxyValue);
    } catch (e) {
      fail(e);
      return;
    }
    const tunnel = httpRequest({
      host: proxy.hostname,
      port: Number(proxy.port || 80),
      method: 'CONNECT',
      path: `${target.hostname}:443`,
      headers: { host: `${target.hostname}:443` },
      timeout: 30_000,
    });
    tunnel.on('connect', (res, socket) => {
      if (res.statusCode !== 200) {
        socket.destroy();
        fail(new Error(`proxy CONNECT to ${target.hostname} returned ${res.statusCode}`));
        return;
      }
      const req = httpsRequest(
        url,
        {
          headers,
          timeout: 30_000,
          createConnection: () => tlsConnect({ socket, servername: target.hostname }),
        },
        onResponse,
      );
      req.on('timeout', () => req.destroy(new Error(`request to ${target.hostname} timed out`)));
      req.on('error', fail);
      req.end();
    });
    tunnel.on('timeout', () => tunnel.destroy(new Error('proxy CONNECT timed out')));
    tunnel.on('error', fail);
    tunnel.end();
  });
}

/** `owner/repo` out of a registry `repository.url`, or null when it is not GitHub. */
function parseGitHubRepo(url) {
  const m = String(url ?? '').match(/github\.com[/:]([^/\s]+)\/([^/#?\s]+?)(?:\.git)?(?:[/#?].*)?$/i);
  return m ? { owner: m[1], repo: m[2] } : null;
}

/** The command names this package installs onto a consumer's PATH. */
function binNames(manifest) {
  const bin = manifest.bin;
  if (typeof bin === 'string') return [path.basename(String(manifest.name ?? 'cli'))];
  if (bin && typeof bin === 'object') return Object.keys(bin);
  return [];
}

// ---------------------------------------------------------------------------
// checks
// ---------------------------------------------------------------------------

function checkEntryAllowlist(census, entries) {
  const stray = entries
    .filter((e) => !e.isDirectory)
    .map((e) => e.path)
    .filter((p) => !ALLOWED_EXACT.has(p) && !p.startsWith(ALLOWED_PREFIX));
  if (stray.length > 0) {
    census.fail(
      'entry-allowlist',
      `${stray.length} entr${stray.length === 1 ? 'y' : 'ies'} outside package/dist/, ` +
        `package/README.md, package/LICENSE and package/package.json: ${stray.slice(0, 10).join(', ')}` +
        (stray.length > 10 ? ` (+${stray.length - 10} more)` : ''),
    );
    return;
  }
  census.pass('entry-allowlist', `${entries.length} entries, all declared by \`files\` or added by npm`);
}

function checkNoDotfiles(census, entries) {
  const hidden = entries.filter((e) => components(e.path).some((c) => c.startsWith('.'))).map((e) => e.path);
  if (hidden.length > 0) {
    census.fail(
      'no-dotfiles',
      `${hidden.length} dotfile or dot-directory entr${hidden.length === 1 ? 'y' : 'ies'}: ` +
        hidden.slice(0, 10).join(', ') +
        (hidden.length > 10 ? ` (+${hidden.length - 10} more)` : ''),
    );
    return;
  }
  census.pass('no-dotfiles', 'no dotfile or dot-directory entries');
}

function checkNoTestMaterial(census, entries) {
  const shipped = entries.filter((e) => TEST_MATERIAL.some((frag) => e.path.includes(frag))).map((e) => e.path);
  if (shipped.length > 0) {
    census.fail(
      'no-test-material',
      `${shipped.length} entr${shipped.length === 1 ? 'y' : 'ies'} whose path contains ` +
        `${TEST_MATERIAL.map((f) => `\`${f}\``).join(', ')}: ` +
        shipped.slice(0, 10).join(', ') +
        (shipped.length > 10 ? ` (+${shipped.length - 10} more)` : ''),
    );
    return;
  }
  census.pass('no-test-material', `no entry contains ${TEST_MATERIAL.map((f) => `\`${f}\``).join(', ')}`);
}

function checkNoInstallScripts(census, manifest) {
  const scripts = manifest.scripts ?? {};
  const present = INSTALL_HOOKS.filter((hook) => typeof scripts[hook] === 'string');
  if (present.length > 0) {
    census.fail(
      'no-install-scripts',
      `the packed package.json runs on a consumer's machine at install time: ` +
        present.map((h) => `${h}="${scripts[h]}"`).join(', '),
    );
    return;
  }
  census.pass('no-install-scripts', `no ${INSTALL_HOOKS.join('/')} in the packed package.json`);
}

function checkPinnedFirstPartyDeps(census, manifest) {
  const floating = [];
  let examined = 0;
  for (const block of CONSUMER_DEP_BLOCKS) {
    for (const [name, range] of Object.entries(manifest[block] ?? {})) {
      if (!name.startsWith('@opena2a/')) continue;
      examined += 1;
      if (FLOATING_RANGE.test(String(range))) floating.push(`${block}.${name}="${range}"`);
    }
  }
  if (floating.length > 0) {
    census.fail(
      'pinned-first-party-deps',
      `${floating.length} first-party dependenc${floating.length === 1 ? 'y' : 'ies'} on a caret or ` +
        `tilde range, so a sibling repo's release changes what this published version resolves to: ` +
        floating.join(', '),
    );
    return;
  }
  census.pass('pinned-first-party-deps', `${examined} @opena2a/ dependenc${examined === 1 ? 'y is' : 'ies are'} exact`);
}

/**
 * Install the tarball into a throwaway global prefix and run the CLI it
 * installs — with an empty HOME and with the network taken away.
 *
 * The three constraints are the point:
 *   - `--ignore-scripts`, so nothing in the tarball's install path executes;
 *   - an empty HOME, because "works on my machine" is usually a config file
 *     the maintainer has and a new user does not;
 *   - no network, because `--version` and `--help` must answer on an
 *     air-gapped machine. A CLI that hangs or crashes without a registry is a
 *     CLI that hangs or crashes behind a corporate proxy.
 *
 * The network is removed inside the child process rather than at the firewall
 * so the check is portable and needs no privileges: a preloaded CommonJS
 * module replaces socket, DNS and fetch entry points with throws.
 */
function checkGlobalInstallSmoke(census, scratch, tarball, manifest, hasDist) {
  if (!hasDist) {
    census.precondition('global-install-smoke', 'the tarball has no package/dist/, so there is no built CLI to run');
    return null;
  }
  const bins = binNames(manifest);
  if (bins.length === 0) {
    census.precondition('global-install-smoke', 'the packed package.json declares no `bin`, so no command is installed');
    return null;
  }

  const prefix = path.join(scratch, 'global-prefix');
  const home = path.join(scratch, 'empty-home');
  mkdirSync(prefix, { recursive: true });
  mkdirSync(home, { recursive: true });

  const install = npm(['install', '-g', tarball, '--ignore-scripts', '--no-audit', '--no-fund', '--prefix', prefix], {
    cwd: scratch,
  });
  if (install.status !== 0) {
    const said = `${install.stdout ?? ''}${install.stderr ?? ''}`;
    if (looksLikeNetworkTrouble(said)) {
      census.precondition(
        'global-install-smoke',
        `the tarball could not be installed into a clean global prefix because the registry was ` +
          `unreachable: ${firstMeaningfulLine(install.stderr || install.stdout)}`,
      );
    } else {
      census.fail(
        'global-install-smoke',
        `\`npm install -g <tarball> --ignore-scripts\` failed on a clean prefix: ` +
          `${firstMeaningfulLine(install.stderr || install.stdout)}`,
      );
    }
    return null;
  }

  const blocker = path.join(scratch, 'no-network.cjs');
  writeFileSync(
    blocker,
    [
      '// Preloaded into the smoke run. Takes the network away from the child so',
      '// `--version` and `--help` are measured the way an air-gapped or',
      '// proxied user would experience them.',
      "const refuse = (what) => { throw new Error('release-artifact-review: network blocked (' + what + ')'); };",
      "require('node:net').Socket.prototype.connect = function () { refuse('net.Socket#connect'); };",
      "require('node:tls').connect = function () { refuse('tls.connect'); };",
      "const dns = require('node:dns');",
      'dns.lookup = function (hostname, options, callback) {',
      "  const done = typeof options === 'function' ? options : callback;",
      "  const err = new Error('release-artifact-review: DNS blocked for ' + hostname);",
      "  err.code = 'ENOTFOUND';",
      '  if (done) done(err);',
      '};',
      "dns.promises.lookup = async function (hostname) { refuse('dns.promises.lookup ' + hostname); };",
      "globalThis.fetch = function () { return Promise.reject(new Error('release-artifact-review: fetch blocked')); };",
      '',
    ].join('\n'),
  );

  const childEnv = {
    PATH: process.env.PATH ?? '',
    HOME: home,
    XDG_CONFIG_HOME: path.join(home, '.config'),
    NO_COLOR: '1',
    NODE_OPTIONS: `--require "${blocker}"`,
  };

  const failures = [];
  let viaInterpreter = false;
  for (const bin of bins) {
    const binPath = path.join(prefix, 'bin', bin);
    if (!existsSync(binPath)) {
      failures.push(`\`${bin}\` is declared in \`bin\` but no ${bin} landed in the prefix's bin/`);
      continue;
    }
    for (const flag of ['--version', '--help']) {
      const spawnOpts = {
        encoding: 'utf8',
        timeout: 120_000,
        maxBuffer: 16 * 1024 * 1024,
        cwd: home,
        env: childEnv,
      };
      let run = spawnSync(binPath, [flag], spawnOpts);
      // A scratch directory on a `noexec` mount — common in hardened CI images
      // and containers — refuses to exec the installed shim no matter how the
      // package is built. That is a property of the runner, not of the
      // artifact, so the CLI is re-run through the interpreter instead of
      // being reported as broken. The fallback is NAMED in the outcome: it
      // exercises one link fewer than the real thing and the log has to say so.
      if (run.error && /EACCES|ENOEXEC|EPERM/.test(String(run.error.code ?? run.error.message))) {
        viaInterpreter = true;
        run = spawnSync(process.execPath, [realpathSync(binPath), flag], spawnOpts);
      }
      const said = `${run.stdout ?? ''}${run.stderr ?? ''}`;
      if (run.error) {
        failures.push(`\`${bin} ${flag}\` could not be spawned: ${run.error.message}`);
        continue;
      }
      if (run.status !== 0) {
        failures.push(`\`${bin} ${flag}\` exited ${run.status ?? `signal ${run.signal}`}: ${firstMeaningfulLine(said)}`);
        continue;
      }
      if (looksLikeStackTrace(said)) {
        failures.push(`\`${bin} ${flag}\` exited 0 but printed a stack trace: ${firstMeaningfulLine(said)}`);
      }
    }
  }

  if (failures.length > 0) {
    census.fail('global-install-smoke', failures.join('; '));
    return prefix;
  }
  census.pass(
    'global-install-smoke',
    `${bins.join(', ')} answered --version and --help from a clean global prefix with an empty HOME ` +
      `and no network` +
      (viaInterpreter ? ' (run through node: this runner mounts the scratch prefix noexec)' : ''),
  );
  return prefix;
}

/**
 * `npm audit --omit=dev` over the tree a consumer resolves FROM THIS TARBALL.
 *
 * The acceptance list is the repo's one shared list — the same one
 * `audit-consumer-resolution.mjs` and `audit-build-tree.mjs` read. A second
 * list here would be a second place to quietly accept something, which is the
 * arrangement that list exists to prevent.
 */
function checkDependencyAdvisories(census, scratch, tarball) {
  const probe = path.join(scratch, 'advisory-probe');
  mkdirSync(probe, { recursive: true });
  writeFileSync(
    path.join(probe, 'package.json'),
    JSON.stringify({ name: 'release-artifact-review-probe', version: '1.0.0', private: true }) + '\n',
  );

  const install = npm(['install', '--omit=dev', '--ignore-scripts', '--no-audit', '--no-fund', tarball], {
    cwd: probe,
  });
  if (install.status !== 0) {
    census.precondition(
      'dependency-advisories',
      `the tarball's production closure could not be resolved, so there was no tree to audit: ` +
        firstMeaningfulLine(install.stderr || install.stdout),
    );
    return;
  }

  const audited = npm(['audit', '--omit=dev', '--json'], { cwd: probe });
  // `npm audit` exits non-zero whenever it finds anything; the report is still
  // on stdout and is the entire point of the call.
  const raw = audited.stdout ?? '';
  let report;
  try {
    report = JSON.parse(raw);
  } catch {
    census.precondition(
      'dependency-advisories',
      `npm audit produced no parseable report, so the closure was never measured (an unreachable ` +
        `advisory database otherwise reads as zero vulnerabilities): ` +
        firstMeaningfulLine(audited.stderr || raw),
    );
    return;
  }
  // An advisory-database failure returns valid JSON with no `vulnerabilities`
  // key. Every reader below would then find nothing and report a clean tree.
  if (!report || typeof report !== 'object' || !report.vulnerabilities || !report.metadata?.vulnerabilities) {
    census.precondition(
      'dependency-advisories',
      `npm audit returned a report with no \`vulnerabilities\` map — the shape an advisory-database ` +
        `failure returns, not a clean tree: ${firstMeaningfulLine(report?.message ?? raw)}`,
    );
    return;
  }

  const accepted = new Map(ACCEPTED_ADVISORIES.map((a) => [a.id, a]));
  const today = new Date().toISOString().slice(0, 10);
  const unlisted = [];
  const expired = [];
  let severe = 0;

  for (const [pkg, entry] of Object.entries(report.vulnerabilities)) {
    if (entry.severity !== 'high' && entry.severity !== 'critical') continue;
    for (const via of entry.via ?? []) {
      if (typeof via !== 'object' || !via.url) continue;
      const id = via.url.split('/').pop();
      severe += 1;
      const allow = accepted.get(id);
      if (!allow) {
        unlisted.push(`${id} (${entry.severity}, via ${pkg})`);
      } else if (allow.reviewBy < today) {
        expired.push(`${id} (accepted, review date ${allow.reviewBy} passed)`);
      }
    }
  }

  if (unlisted.length > 0 || expired.length > 0) {
    census.fail(
      'dependency-advisories',
      [...new Set([...unlisted, ...expired])].join(', ') +
        ' — accept it in scripts/lib/accepted-advisories.mjs with a reason and a review date, or raise the floor',
    );
    return;
  }
  const counts = report.metadata.vulnerabilities;
  census.pass(
    'dependency-advisories',
    `no unaccepted high-or-above advisory in the tarball's production closure ` +
      `(${counts.critical ?? 0} critical, ${counts.high ?? 0} high, ${severe} accepted occurrence(s))`,
  );
}

/** The scanner this package already wraps, resolved without touching the network. */
function resolveScanner() {
  const bundled = path.join(REPO_ROOT, 'node_modules', '.bin', 'hackmyagent');
  if (existsSync(bundled)) return bundled;
  const onPath = spawnSync('hackmyagent', ['--version'], { encoding: 'utf8', timeout: 60_000 });
  if (onPath.status === 0) return 'hackmyagent';
  return null;
}

/** The scanner's version, for the census row — a scan result without the
 *  instrument's version is not reproducible evidence. */
function scannerVersion(scanner) {
  try {
    const manifest = path.join(REPO_ROOT, 'node_modules', 'hackmyagent', 'package.json');
    if (scanner !== 'hackmyagent' && existsSync(manifest)) {
      return String(JSON.parse(readFileSync(manifest, 'utf8')).version ?? 'unknown');
    }
  } catch {
    // fall through to asking the binary
  }
  const run = spawnSync(scanner, ['--version'], { encoding: 'utf8', timeout: 60_000 });
  const m = String(run.stdout ?? '').match(/\d+\.\d+\.\d+\S*/);
  return m ? m[0] : 'unknown';
}

/**
 * Scan a scratch copy of the shipped `dist/` for credentials, with one planted
 * control file proving the scanner was reading.
 *
 * The scan runs on a COPY so the planted control can never be packed, and so a
 * scanner that writes caches or reports does it outside the artifact.
 */
function checkCredentialScan(census, scratch, entries, hasDist) {
  if (!hasDist) {
    census.precondition('credential-scan', 'the tarball has no package/dist/ to scan');
    return;
  }
  const scanner = resolveScanner();
  if (!scanner) {
    census.precondition(
      'credential-scan',
      '`hackmyagent` is not locally resolvable (no node_modules/.bin/hackmyagent and none on PATH) — ' +
        'run `npm ci --ignore-scripts` in this checkout before the review',
    );
    return;
  }

  const version = scannerVersion(scanner);
  const scanDir = path.join(scratch, 'credential-scan');
  mkdirSync(scanDir, { recursive: true });
  // Extracted FLAT — each entry at its path relative to package/dist/, with no
  // `dist` path component: the shipped scanner's walk skips any directory
  // named `dist` (scanner-bridge.js SKIP_DIRS), so a scratch copy that kept
  // the `dist/` prefix would be a scan of nothing that reads as clean.
  const written = extractDist(entries, scanDir);
  if (written === 0) {
    census.precondition('credential-scan', 'package/dist/ unpacked to zero regular files, so there was nothing to scan');
    return;
  }
  writeFileSync(path.join(scanDir, CONTROL_BASENAME), buildControlSource());

  // `--no-registry`/`--no-contribute`: a gate must not publish its subject's
  // scan results to an external registry as a side effect of gating.
  const scan = spawnSync(scanner, ['secure', '--format', 'json', '--no-registry', '--no-contribute', scanDir], {
    encoding: 'utf8',
    timeout: 10 * 60 * 1000,
    maxBuffer: 64 * 1024 * 1024,
  });
  const stdout = scan.stdout ?? '';
  const jsonAt = stdout.indexOf('{');
  if (jsonAt < 0) {
    census.precondition(
      'credential-scan',
      `\`hackmyagent secure --format json\` produced no JSON report, so dist/ was never scanned: ` +
        firstMeaningfulLine(scan.stderr || stdout),
    );
    return;
  }
  let report;
  try {
    report = JSON.parse(stdout.slice(jsonAt));
  } catch (e) {
    census.precondition('credential-scan', `the scanner's JSON report did not parse: ${e?.message ?? e}`);
    return;
  }

  const credential = (report.findings ?? [])
    .filter((f) => f && f.passed !== true)
    .filter((f) => isCredentialClassFinding(f));

  const onControl = credential.filter((f) => String(f.file ?? '').includes(CONTROL_BASENAME));
  const onShipped = credential.filter((f) => !String(f.file ?? '').includes(CONTROL_BASENAME));

  // Shipped findings are judged FIRST. The scanner reports at most one finding
  // per checkId (it collapses duplicates onto the first file in walk order),
  // so a credential in a shipped file SHADOWS the control — the control is
  // named `zz-…` precisely so shipped files sort ahead of it. Testing the
  // control first would turn a caught shipped credential into a "control not
  // flagged" precondition, which blames the instrument for working.
  // The failing checkId and file:line are named — never the matched text,
  // which this tool must not echo.
  if (onShipped.length > 0) {
    census.fail(
      'credential-scan',
      `${onShipped.length} credential-class finding(s) in the SHIPPED dist/ (hackmyagent@${version}): ` +
        onShipped
          .slice(0, 10)
          .map((f) => `${f.checkId ?? '?'} at ${f.file ?? '?'}${f.line ? `:${f.line}` : ''}`)
          .join(', '),
    );
    return;
  }
  if (onControl.length === 0) {
    census.precondition(
      'credential-scan',
      `control not flagged by hackmyagent@${version} — "zero credential findings" here means the ` +
        `scanner is not reading rather than that dist/ is clean ` +
        `(${(report.findings ?? []).length} finding(s) total)`,
    );
    return;
  }
  census.pass(
    'credential-scan',
    `zero credential-class findings across ${written} shipped dist/ file(s); the planted control was ` +
      `found (${onControl.map((f) => f.checkId ?? '?').join(', ')}), so the scan was measuring; ` +
      `scanner hackmyagent@${version}`,
  );
}

/**
 * The own-package census over the fresh-install closure of THIS tarball.
 *
 * The question: does anything a consumer resolves from this artifact ship a
 * deprecated or advisory-covered copy of one of OUR OWN packages — the roster
 * plus the `@opena2a/` scope, the packed package itself included? Deprecation
 * and GitHub security advisories are read live, per copy, because that is
 * exactly the class of finding a lockfile refresh in a sibling repo does not
 * surface here.
 *
 * `audit:consumer` is a different question (npm-audit advisories in the
 * resolved tree) and is NOT this check; it stays in its own job.
 *
 * Two instrument self-tests keep "no findings" honest:
 *   - the deprecation probe reads one NAMED known-deprecated own version
 *     (hackmyagent@0.25.0) and must see a non-empty message;
 *   - the advisory feed must return a non-zero advisory count across the
 *     roster's repositories (hackmyagent's repository alone carries several).
 * Either self-test failing is a `precondition`, never a pass.
 */
async function checkConsumerClosure(census, scratch, tarball, manifest, advisoryStates) {
  let semver;
  try {
    ({ default: semver } = await import('semver'));
  } catch {
    census.precondition(
      'consumer-closure',
      'the `semver` package is not locally resolvable — run `npm ci --ignore-scripts` in this checkout before the review',
    );
    return;
  }

  // 1. Resolve the fresh-install closure of the tarball, lockfile-only.
  const probe = path.join(scratch, 'closure-probe');
  mkdirSync(probe, { recursive: true });
  writeFileSync(
    path.join(probe, 'package.json'),
    JSON.stringify({ name: 'release-artifact-review-closure-probe', version: '1.0.0', private: true }) + '\n',
  );
  const resolveRun = npm(
    ['install', '--package-lock-only', '--ignore-scripts', '--no-audit', '--no-fund', tarball],
    { cwd: probe },
  );
  if (resolveRun.status !== 0) {
    census.precondition(
      'consumer-closure',
      `the fresh-install closure of the tarball did not resolve: ` +
        firstMeaningfulLine(resolveRun.stderr || resolveRun.stdout),
    );
    return;
  }
  let lock;
  try {
    lock = JSON.parse(readFileSync(path.join(probe, 'package-lock.json'), 'utf8'));
  } catch (e) {
    census.precondition('consumer-closure', `the closure lockfile did not parse: ${e?.message ?? e}`);
    return;
  }

  // 2. Every own copy in the closure, alias-aware, the packed package included.
  const copies = new Map(); // "name@version" -> { name, version }
  for (const [pkgPath, entry] of Object.entries(lock.packages ?? {})) {
    if (pkgPath === '' || !entry || typeof entry !== 'object') continue;
    const name = entry.name ?? pkgPath.split('node_modules/').pop();
    if (!name || !entry.version || !isOwnPackageName(name)) continue;
    copies.set(`${name}@${entry.version}`, { name, version: entry.version });
  }
  if (manifest.name && manifest.version && isOwnPackageName(manifest.name)) {
    copies.set(`${manifest.name}@${manifest.version}`, { name: manifest.name, version: manifest.version });
  }

  // 3. Instrument self-test: the deprecation probe must read a deprecation.
  const probeRun = npm(['view', KNOWN_DEPRECATED_OWN_VERSION, 'deprecated']);
  if (probeRun.status !== 0) {
    census.precondition(
      'consumer-closure',
      `npm view ${KNOWN_DEPRECATED_OWN_VERSION} deprecated errored, so deprecations were never read: ` +
        firstMeaningfulLine(probeRun.stderr || probeRun.stdout),
    );
    return;
  }
  if (!String(probeRun.stdout ?? '').trim()) {
    census.precondition(
      'consumer-closure',
      `the deprecation probe on ${KNOWN_DEPRECATED_OWN_VERSION} returned empty — that version is ` +
        `known-deprecated, so the instrument is not reading deprecations`,
    );
    return;
  }

  const failRows = [];
  const notes = [];

  // 4. Deprecation, per own copy.
  for (const { name, version } of copies.values()) {
    const run = npm(['view', `${name}@${version}`, 'deprecated']);
    if (run.status !== 0) {
      const said = `${run.stdout ?? ''}${run.stderr ?? ''}`;
      // The packed candidate's own version legitimately predates its publish;
      // a version the registry has never seen cannot be deprecated. Anything
      // other than a version-level 404 is the instrument failing.
      if (/E404|No match found for version/i.test(said)) {
        notes.push(`${name}@${version} not published yet (no deprecation to read)`);
        continue;
      }
      census.precondition(
        'consumer-closure',
        `npm view ${name}@${version} deprecated errored: ` + firstMeaningfulLine(run.stderr || run.stdout),
      );
      return;
    }
    const message = String(run.stdout ?? '').trim();
    if (message) failRows.push(`${name}@${version} deprecated: ${firstMeaningfulLine(message)}`);
  }

  // 5. GitHub security advisories, per distinct own package's repository.
  const statesQuery = advisoryStates === 'published' ? 'state=published&per_page=100' : 'per_page=100';
  const advisoriesByRepo = new Map(); // "owner/repo" -> advisory[]
  const repoOfName = new Map(); // package name -> "owner/repo"

  const resolveRepo = (name) => {
    if (repoOfName.has(name)) return { key: repoOfName.get(name) };
    const run = npm(['view', name, 'repository.url']);
    if (run.status !== 0) {
      return { error: `npm view ${name} repository.url errored: ${firstMeaningfulLine(run.stderr || run.stdout)}` };
    }
    const url = String(run.stdout ?? '').trim();
    if (!url) return { error: `the registry packument for ${name} carries no repository.url` };
    const parsed = parseGitHubRepo(url);
    if (!parsed) return { error: `repository.url for ${name} is not a GitHub repository: ${url}` };
    const key = `${parsed.owner}/${parsed.repo}`;
    repoOfName.set(name, key);
    return { key };
  };

  const readAdvisories = async (repoKey) => {
    if (advisoriesByRepo.has(repoKey)) return {};
    const { status, text } = await githubGet(
      `https://api.github.com/repos/${repoKey}/security-advisories?${statesQuery}`,
    );
    if (status === 403 || status === 429) {
      return { error: `the advisories endpoint rate-limited or refused (HTTP ${status}) for ${repoKey}` };
    }
    if (status !== 200) {
      return {
        error:
          `the advisories endpoint for ${repoKey} returned ` +
          (status === 0 ? `no response (${firstMeaningfulLine(text)})` : `HTTP ${status}`),
      };
    }
    let advisories;
    try {
      advisories = JSON.parse(text);
    } catch (e) {
      return { error: `the advisories response for ${repoKey} did not parse: ${e?.message ?? e}` };
    }
    if (!Array.isArray(advisories)) {
      return { error: `the advisories response for ${repoKey} was not a list` };
    }
    advisoriesByRepo.set(repoKey, advisories);
    return {};
  };

  const ownNames = [...new Set([...copies.values()].map((c) => c.name))];
  for (const name of ownNames) {
    const repo = resolveRepo(name);
    if (repo.error) {
      census.precondition('consumer-closure', repo.error);
      return;
    }
    const read = await readAdvisories(repo.key);
    if (read.error) {
      census.precondition('consumer-closure', read.error);
      return;
    }
  }

  // 6. Range matching: every own copy against every advisory of its repository.
  //    GitHub joins compound ranges with `, `; npm semver wants a space.
  for (const { name, version } of copies.values()) {
    const advisories = advisoriesByRepo.get(repoOfName.get(name)) ?? [];
    for (const advisory of advisories) {
      for (const vulnerability of advisory.vulnerabilities ?? []) {
        if (vulnerability?.package?.ecosystem !== 'npm' || vulnerability?.package?.name !== name) continue;
        const range = String(vulnerability.vulnerable_version_range ?? '').trim();
        if (!range) continue;
        let inRange;
        try {
          inRange = semver.satisfies(version, range.split(', ').join(' '), { includePrerelease: true });
        } catch (e) {
          census.precondition(
            'consumer-closure',
            `the vulnerable_version_range "${range}" on ${advisory.ghsa_id ?? '?'} did not parse: ${e?.message ?? e}`,
          );
          return;
        }
        if (inRange) {
          failRows.push(`${name}@${version} inside ${advisory.ghsa_id ?? '?'} (${range})`);
        }
      }
    }
  }

  // 7. Instrument self-test: the advisory feed must be demonstrably non-empty
  //    across the roster's repositories, else "no advisory hits" above is
  //    indistinguishable from a feed that returned nothing. Walk the roster
  //    (hackmyagent first — its repository carries published advisories) until
  //    a non-zero count proves the feed is reading.
  let advisoryTotal = [...advisoriesByRepo.values()].reduce((n, list) => n + list.length, 0);
  if (advisoryTotal === 0) {
    for (const name of OWN_PACKAGE_ROSTER) {
      if (repoOfName.has(name)) continue;
      const repo = resolveRepo(name);
      if (repo.error) {
        census.precondition('consumer-closure', repo.error);
        return;
      }
      const read = await readAdvisories(repo.key);
      if (read.error) {
        census.precondition('consumer-closure', read.error);
        return;
      }
      advisoryTotal = [...advisoriesByRepo.values()].reduce((n, list) => n + list.length, 0);
      if (advisoryTotal > 0) break;
    }
  }
  if (advisoryTotal === 0) {
    census.precondition(
      'consumer-closure',
      `the advisory feed returned zero advisories across the roster's repositories ` +
        `(${[...advisoriesByRepo.keys()].join(', ') || 'none read'}) — a feed that reads as empty ` +
        `everywhere is a feed that is not reading (states: ${advisoryStates})`,
    );
    return;
  }

  for (const row of failRows) console.log(`  consumer-closure fail: ${row}`);
  for (const note of notes) console.log(`  consumer-closure note: ${note}`);

  const examined = [...copies.keys()].sort();
  const reposRead = advisoriesByRepo.size;
  if (failRows.length > 0) {
    census.fail(
      'consumer-closure',
      `${failRows.length} fail row(s) over ${examined.length} own cop${examined.length === 1 ? 'y' : 'ies'} ` +
        `(states read: ${advisoryStates}; ${advisoryTotal} advisor${advisoryTotal === 1 ? 'y' : 'ies'} across ` +
        `${reposRead} repo(s)): ` +
        failRows.join('; '),
    );
    return;
  }
  census.pass(
    'consumer-closure',
    `${examined.length} own cop${examined.length === 1 ? 'y' : 'ies'} examined` +
      (examined.length > 0 ? ` (${examined.join(', ')})` : '') +
      `; advisory states read: ${advisoryStates}; ${advisoryTotal} advisor${advisoryTotal === 1 ? 'y' : 'ies'} ` +
      `across ${reposRead} repo(s); 0 fail rows`,
  );
}

// ---------------------------------------------------------------------------
// main
// ---------------------------------------------------------------------------

function parseArgs(argv) {
  const at = argv.indexOf('--tarball');
  if (at === -1 || !argv[at + 1]) {
    throw new Error(
      'usage: node scripts/release-artifact-review.mjs --tarball <path-to.tgz> [--advisory-states published|all]',
    );
  }
  const tarball = path.resolve(argv[at + 1]);
  if (!existsSync(tarball) || !statSync(tarball).isFile()) {
    throw new Error(`--tarball ${tarball} is not a file`);
  }
  let advisoryStates = 'all';
  const statesAt = argv.indexOf('--advisory-states');
  if (statesAt !== -1) {
    advisoryStates = argv[statesAt + 1];
    if (advisoryStates !== 'published' && advisoryStates !== 'all') {
      throw new Error('--advisory-states must be `published` or `all`');
    }
  }
  return { tarball, advisoryStates };
}

async function main() {
  const census = new Census(CHECK_NAMES);
  let scratch = null;
  let tarball = '(none)';
  let advisoryStates = 'all';

  try {
    ({ tarball, advisoryStates } = parseArgs(process.argv.slice(2)));
  } catch (e) {
    console.error(`release-artifact-review: ${e?.message ?? e}`);
    process.exit(2);
  }

  console.log('release-artifact-review — the artifact this tag would publish');
  console.log(`  tarball: ${tarball}`);
  console.log(`  checks:  ${CHECK_NAMES.join(', ')}`);
  console.log(`  advisory states: ${advisoryStates}`);
  console.log('');

  try {
    scratch = mkdtempSync(path.join(tmpdir(), 'release-artifact-review-'));

    const entries = readTarEntries(tarball);
    const manifestEntry = entries.find((e) => e.path === 'package/package.json');
    if (!manifestEntry?.body) {
      throw new Error('the tarball has no package/package.json, so it is not an npm package');
    }
    const manifest = JSON.parse(manifestEntry.body.toString('utf8'));
    const hasDist = entries.some((e) => !e.isDirectory && e.path.startsWith(ALLOWED_PREFIX));

    console.log(`  package: ${manifest.name}@${manifest.version} — ${entries.length} tar entries`);
    if (!hasDist) {
      console.log('  NOTE: no package/dist/ in this tarball; the checks that need a built CLI cannot run.');
    }

    checkEntryAllowlist(census, entries);
    checkNoDotfiles(census, entries);
    checkNoTestMaterial(census, entries);
    checkNoInstallScripts(census, manifest);
    checkPinnedFirstPartyDeps(census, manifest);
    checkGlobalInstallSmoke(census, scratch, tarball, manifest, hasDist);
    checkDependencyAdvisories(census, scratch, tarball);
    checkCredentialScan(census, scratch, entries, hasDist);
    await checkConsumerClosure(census, scratch, tarball, manifest, advisoryStates);
  } catch (e) {
    // A throw here means the checks that had not run yet did not run. They are
    // settled as preconditions rather than left absent, so the census stays
    // complete and the run stays un-green.
    console.error(`\nrelease-artifact-review: ${e?.message ?? e}`);
    if (process.env.RELEASE_ARTIFACT_REVIEW_DEBUG) console.error(e?.stack ?? e);
    census.settle(`the review aborted before this check ran: ${String(e?.message ?? e).slice(0, 200)}`);
  } finally {
    if (scratch) rmSync(scratch, { recursive: true, force: true });
  }

  census.report();

  const failed = census.by('fail');
  const blocked = census.by('precondition');
  if (failed.length === 0 && blocked.length === 0) {
    console.log('');
    console.log(`release-artifact-review PASSED — all ${CHECK_NAMES.length} checks ran and passed.`);
    process.exit(0);
  }

  console.error('');
  console.error('release-artifact-review FAILED — this tarball must not be published as it stands.');
  for (const outcome of failed) {
    console.error(`  FAILED CHECK ${outcome.name}: ${outcome.detail}`);
  }
  for (const outcome of blocked) {
    console.error(`  BLOCKED CHECK ${outcome.name}: precondition: ${outcome.detail}`);
  }
  if (blocked.length > 0) {
    console.error('');
    console.error(
      '  A check that could not run is reported as `precondition` and exits non-zero. It is never\n' +
        '  reported as a pass: a gate that goes green when it is blind is worse than no gate.',
    );
  }
  process.exit(1);
}

await main();
