# oa2a

Command-line tool for querying the [OpenA2A Registry](https://registry.opena2a.org) trust API. Look up trust verdicts, scores, CVE counts, and dependency risk for packages in the registry.

## Install

```bash
npm install -g oa2a
```

Or run directly with npx:

```bash
npx oa2a check @modelcontextprotocol/server-filesystem
```

## Usage

### Check a single package

```bash
oa2a check @modelcontextprotocol/server-filesystem
```

Specify the package type explicitly:

```bash
oa2a check my-agent --type a2a_agent
```

### Audit dependencies from a project file

Parse `package.json` or `requirements.txt` and batch-query all dependencies:

```bash
oa2a audit package.json
oa2a audit requirements.txt
```

Set a minimum trust level threshold (default: 3):

```bash
oa2a audit package.json --min-trust 2
```

### Batch lookup for multiple packages

```bash
oa2a batch express lodash chalk commander
```

Apply the same type to all packages:

```bash
oa2a batch my-server-a my-server-b --type mcp_server
```

### Output options

Get raw JSON output for scripting:

```bash
oa2a check express --json
oa2a audit package.json --json
```

Use a custom registry URL:

```bash
oa2a check express --registry-url http://localhost:8080
```

Disable colored output:

```bash
oa2a check express --no-color
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
git clone https://github.com/opena2a-org/oa2a.git
cd oa2a
npm install
npm run build
```

Run locally without installing globally:

```bash
node dist/index.js check express
```

## License

Apache-2.0
