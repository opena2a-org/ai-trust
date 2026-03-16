# I want to contribute trust data to the community

Time: 1 minute setup, then automatic.

## Steps

### 1. Enable contribution

```bash
ai-trust config contribute on
```

This saves your preference in `~/.opena2a/config.json`. The setting is shared across all OpenA2A tools (opena2a-cli, hackmyagent, ai-trust).

Alternatively, configure via opena2a-cli:

```bash
opena2a config set contribute true
```

### 2. Run scans as usual

With contribution enabled, every scan you run automatically shares results with the OpenA2A Registry:

```bash
ai-trust check some-package --scan-if-missing
```

No extra flags or steps needed. Scan results are submitted in the background after each scan completes.

### 3. How contribution improves trust scores

The OpenA2A Registry uses community-contributed scan data to calculate trust scores:

- **More scans = higher confidence.** A package scanned by 50 contributors has a more reliable trust score than one scanned by 1.
- **Packages move up trust levels.** Contributions help packages move from "Listed" (level 2) to "Scanned" (level 3), reducing risk for everyone.
- **Stale data gets refreshed.** When you re-scan a package, the registry receives updated findings, keeping trust data current.

### 4. What data is shared (and what is not)

**Shared (anonymized telemetry):**

- Package name and version scanned
- Finding counts by severity (e.g., 0 critical, 1 high, 3 medium)
- Check pass/fail status per security rule
- Timestamp of the scan

**Never shared:**

- File paths from your system
- Source code or file contents
- Finding descriptions or remediation details
- Your identity, IP address, or machine information

## Opt out at any time

```bash
ai-trust config contribute off
```

Or:

```bash
opena2a config set contribute false
```

Your local scan results continue to work. Only the anonymous telemetry submission stops.
