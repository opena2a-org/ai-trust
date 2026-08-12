/**
 * Advisories this repo has formally accepted, and the ONLY place an acceptance
 * is recorded.
 *
 * Two gates consume this list, and they measure two different artifacts:
 *
 *   `audit-consumer-resolution.mjs`  the tree a USER resolves from the
 *                                    published tarball. It attaches a
 *                                    `derive()` to each entry and re-measures
 *                                    the environment-dependent half on every
 *                                    run.
 *   `audit-build-tree.mjs`           the lockfile THIS REPO installs on CI
 *                                    runners and maintainer machines.
 *
 * ## Why the list is shared, and why the coupling only runs one way
 *
 * An advisory that reaches both trees was previously accepted in one file and
 * left permanently red in the other, which is the banned "red and tolerated"
 * gate state: a job that is always red carries no differential signal, and the
 * next real finding lands in a job everyone has learned to ignore.
 *
 * The coupling is deliberately ONE-WAY. An id may be waived in the build tree
 * only BECAUSE it is already accepted for the shipped artifact — that is why
 * both gates read this one list rather than keeping two. The reverse must
 * never be built: nothing here may exist to suppress a build-tree finding that
 * we have not already accepted for users. If you find yourself wanting an
 * entry that the consumer gate does not also enforce, that is the signal to
 * stop and route it, not to add a field.
 *
 * ## Why `derive` is NOT here
 *
 * `derive` reasons about a consumer's INSTALLED tree across six platforms.
 * Running it from the build-tree gate would print a consumer measurement
 * inside a build-tree result and label it as that gate's own — the precise
 * confusion the two-job split exists to prevent. So `derive` stays in
 * `audit-consumer-resolution.mjs`, attached by id, and the build-tree gate
 * enforces only the two rules it can honestly evaluate: an unlisted advisory
 * fails, and an expired `reviewBy` fails.
 *
 * ## Why this module has no side effects
 *
 * `audit-consumer-resolution.mjs` ends in a bare `main();` and exports
 * nothing, so importing the list FROM it would run a full network install as
 * an import side effect. The data lives here instead, and this file must stay
 * free of imports, I/O and top-level statements other than the export.
 *
 * ## What an entry has to survive
 *
 * A reader asking "why is my audit red because of your CLI". So `reason`
 * names the blocker, not the severity, and must not restate anything a
 * `derive` can compute — a prose claim about the environment was wrong in our
 * favour once and stayed wrong for weeks because prose is never re-evaluated.
 * Dates expire, and an expired date fails BOTH gates.
 */
export const ACCEPTED_ADVISORIES = [
  {
    id: 'GHSA-xcpc-8h2w-3j85',
    package: 'adm-zip',
    reviewBy: '2026-11-01',
    reason:
      'adm-zip <0.6.0, reached only through onnxruntime-node, which hackmyagent needs ' +
      'for local NanoMind inference and which ai-trust inherits by depending on ' +
      'hackmyagent. There is no stable version of onnxruntime-node that resolves ' +
      'clean: it pins adm-zip inside a caret on 0.5.x and the patched release is ' +
      '0.6.0, outside that caret. An `overrides` block does not help — overrides are ' +
      'applied only to the tree that declares them and are not carried in a published ' +
      'tarball, so a consumer resolves the vulnerable version regardless of what this ' +
      'repo pins. Removing the dependency means removing local inference from ' +
      'hackmyagent, which is a decision for that package, not this one. Whether any ' +
      'admissible version of adm-zip is now patched is RE-DERIVED BY THE CONSUMER GATE ' +
      'against the live registry on every run rather than claimed here; when the answer ' +
      'becomes yes, that derivation fails and the remedy is to raise the resolution, ' +
      'not to re-date this. Blast radius is availability-only and install-time; the ' +
      'concrete per-platform reachability is likewise re-derived there on every run ' +
      'rather than asserted here, because the last time that claim was written as prose ' +
      'it was wrong in our favour and stayed wrong for weeks.',

    /**
     * The build tree's reachability is DIFFERENT from a consumer's, and worse.
     * It gets its own sentence because accepting it under a consumer-shaped
     * reason would be exactly the prose drift this file warns about.
     */
    buildTreeNote:
      'In the build tree this is not the low-reachability case it is for most ' +
      'consumers. Of the six platforms onnxruntime-node ships install manifests for, ' +
      'linux/x64 is the ONLY one whose postinstall actually downloads and parses an ' +
      'archive with adm-zip — and linux/x64 is what our CI runs. Accepted at ' +
      'install-time availability impact only. It is NOT clearance for the fetch-and- ' +
      'execute path underneath it: that postinstall retrieves a native binary with no ' +
      'signature or checksum check, which is tracked separately and is a strictly ' +
      'stronger problem than this advisory.',
  },
];
