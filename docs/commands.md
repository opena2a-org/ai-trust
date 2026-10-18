# Command reference

The `check`, `audit` and `batch` commands, their main options, the trust levels and the exit codes. The [README](../README.md) covers install and the first run.

## Scope: AI packages only

ai-trust verifies trust for AI-native packages. For everything else, use HMA.

| Your package is... | Use |
|---|---|
| MCP server, A2A agent, skill, AI tool, LLM | `ai-trust` |
| General-purpose library (express, chalk, typescript, etc.) | `npx hackmyagent check <pkg>` |
| Full codebase security audit | `npx hackmyagent secure .` |

`ai-trust audit package.json` audits AI packages in the trust table and separately lists libraries in an "Out of scope" section with an HMA pointer.

Running `ai-trust check express` on a general-purpose library returns an "out of scope" verdict with a redirect to `npx hackmyagent check express`. Intentional. ai-trust is for AI packages only.

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

Flags: `--type`, `--contribute`, `--no-scan`, `--no-deep`, `--scan-path`, `--all`, `--json`.

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

The registry's answer names the date of the registry's scan in its header (`scanned 228 days ago (stale)`), or says `scan date not recorded` when the answer carries no date. The answer carries counts of critical and high findings, not the findings themselves, so a count above zero says so (`Findings  0 critical · 1 high (details not returned) · scan status warnings`), and the `Fresh scan` next step is the command that measures the package now (`ai-trust check openai`, or `ai-trust check pip:<name>` for a PyPI package).

When the default `check` finds the package in the registry and the registry's trust score and the local scan's security score differ by more than 20 points out of 100, the scan output prints both scores with their dates, and does not say why they differ: `Registry 79/100 (scanned 228 days ago) vs this scan 100/100 (today)`.

Local scans run HMA with NanoMind semantic analysis enabled by default. Pass `--no-deep` for static-only.

Text output prints the first 10 findings, by severity, then a line that counts the rest and gives the command that prints them: `+ 15 more findings (show all: ai-trust check dvaa --scan-path ./dvaa --no-deep --all)`. `--all` prints every finding with its fix. `--json` output is not truncated.

### `audit`

Parse dependency files and audit AI packages. Reads a file named `package.json` (npm) or a requirements file (PyPI): a `.txt` file whose name contains `requirements` (`requirements.txt`, `requirements-dev.txt`, `dev-requirements.txt`), a bare `requirements`, or a `.txt` file in a directory named `requirements` (`requirements/dev.txt`). Any other file is refused before it is read or anything is looked up, with exit 1: `Error: audit reads package.json or requirements.txt; README.md is neither.` Libraries get partitioned into an "Out of scope" section.

Every dependency that is not in the registry and was not scanned is named in the text output, since each one makes `audit` exit 2: an AI package in the Summary, an unclassified name in the "Unclassified" section, and a library under "Out of scope (libraries)" as `Not found in registry: <names>`.

```bash
ai-trust audit package.json
ai-trust audit requirements.txt
ai-trust audit package.json --min-trust 3                      # require a scan (default 2)
ai-trust audit package.json --scan-missing --contribute        # scan unknown AI packages
```

`--min-trust` defaults to 2 (Listed), so a package that is listed but not yet scanned meets the threshold and exits 0. Pass `--min-trust 3` to fail the gate on any package without a HackMyAgent scan.

Example output for the sample project in [`docs/demo/package.json`](demo/package.json) (five MCP packages, five libraries):

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
ai-trust check server-filesystem --json                                # JSON output for scripting
ai-trust audit package.json --json                                     # JSON audit output
ai-trust check server-filesystem --no-color                            # disable colored output
ai-trust check server-filesystem --registry-url http://localhost:8080  # custom registry endpoint
```

`--registry-url` takes an http or https URL. Any other value stops the command before it runs, with exit code 1 and one line on stderr, `Error: --registry-url must be an http(s) URL, got "<value>". Example: --registry-url https://api.oa2a.org`. With `--json`, the same text is printed on stdout as `{"error": "..."}`.

## Trust levels

| Level | Label | Description |
|---|---|---|
| 0 | Blocked | Package is blocked due to security concerns |
| 1 | Warning | Package has known issues |
| 2 | Listed | Package is listed but not yet scanned |
| 3 | Scanned | Package has been scanned by HackMyAgent |
| 4 | Verified | Package is verified by the publisher |

## Exit codes

| Code | Outcome |
|---|---|
| 0 | Safe: all queried packages are safe and meet the trust threshold |
| 0 | Out of scope: the package is a general-purpose library, not an AI package, and the registry has not flagged it as warning or blocked |
| 0 | Local scan: `check --scan-path` finished scanning the directory and read at least one file, whatever the verdict. On this path a warning or blocked verdict does not yet exit 2 |
| 1 | Operational error: network failure, file not found, server error, or invalid arguments |
| 2 | Warning or blocked: one or more packages have a warning or blocked verdict (except with `check --scan-path`) |
| 2 | Below threshold: one or more packages fall below `--min-trust` (`audit`, `batch`) |
| 2 | Not found: a package is not in the registry and was not scanned locally, or does not exist on npm or PyPI |
| 2 | Local scan could not run: `check --scan-path` found no scanner, or the directory does not exist or could not be scanned. When the directory does not exist or could not be scanned, `--json` prints one object on stdout with `"found": false` and the message as `"error"` |
| 2 | Nothing to scan: `check --scan-path` read 0 files in the directory and found none it could not read, so there is no score or verdict. `--json` prints `"scored": false` and `"filesExamined": 0`. A directory whose files were found but could not be read keeps its score, findings and exit code 0 |
