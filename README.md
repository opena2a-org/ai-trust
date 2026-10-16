# ai-trust

[![Status: stable](https://img.shields.io/badge/status-stable-green)](STATUS.md)
[![npm version](https://img.shields.io/npm/v/ai-trust.svg)](https://github.com/opena2a-org/ai-trust/releases)
[![License: Apache-2.0](https://img.shields.io/badge/License-Apache%202.0-blue.svg)](https://opensource.org/licenses/Apache-2.0)
[![CI](https://github.com/opena2a-org/ai-trust/actions/workflows/ci.yml/badge.svg?branch=main)](https://github.com/opena2a-org/ai-trust/actions/workflows/ci.yml)

Trust verification CLI for AI packages: MCP servers, A2A agents, skills, AI tools and LLMs. It prints the OpenA2A Registry's scans and known advisories for a package, or downloads and scans it locally with HackMyAgent. For general-purpose libraries such as `express`, use [HackMyAgent](https://github.com/opena2a-org/hackmyagent) instead.

```bash
npx ai-trust check @modelcontextprotocol/server-filesystem --no-scan
```

What it prints ([full output](docs/captures/quick-start.txt)):

```
  @modelcontextprotocol/server-filesystem  mcp server · scanned 228 days ago (stale)
  Passed, but the registry recorded 1 high finding

  Trust     ━━━━━━━━━━━━━━━━━━━━ 79/100
  Level     Scanned  Blocked > Warning > Listed > Scanned > Verified
  Scans     3 community scans
  Last scan 228 days ago (stale)
  Findings  0 critical · 1 high · scan status warnings
  CVEs      none recorded

  ── Next Steps ──────────────────────────────────────────────
  → Fresh scan  ai-trust check @modelcontextprotocol/server-filesystem
```

It needs Node.js 18 or later and no account.

- [Check a package before you install it](#check-a-package-before-you-install-it)
- [Gate a project's AI dependencies in CI](#gate-a-projects-ai-dependencies-in-ci)
- [Run it through opena2a-cli](#using-with-opena2a-cli)
- [Share scan results with the registry](docs/use-cases/contribute-scans.md)

## Check a package before you install it

```bash
npx ai-trust check @modelcontextprotocol/server-filesystem
```

Without `--no-scan`, `check` downloads the package to a temporary directory and scans it with the bundled HackMyAgent, which takes longer. A general-purpose library gets an out-of-scope notice instead.

`check` exits 0 for a safe or out-of-scope package, 1 on an operational error, and 2 for a warning or blocked verdict or a package that cannot be found.

## Gate a project's AI dependencies in CI

```bash
npx ai-trust audit package.json --min-trust 3
```

`audit` reads `package.json` or `requirements.txt`, looks up each dependency and lists libraries as out of scope. It exits 2, failing the job, when a package has a warning or blocked verdict, falls below `--min-trust`, or is not in the registry and was not scanned. Exit 1 is an operational error.

`--min-trust` defaults to 2 (Listed), so a listed but unscanned package passes; 3 requires a HackMyAgent scan. On a terminal `audit` offers to scan unknown packages; in CI, pass `--scan-missing`. `ai-trust batch <names...>` checks named packages. [Sample output](docs/commands.md#audit).

## Install

```bash
npm install -g ai-trust
brew install opena2a-org/tap/ai-trust
```

On Linux x64, npm also runs the install script of `onnxruntime-node`, a scanner dependency, which downloads CUDA provider binaries from NuGet unless `ONNXRUNTIME_NODE_INSTALL=skip` is set. Build from source or check a release's provenance: [docs/install.md](docs/install.md).

### Using with opena2a-cli

[`opena2a-cli`](https://github.com/opena2a-org/opena2a) is the unified CLI for the OpenA2A security toolchain. ai-trust powers `opena2a registry`.

```bash
npm install -g opena2a-cli
opena2a registry @modelcontextprotocol/server-filesystem
opena2a review                              # full security dashboard
```

## Telemetry

Usage telemetry is on by default. After each command, ai-trust sends the tool name and version, the command name, success, duration, platform and Node.js major version to the OpenA2A Registry (`api.oa2a.org`), and no package name, argument, file path or content.

Each event carries an install ID, a persistent hash derived from this machine's ID and kept in `~/.config/opena2a/telemetry.json`, so the data is personal data. Policy: [opena2a.org/telemetry](https://opena2a.org/telemetry).

```bash
ai-trust telemetry off            # or set OPENA2A_TELEMETRY=off for one run
ai-trust telemetry status         # the current state and install ID
```

Sharing scan results is opt-in: `ai-trust config contribute on`, or `--contribute` for one scan; `audit` on a terminal asks. A shared scan sends the registry the package name, version and ecosystem, score, verdict and per-check results, not file paths or source code; a pseudonymous contributor token goes with saved consent or summaries queued earlier.

The bundled scanner sends no telemetry or scan results, and no file to any LLM provider: ai-trust runs it without your saved choices, its telemetry or `ANTHROPIC_API_KEY`. The choice, in `~/.opena2a/config.json`, is shared by OpenA2A tools; `ai-trust config contribute off` turns it off. The [contribution guide](docs/use-cases/contribute-scans.md) lists every field.

## Documentation

- [Command reference](docs/commands.md): options, MCP server shorthand, trust levels, exit codes
- [Install from source and verify a release](docs/install.md)
- [Use cases](docs/USE-CASES.md): step-by-step guides
- [Contributing](CONTRIBUTING.md) and security reports
- [ai-trust check: an MCP server, then audit package.json](docs/vhs/check.gif) ([capture](docs/vhs/check-capture.txt), [provenance](docs/vhs/check.json))
- [Website](https://opena2a.org/ai-trust), [Discord](https://discord.gg/uRZa3KXgEn)
- Other OpenA2A tools: [OpenA2A CLI](https://github.com/opena2a-org/opena2a), [HackMyAgent](https://github.com/opena2a-org/hackmyagent), [Secretless](https://github.com/opena2a-org/secretless-ai), [OpenA2A AIM (Agent Identity Management)](https://github.com/opena2a-org/agent-identity-management), [Browser Guard](https://github.com/opena2a-org/AI-BrowserGuard), [DVAA](https://github.com/opena2a-org/damn-vulnerable-ai-agent), [aicomply](https://github.com/opena2a-org/aicomply)

## License

Apache-2.0.
