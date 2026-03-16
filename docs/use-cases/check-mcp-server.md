# I want to verify an MCP server's trust score

Time: 30 seconds.

## Steps

### 1. Run the check command with shorthand

MCP servers support shorthand resolution, so you do not need to type the full package name:

```bash
npx ai-trust check stripe
```

This resolves to the full MCP server package name automatically. Other shorthand examples:

```bash
ai-trust check server-filesystem    # resolves to @modelcontextprotocol/server-filesystem
ai-trust check mcp-server-fetch     # resolves to @modelcontextprotocol/server-fetch
ai-trust check server-github        # resolves to @modelcontextprotocol/server-github
```

Shorthand rules: `server-*` and `mcp-server-*` prefixes resolve to `@modelcontextprotocol/server-*`.

Expected output:

```
@modelcontextprotocol/server-stripe
  Trust Level: 3 (Scanned)
  Verdict:     safe
  Scanned:     2026-02-15
  Findings:    0 critical, 0 high, 1 medium
```

### 2. Understand trust levels

Trust levels indicate how thoroughly a package has been evaluated:

| Level | Label | What it means |
|-------|-------|---------------|
| 0 | Blocked | The package has known security issues and should not be used. |
| 1 | Warning | The package has flagged issues that require review before use. |
| 2 | Listed | The package exists in the registry but has not been scanned yet. |
| 3 | Scanned | The package has been scanned by HackMyAgent with no blocking findings. |
| 4 | Verified | The package publisher has verified its identity and the scan results. |

A trust level of 3 or higher is generally safe to use. Levels 0-1 require investigation. Level 2 means no scan data is available yet -- consider running a local scan with `--scan-if-missing`.

### 3. Get programmatic output

For scripting or CI integration, use the `--json` flag:

```bash
npx ai-trust check stripe --json
```

Expected output:

```json
{
  "name": "@modelcontextprotocol/server-stripe",
  "trustLevel": 3,
  "trustLabel": "Scanned",
  "verdict": "safe",
  "scannedAt": "2026-02-15T00:00:00.000Z",
  "findings": {
    "critical": 0,
    "high": 0,
    "medium": 1,
    "low": 3
  }
}
```

This output can be parsed by `jq`, piped into other tools, or used in CI gates:

```bash
# Fail CI if the trust level is below 3
TRUST=$(npx ai-trust check stripe --json | jq '.trustLevel')
if [ "$TRUST" -lt 3 ]; then
  echo "Trust level too low: $TRUST"
  exit 1
fi
```
