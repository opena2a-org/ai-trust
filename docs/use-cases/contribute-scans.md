# I want to contribute trust data to the community

Time: 3 min.

## Steps

### 1. Enable contribution

The first time you scan a package that has no community trust data, ai-trust asks whether to share the result and saves your answer in `~/.opena2a/config.json`. The setting is shared across all OpenA2A tools (opena2a-cli, hackmyagent, ai-trust).

To save the preference up front, use opena2a-cli:

```bash
opena2a config set contribute true
```

To contribute a single scan without saving a preference (non-interactive shells and CI), pass `--contribute`:

```bash
ai-trust check some-package --scan-if-missing --contribute
```

### 2. Run scans as usual

With contribution enabled, every scan you run automatically shares results with the OpenA2A Registry:

```bash
ai-trust check some-package
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
opena2a config contribute off
```

To skip a single scan, pass `--no-contribute` to `ai-trust check` or `ai-trust audit`.

Or:

```bash
opena2a config set contribute false
```

Your local scan results continue to work. Only the anonymous telemetry submission stops.
