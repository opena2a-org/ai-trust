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
];
