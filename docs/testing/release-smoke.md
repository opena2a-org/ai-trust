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
npm test                  # all green (baseline: 169 tests)
```

Fail the release if any step is red.

---

## 1. Help and version (1 min)

```bash
node dist/index.js --version    # prints: ai-trust 0.x.x + telemetry disclosure
node dist/index.js --help       # lists check, batch, audit, telemetry subcommands
node dist/index.js check -h     # check-specific options
node dist/index.js audit -h     # audit-specific options
node dist/index.js batch -h     # batch-specific options
```

The `--version` output must be two lines:
```
ai-trust 0.x.x
Telemetry: on (opt-out: OPENA2A_TELEMETRY=off  •  details: opena2a.org/telemetry)
```

If the second line is missing, the `versionLine()` helper isn't wired or the
SDK init failed silently.

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
$AI check express --no-scan              # expects "Out of scope" + HMA CTA, exit 2

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
echo -e "fastapi==0.109.0\npydantic>=2.0\nrequests" > /tmp/test-req.txt
$AI audit /tmp/test-req.txt               # PyPI packages, ecosystem: pypi

# --- Edge cases ---
$AI check nonexistent-xyz-999 --no-scan   # not found, exit 2
$AI batch                                  # error: no args, exit 1
```

For each command verify:
1. Output is produced — not silent, no hang
2. No `require is not defined`, `ERR_REQUIRE_ESM`, or unhandled rejection
3. Exit codes: 0 for success, 1 for errors/high-risk, 2 for not-found/out-of-scope
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
$AI audit /tmp/test-req.txt --json 2>&1 | \
  python3 -c "import sys,json; d=json.load(sys.stdin); \
  pkgs=[p for p in d.get('packages',[]) if p.get('ecosystem')=='npm' and 'requirements' in str(d)]; \
  print('BAD: pypi packages show npm' if pkgs else 'OK')"
# Expected: OK
```

Fail the release if any regression check does not produce the expected output.

---

## 5. Telemetry (2 min)

**Do NOT point at the production endpoint while smoking.**

```bash
export OPENA2A_TELEMETRY_URL=http://127.0.0.1:1/never
unset OPENA2A_TELEMETRY
```

| # | Command | Expected |
|---|---|---|
| 5.1 | `node dist/index.js --version` | Two lines: version + `Telemetry: on (opt-out: ...)` |
| 5.2 | `node dist/index.js telemetry status` | `state: on`, install_id, config path, toggle hint |
| 5.3 | `node dist/index.js telemetry off` | `Telemetry disabled for ai-trust.` |
| 5.4 | `node dist/index.js telemetry on` | Re-enables persistently |
| 5.5 | `OPENA2A_TELEMETRY=off node dist/index.js telemetry status` | `state: off` (env wins) |
| 5.6 | `OPENA2A_TELEMETRY_DEBUG=print node dist/index.js check express --no-scan 2>&1 \| grep opena2a:telemetry` | JSON payload: `tool: "ai-trust"`, `event: "command"`, `name: "check"`, `success: true`, `duration_ms: <int>`. No PII. |
| 5.7 | `node dist/index.js check express --no-scan` (unreachable URL) | Completes. Telemetry timeout ≤ 2 s. |

Fail the release if:
- Version disclosure line is absent
- Debug payload contains package names, file paths, or trust scores
- Any command blocks > 2 s when the telemetry endpoint is unreachable

```bash
unset OPENA2A_TELEMETRY_URL
```

---

## 6. Cleanup

```bash
rm -f /tmp/test-req.txt
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
