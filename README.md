> **[OpenA2A](https://github.com/opena2a-org/opena2a)**: [CLI](https://github.com/opena2a-org/opena2a) · [HackMyAgent](https://github.com/opena2a-org/hackmyagent) · [Secretless](https://github.com/opena2a-org/secretless-ai) · [AIM](https://github.com/opena2a-org/agent-identity-management) · [Browser Guard](https://github.com/opena2a-org/AI-BrowserGuard) · [DVAA](https://github.com/opena2a-org/damn-vulnerable-ai-agent)
# ai-trust

Trust verification CLI for AI packages. Queries the OpenA2A Registry trust graph for security scans, community consensus, dependency risk, and known advisories.

[![License](https://img.shields.io/badge/License-Apache_2.0-blue.svg)](https://opensource.org/licenses/Apache-2.0)
[![npm version](https://img.shields.io/npm/v/ai-trust.svg)](https://www.npmjs.com/package/ai-trust)

## Installation

```bash
brew install opena2a-org/tap/ai-trust
```

Or via npm:

```bash
npm install -g ai-trust
```

Or run directly with npx:

```bash
npx ai-trust check @modelcontextprotocol/server-filesystem
```

For a full security dashboard covering trust, credentials, shadow AI, and more:

```bash
npx opena2a-cli review
```

## Quick Start

```bash
ai-trust check @modelcontextprotocol/server-filesystem
```

Expected output:

```
@modelcontextprotocol/server-filesystem
  Trust Level: 3 (Scanned)
  Score:       74/100
  Verdict:     safe
  Scanned:     2026-03-01
  Findings:    0 critical, 0 high, 2 medium
```

![ai-trust audit](docs/ai-trust-demo.gif)

## Built-in Help

```bash
ai-trust --help          # All commands and flags
ai-trust --version       # Current version
ai-trust [command] -h    # Help for a specific command
```

---

## Commands

### check

Look up the trust verdict for a single package.

```bash
ai-trust check @modelcontextprotocol/server-filesystem
ai-trust check my-custom-agent --type a2a_agent
ai-trust check express --json              # JSON output for scripting
```

### MCP Server Trust

MCP servers are the most common trust query. Use shorthand to skip the full `@modelcontextprotocol/` scope:

```bash
# These are equivalent:
ai-trust check server-filesystem
ai-trust check @modelcontextprotocol/server-filesystem

# Third-party MCP servers use their own package names:
ai-trust check mcp-server-kubernetes
ai-trust check @supabase/mcp-server-supabase
ai-trust check @cloudflare/mcp-server-cloudflare
```

Shorthand rule: `server-*` resolves to `@modelcontextprotocol/server-*`. Third-party `mcp-server-*` packages are looked up by their actual name.

#### Scan on demand

When a package is not in the registry, ai-trust can download and scan it locally using [HackMyAgent](https://github.com/opena2a-org/hackmyagent). In interactive mode, you will be prompted. In CI, use flags:

```bash
# Auto-scan unknown packages, contribute results to the community registry
ai-trust check mcp-server-xyz --scan-if-missing --contribute

# Registry lookup only (skip local scan)
ai-trust check server-filesystem --no-scan
```

### audit

Parse dependency files and batch-query all dependencies. Supports any `.json` file (package.json format) or `.txt` file (requirements.txt format).

```bash
ai-trust audit package.json
ai-trust audit requirements.txt
ai-trust audit package.json --min-trust 2         # set minimum trust threshold (default: 3)
ai-trust audit package.json --scan-missing --contribute  # scan deps not in registry
```

### batch

Look up trust verdicts for multiple packages at once.

```bash
ai-trust batch express lodash chalk commander
ai-trust batch my-server-a my-server-b --type mcp_server
```

---

## Output Options

```bash
ai-trust check express --json          # JSON output for scripting
ai-trust audit package.json --json     # JSON audit output
ai-trust check express --no-color      # disable colored output
ai-trust check express --registry-url http://localhost:8080  # custom registry
```

---

## Community Contribution

Every scan you run can improve trust data for the entire community. Scan results are shared as anonymized telemetry (check pass/fail and severity only -- no file paths, source code, or descriptions).

On first scan, ai-trust asks whether you want to contribute. Your choice is saved in `~/.opena2a/config.json` and shared across all OpenA2A tools (opena2a-cli, hackmyagent).

```bash
# Contribute for this scan (non-interactive / CI)
ai-trust check chalk --contribute

# Configure globally via opena2a-cli
opena2a config set contribute true    # opt in
opena2a config set contribute false   # opt out
```

The more scans contributed, the faster packages move from "Listed" to "Scanned" trust level, reducing risk for everyone.

---

## Trust Levels

| Level | Label | Description |
|-------|-------|-------------|
| 0 | Blocked | Package is blocked due to security concerns |
| 1 | Warning | Package has known issues |
| 2 | Listed | Package is listed but not yet scanned |
| 3 | Scanned | Package has been scanned by HackMyAgent |
| 4 | Verified | Package is verified by the publisher |

## Exit Codes

| Code | Meaning |
|------|---------|
| 0 | All queried packages are safe / meet the trust threshold |
| 1 | Operational error (network failure, file not found, server error) |
| 2 | Policy signal: one or more packages have warning/blocked verdict or fall below `--min-trust` |

---

## Requirements

- Node.js 18 or later
- [HackMyAgent](https://github.com/opena2a-org/hackmyagent) (optional, required for local scanning)

## Development

```bash
git clone https://github.com/opena2a-org/ai-trust.git
cd ai-trust && npm install && npm run build
node dist/index.js check express    # run locally without installing
```

## Use Cases

Step-by-step guides for common workflows:

- [Check if a package is safe before installing](docs/use-cases/check-before-install.md)
- [Verify an MCP server's trust score](docs/use-cases/check-mcp-server.md)
- [Contribute trust data to the community](docs/use-cases/contribute-scans.md)

See [docs/USE-CASES.md](docs/USE-CASES.md) for the full index.

## Links

- [OpenA2A Registry](https://registry.opena2a.org) — trust scores and scan data
- [OpenA2A CLI](https://github.com/opena2a-org/opena2a) — unified security CLI
- [HackMyAgent](https://github.com/opena2a-org/hackmyagent) — local scanning for unverified packages
- [opena2a.org](https://opena2a.org) — full platform

## License

Apache-2.0
