# I want to verify an MCP server's trust score

Time: 3 min.

## Steps

### 1. Run the check command with shorthand

Servers published under `@modelcontextprotocol` support shorthand, so you do not need to type the scope:

```bash
npx ai-trust check server-filesystem --no-scan
```

Expected output (scores and scan ages come from the registry and change over time):

```
Resolved: server-filesystem -> @modelcontextprotocol/server-filesystem

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

Shorthand rules:

```bash
ai-trust check server-github            # resolves to @modelcontextprotocol/server-github
ai-trust check mcp/server-memory        # resolves to @modelcontextprotocol/server-memory
ai-trust check mcp-server-kubernetes    # third-party package, looked up by its own name
```

`server-*` and `mcp/server-*` resolve to `@modelcontextprotocol/server-*`. Every other name, including third-party `mcp-server-*` packages, is looked up as written.

### 2. Understand trust levels

Trust levels indicate how thoroughly a package has been evaluated:

| Level | Label | What it means |
|-------|-------|---------------|
| 0 | Blocked | The package has known security issues and should not be used. |
| 1 | Warning | The package has flagged issues that require review before use. |
| 2 | Listed | The package exists in the registry but has not been scanned yet. |
| 3 | Scanned | The package has been scanned by HackMyAgent with no blocking findings. |
| 4 | Verified | The package publisher has verified its identity and the scan results. |

A trust level of 3 or higher is generally safe to use. Levels 0-1 require investigation. Level 2 means the registry has no scan data yet -- `ai-trust check <package>` without `--no-scan` scans it locally.

### 3. Get programmatic output

For scripting or CI integration, use the `--json` flag:

```bash
npx ai-trust check server-filesystem --no-scan --json
```

Expected output on stdout (the `Resolved:` note goes to stderr, so stdout stays parseable):

```json
{
  "name": "@modelcontextprotocol/server-filesystem",
  "source": "registry",
  "found": true,
  "packageType": "mcp_server",
  "verdict": "passed",
  "trustLevel": 3,
  "trustScore": 0.7866666666666666,
  "scanStatus": "warnings",
  "lastScannedAt": "2026-03-02T00:46:00.496394Z",
  "securityProfile": {
    "criticalCount": 0,
    "highCount": 1,
    "knownCves": []
  }
}
```

`trustLevel` uses the 0-4 scale above. `trustScore` is the registry score from 0 to 1 (the text output shows it out of 100). `securityProfile` holds the critical and high finding counts and known CVE identifiers from the registry's last scan; it, `scanStatus` and `lastScannedAt` are omitted when the registry did not return them, and a count the registry did not report is omitted from `securityProfile`. Without `--no-scan`, `--json` prints the local scan result instead (`"source": "scan"`, with `score`, `maxScore` and any failed `findings`).

This output can be parsed by `jq`, piped into other tools, or used in CI gates:

```bash
# Fail CI if the trust level is below 3
TRUST=$(npx ai-trust check server-filesystem --no-scan --json | jq '.trustLevel')
if [ "$TRUST" -lt 3 ]; then
  echo "Trust level too low: $TRUST"
  exit 1
fi
```
