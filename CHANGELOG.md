# Changelog

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
