# Changelog

## Unreleased

### Security

- **The last accepted advisory is retired by remediation, not by re-dating it, and the acceptance list is now empty.** `GHSA-xcpc-8h2w-3j85` (adm-zip <0.6.0) was accepted for the shipped artifact because `onnxruntime-node` pinned adm-zip inside a caret on 0.5.x while the patched release was 0.6.0, so nothing in this repo could reach it. That is no longer true: `onnxruntime-node@1.29.0` is the current stable and declares `adm-zip: ^0.6.0`, and the pinned `hackmyagent@0.25.0` admits it via `onnxruntime-node: ^1.24.3`. A fresh consumer install therefore already resolved clean while this repo's **committed lockfile** still pinned `onnxruntime-node@1.27.0 -> adm-zip@0.5.18` — so the consumer gate began failing on a stale allowlist entry. That failure was the gate working: the entry's own text pre-registered this exit ("when the answer becomes yes, that derivation fails and the remedy is to raise the resolution, not to re-date this"), and the gate refused to let a lockfile that no longer matched reality stand.
  The remedy is `npm audit fix --package-lock-only`, which moves exactly three packages — `adm-zip 0.5.18 -> 0.6.0`, `onnxruntime-node 1.27.0 -> 1.29.0`, `onnxruntime-common 1.27.0 -> 1.29.0`, every `resolved` on `registry.npmjs.org` — plus deleting the acceptance entry and its now-unreachable `derive`. **No manifest change**: `hackmyagent` stays pinned `0.25.0`, lockfiles are not published, so the published artifact is byte-identical and this is not a release. The two edits are atomic and were proven so: with the refreshed lockfile but the entry still listed, the build-tree gate passes; with the entry deleted but the old lockfile, it fails with "Unlisted high advisory in the build tree". Neither ships alone.
  `ACCEPTED_ADVISORIES` is now empty, which is the healthy steady state rather than dead code — the shared list and its one-way coupling stay exactly as they were, so a future advisory in either tree still fails, a waiver that stops matching still fails as stale, and an expired date still fails. The note below stating this advisory "cannot be fixed in this repo at all" was true when written, when 1.27.0 was the latest stable; it is left in place as history rather than edited, because a changelog records what was believed at the time.
  Not resolved by this, and tracked separately: the unsigned, unchecksummed native-binary fetch in `onnxruntime-node`'s postinstall, which is a strictly stronger problem than the advisory it carried.

- **The release workflow no longer runs third-party install scripts in the job that holds the npm publish identity — and no longer runs them at all.** `release.yml` declared `contents: write` + `id-token: write` at workflow level; the `release` job declared no override, so it inherited both while running `npm ci` — which executes every dependency's install script, including `onnxruntime-node`'s, which downloads a nupkg from `api.nuget.org` and extracts a native `.so` with no signature or checksum check — and then ran `npm publish --provenance` in that same job. Any compromised transitive dependency therefore had code execution alongside the OIDC credential that mints our provenance attestations. Now: the workflow grants nothing (`permissions: {}`) and every job declares its own block, so no job inherits; `build` compiles and tests with **`npm ci --ignore-scripts`** and holds no `id-token`; `publish` holds `id-token: write` and nothing else, does no checkout and no `npm ci`, and publishes the tarball `build` already packed and checksummed (`npm publish <tarball>` fires no lifecycle hooks — every one is gated on `spec.type === 'directory'` in the npm CLI, verified against 11.19.0 source and measured, 0 of 4 hooks fired on a probe); `github-release` is separate so no job holds both the publish identity and repo write. Skipping install scripts was measured, not assumed — build clean, 258 tests pass, `release-smoke:corpus` 9/0 — and cannot change the artifact, since `files` is `["dist","README.md"]` and `dist` is `tsc` output. **The honest limit, because this should not be read as more than it is:** the SLSA predicate records workflow, repo, commit and run — never which *job* produced the bytes — so provenance granularity is the run, not the job. What this removes is OIDC-token exfiltration and attestation-minting over arbitrary content; combined with `--ignore-scripts` it also removes the code execution that could have poisoned `dist/` before packing, which is the content-integrity half.
- **The provenance verification gate could never fail, and has now been made able to.** The step polled `npm view <pkg> dist.attestations --json 2>&1` and treated any non-empty, non-`null`, non-`{}` result as success — but `2>&1` captures stderr, and an `E404` (exactly what registry propagation lag returns, which is the entire reason for the five-minute poll) is a ~740-character non-empty string. Measured against the live registry: the old logic reports "Provenance verified" and exits 0 on the first iteration for a version that does not exist. It now captures stdout only and asserts the shape (`.provenance.predicateType == "https://slsa.dev/provenance/v1"`), proven both ways — it rejects the E404 case and still passes against a genuinely provenanced published version.
- **Three further release-path defects fixed while in there.** Values crossing from the build job into the publish job are passed via `env:` and validated rather than interpolated into `run:` bodies — GitHub expands `${{ }}` into the script text before bash parses it, so a crafted tarball filename (writable by the very install scripts this change is defending against) would have executed as code in the hardened job, handing back the whole attack. `npm publish` now passes `--registry` explicitly, because `publishConfig` inside the tarball's own manifest is flattened into the publish options and `registry` is not otherwise a CLI flag, so a poisoned manifest could redirect the publish. And the publish is now idempotent (skips when the version is already on npm), so a green publish followed by a red verification no longer leaves a re-run permanently stuck and the GitHub release never created. Also added: a tag-vs-manifest-version assert in `build` (failing free, before the irreversible step), and an npm-version floor assert in `publish`, which no longer runs `npm ci` and so cannot assume a recent npm.
- **The build-tree advisory gate is honestly green instead of permanently red, and it measures a set difference rather than a count.** `npm audit --package-lock-only` on the committed lockfile reported 12 vulnerabilities / 8 high. A real `npm audit fix --package-lock-only` (not `--dry-run`, which reports no change against this tree and is a false negative) clears 10 of them with **zero waivers, zero `overrides`, and no manifest change**: `fast-uri`, `hono`, `ip-address`, `js-yaml`, `nanoid`, `postcss`, `@hono/node-server`, `@modelcontextprotocol/sdk`, `body-parser`, plus `global-agent` 3.0.0 → 4.1.3. The `esbuild` low advisory is cleared **forward** rather than by the downgrade `npm audit fix` proposes: `npm audit fix` moves esbuild 0.27.7 → 0.27.2 (backwards, out the bottom of the advisory range) because it minimises movement, whereas updating `tsx` 4.21.0 → 4.23.12 — already admitted by the declared `^4.21.0` — brings a `~0.28.0` range and resolves esbuild 0.28.2, clear of the advisory. A downgrade buried in a 45-version refresh is a supply-chain shape we would flag as a finding in someone else's repo. What remains is exactly one advisory (`GHSA-xcpc-8h2w-3j85`, adm-zip <0.6.0, counted twice because `onnxruntime-node` is flagged for depending on it), which cannot be fixed in this repo at all: `onnxruntime-node` pins `adm-zip` inside a caret on 0.5.x and the patched release is 0.6.0. It was already formally accepted for the **shipped** artifact with a dated, self-invalidating, derive-backed waiver — so the gate now asserts "high/critical advisory ids, minus the ids already accepted for the shipped artifact, is empty" instead of "the count is zero". **The severity threshold is unchanged, and no suppression primitive was added** — no lowered `--audit-level`, no `|| true`, no `continue-on-error`. A new high advisory fails on the run it appears; both enforcement rules were proven able to fail on purpose before shipping. Acceptances now live in one place, `scripts/lib/accepted-advisories.mjs`, read by both the build-tree and consumer gates, and the coupling is one-way by construction: an advisory can be waived in the build tree only because it is already accepted for users, never the reverse. The job is renamed `audit` → `build-tree-audit` for the artifact it measures, and restored to the weekly schedule it had been excluded from *because* it was permanently red.
- **Rejected, and recorded so it is not retried:** the root-manifest `"overrides": { "adm-zip": "0.6.0" }` used to fix the identical advisory in the `opena2a` monorepo does **not** transfer here, and the difference is not cosmetic. That repo's root manifest is `private: true` and never published; ai-trust's root manifest **is** the published artifact. Verified by packing a probe and extracting the tarball: an `overrides` block is carried verbatim into the published `package.json`, where npm ignores it (overrides are honoured only in a consuming project's own root) — so it would ship, to every user, a manifest asserting we pin adm-zip to the patched version while their install resolves the vulnerable one. A false claim in a published manifest, from a tool whose job is inspecting other people's manifests.

### Changed

- **Bumped the pinned `hackmyagent` scanner `0.24.0` → `0.25.0`, so local repo scans use content-aware git detection.** ai-trust delegates repo scanning to the hackmyagent it pins exactly. 0.25.0 makes `GIT-001`/`GIT-002` existence-aware via authoritative `git check-ignore` — a missing or incomplete `.gitignore` is a **LOW** advisory when no committable file matches the uncovered patterns (removing a false-`high` on clean/template repos) and stays **HIGH** when a genuine un-ignored match exists — and moves un-ignored `.env` secret exposure to the content-calibrated **`GIT-003`** (`critical`). It also surfaces `CRED-002`/`PERM-001` findings that previously never reached output (an un-ignored private key now scores), plus recursive `CRED-002` + `secrets.json`/`credentials.json` scanning, and the `@opena2a/aim-sdk` `1.0.1` → `1.0.2` security pin. The `release-smoke:corpus` goldens and the shared corpus `aiTrust` repo score bands were rebaselined to match — a deliberate, documented re-bake because the pinned scanner version changed, not a mask over drift. Golden deltas are only the expected content-aware-git changes: benign `tiny-clean-repo` `GIT-002` `high`→`low` (90→98, verdict `safe`), buggy `leaky-env-example` `GIT-002` `high`→`low` (77→83), malicious `kitchen-sink` gains `GIT-003` + the now-visible `CRED-002`/`PERM-001` (score stays `0`).
- **Out-of-scope library JSON now agrees with the human output.** `check <library> --json` (e.g. `check express --json --no-scan`) previously spread the registry record at the top level, so a script read `trustScore` / `trustLevel` / `verdict` as an ai-trust verdict even though the human output declares the package out of scope and shows no score. The JSON now leads with `outOfScope: true` / `scored: false`, and the registry's raw data is preserved under `registryData` (reference only, not an ai-trust verdict).
- **Local-scan output no longer presents a score from zero executed checks.** When a scan finds no analyzable surfaces (0 static checks, no semantic findings), the verdict reads `No analyzable surfaces — not scored` and the Security meter is suppressed instead of showing a vacuous `100/100`. The Observations "Checks" line now reports executed checks (passed + failed, from HMA's `allFindings`) rather than the failure count, so "N static" reflects what was actually measured.
- **Batch all-clear message is grammatical for a single package.** "All 1 AI package meet minimum trust level N" is now "The AI package meets minimum trust level N".

### Fixed

- **`telemetry <unknown-action>` now exits non-zero.** It printed "Unknown action …" but exited 0; scripts and CI can now detect the usage error (exit 1). Valid actions and the default still exit 0.
- **Malformed dependency-file JSON now gives an actionable error.** `audit` on a broken `package.json` surfaced only the raw parser string ("Expected property name … at position 2"). It now names the file and suggests the fix (trailing commas / unquoted keys / unclosed brace) plus a one-line validate command.
- **The anonymous scan ping had no working way to disable it.** `check`/`audit`'s `sendScanPing` (package name + verdict + score, sent to `api.oa2a.org` on every local scan) fired unconditionally regardless of contribution consent. `--help` has advertised `--no-contribute` as the way to stop it since the two-bucket telemetry policy shipped, but the flag was never registered with Commander — `check express --no-contribute` errored with `unknown option '--no-contribute'`. Package name + verdict is scan-result data under that policy (it names what you scanned), not invocation telemetry, so it needs the same opt-in as full contribution. `--no-contribute` is now a real option on both `check` and `audit`, an explicit `--contribute`/`--no-contribute` now correctly overrides a persisted config choice either way (mirrors hackmyagent's existing priority order), and the ping is gated on the same consent as `queueScanResult`. `ai-trust telemetry off` still does not affect this ping — that toggles a separate config file (Tier-1 invocation telemetry) and always has; `--no-contribute` (or `opena2a config contribute off`) is the way to stop scan-result data specifically. Filed for follow-up: the `--help` text's "or ai-trust telemetry off" half of this promise is not implemented here (nor in hackmyagent, which advertises the identical line) and is a separate, fleet-wide gap.

## 0.7.4 (2026-06-07)

### Added

- **Self-tag `source=ci` on publish when run in our CI.** The `audit` (`--scan-missing` bulk) and `check` publish paths now sign their registry contribution with the shared `@opena2a/registry-client` `FirstPartySigner` (0.2.0) when `AI_TRUST_CI_SIGNING_KEY` (a dedicated Ed25519 seed, supplied via the runtime environment only) is set. Signed publishes self-tag `source=ci` over the registry strong canonical (`name|version|score|maxScore|source|nonce|signedAt`) so the registry can authenticate the provenance claim. ai-trust is **not** `first_party_scanner` — `ci` is the correct provenance for our own continuous-integration audits. End-user runs (no key) publish as `community`, the safe default; an unsigned or unverifiable claim is never honored, and the bulk audit signs a fresh nonce per package so a long run never reuses one.

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
