# I want to check if a package is safe before installing

Time: 2 min.

## Steps

### 1. Run the check command

```bash
npx ai-trust check @modelcontextprotocol/server-filesystem --no-scan
```

Expected output (scores and scan ages come from the registry and change over time):

```
  @modelcontextprotocol/server-filesystem  mcp server · scanned 223 days ago (stale)
  No known issues

  Trust     ━━━━━━━━━━━━━━━━━━━━ 79/100
  Level     Scanned  Blocked > Warning > Listed > Scanned > Verified
  Scans     3 community scans
  Last scan 223 days ago (stale)

  ── Next Steps ──────────────────────────────────────────────
  → Fresh scan  ai-trust check @modelcontextprotocol/server-filesystem
  • Full project audit  ai-trust audit package.json
```

`--no-scan` reads the registry's answer only. Drop it to download the package and scan it locally with HackMyAgent instead.

### 2. Read the trust score and factors

The output tells you:

- **Header** -- the package name, its type, and how long ago the registry last scanned it. `(stale)` marks a scan older than 90 days; a fresh local scan gives a current answer.
- **Verdict line** -- `No known issues`, `Warning — review before installing`, `Blocked by registry`, or `Listed — limited signal` (in the registry, not yet scanned). This is the actionable recommendation.
- **Trust** -- the registry trust score out of 100. Packages that have not been scanned show `not scanned` instead of a score.
- **Level** -- how thoroughly the package has been evaluated, on the scale `Blocked > Warning > Listed > Scanned > Verified`. See [Trust Levels](../../README.md#trust-levels) for the full scale.
- **Scans** and **Last scan** -- how many community scans the registry holds and when the last one ran.

### 3. Decide whether to install

| Verdict line | Action |
|---------|--------|
| `No known issues` | Install. |
| `Listed — limited signal` | No scan data yet. Run `ai-trust check <package>` (without `--no-scan`) to scan it locally before installing. |
| `Warning — review before installing` | Run `ai-trust check <package>` for a local scan with the findings listed, then decide. |
| `Blocked by registry` | Do not install. The package has known security issues. Look for an alternative. |

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
# Exit code 0 = safe, exit code 2 = warning or blocked
```

See [Exit Codes](../../README.md#exit-codes) for the full list.
