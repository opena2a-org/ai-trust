# I want to check if a package is safe before installing

Time: 2 min.

## Steps

### 1. Run the check command

```bash
npx ai-trust check @modelcontextprotocol/server-filesystem --no-scan
```

Expected output (scores and scan ages come from the registry and change over time):

```
  @modelcontextprotocol/server-filesystem  mcp server · scanned 225 days ago (stale)
  Passed, but the registry recorded 1 high finding

  Trust     ━━━━━━━━━━━━━━━━━━━━ 79/100
  Level     Scanned  Blocked > Warning > Listed > Scanned > Verified
  Scans     3 community scans
  Last scan 225 days ago (stale)
  Findings  0 critical · 1 high · scan status warnings
  CVEs      none recorded

  ── Next Steps ──────────────────────────────────────────────
  → Fresh scan  ai-trust check @modelcontextprotocol/server-filesystem
```

`--no-scan` reads the registry's answer only. Drop it to download the package and scan it locally with HackMyAgent instead.

### 2. Read the trust score and factors

The output tells you:

- **Header** -- the package name, its type, and how long ago the registry last scanned it. `(stale)` marks a scan older than 90 days; a fresh local scan gives a current answer.
- **Verdict line** -- `No known issues`, `Warning — review before installing`, `Blocked by registry`, or `Listed — limited signal` (in the registry, not yet scanned). This is the actionable recommendation. A `passed` verdict reads `No known issues` only when the registry records no critical or high finding and no known CVE; when it records any, the verdict line names them, as above.
- **Trust** -- the registry trust score out of 100. Packages that have not been scanned show `not scanned` instead of a score.
- **Level** -- how thoroughly the package has been evaluated, on the scale `Blocked > Warning > Listed > Scanned > Verified`. See [Trust Levels](../commands.md#trust-levels) for the full scale.
- **Scans** and **Last scan** -- how many community scans the registry holds and when the last one ran.
- **Findings** -- critical and high finding counts from the registry's last scan, and that scan's status. Medium and low counts are not shown.
- **CVEs** -- known CVE and advisory identifiers the registry records for the package, or `none recorded`.

### 3. Decide whether to install

| Verdict line | Action |
|---------|--------|
| `No known issues` | Install. |
| `Passed, but the registry recorded ...` | Review the recorded findings or CVEs first. Run `ai-trust check <package>` for a local scan with the findings listed, then decide. |
| `Listed — limited signal` | No scan data yet. Run `ai-trust check <package>` (without `--no-scan`) to scan it locally before installing. |
| `Warning — review before installing` | Run `ai-trust check <package>` for a local scan with the findings listed, then decide. |
| `Blocked by registry` | Do not install. The package has known security issues. Look for an alternative. |

The `verdict` field of `--json` output uses the registry's words on a registry lookup (`--no-scan`): `passed`, `listed`, `warning` or `blocked`. A local scan reports `safe`, `warning` or `blocked`. A registry lookup's `--json` output also carries `scanStatus`, `lastScannedAt` and `securityProfile` (`criticalCount`, `highCount`, `knownCves`), each omitted when the registry did not return it; a local scan's lists each failed finding under `findings`.

## If the package is not in the registry

The same command works. By default, `ai-trust check` downloads the package and scans it locally using [HackMyAgent](https://github.com/opena2a-org/hackmyagent), whether or not the registry has it:

```bash
npx ai-trust check unknown-package
```

This downloads the package, runs a local security scan, and returns a trust verdict. Add `--contribute` to share the results with the community registry.

## CI integration

Use exit codes to gate installs in CI pipelines:

```bash
npx ai-trust check @modelcontextprotocol/server-filesystem --no-scan
# Exit code 0 = safe or out of scope, 1 = operational error, 2 = warning, blocked or not found
```

See [Exit Codes](../commands.md#exit-codes) for the full list.
