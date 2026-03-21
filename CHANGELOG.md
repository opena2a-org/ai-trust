# Changelog

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
