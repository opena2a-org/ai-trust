# I want to contribute trust data to the community

Time: 3 min.

## Steps

### 1. Enable contribution

`ai-trust check` never asks whether to share: it shares a scan only when contribution is enabled or you pass `--contribute`. `ai-trust audit` on a terminal asks after it scans packages that the registry does not have, unless contribution is already enabled, you answered no to that question or ran `ai-trust config contribute off`, or you pass `--contribute` or `--no-contribute`. It saves your answer in `~/.opena2a/config.json`. The setting is shared across all OpenA2A tools (opena2a-cli, hackmyagent, ai-trust). A no saved by ai-trust 0.7.6, or an off saved by hackmyagent, is stored the same way as no choice at all, so `audit` still asks; answering it or running `ai-trust config contribute off` records the choice.

To save the preference up front:

```bash
ai-trust config contribute on
```

With opena2a-cli installed, `opena2a config contribute on` does the same.

Check the saved choice at any time:

```bash
ai-trust config contribute status
```

To contribute a single scan without saving a preference (non-interactive shells and CI), pass `--contribute`:

```bash
ai-trust check some-package --contribute
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

**Shared by ai-trust (pseudonymous telemetry):**

- Package name, version and ecosystem (`npm` or `pypi`) of the package scanned, and the package type when you pass `--type`
- Score and maximum score, verdict and project type (for example `library` or `mcp_server`)
- Check counts: total, passed, and failed by severity (e.g., 0 critical, 1 high, 3 medium), and a duration field that ai-trust always sends as 0
- Per security check: check ID, pass/fail, severity, category and attack class (the `name` field repeats the check ID and the `message` field is empty)
- Tool name and version, the kind of event, and the timestamps of the scan and of the submission
- A contributor token: a pseudonymous per-device identifier, the SHA-256 hash of your hostname, username and a random salt stored only on your machine (`~/.opena2a/contributor-salt`). It links contributions from the same device to each other; it does not contain your hostname or username. The scan ping sends the fixed word `anonymous` in its place.

**Shared by the bundled scanner (hackmyagent), when contribution is saved as on:**

On a default scan (not with `--no-deep`), the scanner sends classification telemetry for the files its NanoMind classifier reads:

- The scanner's name and version
- Per classified file: the content type (for example `source_code` or `skill`), a SHA-256 hash of the file's content, the classification and its confidence, the verdict, the model version and a timestamp

It carries no package name, no file path and no contributor token. The hash is not the content, but it is the same for anyone who has an identical file. This telemetry follows only the saved choice: `--contribute` on a single scan does not send it, `--no-contribute` does not stop it, and it is also sent when you scan a local directory with `ai-trust check <name> --scan-path <dir>`.

**Never shared:**

- File paths from your system
- Source code or file contents (the scanner's classification telemetry carries a hash of each classified file, not the file)
- Finding names, messages, descriptions or remediation details
- Your identity, IP address, hostname or username

## Opt out at any time

```bash
ai-trust config contribute off
```

To skip a single scan, pass `--no-contribute` to `ai-trust check` or `ai-trust audit`: ai-trust then shares nothing from that scan. If contribution is saved as on, the bundled scanner (hackmyagent) still sends its classification telemetry for a default scan: for each file it classifies, a content type, a SHA-256 hash of the content and the classification result. `--no-contribute` does not stop that. Add `--no-deep`, or turn contribution off as shown above, to stop it.

Or, with opena2a-cli installed:

```bash
opena2a config contribute off
```

Your local scan results continue to work. Only the telemetry submission stops.

## Community contribution

Every scan you run can improve trust data for the entire community. A contributed scan carries the package name, version and ecosystem, the score and verdict, the project type, check counts by severity, and for each check its ID, pass/fail, severity, category and attack class. No file paths, source code, finding names, messages or descriptions. Contributions from one device share a pseudonymous contributor token: a SHA-256 hash of the hostname, username and a random salt that stays on your machine, so the hostname and username themselves are never sent.

When contribution is saved as on, the bundled scanner (hackmyagent) also sends classification telemetry on a default scan: for each file its classifier reads, the content type, a SHA-256 hash of the content, the classification, confidence, verdict and model version, with no package name or file path. `--no-contribute` does not stop it; `--no-deep` or turning contribution off does. [What data is shared](#4-what-data-is-shared-and-what-is-not) lists the fields.

No scan results are shared until you opt in. `check` never asks: after a few scans without a choice, it prints a tip on how to opt in. `audit` on a terminal asks whether to share after it scans packages the registry does not have, unless contribution is already on, you answered no to that question or ran `ai-trust config contribute off`, or you pass `--contribute` or `--no-contribute`. A no saved by ai-trust 0.7.6 or an off saved by hackmyagent looks like no choice, so `audit` still asks; answering it or running `ai-trust config contribute off` records the choice. A global choice is saved in `~/.opena2a/config.json` and shared across all OpenA2A tools (`opena2a-cli`, `hackmyagent`).

```bash
ai-trust check @modelcontextprotocol/server-filesystem --contribute   # contribute for this scan (non-interactive / CI)
ai-trust config contribute on                  # opt in globally
ai-trust config contribute off                 # opt out globally
ai-trust config contribute status              # show the saved choice
```

With opena2a-cli installed, `opena2a config contribute on` and `opena2a config contribute off` change the same setting.

More scans contributed means packages move from "Listed" to "Scanned" faster, reducing risk for everyone.
