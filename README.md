# ai-trust

[![Status: stable](https://img.shields.io/badge/status-stable-green)](./STATUS.md)

> **[OpenA2A](https://github.com/opena2a-org/opena2a)**: [CLI](https://github.com/opena2a-org/opena2a) · [HackMyAgent](https://github.com/opena2a-org/hackmyagent) · [Secretless](https://github.com/opena2a-org/secretless-ai) · [AIM](https://github.com/opena2a-org/agent-identity-management) · [Browser Guard](https://github.com/opena2a-org/AI-BrowserGuard) · [DVAA](https://github.com/opena2a-org/damn-vulnerable-ai-agent)

Trust verification CLI for AI packages. MCP servers, A2A agents, skills, AI tools, LLMs. Queries the OpenA2A Registry trust graph for security scans, community consensus, dependency risk, and known advisories. Apache 2.0.

[![npm version](https://img.shields.io/npm/v/ai-trust.svg)](https://www.npmjs.com/package/ai-trust)
[![License: Apache-2.0](https://img.shields.io/badge/License-Apache%202.0-blue.svg)](https://opensource.org/licenses/Apache-2.0)
[![Tests](https://img.shields.io/badge/tests-201%20passing-brightgreen)](https://github.com/opena2a-org/ai-trust)

[Website](https://opena2a.org/ai-trust) · [Registry](https://registry.opena2a.org) · [Discord](https://discord.gg/uRZa3KXgEn)

For general-purpose libraries (express, typescript, chalk, etc.) use [HackMyAgent](https://github.com/opena2a-org/hackmyagent) instead. ai-trust is scoped to AI-native packages only.

## Quick start

```bash
npx ai-trust check @modelcontextprotocol/server-filesystem --no-scan
```

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

`--no-scan` prints the registry's answer. Without it, ai-trust downloads the package and scans it locally with [HackMyAgent](https://github.com/opena2a-org/hackmyagent) instead, which takes longer and prints a scan report.

![ai-trust demo: check an MCP server, then audit a package.json](docs/ai-trust-demo.gif)

## Install

### npm

```bash
npx ai-trust check <pkg>     # run once, no install
npm install -g ai-trust      # install globally
```

Requires Node.js 18 or later.

### Homebrew

```bash
brew install opena2a-org/tap/ai-trust
```

### From source

```bash
git clone https://github.com/opena2a-org/ai-trust.git
cd ai-trust
npm install
npm run build
node dist/index.js check express
```

### Verifying what was installed

Every release publishes via npm Trusted Publishing with SLSA v1 provenance. No long-lived `NPM_TOKEN`. GitHub Actions exchanges its OIDC token with npm at publish time.

```bash
npm view ai-trust dist.attestations --json
# Expects non-empty result with predicateType "https://slsa.dev/provenance/v1"
```

## Scope: AI packages only

ai-trust verifies trust for AI-native packages. For everything else, use HMA.

| Your package is... | Use |
|---|---|
| MCP server, A2A agent, skill, AI tool, LLM | `ai-trust` |
| General-purpose library (express, chalk, typescript, etc.) | `hackmyagent check <pkg>` |
| Full codebase security audit | `hackmyagent secure .` |

`ai-trust audit package.json` audits AI packages in the trust table and separately lists libraries in an "Out of scope" section with an HMA pointer.

Running `ai-trust check express` on a general-purpose library returns an "out of scope" verdict with a redirect to `hackmyagent check express`. Intentional. ai-trust is for AI packages only.

## Commands

### `check`

Download a single AI package, scan it locally, and print its trust verdict. `--no-scan` prints the registry's verdict instead, without downloading.

```bash
ai-trust check @modelcontextprotocol/server-filesystem
ai-trust check my-custom-agent --type a2a_agent
ai-trust check @modelcontextprotocol/server-postgres --json
ai-trust check mcp-server-xyz --contribute                    # download + scan + share
ai-trust check server-filesystem --no-scan                    # registry lookup only
ai-trust check /path/to/local --scan-path /path/to/local      # scan a local directory
```

Flags: `--type`, `--contribute`, `--no-scan`, `--no-deep`, `--scan-path`, `--json`.

### MCP server shorthand

```bash
# These are equivalent:
ai-trust check server-filesystem
ai-trust check @modelcontextprotocol/server-filesystem

# Third-party MCP servers use their own package names:
ai-trust check mcp-server-kubernetes
ai-trust check @supabase/mcp-server-supabase
ai-trust check @cloudflare/mcp-server-cloudflare
```

`server-*` resolves to `@modelcontextprotocol/server-*`. Third-party `mcp-server-*` packages are looked up by their actual name.

### Local scan and registry lookup

`check` downloads the package and scans it locally using [HackMyAgent](https://github.com/opena2a-org/hackmyagent), whether or not the registry has it, so the verdict comes from the current scanner rather than an older registry score. Packages the registry classifies as general-purpose libraries are not scanned; they get the out-of-scope notice. There is no prompt, so the same command works in a terminal and in CI:

```bash
ai-trust check mcp-server-xyz --contribute                     # download + scan + share
ai-trust check server-filesystem --no-scan                     # registry lookup only, no download
```

With `--no-scan`, a package the registry does not have exits 2 and points at the plain `check` command to scan it. `--scan-if-missing` is accepted for compatibility and changes nothing, since every package is scanned.

Local scans run HMA with NanoMind semantic analysis enabled by default. Pass `--no-deep` for static-only.

### `audit`

Parse dependency files and audit AI packages. Supports `.json` (package.json format) and `.txt` (requirements.txt format). Libraries get partitioned into an "Out of scope" section.

```bash
ai-trust audit package.json
ai-trust audit requirements.txt
ai-trust audit package.json --min-trust 3                      # require a scan (default 2)
ai-trust audit package.json --scan-missing --contribute        # scan unknown AI packages
```

`--min-trust` defaults to 2 (Listed), so a package that is listed but not yet scanned meets the threshold and exits 0. Pass `--min-trust 3` to fail the gate on any package without a HackMyAgent scan.

Example output for the sample project in [`docs/demo/package.json`](docs/demo/package.json) (five MCP packages, five libraries):

```
  5 AI packages audited · 5 libraries out of scope

  PACKAGE                             TYPE          VERDICT   TRUST       SCORE           SCAN
  ──────────────────────────────────────────────────────────────────────────────────────────────────
  @modelcontextprotocol/sdk           mcp_server    SAFE      Scanned     ━━━━━━━━ 71  warnings
  @modelcontextprotocol/server-fi...  mcp_server    SAFE      Scanned     ━━━━━━━━ 79  warnings
  @modelcontextprotocol/server-me...  mcp_server    SAFE      Scanned     ━━━━━━━━ 79  warnings
  @modelcontextprotocol/server-gi...  mcp_server    LISTED    Listed      ━━━━━━━━ --  -
  mcp-server-kubernetes               mcp_server    LISTED    Listed      ━━━━━━━━ --  -

  All 5 AI packages meet minimum trust level 2.

  ── Out of scope (libraries) ────────────────────────────────
  ai-trust is for AI packages. For general security, use HackMyAgent.
  chalk, commander, express, typescript, vitest

  Blocked > Warning > Listed > Scanned > Verified

  ── Next Steps ──────────────────────────────────────────────
  Library security:  npx hackmyagent secure .
```

### `batch`

Look up trust verdicts for multiple AI packages at once. Non-AI packages get partitioned into the "Out of scope" footer.

```bash
ai-trust batch @modelcontextprotocol/server-filesystem @modelcontextprotocol/server-postgres
ai-trust batch my-server-a my-server-b --type mcp_server
ai-trust batch react vue express lodash chalk
```

Flags: `--type`, `--min-trust` (trust level 0-4, default 2).

## Output options

```bash
ai-trust check express --json                                    # JSON output for scripting
ai-trust audit package.json --json                               # JSON audit output
ai-trust check express --no-color                                # disable colored output
ai-trust check express --registry-url http://localhost:8080      # custom registry endpoint
```

## Trust levels

| Level | Label | Description |
|---|---|---|
| 0 | Blocked | Package is blocked due to security concerns |
| 1 | Warning | Package has known issues |
| 2 | Listed | Package is listed but not yet scanned |
| 3 | Scanned | Package has been scanned by HackMyAgent |
| 4 | Verified | Package is verified by the publisher |

## Exit codes

| Code | Meaning |
|---|---|
| 0 | All queried packages are safe and meet the trust threshold |
| 1 | Operational error (network failure, file not found, server error) |
| 2 | Policy signal: one or more packages have warning or blocked verdict, or fall below `--min-trust` |

## Community contribution

Every scan you run can improve trust data for the entire community. A contributed scan carries the package name and version, the score and verdict, the project type, and for each check its ID, pass/fail, severity, category and attack class. No file paths, source code, finding names, messages or descriptions. Contributions from one device share a pseudonymous contributor token: a SHA-256 hash of the hostname, username and a random salt that stays on your machine, so the hostname and username themselves are never sent.

No scan results are shared until you opt in, and ai-trust does not stop to ask. After a few scans without a choice, it prints a tip on how to opt in. A global choice is saved in `~/.opena2a/config.json` and shared across all OpenA2A tools (`opena2a-cli`, `hackmyagent`).

```bash
ai-trust check mcp-server-xyz --contribute     # contribute for this scan (non-interactive / CI)
opena2a config set contribute true             # opt in globally
opena2a config set contribute false            # opt out globally
```

More scans contributed means packages move from "Listed" to "Scanned" faster, reducing risk for everyone.

## Using with opena2a-cli

[`opena2a-cli`](https://github.com/opena2a-org/opena2a) is the unified CLI for the OpenA2A security toolchain. ai-trust powers `opena2a trust`.

```bash
npm install -g opena2a-cli
opena2a trust @modelcontextprotocol/server-filesystem
opena2a review                              # full security dashboard
```

## Use cases

| Guide | Time |
|---|---|
| [Check if a package is safe before installing](docs/use-cases/check-before-install.md) | 2 min |
| [Verify an MCP server's trust score](docs/use-cases/check-mcp-server.md) | 3 min |
| [Contribute trust data to the community](docs/use-cases/contribute-scans.md) | 3 min |

Full index: [docs/USE-CASES.md](docs/USE-CASES.md).

## Contributing

Apache 2.0. PRs from outside the org welcome.

```bash
git clone https://github.com/opena2a-org/ai-trust.git
cd ai-trust && npm install && npm run build && npm test
```

Security issues: `info@opena2a.org` (coordinated disclosure, response within 24 hours).

## Links

- [Website](https://opena2a.org/ai-trust)
- [OpenA2A Registry](https://registry.opena2a.org). Trust scores and scan data.
- [OpenA2A CLI](https://github.com/opena2a-org/opena2a). Unified security CLI.
- [HackMyAgent](https://github.com/opena2a-org/hackmyagent). Local scanning for unverified packages.
- [aicomply](https://github.com/opena2a-org/aicomply). Inline PII, credential, and regulated-data classification for agent I/O before it reaches an LLM.

Part of the [OpenA2A](https://opena2a.org) security platform.

## License

Apache-2.0.
