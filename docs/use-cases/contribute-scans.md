# I want to contribute trust data to the community

Time: 3 min.

## Steps

### 1. Enable contribution

`ai-trust check` never asks whether to share: it shares a scan only when contribution is enabled or you pass `--contribute`. `ai-trust audit` on a terminal asks after it scans packages that the registry does not have, unless contribution is already enabled, you answered no to that question or ran `ai-trust config contribute off`, or you pass `--contribute` or `--no-contribute`. It saves your answer in `~/.opena2a/config.json`. The setting is shared across all OpenA2A tools (opena2a-cli, hackmyagent, ai-trust). A no saved by ai-trust 0.7.6, or an off saved by hackmyagent, carries no mark of a choice. ai-trust reads it as a no, and marks it, when it finds it with fewer than three scans counted in that file; from the third counted scan on it looks the same as no choice at all, so `audit` still asks. Answering it or running `ai-trust config contribute off` records the choice.

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

The check counts travel in a summary that the contribute library queues in `~/.opena2a/contribute-queue.json` only when contribution is saved as on, and the contributor token goes with each batch of queued summaries. A scan shared with `--contribute` alone sends the other fields and queues no summary of its own. A run that shares also sends the summaries still queued from earlier runs, with the contributor token: a summary stays queued when its upload failed while contribution was saved as on, and `ai-trust config contribute off` does not remove it.

**Shared by the bundled scanner (hackmyagent): no telemetry, no scan results, and no file with any LLM provider.**

ai-trust runs the scanner with your saved choices out of its reach, with its usage telemetry off (`OPENA2A_TELEMETRY=off`), with `--no-contribute`, and without `ANTHROPIC_API_KEY` in its environment. During an ai-trust scan, the scanner sends no classification telemetry, no usage events and no scan results, whatever `~/.opena2a/config.json` and `~/.hackmyagent/config.json` hold, and it changes neither file. With `ANTHROPIC_API_KEY` set in your shell, the scanner still runs without it, so a deep scan sends no file to any LLM provider.

**Never shared, with the registry or with any LLM provider:**

- File paths from your system
- Source code or file contents
- Finding names, messages, descriptions or remediation details
- Your identity, IP address, hostname or username

## Opt out at any time

```bash
ai-trust config contribute off
```

To skip a single scan, pass `--no-contribute` to `ai-trust check` or `ai-trust audit`: ai-trust then shares nothing from that scan, and the bundled scanner (hackmyagent) sends no telemetry, no scan results and no file to any LLM provider from any ai-trust scan.

Or, with opena2a-cli installed:

```bash
opena2a config contribute off
```

Your local scan results continue to work. Only the telemetry submission stops.

## Community contribution

Every scan you run can improve trust data for the entire community. A contributed scan carries the package name, version and ecosystem, the score and verdict, the project type, and for each check its ID, pass/fail, severity, category and attack class. No file paths, source code, finding names, messages or descriptions. With contribution saved as on, it also queues a summary with check counts by severity. The queued summaries go out with this run or with a later run that shares, and each batch of them carries a pseudonymous contributor token: a SHA-256 hash of the hostname, username and a random salt that stays on your machine, so the hostname and username themselves are never sent.

The bundled scanner (hackmyagent) sends no telemetry or scan results of its own during an ai-trust scan: ai-trust keeps your saved choice out of its reach, so the choice decides only what ai-trust shares. ai-trust also runs the scanner without `ANTHROPIC_API_KEY`, so the scanner sends no file to any LLM provider. [What data is shared](#4-what-data-is-shared-and-what-is-not) lists the fields.

No scan results are shared until you opt in. `check` never asks: after a few scans without a choice, it prints a tip on how to opt in. `audit` on a terminal asks whether to share after it scans packages the registry does not have, unless contribution is already on, you answered no to that question or ran `ai-trust config contribute off`, or you pass `--contribute` or `--no-contribute`. A no saved by ai-trust 0.7.6 or an off saved by hackmyagent counts as a no when ai-trust finds it with fewer than three scans counted; after that it looks like no choice, so `audit` still asks. Answering it or running `ai-trust config contribute off` records the choice. A global choice is saved in `~/.opena2a/config.json` and shared across all OpenA2A tools (`opena2a-cli`, `hackmyagent`).

```bash
ai-trust check @modelcontextprotocol/server-filesystem --contribute   # contribute for this scan (non-interactive / CI)
ai-trust config contribute on                  # opt in globally
ai-trust config contribute off                 # opt out globally
ai-trust config contribute status              # show the saved choice
```

With opena2a-cli installed, `opena2a config contribute on` and `opena2a config contribute off` change the same setting.

More scans contributed means packages move from "Listed" to "Scanned" faster, reducing risk for everyone.
