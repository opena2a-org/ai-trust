/**
 * Deprecated packages in the tree a consumer resolves.
 *
 * When a publisher deprecates a version, the registry serves its manifest with
 * a `deprecated` field holding the notice. npm reads that field while it
 * resolves a tree, writes the notice into the package's lockfile entry, and
 * prints it on stderr while installing, as
 *
 *   npm warn deprecated <name>@<version>: <first line of the notice>
 *   npm warn deprecated   <each further line of the notice>
 *
 * A user who runs `npx ai-trust` installs it first, so the notice is the first
 * thing they read. The published `ai-trust@0.7.6` resolved `hackmyagent@0.23.11`
 * and, under it, `hackmyagent@0.17.11`, both deprecated with a four-line
 * notice: a clean install printed eight `npm warn deprecated` lines before
 * ai-trust printed anything.
 *
 * The measurement is the lockfile npm wrote in the probe: a `deprecated` field
 * on an entry means the registry carried the notice when npm resolved that
 * version, and `npm view <name>@<version> deprecated` prints the same text. The
 * install's stderr is read as well, so the count a user sees is reported and a
 * notice npm printed is never missed.
 *
 * These are pure functions over the probe's lockfile and the install's stderr,
 * so the decision is testable without a network install. The gate script ends
 * in a bare `main();` and exports nothing, so the logic lives here, next to
 * `accepted-advisories.mjs`, and the gate imports it.
 */

/** The package a lockfile path names: the segment after its last `node_modules/`. */
export function packageNameOf(lockPath) {
  const marker = 'node_modules/';
  const at = lockPath.lastIndexOf(marker);
  return at === -1 ? lockPath : lockPath.slice(at + marker.length);
}

/**
 * Every entry below the root whose lockfile record carries a deprecation
 * notice, in lockfile order.
 *
 * The root (`""`) is the probe's own manifest and is skipped. An aliased
 * install records the real package under `name`, and that is the name
 * `npm view` needs, so it wins over the path. An entry whose `deprecated`
 * field is not a non-empty string carries no notice.
 */
export function deprecatedResolutions(lock) {
  const found = [];
  for (const [lockPath, entry] of Object.entries(lock?.packages ?? {})) {
    if (lockPath === '') continue;
    const notice = entry?.deprecated;
    if (typeof notice !== 'string' || notice.trim() === '') continue;
    found.push({
      path: lockPath,
      name: typeof entry.name === 'string' && entry.name !== '' ? entry.name : packageNameOf(lockPath),
      version: typeof entry.version === 'string' ? entry.version : null,
      notice,
    });
  }
  return found;
}

const WARN_LINE = /^npm warn deprecated\b/i;
const WARN_SPEC = /^npm warn deprecated ((?:@[^/\s]+\/)?[^@\s]+)@([^\s:]+):/i;

/**
 * The `npm warn deprecated` lines in an install's stderr.
 *
 * `lines` counts them all, continuation lines included, which is the number a
 * user reads. `packages` lists each `name@version` a notice's first line
 * names, once, in the order npm printed them.
 */
export function deprecationWarnings(stderr) {
  let lines = 0;
  const packages = [];
  const seen = new Set();
  for (const line of String(stderr ?? '').split(/\r?\n/)) {
    if (!WARN_LINE.test(line)) continue;
    lines += 1;
    const spec = WARN_SPEC.exec(line);
    if (!spec) continue;
    const key = `${spec[1]}@${spec[2]}`;
    if (seen.has(key)) continue;
    seen.add(key);
    packages.push({ name: spec[1], version: spec[2] });
  }
  return { lines, packages };
}

function firstLine(notice) {
  return notice.split(/\r?\n/)[0].trim();
}

function describeCopies(copies) {
  return copies
    .map((c) => (c.path ? `${c.version ?? '?'} at ${c.path}` : `${c.version ?? '?'} (warned on install, not in the lockfile)`))
    .join(', ');
}

/**
 * Judge the findings against the waivers, on the terms the gate applies to a
 * nested copy: a package with no waiver fails, a copy at a version the waiver
 * does not name fails, a waiver that matches nothing fails, and a waiver past
 * its review date fails. A package npm warned about that the lockfile does not
 * record is judged as a finding too, so nothing a user saw is dropped.
 *
 * `found` is `deprecatedResolutions()`, `warned` is `deprecationWarnings()`,
 * `today` is an ISO date, `scriptRef` is how the gate names itself in a
 * message. Returns the failure messages and the log lines for waived packages.
 */
export function judgeDeprecations({ found, warned, waivers = [], today, scriptRef }) {
  const failures = [];
  const log = [];

  const byName = new Map();
  for (const copy of found) {
    if (!byName.has(copy.name)) byName.set(copy.name, []);
    byName.get(copy.name).push(copy);
  }
  for (const warnedPkg of warned?.packages ?? []) {
    const recorded = (byName.get(warnedPkg.name) ?? []).some((c) => c.version === warnedPkg.version);
    if (recorded) continue;
    if (!byName.has(warnedPkg.name)) byName.set(warnedPkg.name, []);
    byName.get(warnedPkg.name).push({ path: null, name: warnedPkg.name, version: warnedPkg.version, notice: '' });
  }

  const waiverFor = new Map(waivers.map((w) => [w.name, w]));

  for (const [name, copies] of byName) {
    const waiver = waiverFor.get(name);
    const describe = describeCopies(copies);
    const notice = copies.map((c) => firstLine(c.notice)).find((line) => line !== '') ?? '(notice not captured)';
    const version = copies[0].version ?? '<version>';

    if (!waiver) {
      failures.push(
        `Deprecated package in the consumer tree: \`${name}\` ${describe}.\n` +
          `    npm prints its notice while installing, before ai-trust prints anything: "${notice}"\n` +
          `    Raise the resolution to a version for which \`npm view ${name}@${version} deprecated\` ` +
          `prints nothing, drop the dependency, or add a dated waiver to DEPRECATION_WAIVERS in ` +
          `${scriptRef} with a reason a user would accept.`
      );
      continue;
    }

    const uncovered = copies.filter((c) => !waiver.versions.includes(c.version));
    if (uncovered.length > 0) {
      failures.push(
        `Deprecated \`${name}\` at a version its waiver does not cover: ${describeCopies(uncovered)}. ` +
          `Waived versions are [${waiver.versions.join(', ')}].\n` +
          `    ${waiver.reason.replace(/\s+/g, ' ')}\n` +
          `    The tree moved without anyone re-reading the waiver. Re-check it.`
      );
      continue;
    }
    if (waiver.reviewBy < today) {
      failures.push(
        `Deprecation waiver for \`${name}\` passed its review date ${waiver.reviewBy}. ` +
          `Re-check whether the resolution can now be raised, then either fix it or move the ` +
          `date with a fresh reason.`
      );
      continue;
    }
    log.push(`  allowed  deprecated ${name}  (review by ${waiver.reviewBy})`);
    log.push(`           present: ${describe}`);
    log.push(`           ${waiver.reason.replace(/\s+/g, ' ')}`);
    log.push('');
  }

  for (const waiver of waivers) {
    if (byName.has(waiver.name)) continue;
    failures.push(
      `Stale deprecation waiver: no deprecated \`${waiver.name}\` is in the consumer tree any ` +
        `more. Delete its entry in DEPRECATION_WAIVERS in ${scriptRef} so the check goes back to ` +
        `unconditional.`
    );
  }

  return { failures, log };
}
