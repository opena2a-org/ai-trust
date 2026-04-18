> **[OpenA2A](https://github.com/opena2a-org/opena2a)**: [CLI](https://github.com/opena2a-org/opena2a) · [HackMyAgent](https://github.com/opena2a-org/hackmyagent) · [Secretless](https://github.com/opena2a-org/secretless-ai) · [AIM](https://github.com/opena2a-org/agent-identity-management) · [Browser Guard](https://github.com/opena2a-org/AI-BrowserGuard) · [DVAA](https://github.com/opena2a-org/damn-vulnerable-ai-agent)
# ai-trust

Trust verification CLI **for AI packages** — MCP servers, A2A agents, skills, AI tools, and LLMs. Queries the OpenA2A Registry trust graph for security scans, community consensus, dependency risk, and known advisories.

For general-purpose libraries (express, typescript, chalk, etc.) use [HackMyAgent](https://github.com/opena2a-org/hackmyagent) instead — ai-trust is scoped to AI-native packages only.

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
  @modelcontextprotocol/server-filesystem  mcp_server · scanned 2 days ago
  No known issues

  Trust     ━━━━━━━━━━━━━━━━━━━━ 87/100
  Level     Scanned (3/4)
  Blocked > Warning > Listed > Scanned > Verified

  ── Next Steps ──────────────────────────────────────────────
  Fresh scan:         ai-trust check @modelcontextprotocol/server-filesystem
  Full project audit: ai-trust audit package.json
```

## Scope: AI packages only

ai-trust verifies trust for **AI-native** packages. For everything else, use HMA:

| Your package is... | Use |
|---|---|
| MCP server / A2A agent / skill / AI tool / LLM | `ai-trust` |
| General-purpose library (express, chalk, typescript, etc.) | `hackmyagent check <pkg>` |
| Full codebase security audit | `hackmyagent secure .` |

`ai-trust audit package.json` audits AI packages in the trust table and separately lists libraries in an "Out of scope" section with an HMA pointer.

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

Look up the trust verdict for a single AI package.

```bash
ai-trust check @modelcontextprotocol/server-filesystem
ai-trust check my-custom-agent --type a2a_agent
ai-trust check @modelcontextprotocol/server-postgres --json     # JSON output for scripting
```

Running `check` on a general-purpose library (e.g. `ai-trust check express`) returns an "out of scope" message with a redirect to `hackmyagent check express`. This is intentional — ai-trust is for AI packages only.

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

Parse dependency files and audit AI packages. Supports any `.json` file (package.json format) or `.txt` file (requirements.txt format). Libraries in the file are partitioned into an "Out of scope" section with a pointer to HMA for general security scanning.

```bash
ai-trust audit package.json
ai-trust audit requirements.txt
ai-trust audit package.json --min-trust 2         # set minimum trust threshold (default: 3)
ai-trust audit package.json --scan-missing --contribute  # scan unknown AI packages
```

Example output (mixed AI + libraries):

```
  5 AI packages audited · 9 libraries out of scope

  PACKAGE                    TYPE          VERDICT   TRUST       SCORE         SCAN
  ──────────────────────────────────────────────────────────────────────────────────────
  @modelcontextprotocol/sdk  mcp_server    SAFE      Scanned     ━━━━━━━━ 87  passed
  @opena2a/aim-core          a2a_agent    SAFE      Scanned     ━━━━━━━━ 81  passed
  ...

  ── Out of scope (libraries) ────────────────────────────────
  ai-trust is for AI packages. For general security, use HackMyAgent.
  @noble/ed25519, @noble/post-quantum, commander, js-yaml, onnxruntime-node + 4 more

  ── Next Steps ──────────────────────────────────────────────
  Library security:  npx hackmyagent secure .
```

### batch

Look up trust verdicts for multiple AI packages at once. Non-AI packages get partitioned into the "Out of scope" footer.

```bash
ai-trust batch @modelcontextprotocol/server-filesystem @modelcontextprotocol/server-postgres
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
