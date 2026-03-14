> **[OpenA2A](https://github.com/opena2a-org/opena2a)**: [CLI](https://github.com/opena2a-org/opena2a) · [HackMyAgent](https://github.com/opena2a-org/hackmyagent) · [Secretless AI](https://github.com/opena2a-org/secretless-ai) · [AIM](https://github.com/opena2a-org/agent-identity-management) · [Browser Guard](https://github.com/opena2a-org/AI-BrowserGuard) · [DVAA](https://github.com/opena2a-org/damn-vulnerable-ai-agent) · [Homebrew Tap](https://github.com/opena2a-org/homebrew-tap) · **ai-trust**

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

## Commands

### check

Look up the trust verdict for a single package.

```bash
ai-trust check @modelcontextprotocol/server-filesystem
```

Specify the package type explicitly:

```bash
ai-trust check my-agent --type a2a_agent
```

### audit

Parse `package.json` or `requirements.txt` and batch-query all dependencies.

```bash
ai-trust audit package.json
ai-trust audit requirements.txt
```

Set a minimum trust level threshold (default: 3):

```bash
ai-trust audit package.json --min-trust 2
```

### batch

Look up trust verdicts for multiple packages at once.

```bash
ai-trust batch express lodash chalk commander
```

Apply the same type to all packages:

```bash
ai-trust batch my-server-a my-server-b --type mcp_server
```

## Output Options

Get raw JSON for scripting:

```bash
ai-trust check express --json
ai-trust audit package.json --json
```

Use a custom registry URL:

```bash
ai-trust check express --registry-url http://localhost:8080
```

Disable colored output:

```bash
ai-trust check express --no-color
```

## Exit Codes

| Code | Meaning |
|------|---------|
| 0 | All queried packages are safe |
| 1 | One or more packages have warnings, are blocked, or fall below the trust threshold |

## Trust Levels

| Level | Label | Description |
|-------|-------|-------------|
| 0 | Blocked | Package is blocked due to security concerns |
| 1 | Warning | Package has known issues |
| 2 | Listed | Package is listed but not yet scanned |
| 3 | Scanned | Package has been scanned by HackMyAgent |
| 4 | Verified | Package is verified by the publisher |

## Requirements

- Node.js 18 or later

## Development

```bash
git clone https://github.com/opena2a-org/ai-trust.git
cd ai-trust
npm install
npm run build
```

Run locally without installing globally:

```bash
node dist/index.js check express
```

## Links

- [OpenA2A](https://opena2a.org)
- [OpenA2A Registry](https://registry.opena2a.org)

## License

Apache-2.0
