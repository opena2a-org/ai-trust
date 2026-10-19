# ai-trust release smoke test

**Run before every tag push to `v*`. ~20 minutes by hand.**

Every item came from a real bug or data-accuracy gap that shipped. Don't skip
without writing down why.

Run every command from a clean clone. Use `node dist/index.js` not the global
install. Capture exact output for the `USER_VISIBLE_IMPACT:` marker.

---

## 0. Build + tests (2 min)

```bash
cd ai-trust
git status                # clean, or only the branch you intend to ship
npm ci                    # lockfile valid
npm run build             # zero output, zero errors
npm run docs:capture      # re-captures the README's first command from this build; commit the three files it writes
npm test                  # all green
npx vitest list | wc -l   # test count; must not be lower than on the last release tag
npm run docs:links        # exit 0: each URL the docs and the CLI cite resolves
```

Fail the release if any step is red, or if the test count dropped since the last
release tag without a changelog line saying which tests were removed and why.
The baseline is measured, not written down here (a number in this file goes stale
with the next test added): check the last tag out into a scratch worktree and count
there.

```bash
git worktree add /tmp/ai-trust-baseline v0.x.y    # the last release tag
(cd /tmp/ai-trust-baseline && npm ci && npx vitest list | wc -l)
git worktree remove /tmp/ai-trust-baseline
```

---

## 1. Help and version (1 min)

```bash
node dist/index.js --version              # prints: ai-trust 0.x.x + telemetry disclosure
node dist/index.js --version 2>/dev/null  # stdout ONLY: single clean line `ai-trust 0.x.x`
node dist/index.js --version 2>&1 1>/dev/null  # stderr ONLY: telemetry disclosure
node dist/index.js --help       # lists check, audit, batch, config, telemetry subcommands
node dist/index.js check -h     # check-specific options
node dist/index.js audit -h     # audit-specific options
node dist/index.js batch -h     # batch-specific options
```

As of cli-ui 0.5.2 the `--version` output is stream-split: the bare version
goes to **stdout** as a single parseable line, and the telemetry disclosure
goes to **stderr**:
```
# stdout
ai-trust 0.x.x
# stderr
Telemetry: on (opt-out: OPENA2A_TELEMETRY=off  •  details: opena2a.org/telemetry)
```

If the stderr line is missing, the `versionLineParts()` helper isn't wired or
the SDK init failed silently. If the telemetry line leaks into stdout, the
manual `option:version` handler regressed back to Commander's `.version()`.

---

## 2. New-user command walkthrough — 20 commands (10 min)

Run every command. Each must produce output, return the correct exit code, and
have no stack traces or `require is not defined` errors.

```bash
AI=node\ dist/index.js   # alias

# --- Basic ---
$AI --version
$AI --help
$AI check -h
$AI audit -h
$AI batch -h

# --- Single check: native (Tier 1) ---
$AI check @modelcontextprotocol/server-filesystem --no-scan
$AI check server-filesystem --no-scan     # shorthand resolves to @modelcontextprotocol/server-filesystem

# --- Single check: out-of-scope (Tier 3) ---
$AI check express --no-scan              # expects "Out of scope" + HMA CTA, exit 0

# --- Not found ---
$AI check @anthropic-ai/claude-code --no-scan   # not in registry, exit 2

# --- Flags ---
$AI check express --json --no-scan      # JSON output on stdout, no color
$AI check express --no-color --no-scan  # plain text, no ANSI escapes

# --- Batch ---
$AI batch react vue express lodash chalk          # all Tier 3 → partitioned table
$AI batch mcp-server-kubernetes mcp-server-docker mcp-server-git

# --- Audit ---
$AI audit package.json                            # partitions by tier
mkdir -p /tmp/ai-trust-req
echo -e "fastapi==0.109.0\npydantic>=2.0\nrequests" > /tmp/ai-trust-req/requirements.txt
$AI audit /tmp/ai-trust-req/requirements.txt   # PyPI packages, ecosystem: pypi

# --- Edge cases ---
$AI check nonexistent-xyz-999 --no-scan   # not found, exit 2
$AI batch                                  # error: no args, exit 1
$AI audit README.md                        # refused before any lookup, exit 1
```

For each command verify:
1. Output is produced — not silent, no hang
2. No `require is not defined`, `ERR_REQUIRE_ESM`, or unhandled rejection
3. Exit codes: 0 for safe or out-of-scope, 1 for operational errors, 2 for
   warning, blocked, below `--min-trust` or not-found (see the exit-code table in docs/commands.md)
4. No stack traces in normal paths (stderr is acceptable for debug log lines)
5. No BLOCKED verdict for a general-purpose library like `express` (it must be
   "Out of scope" Tier 3, not "BLOCKED")

---

## 3. Data accuracy check — 3 packages (5 min)

Pick 3 packages that show real scores in the registry (scan status = completed,
not unscanned). Compare registry score against a fresh HMA scan. Divergence
> 20 points means the registry data is stale or the scoring model changed.

```bash
# Registry score
node dist/index.js check <pkg> --no-scan --json 2>&1 | \
  python3 -c "import sys,json; d=json.load(sys.stdin); \
  print(f'Registry: {round(d.get(\"trustScore\",0)*100)}/100  scan={d.get(\"scanStatus\")}')"

# Fresh local scan (in a temp dir to avoid contamination)
mkdir -p /tmp/ai-trust-verify && cd /tmp/ai-trust-verify
npm pack <pkg> --pack-destination . && tar xzf *.tgz
npx hackmyagent secure --format json --deep package 2>/dev/null | \
  python3 -c "import sys,json,re; m=re.search(r'\{.*\}',sys.stdin.read(),re.DOTALL); \
  d=json.loads(m.group()); print(f'HMA: {d[\"score\"]}/{d[\"maxScore\"]} findings={len([f for f in d[\"findings\"] if not f[\"passed\"]])}')"
cd - && rm -rf /tmp/ai-trust-verify
```

Suggested packages (rotate to keep checks fresh):
- `@modelcontextprotocol/server-filesystem` — should have a real HMA score
- `mcp-server-git` — standalone third-party MCP
- One A2A agent or skill from the registry

Fail the release if:
- Registry score and fresh HMA scan differ by > 20 points without a known reason
  (e.g. HMA version bump since last registry scan)
- `scanStatus` is not `completed` for a package that should be scanned (indicates
  registry pipeline is stale)

If scores diverge: investigate before publishing. Possible causes: stale registry
data, HMA version mismatch, scoring model change. Do not publish with unresolved
divergence — users see the registry score, not the fresh scan.

---

## 4. Regression checks (2 min)

These are the exact regressions that shipped in prior releases. Verify each:

```bash
AI=node\ dist/index.js

# R1 — ESM crash (v0.2.10): require is not defined
$AI check express --no-scan 2>&1 | grep -i "require is not defined"
# Expected: no output (grep returns 1)

# R2 — mcp-server-* shorthand (v0.2.11): must NOT resolve to @modelcontextprotocol
$AI check mcp-server-kubernetes --no-scan --json 2>&1 | \
  python3 -c "import sys,json; d=json.load(sys.stdin); \
  print('BAD' if '@modelcontextprotocol' in str(d.get('name','')) else 'OK')"
# Expected: OK  (mcp-server-kubernetes is NOT under @modelcontextprotocol)

# R3 — server-* shorthand DOES resolve (inverse of R2)
$AI check server-filesystem --no-scan --json 2>&1 | \
  python3 -c "import sys,json; d=json.load(sys.stdin); \
  print('OK' if '@modelcontextprotocol' in str(d.get('name','')) else 'BAD')"
# Expected: OK  (server-filesystem resolves to @modelcontextprotocol/server-filesystem)

# R4 — exit code 2 for not-found (not 1)
$AI check nonexistent-xyz-999 --no-scan; echo "exit: $?"
# Expected: exit: 2

# R5 — Python packages parsed as pypi ecosystem
# (< /dev/null keeps the "Scan locally?" prompt from waiting on a terminal)
$AI audit /tmp/ai-trust-req/requirements.txt --json < /dev/null 2>/dev/null | \
  python3 -c "import sys,json; r=json.load(sys.stdin).get('results',[]); \
  print('OK' if r and all(p.get('ecosystem')=='pypi' for p in r) \
  else 'BAD: ' + str([(p.get('name'), p.get('ecosystem')) for p in r]))"
# Expected: OK  (an empty or missing results array, or any entry that is not
# pypi, prints BAD; so does an error response, which carries no results)
```

Fail the release if any regression check does not produce the expected output.

---

## 5. Telemetry (2 min)

**Do NOT point at the production endpoint while smoking.**

```bash
# 192.0.2.1 (TEST-NET-1) is not routed: the connect hangs, as it does behind a
# firewall that drops egress. A refused port such as 127.0.0.1:1 fails at once
# and cannot show a stall.
export OPENA2A_TELEMETRY_URL=http://192.0.2.1/never
unset OPENA2A_TELEMETRY
```

| # | Command | Expected |
|---|---|---|
| 5.1 | `node dist/index.js --version` | Version line on **stdout** (`ai-trust 0.x.x`, single line) + `Telemetry: on (opt-out: ...)` on **stderr**. `--version 2>/dev/null` shows only the version; `--version 2>&1 1>/dev/null` shows only the telemetry line. |
| 5.2 | `node dist/index.js telemetry status` | `state: on`, install_id, config path, toggle hint |
| 5.3 | `node dist/index.js telemetry off` | `Telemetry disabled for ai-trust and hackmyagent, which share the config file below.` |
| 5.4 | `node dist/index.js telemetry on` | Re-enables persistently |
| 5.5 | `OPENA2A_TELEMETRY=off node dist/index.js telemetry status` | `state: off` (env wins) |
| 5.6 | `OPENA2A_TELEMETRY_DEBUG=print node dist/index.js check express --no-scan 2>&1 \| grep opena2a:telemetry` | JSON payload: `tool: "ai-trust"`, `event: "command"`, `name: "check"`, `success: true`, `duration_ms: <int>`. No PII. |
| 5.7 | `time node dist/index.js check express --no-scan`, then the same with `OPENA2A_TELEMETRY=off` (unreachable URL) | Both complete. Telemetry timeout ≤ 2 s: the first run takes at most about 2 s longer than the second, not about 10 s. |
| 5.8 | `node dist/index.js --help`, then `OPENA2A_TELEMETRY=off node dist/index.js --help` | The line under `Telemetry:` reads `Usage telemetry is on and each event carries a persistent install ID. Disable: OPENA2A_TELEMETRY=off`, then `Usage telemetry is off. Enable: unset OPENA2A_TELEMETRY and run ai-trust telemetry on`. Each matches the state 5.1 and 5.5 print. Neither help says "anonymous". The contribution line below it is the same in both helps. |
| 5.9 | With `H=$(mktemp -d)`: `OPENA2A_HOME=$H node dist/index.js --help`, then `OPENA2A_HOME=$H node dist/index.js config contribute off` and `OPENA2A_HOME=$H node dist/index.js --help`, then `OPENA2A_HOME=$H node dist/index.js config contribute on` and `OPENA2A_HOME=$H node dist/index.js --help`. Run no scan with `$H`. | The second line under `Telemetry:` reads `Community contribution: not set (scan results are not shared). Enable: ai-trust config contribute on, or pass --contribute to check or audit for one scan`, then `Community contribution: disabled. Saved as off, so scan results are not shared. Enable: ai-trust config contribute on`, then `Community contribution: enabled. Package scan results are shared with the OpenA2A Registry. Keep a scan's results on this machine: --no-contribute. Disable: ai-trust config contribute off`. Each starts with the line `OPENA2A_HOME=$H node dist/index.js config contribute status` prints in that state. |

Fail the release if:
- Version disclosure line is absent
- The `--help` telemetry line states a different state than `--version` in the same environment
- The `--help` contribution line states a different choice than `config contribute status` with the same `OPENA2A_HOME`
- Debug payload contains package names, file paths, or trust scores
- Any command blocks > 2 s when the telemetry endpoint is unreachable

```bash
unset OPENA2A_TELEMETRY_URL
```

---

## 6. Cleanup

```bash
rm -rf /tmp/ai-trust-req
# Restore telemetry config if overwritten:
# rm ~/.config/opena2a/telemetry.json
```

---

## When this checklist isn't enough

- If the diff touches the AI classifier (Tier 1/2/3 routing): verify that no
  general-purpose library gets a trust verdict, and that all known-AI packages
  still route correctly. The classifier is the single source of truth.
- If the diff touches the registry API client: re-run the data accuracy check
  with 5 packages (not 3) and confirm the JSON shapes haven't drifted.
- If a regression ships that would have been caught by an item NOT on this list:
  add the item here as part of the fix.
