#!/usr/bin/env node
/**
 * Build-tree advisory gate — this repo's committed lockfile.
 *
 * ## Which artifact this measures, and why it is a real one
 *
 * Not the tree a user resolves (that is `audit-consumer-resolution.mjs`).
 * This is the tree `npm ci` installs on our CI runners and maintainer
 * machines. It matters on its own terms because `release.yml`'s publish job
 * runs `npm ci` — executing every dependency's install script — in the same
 * job that holds `id-token: write` and runs `npm publish --provenance`. That
 * is the tree an attacker would use to alter what we publish, and nothing
 * else in this repo measures it.
 *
 * ## Why this is not a plain `npm audit --audit-level=high`
 *
 * It used to be, and it sat red for weeks over a single advisory that had
 * already been formally accepted for the shipped artifact — with a dated
 * waiver and a live re-derivation — while this gate could only report a
 * number. A count cannot distinguish "new and unexamined" from "known and
 * adjudicated"; it reported both as the same red, so the red stopped carrying
 * information and the job was excluded from its own schedule for being
 * permanently red.
 *
 * So the assertion changed shape, NOT strictness:
 *
 *   before   high/critical advisory count is zero
 *   after    high/critical advisory ids, MINUS the ids already accepted for
 *            the shipped artifact, is empty
 *
 * The severity threshold is unchanged. There is no `|| true`, no
 * `continue-on-error`, no suppression flag, and no way to pass by lowering
 * anything. A new high advisory fails this gate on the run it appears.
 *
 * ## The one-way coupling
 *
 * Acceptances are read from `lib/accepted-advisories.mjs`, the same list the
 * consumer gate enforces. An id can be waived here only BECAUSE it is already
 * accepted for users. The reverse is deliberately not possible: there is no
 * build-tree-only waiver mechanism, and adding one would mean suppressing a
 * finding in the tree that publishes our artifacts without having accepted it
 * for the people who install them.
 *
 * This gate deliberately does NOT run each entry's `derive()`. Those
 * derivations reason about a consumer's installed tree across six platforms;
 * printing that here would label a consumer measurement as a build-tree one.
 * What this gate enforces is the two rules it can evaluate honestly:
 *
 *   1. an unlisted high/critical advisory fails
 *   2. an expired `reviewBy` fails
 *
 * Rule 2 is why an acceptance cannot quietly become permanent. It is shared
 * with the consumer gate, so an expiry fails both.
 *
 * Staleness (an entry no longer matching anything) is intentionally NOT
 * checked here. The two trees may legitimately diverge, and a shared
 * staleness rule would let either tree fail the other's waiver.
 */
import { execFileSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { ACCEPTED_ADVISORIES } from './lib/accepted-advisories.mjs';

const SELF = fileURLToPath(import.meta.url);
const REPO_ROOT = path.resolve(path.dirname(SELF), '..');

/**
 * High and critical advisories in the build tree, keyed by GHSA id.
 *
 * Same extraction shape as the consumer gate's `highAndCritical`, so the two
 * gates cannot disagree about what counts as an advisory or which id names it.
 */
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
 * `npm audit --package-lock-only --json` against the committed lockfile.
 *
 * `--package-lock-only` installs nothing, so no dependency's install script
 * runs. This job triggers on `pull_request`, which includes forks, and a job
 * that installs a fork's branch executes whatever that branch put in a
 * `postinstall` — least acceptable in the CI of a supply-chain tool.
 *
 * npm exits non-zero when it finds anything at or above the audit level, so a
 * non-zero exit here is expected and is not itself the verdict. What matters
 * is whether the report parses: an unparseable report is "we could not check",
 * which must never present as "we checked and it was fine".
 */
function auditReport() {
  let raw;
  try {
    raw = execFileSync('npm', ['audit', '--package-lock-only', '--json'], {
      cwd: REPO_ROOT,
      encoding: 'utf8',
      maxBuffer: 64 * 1024 * 1024,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
  } catch (e) {
    // Non-zero exit is normal when advisories exist; the payload is on stdout.
    raw = e.stdout;
  }
  if (!raw || !raw.trim()) {
    throw new Error(
      'npm audit produced no output, so the build tree is unmeasured. ' +
        'Refusing to report a pass on a check that did not run.'
    );
  }
  try {
    return JSON.parse(raw);
  } catch {
    throw new Error(
      'npm audit output could not be parsed as JSON, so the build tree is ' +
        'unmeasured. Refusing to report a pass on a check that did not run.'
    );
  }
}

function main() {
  console.log('[BUILD TREE] The lockfile this repo installs on CI and dev machines.');
  console.log('[BUILD TREE] Not the tree a user resolves — that is the consumer audit.\n');

  const report = auditReport();
  const totals = report.metadata?.vulnerabilities ?? {};
  console.log(
    `Build tree: ${totals.critical ?? 0} critical, ${totals.high ?? 0} high, ` +
      `${totals.moderate ?? 0} moderate, ${totals.low ?? 0} low`
  );
  console.log(
    '(Moderate and low are reported, never gated: an advisory below the ' +
      'threshold\n blocking unrelated work costs more than it buys. The ' +
      'informational steps\n in the workflow print them in full.)\n'
  );

  const found = highAndCritical(report);
  const acceptedById = new Map(ACCEPTED_ADVISORIES.map((a) => [a.id, a]));
  const failures = [];

  // 1. Every high/critical advisory must already be accepted for the shipped
  //    artifact. Unlisted is a failure — this is the whole gate.
  for (const adv of found.values()) {
    const accepted = acceptedById.get(adv.id);
    if (!accepted) {
      failures.push(
        `Unlisted ${adv.severity} advisory in the build tree: ${adv.id} ` +
          `(via ${[...adv.packages].join(', ')}).\n` +
          `    This tree is installed by the job that publishes with provenance. ` +
          `Either refresh the lockfile to a patched version (\`npm audit fix ` +
          `--package-lock-only\` — not \`--dry-run\`, which reports no change ` +
          `against this tree), raise the dependency, or — only if it is also ` +
          `accepted for the shipped artifact — add it to ACCEPTED_ADVISORIES in ` +
          `${path.relative(REPO_ROOT, path.join(REPO_ROOT, 'scripts/lib/accepted-advisories.mjs'))}.`
      );
      continue;
    }
    // No silent caps: say what was waived, every run.
    console.log(`  accepted  ${adv.id}  ${accepted.package}  (review by ${accepted.reviewBy})`);
    console.log(`            ${accepted.reason.replace(/\s+/g, ' ')}`);
    if (accepted.buildTreeNote) {
      console.log(`            BUILD TREE: ${accepted.buildTreeNote.replace(/\s+/g, ' ')}`);
    }
    console.log('');
  }

  // 2. Acceptances expire. Shared with the consumer gate, so an expired date
  //    fails both — which is the forcing function, not a formality.
  const today = new Date().toISOString().slice(0, 10);
  for (const accepted of ACCEPTED_ADVISORIES) {
    if (accepted.reviewBy >= today) continue;
    failures.push(
      `Accepted advisory ${accepted.id} (${accepted.package}) passed its review date ` +
        `${accepted.reviewBy}. Re-check whether upstream now resolves clean, then either ` +
        `fix it or move the date with a fresh reason.`
    );
  }

  if (failures.length > 0) {
    console.error('\n[BUILD TREE] Build-tree audit FAILED:\n');
    for (const f of failures) console.error(`  - ${f}\n`);
    process.exit(1);
  }

  console.log('[BUILD TREE] Build-tree audit passed (ai-trust).');
}

main();
