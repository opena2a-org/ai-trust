#!/usr/bin/env node
/**
 * Audit the tree a CONSUMER of the PUBLISHED `ai-trust` resolves — not the
 * tree this repo pins.
 *
 * ## The premise
 *
 * The artifact we audit is not the artifact we ship. An ordinary `npm audit`
 * runs against this repo's lockfile: devDependencies included, local
 * `overrides` honoured, and every version pinned by the working tree rather
 * than by the last release. A consumer runs `npm install ai-trust` and gets a
 * different tree. A green repo audit therefore says nothing about what users
 * get, and a gate that measures the repo when the risk lives in the published
 * tree is decorative regardless of its colour.
 *
 * Two divergences are live in this package today and both are measurable:
 *
 * 1. VERSION SKEW. `package.json` in this repo pins `hackmyagent` at one
 *    version; the last published `ai-trust` pins whatever it pinned on its
 *    release day. Those are different dependency sets, so they resolve
 *    different advisories.
 * 2. THE CYCLE. `hackmyagent` depended back on `ai-trust` up to and including
 *    0.26.1, and that older `ai-trust` depends back on an older `hackmyagent`.
 *    A consumer of this package therefore resolves MULTIPLE copies of our own
 *    scanner, including versions carrying a deprecation notice describing
 *    defects in a release the user never asked for. `hackmyagent`'s own gate
 *    forbids the nested copy; nothing on this side ever checked.
 *
 * Evidence this is not hypothetical: on 2026-08-10 the published
 * `opena2a-cli@0.10.13` production tree was found to carry a high advisory
 * (GHSA-xcpc-8h2w-3j85, adm-zip) through
 * `hackmyagent -> onnxruntime-node -> adm-zip`, while every repo-level audit
 * in the org was green.
 *
 * ## What it measures
 *
 * It installs the PUBLISHED package from the registry into a scratch
 * directory with `--omit=dev --ignore-scripts` and audits THAT. Auditing
 * `npm ci` in this repo is the exact failure mode this exists to fix.
 *
 * Default target is `ai-trust@<latest dist-tag>`: the artifact users can
 * install right now. Pass `--target <spec>` to point it at a candidate
 * instead — e.g. a tarball from `npm pack` — to check a fix before release.
 * Note the honest consequence of the default: a PR that fixes a dependency
 * cannot turn this gate green, because the gate describes the published
 * artifact and not the branch. That is the intended reading. The gate goes
 * green when the fix is RELEASED, which is when users stop being affected.
 *
 * ## Why it installs, and why that is still fork-safe
 *
 * `hackmyagent`'s sibling of this script resolves `--package-lock-only` so
 * nothing is fetched. This one performs a real install, because the waiver
 * below re-derives its reachability claim from the installed dependency's own
 * metadata files, and you cannot read files that were never downloaded.
 *
 * The fork-safety argument survives intact, on two grounds:
 *   - `--ignore-scripts` on the install, so no dependency's `postinstall`
 *     executes;
 *   - the target is a PUBLISHED registry spec, not this checkout. A pull
 *     request from a fork cannot change what gets installed here, because
 *     nothing from the PR's tree enters the scratch directory.
 *
 * ## Why the gate is an allowlist and not a count
 *
 * At least one advisory in the consumer tree has no fix available at any
 * stable version, and `overrides` written here are not carried in the
 * published tarball, so that lever does not reach a consumer. A gate that can
 * only ever be red gets switched off within a release and protects nothing.
 *
 * So every high/critical advisory must be NAMED in ALLOWED with a reason and
 * a review date. Anything unlisted fails. An entry that stops matching also
 * fails, so waivers cannot quietly accumulate for advisories fixed years ago:
 * a stale waiver reads exactly like a considered one. Dates expire.
 *
 * ## Why waivers may not restate environment-dependent facts in prose
 *
 * This is a hard rule and it comes from a real defect. `hackmyagent`'s waiver
 * for GHSA-xcpc-8h2w-3j85 asserted, in prose, that the shipped tarball made
 * the vulnerable code path unreachable. The claim was false, and false in our
 * favour — the worst direction for a waiver to be wrong — and nothing detected
 * the drift for weeks, because prose does not get re-evaluated.
 *
 * So an ALLOWED entry that needs to say something about platforms, versions,
 * ranges, or reachability declares a `derive(ctx)` instead. It runs against
 * the installed tree on every invocation, its output is printed in full, and
 * if it cannot reach a conclusion the gate FAILS rather than falling back to
 * the last thing someone wrote down.
 */
import { execFileSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync, readFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const SELF = fileURLToPath(import.meta.url);
const REPO_ROOT = path.resolve(path.dirname(SELF), '..');
const PACKAGE_NAME = JSON.parse(readFileSync(path.join(REPO_ROOT, 'package.json'), 'utf8')).name;

/**
 * Advisories accepted in the consumer tree, keyed by GHSA id.
 *
 * An entry is a statement that a user installing this tool gets this advisory
 * and we decided to ship anyway. It has to survive a reader asking "why is my
 * audit red because of your CLI", so `reason` names the blocker, not the
 * severity — and it must not restate anything a `derive` can compute.
 */
const ALLOWED = [
  {
    id: 'GHSA-xcpc-8h2w-3j85',
    package: 'adm-zip',
    reason:
      'adm-zip <0.6.0, reached only through onnxruntime-node, which hackmyagent needs ' +
      'for local NanoMind inference and which ai-trust inherits by depending on ' +
      'hackmyagent. There is no stable version of onnxruntime-node that resolves ' +
      'clean: it pins adm-zip inside a caret on 0.5.x and the patched release is ' +
      '0.6.0, outside that caret. An `overrides` block does not help — overrides are ' +
      'applied only to the tree that declares them and are not carried in a published ' +
      'tarball, so a consumer resolves the vulnerable version regardless of what this ' +
      'repo pins. Removing the dependency means removing local inference from ' +
      'hackmyagent, which is a decision for that package, not this one. The fix has ' +
      'landed upstream on onnxruntime-node\'s dev channel, and hackmyagent\'s caret ' +
      'range admits it, so a stable cut resolves this with no action here. ' +
      'Blast radius is availability-only and install-time; the concrete per-platform ' +
      'reachability is DERIVED below on every run rather than asserted here, because ' +
      'the last time that claim was written as prose it was wrong in our favour and ' +
      'stayed wrong for weeks.',
    reviewBy: '2026-11-01',
    /**
     * Re-derive the reachability claim from onnxruntime-node's own install
     * metadata in the installed tree. Throws — failing the gate — if the
     * package, its metadata, or its shape cannot be read, because "we could
     * not check" must never present as "we checked and it was fine".
     */
    derive({ probeDir }) {
      const root = findInstalled(probeDir, 'onnxruntime-node');
      if (!root) {
        throw new Error(
          'onnxruntime-node is not present in the installed consumer tree, so this ' +
            "waiver's reachability claim cannot be derived. If the dependency is gone, " +
            'the advisory should be gone too and this entry should be deleted.'
        );
      }
      const pkg = JSON.parse(readFileSync(path.join(root, 'package.json'), 'utf8'));
      const admRange = pkg.dependencies?.['adm-zip'];
      if (!admRange) {
        throw new Error(
          `onnxruntime-node@${pkg.version} no longer declares an adm-zip dependency. ` +
            'The premise of this waiver has changed; re-check it.'
        );
      }

      const utilsPath = path.join(root, 'script', 'install-utils.js');
      if (!existsSync(utilsPath)) {
        throw new Error(
          `onnxruntime-node@${pkg.version} has no script/install-utils.js; the install ` +
            'path this waiver reasons about no longer exists in the shape we expect.'
        );
      }
      const utils = readFileSync(utilsPath, 'utf8');
      const requiredUnconditionally = /^\s*const\s+\w+\s*=\s*require\(['"]adm-zip['"]\)/m.test(utils);

      const { requirements, manifests } = readOnnxInstallMetadata(root);
      const lines = [];
      let parsingPlatforms = 0;
      for (const [platform, reqs] of Object.entries(requirements)) {
        if (reqs.length === 0) {
          lines.push(`${platform}: no manifest required -> nothing downloaded, no ZIP parsed`);
          continue;
        }
        const missing = [];
        for (const req of reqs) {
          const key = `${platform}:${req}`;
          const files = manifests[key];
          if (!files) {
            throw new Error(
              `install-metadata.js requires manifest "${key}" but declares no such ` +
                'manifest. The metadata shape changed; re-derive this waiver by hand.'
            );
          }
          for (const file of files) {
            if (!existsSync(path.join(root, 'bin', 'napi-v6', platform, file))) {
              missing.push(`${req}${file.replace(/^\./, '')}`);
            }
          }
        }
        if (missing.length > 0) {
          parsingPlatforms++;
          lines.push(
            `${platform}: requires [${reqs.join(', ')}], ${missing.length} file(s) absent from ` +
              `the tarball -> postinstall DOWNLOADS an archive and PARSES it with adm-zip`
          );
        } else {
          lines.push(
            `${platform}: requires [${reqs.join(', ')}], all files present in the tarball -> ` +
              'no download, no ZIP parsed'
          );
        }
      }
      if (Object.keys(requirements).length === 0) {
        throw new Error(
          'install-metadata.js declared no platform requirements; refusing to conclude ' +
            'anything from an empty derivation.'
        );
      }

      return [
        `onnxruntime-node@${pkg.version} pins adm-zip ${admRange} (patched release is 0.6.0)`,
        `adm-zip required unconditionally at module load in script/install-utils.js: ` +
          `${requiredUnconditionally ? 'YES, on every platform' : 'NO — verify by hand, the load site moved'}`,
        `platforms whose postinstall actually parses an archive: ${parsingPlatforms} of ` +
          `${Object.keys(requirements).length}`,
        ...lines,
      ];
    },
  },
];

/**
 * Packages that must never appear in a consumer tree below the root, at any
 * version.
 *
 * A `waiver` here carries the same discipline as ALLOWED: a reason, a review
 * date, and the exact versions it covers. A copy at a version the waiver does
 * not name fails, a waiver that stops matching fails, and an expired date
 * fails. The alternative — an unwaivable check on a condition this repo
 * cannot fix alone — is a permanently red gate, and a permanently red gate
 * gets deleted.
 */
const FORBIDDEN_PACKAGES = [
  {
    name: 'hackmyagent',
    reason:
      'A second, older copy of the scanner this package wraps. It arrives through a ' +
      'dependency cycle: ai-trust -> hackmyagent -> ai-trust (older) -> hackmyagent ' +
      '(much older). The old copy prints a deprecation notice describing defects in a ' +
      'version the user never asked for, and it means `ai-trust` and the scanner it ' +
      'reports on can disagree about their own version.',
    waiver: {
      versions: ['0.17.11'],
      reason:
        'Not fixable from this repo at the currently published pin. Every hackmyagent ' +
        'release through 0.26.1 declares `ai-trust: ^0.2.6`, so pinning any of them ' +
        'reintroduces the cycle no matter which one is chosen. hackmyagent 0.27.0 is ' +
        'the first release that drops the ai-trust edge; the remedy is to raise the ' +
        'pin here to >=0.27.0 and publish, after which this waiver must be DELETED ' +
        '(it will fail as stale on the next run, which is the intended forcing ' +
        'function). Until that release ships, users installing ai-trust do resolve a ' +
        'second scanner copy, and this entry records that we know.',
      reviewBy: '2026-09-15',
    },
  },
  {
    name: 'ai-trust',
    reason:
      'A second, older copy of THIS package inside a consumer tree. Two ai-trust ' +
      'installs with different check sets and different registry clients can return ' +
      'different verdicts for the same query, and only one of them is the one the ' +
      'user installed.',
    waiver: {
      versions: ['0.2.25'],
      reason:
        'Same root cause and same remedy as the hackmyagent entry above: the old ' +
        'ai-trust is pulled in BY hackmyagent, not by anything this repo declares. It ' +
        'disappears when the hackmyagent pin reaches >=0.27.0, which dropped the ' +
        'ai-trust edge. Nothing in this repo can suppress it before then — the nested ' +
        'copy is a transitive dependency of a dependency, and `overrides` are not ' +
        'published. Delete this entry with the other one.',
      reviewBy: '2026-09-15',
    },
  },
];

function run(cmd, args, opts = {}) {
  return execFileSync(cmd, args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], ...opts });
}

/** First installed copy of `name` under `dir`, searched via the written lockfile. */
function findInstalled(dir, name) {
  const lockPath = path.join(dir, 'package-lock.json');
  if (existsSync(lockPath)) {
    const lock = JSON.parse(readFileSync(lockPath, 'utf8'));
    for (const p of Object.keys(lock.packages ?? {})) {
      if (p.endsWith(`node_modules/${name}`) && existsSync(path.join(dir, p))) {
        return path.join(dir, p);
      }
    }
  }
  const direct = path.join(dir, 'node_modules', name);
  return existsSync(direct) ? direct : null;
}

/**
 * Read onnxruntime-node's `script/install-metadata.js` WITHOUT executing it.
 *
 * `require()` would be shorter, but this script's whole subject is not
 * trusting a dependency, and the install was deliberately run with
 * `--ignore-scripts`; loading a dependency's module here would hand it
 * execution anyway. So the two blocks are extracted textually, and any shape
 * this parser does not recognise raises rather than returning an empty result
 * that would read as "nothing affected".
 */
function readOnnxInstallMetadata(root) {
  const src = readFileSync(path.join(root, 'script', 'install-metadata.js'), 'utf8');

  const braceBlock = (key) => {
    const at = src.indexOf(`${key}: {`);
    if (at === -1) return null;
    const open = src.indexOf('{', at);
    let depth = 0;
    for (let i = open; i < src.length; i++) {
      if (src[i] === '{') depth++;
      else if (src[i] === '}' && --depth === 0) return src.slice(open + 1, i);
    }
    return null;
  };

  const reqSrc = braceBlock('requirements');
  const manSrc = braceBlock('manifests');
  if (reqSrc === null || manSrc === null) {
    throw new Error(
      'Could not locate the `requirements` and `manifests` blocks in onnxruntime-node ' +
        'install-metadata.js. Upstream changed the file; re-derive this waiver by hand ' +
        'rather than trusting a stale conclusion.'
    );
  }

  const requirements = {};
  for (const m of reqSrc.matchAll(/'([^']+)'\s*:\s*\[([^\]]*)\]/g)) {
    requirements[m[1]] = [...m[2].matchAll(/'([^']+)'/g)].map((x) => x[1]);
  }

  const manifests = {};
  const entry = /'([^']+)'\s*:\s*\{/g;
  let cursor = 0;
  for (;;) {
    entry.lastIndex = cursor;
    const hit = entry.exec(manSrc);
    if (!hit) break;
    const open = manSrc.indexOf('{', hit.index);
    let depth = 0;
    let end = -1;
    for (let i = open; i < manSrc.length; i++) {
      if (manSrc[i] === '{') depth++;
      else if (manSrc[i] === '}' && --depth === 0) {
        end = i;
        break;
      }
    }
    if (end === -1) break;
    manifests[hit[1]] = [...manSrc.slice(open + 1, end).matchAll(/'(\.\/[^']+)'\s*:\s*\{/g)].map(
      (x) => x[1]
    );
    cursor = end + 1;
  }

  return { requirements, manifests };
}

/** Install `spec` as a production dependency of an empty package and audit it. */
function auditConsumerTree(spec, probeDir) {
  writeFileSync(
    path.join(probeDir, 'package.json'),
    JSON.stringify({ name: 'consumer-resolution-probe', version: '1.0.0', private: true }) + '\n'
  );
  run('npm', ['install', '--omit=dev', '--ignore-scripts', '--no-audit', '--no-fund', spec], {
    cwd: probeDir,
  });

  let raw;
  try {
    raw = run('npm', ['audit', '--omit=dev', '--json'], { cwd: probeDir });
  } catch (e) {
    // `npm audit` exits non-zero when it finds anything. The report is still
    // on stdout and is the entire point of the call.
    raw = e.stdout ?? '';
  }

  let report;
  try {
    report = JSON.parse(raw);
  } catch {
    // A gate that could not take its measurement has not passed. `npm audit`
    // reaches the live advisory database, so an unreachable registry, a proxy,
    // or a rate limit all land here — and every one of them would otherwise
    // surface as a raw SyntaxError that reads like a bug in this script.
    throw new Error(
      'npm audit produced no parseable report, so the consumer tree was never measured. ' +
        'This is not a pass. Check network access to the npm advisory database and re-run.\n' +
        `npm said: ${(raw || '(nothing)').slice(0, 500)}`
    );
  }

  const lock = JSON.parse(readFileSync(path.join(probeDir, 'package-lock.json'), 'utf8'));
  return { report, lock };
}

/** Every GHSA id at `high` or `critical`, with the package it lands on. */
function highAndCritical(report) {
  const out = new Map();
  for (const [name, v] of Object.entries(report.vulnerabilities ?? {})) {
    if (v.severity !== 'high' && v.severity !== 'critical') continue;
    for (const via of v.via ?? []) {
      if (typeof via !== 'object' || !via.url) continue;
      const id = via.url.split('/').pop();
      if (!out.has(id)) {
        out.set(id, { id, severity: via.severity ?? v.severity, packages: new Set() });
      }
      out.get(id).packages.add(name);
    }
  }
  return out;
}

/**
 * Copies of `name` that are not the root package under test.
 *
 * Read off the lockfile rather than the audit report on purpose: a nested old
 * copy is wrong whether or not it currently carries an advisory, and reading
 * it from the advisory list would make the check disappear the day upstream
 * patches something. Each hit is confirmed to exist on disk, so a lockfile
 * entry npm chose not to install is not reported as a shipped copy.
 */
function nestedCopies(lock, probeDir, name) {
  return Object.keys(lock.packages ?? {})
    .filter((p) => p !== `node_modules/${name}` && p.endsWith(`node_modules/${name}`))
    .filter((p) => existsSync(path.join(probeDir, p)))
    .map((p) => ({ path: p, version: lock.packages[p]?.version ?? null }));
}

function main() {
  const argv = process.argv.slice(2);
  const targetArg = argv.indexOf('--target');
  const explicitTarget = targetArg !== -1 ? argv[targetArg + 1] : null;

  const scratch = mkdtempSync(path.join(tmpdir(), 'ai-trust-consumer-audit-'));
  const failures = [];
  try {
    let spec = explicitTarget;
    if (!spec) {
      const published = run('npm', ['view', PACKAGE_NAME, 'dist-tags.latest']).trim();
      if (!published) {
        throw new Error(
          `Could not resolve the published latest version of \`${PACKAGE_NAME}\` from the ` +
            'registry, so there is nothing to measure. This is not a pass.'
        );
      }
      spec = `${PACKAGE_NAME}@${published}`;
    }

    const repoVersion = JSON.parse(readFileSync(path.join(REPO_ROOT, 'package.json'), 'utf8')).version;
    console.log(`Target (what a user installs today): ${spec}`);
    console.log(`This checkout is at ${repoVersion}. The two are audited separately and on`);
    console.log('purpose: this job describes the published artifact, not the branch.\n');

    const probeDir = path.join(scratch, 'probe');
    mkdirSync(probeDir, { recursive: true });
    const { report, lock } = auditConsumerTree(spec, probeDir);

    const counts = report.metadata?.vulnerabilities ?? {};
    console.log(
      `Consumer resolution: ${counts.critical ?? 0} critical, ${counts.high ?? 0} high, ` +
        `${counts.moderate ?? 0} moderate, ${counts.low ?? 0} low`
    );
    console.log(
      "(This repo's own lockfile is audited by the `audit` job and reports a different\n" +
        ' number: it includes devDependencies and honours local overrides, neither of\n' +
        ' which reaches a consumer.)\n'
    );

    const found = highAndCritical(report);
    const allowedById = new Map(ALLOWED.map((a) => [a.id, a]));

    // 1. Every high/critical advisory must be allowlisted, and every waiver
    //    that claims something about the environment must re-derive it now.
    for (const adv of found.values()) {
      const allow = allowedById.get(adv.id);
      if (!allow) {
        failures.push(
          `Unlisted ${adv.severity} advisory in the consumer tree: ${adv.id} ` +
            `(via ${[...adv.packages].join(', ')}).\n` +
            `    A user installing this tool inherits it. Either raise the floor to a ` +
            `patched version, drop the dependency, or add it to ALLOWED in ` +
            `${path.relative(REPO_ROOT, SELF)} with a reason a user would accept and a ` +
            `review date.`
        );
        continue;
      }
      // No silent caps: say what was waived, every run.
      console.log(`  allowed  ${adv.id}  ${allow.package}  (review by ${allow.reviewBy})`);
      console.log(`           ${allow.reason.replace(/\s+/g, ' ')}`);
      if (allow.derive) {
        let derived;
        try {
          derived = allow.derive({ probeDir, report, lock });
        } catch (e) {
          failures.push(
            `Allowlist entry ${allow.id} (${allow.package}) could not re-derive its own ` +
              `claim, so it is unverified rather than accepted:\n    ${e.message}`
          );
          console.log('           DERIVED: FAILED — see failures below\n');
          continue;
        }
        console.log('           DERIVED NOW, not asserted:');
        for (const line of derived) console.log(`             - ${line}`);
        console.log('');
      } else {
        console.log('');
      }
    }

    // 2. An allowlist entry that no longer matches is removed, not left to rot.
    for (const allow of ALLOWED) {
      if (found.has(allow.id)) continue;
      failures.push(
        `Stale allowlist entry: ${allow.id} (${allow.package}) is no longer in the consumer ` +
          `tree. Delete it — a waiver nobody rechecks reads the same as a considered one.`
      );
    }

    // 3. Allowlist entries expire.
    const today = new Date().toISOString().slice(0, 10);
    for (const allow of ALLOWED) {
      if (allow.reviewBy >= today) continue;
      failures.push(
        `Allowlist entry ${allow.id} (${allow.package}) passed its review date ` +
          `${allow.reviewBy}. Re-check whether upstream now resolves clean, then either ` +
          `fix it or move the date with a fresh reason.`
      );
    }

    // 4. Forbidden packages, advisory or not — waivable on the same terms.
    for (const forbidden of FORBIDDEN_PACKAGES) {
      const copies = nestedCopies(lock, probeDir, forbidden.name);
      const waiver = forbidden.waiver;

      if (copies.length === 0) {
        if (waiver) {
          failures.push(
            `Stale nested-copy waiver: no nested \`${forbidden.name}\` is in the consumer ` +
              `tree any more. Delete the \`waiver\` block for \`${forbidden.name}\` in ` +
              `${path.relative(REPO_ROOT, SELF)} so the check goes back to unconditional.`
          );
        }
        continue;
      }

      const describe = copies.map((c) => `${c.version ?? '?'} at ${c.path}`).join(', ');
      if (!waiver) {
        failures.push(
          `Nested copy of \`${forbidden.name}\` in the consumer tree: ${describe}.\n` +
            `    ${forbidden.reason.replace(/\s+/g, ' ')}`
        );
        continue;
      }

      const unexpected = copies.filter((c) => !waiver.versions.includes(c.version));
      if (unexpected.length > 0) {
        failures.push(
          `Nested \`${forbidden.name}\` at a version this waiver does not cover: ` +
            `${unexpected.map((c) => `${c.version ?? '?'} at ${c.path}`).join(', ')}. ` +
            `Waived versions are [${waiver.versions.join(', ')}].\n` +
            `    ${forbidden.reason.replace(/\s+/g, ' ')}\n` +
            `    The tree moved without anyone re-reading the waiver. Re-check it.`
        );
        continue;
      }
      if (waiver.reviewBy < today) {
        failures.push(
          `Nested-copy waiver for \`${forbidden.name}\` passed its review date ` +
            `${waiver.reviewBy}. Re-check whether the pin can now be raised, then either ` +
            `fix it or move the date with a fresh reason.`
        );
        continue;
      }
      console.log(`  allowed  nested ${forbidden.name}  (review by ${waiver.reviewBy})`);
      console.log(`           present: ${describe}`);
      console.log(`           ${waiver.reason.replace(/\s+/g, ' ')}\n`);
    }
  } finally {
    rmSync(scratch, { recursive: true, force: true });
  }

  if (failures.length > 0) {
    console.error('\nConsumer-resolution audit FAILED:\n');
    for (const f of failures) console.error(`  - ${f}\n`);
    process.exit(1);
  }
  console.log('Consumer-resolution audit passed.');
}

main();
