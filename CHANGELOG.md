# Changelog

## Unreleased

### Security

- **The build-tree lockfile is refreshed to patched releases, clearing every advisory `npm audit` reports for it, with no manifest change and an empty acceptance list.** `npm audit --package-lock-only` on the committed lockfile reported 11 vulnerabilities (1 critical, 5 high, 5 moderate), all of them published, or revised to cover the locked version, after the last refresh (whose own audit found 0 vulnerabilities), and all with a patched release inside the declared ranges: `proxy-addr` (critical), `@modelcontextprotocol/sdk`, `adm-zip`, `fast-uri`, `js-yaml`, `source-map-js` (high), and `hono`, `ip-address`, `qs`, `vitest`/`@vitest/mocker` (moderate). `npm audit fix --package-lock-only` moves 55 packages forward, removes 7 (`@emnapi/*`, `@napi-rs/wasm-runtime`, `@rolldown/binding-wasm32-wasi`, `@tybys/wasm-util`, `tslib`) and adds 1 (`@rolldown/binding-android-arm-eabi`), every `resolved` on `registry.npmjs.org`, no downgrade. `package.json` is untouched: `hackmyagent` stays pinned `0.25.0`, lockfiles are not published, and the published artifact is byte-identical. Nothing was accepted: `ACCEPTED_ADVISORIES` stays empty, and both the build-tree gate and the consumer-resolution gate measure 0 advisories on this tree.
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

- **Bumped the pinned `hackmyagent` scanner `0.25.0` → `0.33.2`, because `0.25.0` is deprecated on the registry.** ai-trust pins the scanner exactly, so the pin decides which scanner an install resolves. `0.33.2` carries no deprecation notice. The move also ends a dependency cycle: `hackmyagent@0.26.1` declares `ai-trust: ^0.2.6` and `0.27.0` drops it, so an install no longer contains a second, older `ai-trust` and under it a second, older `hackmyagent`. Measured by installing the packed artifact into an empty directory with `--omit=dev`: 136 packages, one `hackmyagent` at `0.33.2`, no deprecation warning, and `npm audit` reports 0 critical, 0 high, 0 moderate, 0 low. The same install of the published `0.7.6` prints deprecation warnings for `hackmyagent@0.23.11` and a nested `hackmyagent@0.17.11`. The scanner invocation is unchanged: the scanner is still invoked as `secure --format json` (with `--deep` or `--analm`), and every JSON field ai-trust reads is still present. The two nested-copy waivers in `scripts/audit-consumer-resolution.mjs` are deleted, so that gate now fails on any second copy of `hackmyagent` or `ai-trust` in a consumer tree.
  **The default package check drops `DEP-001` and `SANDBOX-001` on a downloaded package, so clean packages score as they did under `0.25.0`.** On the default `check <package>` path, which downloads the package and scans it, `0.33.2` reports `DEP-001` ("Dependency Lock File": no `package-lock.json`, `yarn.lock` or `pnpm-lock.yaml`) and `SANDBOX-001` ("Container Isolation": no `Dockerfile`, `docker-compose.yml` or `docker-compose.yaml`), both medium, where `0.25.0` reported neither. On a downloaded package neither describes the package: npm never publishes the three lock files `DEP-001` probes (the one lock file it does publish, `npm-shrinkwrap.json`, is not probed), and container isolation is a property of the consumer's deployment, not of the tarball. ai-trust now drops these two failing checks from a downloaded package's findings before it recomputes the score, next to the local-only categories it already drops there. The exclusion is by check id: other checks in the `dependencies` and `sandboxing` categories stay, and a package that ships a `Dockerfile` keeps its `SANDBOX-001` pass. Local scans through `--scan-path` are unchanged; on a project tree both findings stand. Measured with `check <package> --json --no-contribute` on `@modelcontextprotocol/server-memory` 1.0.0 and `mcp-remote` 0.14.3: on `0.25.0` both scored 100 with no findings; on `0.33.2` without the exclusion both score 90 with those two findings; with it both score 100, trust level 3, verdict `safe`, no findings. The scanner's own `check <package>` reports the same two findings; upstream report: `opena2a-org/hackmyagent#965`.
  **`GHSA-ccp3-g7fv-9cqr` is not resolved by this bump.** The advisory is published, critical, covers `hackmyagent >= 0.17.11` and has no patched version, so both the old pin and the new one are inside it. `npm audit` over the consumer tree reports 0 critical, 0 high, 0 moderate, 0 low only because the advisory is not in the global advisory database; that count says nothing about it.
  **What changes in local-scan (`--scan-path`) scores, and why.** These come from the scanner, not from ai-trust, and are measured on the eleven `release-smoke:corpus` entries:
  - `DEP-001` (medium) is now in all eleven goldens. It is true on `repo/benign/tiny-clean-repo` (one declared dependency, no lock file) and `repo/malicious/kitchen-sink` (four, no lock file). It is a false positive on the other nine: six have no `package.json` and three have a `package.json` that declares no dependencies. `DEP-001` costs 0 to 5 points; on the eleven corpus entries it flips no verdict, and a tree within that margin above 70 or 40 changes verdict.
  - `SANDBOX-001` is in no golden. On `repo/benign/tiny-clean-repo` the scanner fails it in `allFindings` but leaves it out of the `findings` that ai-trust reads, so it does not appear in these local-scan results; on the default package check ai-trust drops it (above).
  - The verdict-band clamp: a critical or high finding now caps the score at 69. On `repo/buggy/leaky-env-example` (critical `CONFIG-004`) the scanner's raw score is 79 and its score 69; the golden goes 83 → 69, trust level 2 → 1, verdict `warning` unchanged.
  - `skill/malicious/exfil-skill` gains `SKILL-025` and loses `AST-CRED-001`; it stays `blocked`.
  - The two nested-artifact fixtures, which had no golden, get one: `repo/malicious/nested-mcp-config` carries `CRED-001`, `SEM-CRED-001` and `SEM-CRED-004` (critical) and scores 40, and `repo/malicious/nested-claude-skill` carries `SKILL-001`, `SKILL-020` and `SUPPLY-001`/`002`/`004` (medium) and scores 71.
  - `repo/malicious/kitchen-sink` gains `AST-HEARTBEAT-001` and `AST-MANIP-001`.
  **The `release-smoke:corpus` harness now runs without the scanner's semantic layer, without usage telemetry, in an isolated home, with the scanner's pinned classifier model set verified by hash; its goldens are recorded in that state.** With `ANTHROPIC_API_KEY` present the scanner's `--deep` path calls a remote model and adds `SEM-LLM-*` findings; the harness deletes that key from each scan's environment, so the semantic layer never runs. Every scan runs with `HOME` set to a directory the harness creates under its temp directory and removes on exit, so the caller's classifier model files and state directory are invisible (`OPENA2A_HOME` and `NANOMIND_URL` are removed from the scan environment as well). Because that home holds no saved telemetry opt-out, the harness also sets `OPENA2A_TELEMETRY=off` for every scan, so neither ai-trust nor the scanner sends usage events from a test run. Before the first scan it reads the three file names and sha256 values the installed scanner pins from the scanner's own classifier source, puts those files into that home's `~/.nanomind/models` (copied from the caller's cache when the hashes match, otherwise fetched by the scanner's downloader) and verifies each file's sha256 against the pin; the verified names and hashes are printed. A set it cannot obtain is a setup error: exit 2 with a message naming the file and the pinned hash, and no golden is compared. Every previous golden that carried `SEM-LLM-*` findings (the three `mcp` entries and `kitchen-sink`) was recorded with the key set; the re-recorded goldens carry none. The goldens are recorded in this state against opena2a-corpus `c94fe7a`, and two missing ones are added (score, trust level, verdict):

  | Corpus entry | Old golden | New golden | Check ids added (removed) |
  |---|---|---|---|
  | `mcp/benign/readonly-fs-mcp` | 85, tl2, `safe` | 93, tl3, `safe` | `DEP-001` (`SEM-LLM-001` to `004`) |
  | `mcp/buggy/ibm-mcp-clone` | 51, tl1, `warning` | 93, tl3, `safe` | `DEP-001` (`SEM-LLM-001` to `007`) |
  | `mcp/malicious/shell-rce-mcp` | 15, tl0, `blocked` | 40, tl1, `warning` | `DEP-001` (`SEM-LLM-001` to `009`) |
  | `skill/benign/clean-skill` | 73, tl2, `safe` | 70, tl2, `safe` | `DEP-001` |
  | `skill/buggy/caps-sprawl-skill` | 64, tl1, `warning` | 60, tl1, `warning` | `DEP-001` |
  | `skill/malicious/exfil-skill` | 30, tl0, `blocked` | 29, tl0, `blocked` | `DEP-001`, `SKILL-025` (`AST-CRED-001`) |
  | `repo/benign/tiny-clean-repo` | 98, tl3, `safe` | 93, tl3, `safe` | `DEP-001` |
  | `repo/buggy/leaky-env-example` | 83, tl2, `warning` | 69, tl1, `warning` | `DEP-001`; clamp on `CONFIG-004` |
  | `repo/malicious/kitchen-sink` | 0, tl0, `blocked` | 0, tl0, `blocked` | `AST-HEARTBEAT-001`, `AST-MANIP-001`, `DEP-001` (`SEM-LLM-001` to `011`); now critical 40, high 63, medium 38, low 1 |
  | `repo/malicious/nested-claude-skill` | none | 71, tl2, `safe` | `DEP-001`, `GIT-001`, `SKILL-001`, `SKILL-020`, `SUPPLY-001`/`002`/`004` |
  | `repo/malicious/nested-mcp-config` | none | 40, tl1, `warning` | `CRED-001`, `DEP-001`, `GIT-001`, `SEM-CRED-001`, `SEM-CRED-004` |

  The old goldens of the three `mcp` entries and `kitchen-sink` carried the remote model's `SEM-LLM-*` findings, which the new goldens do not, so their old → new change is not a measure of the pin alone. Two entries now sit exactly on a verdict line: `skill/benign/clean-skill` at 70 (`safe` needs 70) and `mcp/malicious/shell-rce-mcp` at 40 (`warning` needs 40). Two harness runs (one recording, one comparing), each from a fresh harness home whose caller cache held no model files, gave identical output: every golden matches; 7 passed, 4 failed, 1 skipped. The four failures are score-band misses only: `ibm-mcp-clone` (93 vs [48, 54]), `shell-rce-mcp` (40 vs [11, 17]), `nested-claude-skill` (71 vs [48, 54]) and `nested-mcp-config` (40 vs [25, 31]). They stay as recorded gaps: a buggy MCP server scored `safe`, an RCE MCP server not `blocked`, and two nested malicious fixtures above their bands. Writing their measured scores into the bands would record those false negatives as correct.
- **Bumped the pinned `hackmyagent` scanner `0.24.0` → `0.25.0`, so local repo scans use content-aware git detection.** ai-trust delegates repo scanning to the hackmyagent it pins exactly. 0.25.0 makes `GIT-001`/`GIT-002` existence-aware via authoritative `git check-ignore` — a missing or incomplete `.gitignore` is a **LOW** advisory when no committable file matches the uncovered patterns (removing a false-`high` on clean/template repos) and stays **HIGH** when a genuine un-ignored match exists — and moves un-ignored `.env` secret exposure to the content-calibrated **`GIT-003`** (`critical`). It also surfaces `CRED-002`/`PERM-001` findings that previously never reached output (an un-ignored private key now scores), plus recursive `CRED-002` + `secrets.json`/`credentials.json` scanning, and the `@opena2a/aim-sdk` `1.0.1` → `1.0.2` security pin. The `release-smoke:corpus` goldens and the shared corpus `aiTrust` repo score bands were rebaselined to match — a deliberate, documented re-bake because the pinned scanner version changed, not a mask over drift. Golden deltas are only the expected content-aware-git changes: benign `tiny-clean-repo` `GIT-002` `high`→`low` (90→98, verdict `safe`), buggy `leaky-env-example` `GIT-002` `high`→`low` (77→83), malicious `kitchen-sink` gains `GIT-003` + the now-visible `CRED-002`/`PERM-001` (score stays `0`).

### Fixed

- **`audit --no-contribute` no longer asks to share the scans.** On a terminal, `audit --scan-missing --no-contribute` still asked "Share these scans with the community?" after scanning packages the registry does not have, and accepting the default with Enter sent the scans and saved contribution as on for later runs. An explicit `--no-contribute` now shares nothing, asks nothing and saves no choice. Without a terminal, it also no longer prints the suggestion to rerun with `--contribute`.
- **A contributed `audit` scan of a PyPI package is no longer recorded as an npm package.** With contribution enabled, `audit requirements.txt --scan-missing` published each scan to the registry without an `ecosystem` field, and the registry records a scan without one as npm, so the scan of a PyPI package was stored as a scan of an npm package with the same name. The publish now carries `ecosystem`: `pypi` for a requirements.txt audit and `npm` otherwise, as audit's contribution queue and scan ping already did.
- **The README, demo GIF and use-case guides now show output the CLI actually prints.** The quick start mixed the registry-lookup and local-scan formats (`Level Scanned (3/4)` under a registry header). The GIF replayed a saved file that scored libraries and showed two of them BLOCKED. The guides used formats that do not exist (`Trust Level: 4 (Verified)`, a `findings` JSON object) and shorthand that does not resolve (`stripe`, `mcp-server-fetch`). Every sample is regenerated from the build. The GIF is re-recorded by running the commands (`docs/demo.tape`). The guide times now agree, and the audit example states the real `--min-trust` default (2). New `src/docs-samples.test.ts` runs each documented command against a fixed registry fixture (`docs/demo/registry-fixture.json`). It fails when a sample's structure drifts from the output, when an output block in the docs has no command behind it, or when a doc cites an unregistered `ai-trust` subcommand or flag. That last check caught one more case: step 1 of the contribution guide still told users to run the nonexistent `ai-trust config contribute on`.
- **`--no-contribute` now stops every scan result, including the one the bundled scanner sent.** ai-trust runs `hackmyagent secure` for local scans but passed it no contribute flag, so with contribution enabled in `~/.opena2a/config.json` the scanner queued and sent its own `scan_result` event even under `check --no-contribute`, `audit --no-contribute` or `check --scan-path`. ai-trust now passes `--no-contribute` to every scanner run and is the only party that decides about contribution. The `--help` line also named `ai-trust telemetry off` as an opt-out, which only toggles usage telemetry; it now names `--no-contribute` (this scan) and `opena2a config contribute off` (saved choice), and the contribution guide no longer cites a nonexistent `ai-trust config` command.
- **`--no-deep` now limits `check` and `audit` scans to static checks.** The flag only left out hackmyagent's `--deep`, so hackmyagent still ran its default AST semantic analysis and `--no-deep` returned the same score and `AST-*` findings as a default scan. ai-trust now passes `--static-only` when `--no-deep` is set, matching the flag's help text. If an older hackmyagent rejects `--static-only` as an unknown option, the scan retries without it, as it already did for `--analm`.
- **Contributed scans no longer send finding names or messages, and now send the package version.** With contribution enabled, `check` and `audit` published each finding's `name` and `message` to the registry, and a message can quote the scanned files (a scope finding echoes the contents of an `mcp.json`). This contradicted the README and the contribution guide, which promise no descriptions or file contents. Each published finding now carries only its check ID, severity, pass/fail, category and attack class; the `name` field holds the check ID and `message` is empty, so the registry's finding schema is unchanged. The publish and the contribution queue now include the package version, read from the downloaded package's own manifest (`package.json` for npm, `PKG-INFO` or wheel `METADATA` for PyPI) and dropped when it is not version-shaped. The README and `docs/use-cases/contribute-scans.md` now list every field that is sent, including the contributor token, documented as a pseudonymous per-device identifier (a salted SHA-256 hash of hostname and username; the salt never leaves the machine).
- **The README stated the wrong `--min-trust` default.** It said "default 3", but `audit` and `batch` default to 2 (Listed), so a package that is listed but not yet scanned passes the gate with exit 0. The README now says default 2 and shows `--min-trust 3` as the way to fail the gate on any package without a scan. Behaviour is unchanged.
- **The exit-code documentation now covers not-found, out-of-scope and local `--scan-path` scans.** The README's exit-code table had no row for a package that is not found (exit 2) or out of scope (exit 0). It also gave exit 2 for a warning or blocked verdict without saying that `check --scan-path` exits 0 after a finished scan whatever the verdict, and exits 2 when no scanner is found or the directory cannot be scanned; it now has rows for both. The release checklist said an out-of-scope `check express --no-scan` exits 2 and that high-risk exits 1; it exits 0, and warning or blocked exits 2. The CI comment in `docs/use-cases/check-before-install.md` left out not-found. The 0.7.2 entry gave below-threshold as exit 1, but it was already 2. No exit code changed.
- **`check` help, next-step hints and docs now describe what `check` does: it scans every package by default ([#98](https://github.com/opena2a-org/ai-trust/issues/98)).** `check <pkg>` downloads and scans the package locally whether or not the registry has it, and never prompts. The README, the use-case docs and `check --help` still described the older flow: a registry lookup first, a prompt on a registry miss, `--scan-if-missing` to scan in CI, and a contribution question after the first scan. The `--no-scan` not-found block and its `--json` `nextSteps` sent users to `--scan-if-missing`, a flag that changes nothing. Those hints now give the plain `check <pkg>` command, `--scan-if-missing` is marked deprecated in `--help` and dropped from the examples, and the README states that `--no-scan` is the registry-only path and that `check` never asks about contribution: it is opt-in, with a tip rather than a prompt. Scan behaviour, verdicts, scores and exit codes are unchanged.

- **The anonymous scan ping had no working way to disable it.** `check`/`audit`'s `sendScanPing` (package name + verdict + score, sent to `api.oa2a.org` on every local scan) fired unconditionally regardless of contribution consent. `--help` has advertised `--no-contribute` as the way to stop it since the two-bucket telemetry policy shipped, but the flag was never registered with Commander — `check express --no-contribute` errored with `unknown option '--no-contribute'`. Package name + verdict is scan-result data under that policy (it names what you scanned), not invocation telemetry, so it needs the same opt-in as full contribution. `--no-contribute` is now a real option on both `check` and `audit`, an explicit `--contribute`/`--no-contribute` now correctly overrides a persisted config choice either way (mirrors hackmyagent's existing priority order), and the ping is gated on the same consent as `queueScanResult`. `ai-trust telemetry off` still does not affect this ping — that toggles a separate config file (Tier-1 invocation telemetry) and always has; `--no-contribute` (or `opena2a config contribute off`) is the way to stop scan-result data specifically. Filed for follow-up: the `--help` text's "or ai-trust telemetry off" half of this promise is not implemented here (nor in hackmyagent, which advertises the identical line) and is a separate, fleet-wide gap.

## 0.7.6 (2026-06-19)

### Added

- **`check --json` has one stable, documented shape.** Both in-scope paths, a registry lookup and a local scan, now map onto one camelCase object: `name`, `source`, `found`, `packageType`, `verdict`, `trustLevel`, `trustScore`, plus `score`, `maxScore` and `findings` for scans. A value the pipeline does not produce is omitted, never filled in. stdout carries only the JSON.
- **`check` honours `AI_TRUST_CLI_PREFIX`.** When ai-trust runs as `opena2a registry <pkg>`, the wrapper sets `AI_TRUST_CLI_PREFIX='opena2a registry'`, and every command `check` cites in its own output (usage line, examples, next-steps footer, not-found hints) uses that prefix in place of `ai-trust check`. Output is unchanged when the variable is unset, and `audit` and `batch` citations are not affected.

### Changed

- **The `hackmyagent` scanner is pinned exactly at `0.23.11`, up from `^0.17.1`.** `check --scan-path` runs the scanner in deep mode, so local scan scores move with it. The four `release-smoke:corpus` goldens it affects were rebaselined and every verdict direction holds: benign `clean-skill` goes from `warning` (60) to `safe` (73), malicious `exfil-skill` goes from 2 to 5 critical findings and stays `blocked`.

### Fixed

- **The terminal verdict and the `--json` verdict no longer disagree.** The human headline counted findings by severity and the Observations block used a severity-only verdict, while `--json` used the score-aware one, so a third-party package scoring 90/100 with a high finding read `warning` in JSON and "Not safe to ship" in the terminal. Both human surfaces now derive from the same score-aware verdict as `--json`. Verdict thresholds, severity assignment and exit codes are unchanged; local scans keep the `secure --fix` guidance and downloaded packages keep the review-or-avoid guidance.
- **`release-smoke:corpus` reads scan results again.** The curated `check --json` moved `score` and `findings` to the top level while the harness still read them under `scan`, so every fixture reported no parsable result. It now reads the top level and falls back to the nested shape.

### Documentation

- The README's Links section points to aicomply.

## 0.7.5 (2026-06-08)

### Changed

- **Out-of-scope library JSON now agrees with the human output.** `check <library> --json` (e.g. `check express --json --no-scan`) previously spread the registry record at the top level, so a script read `trustScore` / `trustLevel` / `verdict` as an ai-trust verdict even though the human output declares the package out of scope and shows no score. The JSON now leads with `outOfScope: true` / `scored: false`, and the registry's raw data is preserved under `registryData` (reference only, not an ai-trust verdict).
- **Local-scan output no longer presents a score from zero executed checks.** When a scan finds no analyzable surfaces (0 static checks, no semantic findings), the verdict reads `No analyzable surfaces — not scored` and the Security meter is suppressed instead of showing a vacuous `100/100`. The Observations "Checks" line now reports executed checks (passed + failed, from HMA's `allFindings`) rather than the failure count, so "N static" reflects what was actually measured.
- **Batch all-clear message is grammatical for a single package.** "All 1 AI package meet minimum trust level N" is now "The AI package meets minimum trust level N".
- **`--version` prints one parseable line on stdout.** With `@opena2a/cli-ui` `0.5.1` → `0.5.2`, `ai-trust --version` writes the bare `ai-trust x.y.z` line to stdout and the telemetry disclosure to stderr, so a script can capture the version on its own.
- **Scans of downloaded packages no longer suggest `secure --fix`.** The default `check <pkg>` path scans an npm or PyPI package the user downloaded and does not own, so its verdict line and Next Steps now recommend pinning a vetted version or choosing an alternative, and the header reads `downloaded package`. `--scan-path` on the user's own tree still reads `local scan` and keeps the `secure --fix` guidance.

### Fixed

- **`telemetry <unknown-action>` now exits non-zero.** It printed "Unknown action …" but exited 0; scripts and CI can now detect the usage error (exit 1). Valid actions and the default still exit 0.
- **Malformed dependency-file JSON now gives an actionable error.** `audit` on a broken `package.json` surfaced only the raw parser string ("Expected property name … at position 2"). It now names the file and suggests the fix (trailing commas / unquoted keys / unclosed brace) plus a one-line validate command.

### Security

- **The `vitest` dev dependency is raised to `^4.1.8` for GHSA-5xrq-8626-4rwp** (critical, Vitest UI server, affecting the previously locked 3.2.4). This is development tooling only and does not change the published CLI. The CI test matrix drops Node 18, which vitest 4 does not support; the CLI's `engines` stays `>=18.0.0`.

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
- **Telemetry dispatcher passes `semanticSuccessCodes: [2]` to `successFromExitCode`.** Per `briefs/cli-telemetry-success-semantics.md`, invocation telemetry's `success` field follows crash-rate semantics: ai-trust's exit code 2 means "I checked, the package isn't in the registry" — a working outcome, not a crash. The previous dispatcher mis-labeled these as `success: false`, producing a 50% "failure" rate on `ai-trust audit` in the `/admin/cli-usage` rollup over the prior 60 days even though the real crash rate was near 0%. With this release, the dashboard signal reflects actual reliability. Public CLI exit-code contract is unchanged — `check`, `audit`, and `batch` still exit 2 for not-found and below-threshold, exit 0 for clean. (Corrected after release: this line first gave below-threshold as exit 1, but it was already 2 in this release.)

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
- **Round 2 `buildNotFoundOutput` adoption (was queued in 0.5.1).** Bundles the five not-found path migrations into the 0.6.0 release window per the round 2 queueing decision, which held the standalone publish until partner work surfaced. Partner work is the check-core 0.2.0 consume above.

### Brief
- opena2a-org/briefs/check-rich-context-skills-mcp-v1.md (§8 task 2f, "round 2 PRs ride along")

## 0.5.1 (2026-04-22)

### Changed
- **`check --json` not-found paths now emit the canonical `NotFoundOutput` shape from `@opena2a/check-core`.** Five inline `formatJson({name, found: false, ...})` emit sites in `src/commands/check.ts` (registry error, non-TTY registry miss, translated download error, generic scan error, `--no-scan` miss) all flow through `buildNotFoundOutput({name, ecosystem, error, errorHint?, suggestions?, nextSteps?})`. `nextSteps` preserved on the `--scan-if-missing` CTA paths. Closes the data-layer half of the F2 (not-found shape) and F3 (git-style miss) parity fixtures in opena2a-parity (companion to hackmyagent 0.19.1).

### Fixed
- The translated download error path previously emitted `hint: ...` instead of `errorHint: ...` — corrected to match the shared `NotFoundOutput` schema.

## 0.5.0 (2026-04-22)

### Changed
- **`check` happy-path consumes `@opena2a/check-core@0.1.0` primitives (exact pin).** `translateDownloadError` + `mapScanStatusForMeter` move to the shared package; local copies deleted. ai-trust, hackmyagent, and opena2a-cli now share one implementation for the registered-package `--json` shape — the F1 parity fixture in opena2a-parity is byte-identical across all three.

## 0.4.0 (2026-04-23)

### Changed
- **`ai-trust check <pkg>` now consumes `@opena2a/cli-ui@0.3.0` (exact pin).** Rendering of registered packages, package-not-found results, and the Next Steps block flows through shared primitives (`renderCheckBlock`, `renderNotFoundBlock`, `renderNextSteps`). Closes F5 (divergent output schemas), F6 (meter suppressed on unscanned packages — "a number implies measurement"), and F7 (Next Steps CTAs diverged) from `briefs/check-command-divergence.md`. Trust-level legend is always shown inline on the Level row so users see the full scale next to where their package sits.

### Fixed
- **Git-style package names no longer leak raw `code 128` (F3).** `ai-trust check anthropic/code-review` previously surfaced the raw git exit code when `npm pack` fell through to git. The error is now translated into a shared not-found block with a "did you mean '@anthropic/code-review'?" hint.
- **`--no-scan` package-not-found output matches the same shared block** emitted by scan-flow failures (F2). All not-found shapes share one renderer.

## 0.3.1 (2026-04-22)

### Changed
- **Trust queries route through `@opena2a/registry-client@0.1.0` (exact pin).** The inline `src/api/client.ts` was deleted; all trust lookups now flow through the shared package (published with SLSA v1 provenance). Identical trust-lookup implementation with hackmyagent and opena2a-cli — any client-side fix lands in one place. No user-visible output change; registry returns the same canonical trust levels either way.

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
