# I want to check if a package is safe before installing

Time: 30 seconds.

## Steps

### 1. Run the check command

```bash
npx ai-trust check @modelcontextprotocol/server-filesystem
```

Expected output:

```
@modelcontextprotocol/server-filesystem
  Trust Level: 4 (Verified)
  Verdict:     safe
  Scanned:     2026-03-01
  Findings:    0 critical, 0 high, 2 medium
```

### 2. Read the trust score and factors

The output tells you:

- **Trust Level** -- how thoroughly the package has been evaluated (0-4, higher is better). See [Trust Levels](../../README.md#trust-levels) for the full scale.
- **Verdict** -- `safe`, `warning`, or `blocked`. This is the actionable recommendation.
- **Scanned** -- when the last security scan ran. Stale dates may indicate the package needs a re-scan.
- **Findings** -- count of security findings by severity. Critical or high findings warrant investigation before installing.

### 3. Decide whether to install

| Verdict | Action |
|---------|--------|
| `safe` | Install with confidence. |
| `warning` | Review the findings. Run `ai-trust check <package> --json` to see details, then decide. |
| `blocked` | Do not install. The package has known security issues. Look for an alternative. |

## If the package is not in the registry

ai-trust can scan it locally using [HackMyAgent](https://github.com/opena2a-org/hackmyagent):

```bash
npx ai-trust check unknown-package --scan-if-missing
```

This downloads the package, runs a local security scan, and returns a trust verdict. Add `--contribute` to share the results with the community registry.

## CI integration

Use exit codes to gate installs in CI pipelines:

```bash
npx ai-trust check @modelcontextprotocol/server-filesystem
# Exit code 0 = safe, exit code 2 = warning or blocked
```

See [Exit Codes](../../README.md#exit-codes) for the full list.
