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
 * ## The two artifacts, and why both are measured
 *
 * The rule above cuts both ways, and the first version of this script failed
 * its own test. It defaulted to the published `ai-trust@<latest>` and the
 * workflow passed no `--target`, so on a pull request it measured the
 * ALREADY-PUBLISHED package. It therefore could not fail on the PR's own diff:
 * a PR adding a vulnerable dependency went green, because the gate was looking
 * at npm rather than at what the PR would publish. A gate that cannot fail on
 * the change under review is not gating the change under review.
 *
 * So there are two runs, asking two genuinely different questions:
 *
 *   CANDIDATE  (`--target <tarball>`, wired to pull_request, push and release)
 *     "Would the tree a user resolves from THIS BRANCH carry an advisory?"
 *     The workflow runs `npm pack` and points the gate at the resulting
 *     tarball. This is the run that can fail on a diff, it is the one that has
 *     to be green before a change lands, and it is the one that blocks a
 *     release before `npm publish` rather than after.
 *
 *   PUBLISHED  (default `ai-trust@<latest dist-tag>`, wired to the schedule)
 *     "Has the tree users already installed drifted into an advisory?"
 *     Nothing here has to change for that answer to flip — an advisory
 *     published against an untouched transitive dependency does it — so it is
 *     asked on a timer rather than on a diff. A PR cannot turn this one green;
 *     only a release can, which is when users stop being affected.
 *
 * Both print their mode in the banner and in the closing line, because the two
 * numbers are not comparable and a reader has to be able to tell which tree a
 * given failure describes.
 *
 * ## Why it installs, and what that means for fork-safety
 *
 * `hackmyagent`'s sibling of this script resolves `--package-lock-only` so
 * nothing is fetched. This one performs a real install, because the waiver
 * below re-derives its reachability claim from the installed dependency's own
 * metadata files, and you cannot read files that were never downloaded.
 *
 * What holds in both modes:
 *   - `--ignore-scripts` on the install, so no dependency's `postinstall`
 *     executes;
 *   - nothing from the target is executed or imported by this script. It is
 *     unpacked, its manifests are read as TEXT, and that is all.
 *
 * In CANDIDATE mode the tarball is built from the branch under test, so the
 * older claim that "nothing from the PR's tree enters the scratch directory"
 * no longer holds and is not made here. What replaces it: the branch's files
 * are unpacked but never run, and the workflow packs with `--ignore-scripts`
 * so the branch's own `prepack`/`prepare` hooks do not execute either. The
 * workflow also does not build first, deliberately — what decides whether a
 * user inherits an advisory is the manifest's dependency closure, which
 * `npm pack` carries whether or not `dist/` was compiled, so building would
 * buy no measurement and would cost arbitrary code execution from a fork.
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
import { ACCEPTED_ADVISORIES } from './lib/accepted-advisories.mjs';

const SELF = fileURLToPath(import.meta.url);
const REPO_ROOT = path.resolve(path.dirname(SELF), '..');
const PACKAGE_NAME = JSON.parse(readFileSync(path.join(REPO_ROOT, 'package.json'), 'utf8')).name;

/**
 * Environment-dependent re-derivations, attached by advisory id.
 *
 * The acceptance itself — id, package, reason, review date — lives in
 * `lib/accepted-advisories.mjs`, because the build-tree gate consumes the same
 * acceptance and must not import from this file (it ends in a bare `main();`,
 * so importing it would run a full network install as a side effect).
 *
 * What stays HERE is the half that only makes sense against a consumer's
 * installed tree. `ALLOWED` is then assembled from the shared list below, so
 * an advisory cannot be accepted for the build tree without this gate also
 * enforcing it — that is the one-way coupling, made structural rather than
 * documented.
 */
const DERIVATIONS = {
  'GHSA-xcpc-8h2w-3j85': {
    /**
     * Re-derive the reachability claim from onnxruntime-node's own install
     * metadata in the installed tree. Throws — failing the gate — if the
     * package, its metadata, or its shape cannot be read, because "we could
     * not check" must never present as "we checked and it was fine".
     */
    derive({ probeDir, report }) {
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
      // Anchored at column 0, with no leading-whitespace tolerance. The claim
      // being made is "required unconditionally at module load"; a require
      // indented inside a function or an `if` is a CONDITIONAL require, which
      // is a different and weaker claim. The previous `^\s*` let an indented
      // load site satisfy an unconditional conclusion.
      const utils = readFileSync(utilsPath, 'utf8');
      const loadSite = utils
        .split('\n')
        .findIndex((l) => /^(?:const|let|var|import)\b.*\brequire\(['"]adm-zip['"]\)/.test(l));
      if (loadSite === -1) {
        // Previously this printed "NO — verify by hand, the load site moved"
        // and passed. A derivation that reports it could not reach its
        // conclusion, and then lets the gate go green anyway, is the same
        // unchecked-prose failure in a different costume.
        throw new Error(
          `onnxruntime-node@${pkg.version} no longer requires adm-zip at top level in ` +
            'script/install-utils.js. The load site moved, so the reachability claim this ' +
            'waiver rests on is unmeasured — which is not the same as it holding. Re-read ' +
            'the install path before re-dating this entry.'
        );
      }

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

      // Is a clean version reachable at all? Both halves are measured. The
      // vulnerable range comes out of THIS RUN's audit report, and the set of
      // versions the declared range admits is resolved by npm's semver against
      // the real published version list.
      //
      // This line previously read `pins adm-zip ${admRange} (patched release is
      // 0.6.0)`: a measured value interpolated next to a hardcoded conclusion
      // about it. It would have gone on printing "0.6.0", unchanged and in our
      // favour, after upstream widened the caret or the advisory was revised —
      // the exact prose-drift failure the derive() rule exists to prevent,
      // relocated inside the derivation.
      const vulnRange = vulnerableRange(report, 'adm-zip', 'GHSA-xcpc-8h2w-3j85');
      const admitted = versionsSatisfying('adm-zip', admRange);
      if (admitted.length === 0) {
        // Otherwise "every admitted version is vulnerable" is vacuously true
        // over an empty set, and the waiver would hold on a measurement of
        // nothing — the same defect this derivation exists to prevent.
        throw new Error(
          `no published adm-zip version satisfies onnxruntime-node's declared range ` +
            `"${admRange}", so the claim that none of them is patched is a conclusion about ` +
            'an empty set. The dependency was resolved from somewhere this check cannot ' +
            'see. Not a pass.'
        );
      }
      const vulnerable = new Set(versionsSatisfying('adm-zip', vulnRange));
      const cleanAdmissible = admitted.filter((v) => !vulnerable.has(v));
      if (cleanAdmissible.length > 0) {
        throw new Error(
          `onnxruntime-node@${pkg.version} declares adm-zip "${admRange}", and ` +
            `${cleanAdmissible.length} published version(s) satisfying it now fall OUTSIDE ` +
            `the advisory range "${vulnRange}" (${cleanAdmissible.slice(-3).join(', ')}). ` +
            "A clean resolution is reachable, so this waiver's premise — that no admissible " +
            'version is patched — is false. Raise the resolution instead of re-dating it.'
        );
      }

      return [
        `onnxruntime-node@${pkg.version} pins adm-zip "${admRange}"; this run's audit report ` +
          `gives the advisory range as "${vulnRange}", and all ${admitted.length} published ` +
          'versions satisfying the pin resolve inside it, so no admissible version is clean',
        `adm-zip required at top level (column 0) of script/install-utils.js:${loadSite + 1}, ` +
          'so it is loaded on every platform whenever postinstall runs at all',
        `platforms whose postinstall actually parses an archive: ${parsingPlatforms} of ` +
          `${Object.keys(requirements).length}`,
        ...lines,
      ];
    },
  },
};

/**
 * Advisories accepted in the consumer tree, keyed by GHSA id.
 *
 * An entry is a statement that a user installing this tool gets this advisory
 * and we decided to ship anyway. It has to survive a reader asking "why is my
 * audit red because of your CLI", so `reason` names the blocker, not the
 * severity — and it must not restate anything a `derive` can compute.
 *
 * Built from the shared acceptance list rather than declared here, so the
 * build-tree gate cannot be given an acceptance this gate does not also
 * enforce. An id carrying a derivation gets it attached; one without is still
 * enforced, just without an environment claim to re-check.
 */
const ALLOWED = ACCEPTED_ADVISORIES.map((accepted) => {
  const derivation = DERIVATIONS[accepted.id];
  return derivation ? { ...accepted, ...derivation } : { ...accepted };
});

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

/**
 * Which of the two questions this invocation is answering.
 *
 * Decided from the target rather than from a flag, so the label cannot drift
 * away from the thing actually installed: a target that exists on disk as a
 * tarball is by construction something this repo just built, anything else is
 * resolved from the registry.
 */
function classifyTarget(spec) {
  const asPath = spec.startsWith('file:') ? spec.slice('file:'.length) : spec;
  if (/\.(tgz|tar\.gz)$/i.test(asPath) && existsSync(asPath)) {
    return {
      mode: 'CANDIDATE',
      spec: path.resolve(asPath),
      headline: 'CANDIDATE artifact — the tree a user would resolve from THIS BRANCH',
      question: 'Would publishing this branch ship an advisory to users?',
    };
  }
  return {
    mode: 'PUBLISHED',
    spec,
    headline: 'PUBLISHED artifact — the tree a user resolves from npm right now',
    question: 'Has the already-shipped tree drifted into an advisory since release?',
  };
}

/**
 * The vulnerable range this run's audit report gives for `id` on `pkg`.
 *
 * Read out of the report rather than typed into a waiver, because it is a
 * property of the live advisory and advisories get revised. A waiver that
 * hardcodes "<0.6.0" keeps printing "<0.6.0" after the advisory is widened.
 */
function vulnerableRange(report, pkg, id) {
  const entry = report?.vulnerabilities?.[pkg];
  if (!entry) {
    throw new Error(
      `the audit report has no entry for \`${pkg}\`, so the advisory range for ${id} cannot ` +
        'be read. Not a pass.'
    );
  }
  for (const via of entry.via ?? []) {
    if (typeof via === 'object' && via.url?.endsWith(id) && via.range) return via.range;
  }
  throw new Error(
    `the audit report's entry for \`${pkg}\` names no ${id} advisory carrying a range, so the ` +
      'vulnerable range cannot be measured. Not a pass.'
  );
}

/**
 * Every PUBLISHED version of `name` that `range` admits, resolved by npm.
 *
 * npm's own semver against the real version list, which is the same resolution
 * a consumer's install performs. Doing it this way rather than comparing
 * strings or hand-rolling range arithmetic keeps the answer identical to the
 * one that decides what a user actually gets — a range and a version are not
 * comparable with `===`, and a check that tries silently answers "no" for every
 * range not written as a bare exact version. It also keeps this script
 * dependency-free: the job installs nothing from this repo, so `semver` is not
 * importable here.
 */
function versionsSatisfying(name, range) {
  let raw;
  try {
    raw = run('npm', ['view', `${name}@${range}`, 'version', '--json']);
  } catch (e) {
    const said = `${e.stdout ?? ''}${e.stderr ?? ''}`;
    // "nothing published satisfies this range" is a real, usable answer.
    if (/E404|No match found for version/.test(said)) return [];
    throw new Error(
      `could not resolve "${name}@${range}" against the registry, so the versions it admits ` +
        `are unknown: ${said.trim().slice(0, 200)}`
    );
  }
  let parsed;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new Error(`npm view "${name}@${range}" returned no parseable version list.`);
  }
  // `npm view` returns a bare string when exactly one version matches.
  const versions = (Array.isArray(parsed) ? parsed : [parsed]).filter((v) => typeof v === 'string');
  if (versions.length === 0) {
    throw new Error(`npm view "${name}@${range}" returned no versions in a usable shape.`);
  }
  return versions;
}

/**
 * Assert `npm audit --json` actually returned a MEASUREMENT, and hand back the
 * counts.
 *
 * This is not defensive tidying, it closes a hole that silently inverted the
 * gate. When the advisory database is unreachable, `npm audit --json` exits
 * non-zero but writes VALID JSON to stdout:
 *
 *   {"message":"request to https://registry.npmjs.org/-/npm/v1/security/
 *     advisories/bulk failed, reason: connect ECONNREFUSED","error":{...}}
 *
 * No `vulnerabilities` key, no `metadata`. `JSON.parse` succeeds, every reader
 * below is written `?? {}`, and the run reports "0 critical, 0 high" and
 * passes — so an outage, a proxy, an auth failure or a rate limit all present
 * as a clean tree, which is the single worst direction for this gate to be
 * wrong in.
 *
 * A structure we cannot read a count out of means the tree was not measured,
 * and not measured is not a pass.
 */
function assertMeasurableReport(report, raw) {
  const fail = (why) => {
    const said = (report && typeof report === 'object' && report.message) || raw || '(nothing)';
    throw new Error(
      `npm audit returned no usable report, so the consumer tree was NOT measured: ${why}.\n` +
        '    Unknown is not a pass — an unreachable advisory database otherwise reads as zero ' +
        'vulnerabilities. Check network access to the npm advisory database and re-run.\n' +
        `    npm said: ${String(said).trim().slice(0, 400)}`
    );
  };
  if (!report || typeof report !== 'object' || Array.isArray(report)) fail('not a JSON object');
  if (!report.vulnerabilities || typeof report.vulnerabilities !== 'object') {
    fail('no `vulnerabilities` map — this is exactly the shape an advisory-database failure returns');
  }
  const counts = report.metadata?.vulnerabilities;
  if (!counts || typeof counts !== 'object') fail('no `metadata.vulnerabilities` counts');
  for (const key of ['critical', 'high', 'moderate', 'low', 'total']) {
    if (typeof counts[key] !== 'number') fail(`\`metadata.vulnerabilities.${key}\` is not a number`);
  }
  return counts;
}

/**
 * Assert the tree under test was actually RESOLVED, and say what it resolved to.
 *
 * Everything below reads the lockfile, and every one of those readers treats an
 * absent entry as "nothing to report". So a botched install — a target that
 * resolved to nothing, an `npm install` that half-failed, an empty probe —
 * produces an empty lockfile and a clean, confident, meaningless pass. The
 * liveness facts are therefore asserted before any of them run.
 *
 * The root name is taken from the lockfile rather than parsed out of the target
 * spec, because the spec may be a filesystem path to a tarball, from which the
 * package name cannot be recovered by string surgery.
 */
function assertTreeResolved(lock, probeDir) {
  const rootDeps = lock.packages?.['']?.dependencies ?? {};
  const names = Object.keys(rootDeps);
  if (names.length !== 1) {
    throw new Error(
      `the probe's lockfile records ${names.length} root dependencies ` +
        `(${names.join(', ') || 'none'}) where exactly one was installed. The tree under test ` +
        'was not resolved, so nothing below measured anything. Not a pass.'
    );
  }
  const rootName = names[0];
  const rootEntry = lock.packages[`node_modules/${rootName}`];
  if (!rootEntry?.version) {
    throw new Error(
      `\`${rootName}\` is named as the root dependency but has no node_modules/${rootName} ` +
        'entry in the lockfile, so the target was never resolved. Not a pass.'
    );
  }
  if (!existsSync(path.join(probeDir, 'node_modules', rootName))) {
    throw new Error(
      `the lockfile resolves \`${rootName}\` but node_modules/${rootName} is not on disk, so ` +
        'the install did not complete. Not a pass.'
    );
  }
  const entries = Object.keys(lock.packages).filter((p) => p !== '');
  if (entries.length <= 1) {
    throw new Error(
      `the consumer tree resolved to ${entries.length} package(s) — \`${rootName}\` and nothing ` +
        'below it. This package has production dependencies, so a closure that small means the ' +
        'install did not resolve them rather than that the tree is clean. Not a pass.'
    );
  }
  return { rootName, rootVersion: rootEntry.version, packageCount: entries.length };
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
  // Parseable is not usable, and usable is not resolved. Both are asserted
  // before anything downstream is allowed to read a zero as good news.
  const counts = assertMeasurableReport(report, raw);

  const lockPath = path.join(probeDir, 'package-lock.json');
  if (!existsSync(lockPath)) {
    throw new Error(
      'the probe wrote no package-lock.json, so npm never resolved a tree here and every ' +
        'lockfile-driven check below would report nothing found. Not a pass.'
    );
  }
  const lock = JSON.parse(readFileSync(lockPath, 'utf8'));
  const liveness = assertTreeResolved(lock, probeDir);
  return { report, lock, counts, liveness };
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
  let target = classifyTarget(explicitTarget ?? `${PACKAGE_NAME}@latest`);
  let rootName = '(unresolved)';
  try {
    if (!explicitTarget) {
      // Resolve the dist-tag to a concrete version so the log names the exact
      // artifact measured rather than a label that moves under it.
      const published = run('npm', ['view', PACKAGE_NAME, 'dist-tags.latest']).trim();
      if (!published) {
        throw new Error(
          `Could not resolve the published latest version of \`${PACKAGE_NAME}\` from the ` +
            'registry, so there is nothing to measure. This is not a pass.'
        );
      }
      target = classifyTarget(`${PACKAGE_NAME}@${published}`);
    }
    const spec = target.spec;

    const repoVersion = JSON.parse(readFileSync(path.join(REPO_ROOT, 'package.json'), 'utf8')).version;
    // Which of the two questions this run answers, said before anything else,
    // so a failure in the log is attributable to a tree without reading the
    // workflow that produced it.
    console.log(`[${target.mode}] ${target.headline}`);
    console.log(`[${target.mode}] ${target.question}`);
    console.log(`[${target.mode}] Target: ${spec}`);
    console.log(`[${target.mode}] This checkout is at ${repoVersion}.\n`);

    const probeDir = path.join(scratch, 'probe');
    mkdirSync(probeDir, { recursive: true });
    const { report, lock, counts, liveness } = auditConsumerTree(spec, probeDir);
    rootName = liveness.rootName;

    // Say what was actually measured. In PUBLISHED mode the dist-tag moves, and
    // in CANDIDATE mode a tarball's filename does not have to match what is
    // inside it, so the resolved version is read back off the lockfile or the
    // measurement is unattributable.
    console.log(
      `[${target.mode}] Resolved ${liveness.rootName}@${liveness.rootVersion} — ` +
        `${liveness.packageCount} packages in the production closure\n`
    );

    console.log(
      `Consumer resolution: ${counts.critical ?? 0} critical, ${counts.high ?? 0} high, ` +
        `${counts.moderate ?? 0} moderate, ${counts.low ?? 0} low`
    );
    console.log(
      "(This repo's own lockfile is audited by the `build-tree-audit` job and reports\n" +
        ' a different number: it includes devDependencies and honours local overrides,\n' +
        ' neither of which reaches a consumer.)\n'
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
  } catch (e) {
    // A throw before or during measurement means there IS no measurement.
    // Routed through `failures` rather than left to crash, so it exits in the
    // gate's own failure format instead of a stack trace that reads like a bug
    // in this script — and so it can never be mistaken for a clean run.
    failures.push(
      `The consumer tree was not measured, so this run produced no result:\n    ${e?.message ?? e}`
    );
    if (process.env.CONSUMER_AUDIT_DEBUG) console.error(e?.stack ?? e);
  } finally {
    rmSync(scratch, { recursive: true, force: true });
  }

  if (failures.length > 0) {
    console.error(`\n[${target.mode}] Consumer-resolution audit FAILED — ${target.headline}:\n`);
    for (const f of failures) console.error(`  - ${f}\n`);
    if (target.mode === 'CANDIDATE') {
      console.error(
        '  This is the CANDIDATE run. It measured the tarball this branch would publish, so a\n' +
          '  failure here is about the change under review and is fixable in this branch.\n'
      );
    } else {
      console.error(
        '  This is the PUBLISHED run. It measured what users can install right now, so a\n' +
          '  failure here is NOT fixable by merging — it clears when a fix is released.\n'
      );
    }
    process.exit(1);
  }
  console.log(`[${target.mode}] Consumer-resolution audit passed (${rootName}).`);
}

main();
