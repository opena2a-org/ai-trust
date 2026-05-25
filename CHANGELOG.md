# Changelog

## 0.7.3 (2026-05-25)

### Fixed

- **`check pip:<pkg>` now strips the prefix and reports `ecosystem: "pypi"` ([#50](https://github.com/opena2a-org/ai-trust/issues/50)).** Prior to this release, `ai-trust check pip:anthropic --no-scan --json` returned `name: "pip:anthropic"` (kept the prefix verbatim) and `ecosystem: "npm"` (wrong). The Registry stores packages by canonical name, so the prefixed query never matched any indexed PyPI package: ai-trust's PyPI no-scan flow was effectively broken for the Registry's entire PyPI corpus. New behavior: the `pip:` prefix is stripped before the Registry query, and ecosystem flows through every not-found / scan-path output site. `check pip:anthropic --no-scan --json` now resolves the real `anthropic` record (`packageType: "ai_tool"`, full trust data). The fix also adds an explicit `npm:` prefix for symmetry. Discovered while building the 3-way PyPI parity fixture at `opena2a-standards/opena2a-parity` (the fixture was blocked on this bug).

### Added

- `parsePackageTarget()` helper in `src/utils/resolve.ts`. Mirrors the prefix convention `src/utils/parser.ts` already uses for dependency files (requirements.txt to pypi, package.json to npm). 6 unit tests cover pip:/npm:/no-prefix/edge cases (bare `pip:`, colons in scoped names, unrecognized prefixes like `pypi:` left alone).

### Threading

- `handleScanFlow` and `handleNoScanNotFound` both take `ecosystem` as a parameter; 7 hardcoded `ecosystem: "npm"` call sites in `src/commands/check.ts` now consume the parsed value. `handleNotFound` (currently unreferenced dead code) also threaded for hygiene, marked with a kept-for-future comment.

## 0.7.2 (2026-05-24)

### Changed
- **Telemetry dispatcher passes `semanticSuccessCodes: [2]` to `successFromExitCode`.** Per [CHIEF-CSR-018] + [CHIEF-CPO-022] (`briefs/cli-telemetry-success-semantics.md`), invocation telemetry's `success` field follows crash-rate semantics: ai-trust's exit code 2 means "I checked, the package isn't in the registry" — a working outcome, not a crash. The previous dispatcher mis-labeled these as `success: false`, producing a 50% "failure" rate on `ai-trust audit` in the `/admin/cli-usage` rollup over the prior 60 days even though the real crash rate was near 0%. With this release, the dashboard signal reflects actual reliability. Public CLI exit-code contract is unchanged — `check`, `audit`, and `batch` still exit 2 for not-found, exit 1 for below-threshold, exit 0 for clean.

### Pinned
- `@opena2a/telemetry` bumped from `0.2.0` to `0.3.0` (exact). 0.3.0 adds the optional `semanticSuccessCodes` argument; the bump unlocks the dispatcher change above.

### Brief
- opena2a-org/briefs/cli-telemetry-success-semantics.md

## 0.7.0 (2026-04-27)

### Added
- **`check skill:<name>` and `check mcp:<name>` rich-context block.** Mirrors `hackmyagent check`'s rich block from cli-ui 0.5.0 — header with verdict + score + scan-age, hardcoded-secrets section with rotation guidance, "What is this skill?" / MCP narrative block, deterministic verdict reasoning, threat-model questions, action gradient. Same UX across all three CLIs (parity F12 / F13). Falls through to the existing AI-classifier flow when the registry has no fresh narrative.
- **Tier-1 anonymous usage telemetry.** Default ON; opt-out via `OPENA2A_TELEMETRY=off` or `ai-trust telemetry off`. Tracks command name, success/failure, duration. No package names, no scan content. Mirrors the pattern shipped in `hackmyagent` and `opena2a-cli`. Disclosure: `--version`, `telemetry status`, README, opena2a.org/telemetry.
- **`telemetry [on|off|status]` subcommand** to inspect or toggle anonymous usage telemetry.

### Fixed
- **AI-TRUST-1: Tier 3 library renders out-of-scope only.** Per `CLAUDE.md` v0.3 "UX philosophy", libraries get the redirect to HMA without a trust block on top. Earlier behavior surfaced `formatCheckResult` AND the out-of-scope CTA, which on errored library scans showed "Scan failed — score is unreliable" stacked on "Out of scope for ai-trust" — two unrelated messages competing. The full trust read for libraries lives in `hackmyagent check`.

### Policy
- **Silent post-consent rule** (`briefs/scan-result-telemetry-policy.md` §5). Once the user has opted in to scan contribution, the act of contributing is invisible — no per-scan banner, no "queued for registry" line. ai-trust currently emits no per-scan contribution prints; this release locks that behavior in by policy. Disclosure lives in the initial consent prompt, `--help`, and the privacy policy.

### Pinned
- `@opena2a/cli-ui` exact-pinned at `0.5.0` (was `0.3.0`). Required for `renderCheckRichBlock` + sub-block primitives.
- `@opena2a/telemetry` added at `^0.1.2`.

### Brief
- opena2a-org/briefs/check-rich-context-skills-mcp-v1.md (§3, §8)
- opena2a-org/briefs/scan-result-telemetry-policy.md

## 0.6.0 (2026-04-27)

### Changed
- **`@opena2a/check-core` exact-pinned at `0.2.0`** (was `0.1.0`). Ride-along consume — ai-trust does not yet render the rich-context narrative block (that lands with `cli-ui@0.4.0` in session 3 of `briefs/check-rich-context-skills-mcp-v1.md`). Bumping the pin keeps ai-trust on the same data-layer version as `hackmyagent@0.20.0` and prevents check-core 0.1.0 from being silently retained as a transitive dep.
- **Round 2 `buildNotFoundOutput` adoption (was queued in 0.5.1).** Bundles the five not-found path migrations into the 0.6.0 release window per the `[CA-034] round 2` queueing decision, which held the standalone publish until partner work surfaced. Partner work is the check-core 0.2.0 consume above.

### Brief
- opena2a-org/briefs/check-rich-context-skills-mcp-v1.md (§8 task 2f, "round 2 PRs ride along")

## 0.5.1 (2026-04-22)

### Changed
- **`check --json` not-found paths now emit the canonical `NotFoundOutput` shape from `@opena2a/check-core`.** Five inline `formatJson({name, found: false, ...})` emit sites in `src/commands/check.ts` (registry error, non-TTY registry miss, translated download error, generic scan error, `--no-scan` miss) all flow through `buildNotFoundOutput({name, ecosystem, error, errorHint?, suggestions?, nextSteps?})`. `nextSteps` preserved on the `--scan-if-missing` CTA paths. Closes the data-layer half of the F2 (not-found shape) and F3 (git-style miss) parity fixtures in opena2a-parity (companion to hackmyagent 0.19.1).

### Fixed
- The translated download error path previously emitted `hint: ...` instead of `errorHint: ...` — corrected to match the shared `NotFoundOutput` schema.

## 0.5.0 (2026-04-22)

### Changed
- **`check` happy-path consumes `@opena2a/check-core@0.1.0` primitives (exact pin).** `translateDownloadError` + `mapScanStatusForMeter` move to the shared package; local copies deleted. ai-trust, hackmyagent, and opena2a-cli now share one implementation for the registered-package `--json` shape — the F1 parity fixture in opena2a-parity is byte-identical across all three (CA-034 M3).

## 0.4.0 (2026-04-23)

### Changed
- **`ai-trust check <pkg>` now consumes `@opena2a/cli-ui@0.3.0` (exact pin).** Rendering of registered packages, package-not-found results, and the Next Steps block flows through shared primitives (`renderCheckBlock`, `renderNotFoundBlock`, `renderNextSteps`) per CA-034 M2 Day-2. Closes F5 (divergent output schemas), F6 (meter suppressed on unscanned packages — "a number implies measurement"), and F7 (Next Steps CTAs diverged) from `briefs/check-command-divergence.md`. Trust-level legend is always shown inline on the Level row so users see the full scale next to where their package sits.

### Fixed
- **Git-style package names no longer leak raw `code 128` (F3).** `ai-trust check anthropic/code-review` previously surfaced the raw git exit code when `npm pack` fell through to git. The error is now translated into a shared not-found block with a "did you mean '@anthropic/code-review'?" hint.
- **`--no-scan` package-not-found output matches the same shared block** emitted by scan-flow failures (F2). All not-found shapes share one renderer.

## 0.3.1 (2026-04-22)

### Changed
- **Trust queries route through `@opena2a/registry-client@0.1.0` (exact pin).** The inline `src/api/client.ts` was deleted; all trust lookups now flow through the shared package (published with SLSA v1 provenance). Identical trust-lookup implementation with hackmyagent and opena2a-cli — any client-side fix lands in one place. Per CA-034 M1. No user-visible output change; registry returns the same canonical trust levels either way.

## 0.2.3 (2026-03-18)

### Added
- Next steps section after `check`, `audit`, and `batch` commands with contextual recommendations
- Trust level legend shown for non-Verified packages

### Changed
- Help description updated to "Check security trust scores for AI agents and MCP servers before installing them"

## 0.2.2 (2026-03-16)

### Fixed
- Trust score now displays as `47/100` instead of raw decimal `0.47` for consistency with opena2a CLI

## 0.2.1 (2026-03-15)

### Added
- **Community contribution telemetry**: Anonymized scan findings (check pass/fail and severity only) can be shared with the OpenA2A Registry. Prompts on first scan; choice is saved to `~/.opena2a/config.json` and shared across all OpenA2A tools.
- **Attack taxonomy context**: Scan findings now display their attack class when available from HMA.
- **Scan on demand**: `check --scan-if-missing`, `check --rescan`, `audit --scan-missing` download packages and scan locally with HackMyAgent when not in the registry.
- `--contribute` flag on `check` and `audit` commands for non-interactive contribution in CI.

### Changed
- Exit code 2 now signals policy violations (warning/blocked verdicts, below `--min-trust` threshold). Exit code 1 is reserved for operational errors (network failures, missing files).
- `audit` errors now output JSON on stdout when `--json` is set, matching `check` behavior.

### Fixed
- Contribution endpoint updated from non-existent `/api/v1/trust/publish` to the working `/api/v1/telemetry/scan`.

## 0.1.3 (2026-03-12)

### Added
- Initial release with `check`, `audit`, and `batch` commands.
- OpenA2A Registry trust graph queries.
- MCP package name shorthand resolution.
- Dependency file parsing (package.json, requirements.txt).
- JSON output mode for CI/CD integration.
