/**
 * An unreachable telemetry endpoint must not hold the process open.
 *
 * The telemetry sender aborts its request after 2 s, but an aborted connect to
 * an address that drops packets keeps the socket, and the process, alive until
 * the socket's own connect timeout (about 10 s). index.ts caps the exit. A
 * refused port (127.0.0.1:1) fails fast and cannot show the stall, so these
 * tests use 192.0.2.1 (TEST-NET-1, RFC 5737), which is not routed.
 *
 * `audit` is a tracked command; on a manifest with no dependencies, or on a
 * missing file, it finishes without the registry, so the suite runs offline.
 * Exercises the built `dist/index.js` end-to-end.
 */
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { resolve, join } from "node:path";
import { tmpdir } from "node:os";

const CLI_PATH = resolve(__dirname, "../dist/index.js");
const DROPPED_ENDPOINT = "http://192.0.2.1/never";
// Without the cap the run takes the connect timeout (about 10 s); with it,
// the 2 s request abort plus process startup.
const MAX_WALL_MS = 6000;

let workDir: string;

beforeAll(() => {
  workDir = mkdtempSync(join(tmpdir(), "ai-trust-exit-cap-"));
  writeFileSync(
    join(workDir, "package.json"),
    JSON.stringify({ name: "fixture", version: "1.0.0", dependencies: {} }),
  );
});

afterAll(() => {
  rmSync(workDir, { recursive: true, force: true });
});

function runAudit(file: string): { stderr: string; status: number | null; wallMs: number } {
  const startedAt = Date.now();
  const res = spawnSync(process.execPath, [CLI_PATH, "audit", file], {
    encoding: "utf8",
    timeout: 30000,
    env: {
      ...process.env,
      NODE_OPTIONS: "",
      NO_COLOR: "1",
      OPENA2A_TELEMETRY: "on",
      OPENA2A_TELEMETRY_DEBUG: "print",
      OPENA2A_TELEMETRY_URL: DROPPED_ENDPOINT,
      // A fresh config directory, so a persisted opt-out on the host cannot
      // turn the send off.
      XDG_CONFIG_HOME: join(workDir, "config"),
    },
  });
  return { stderr: res.stderr ?? "", status: res.status, wallMs: Date.now() - startedAt };
}

describe("exit with an unreachable telemetry endpoint", () => {
  it("dist/index.js exists", () => {
    expect(existsSync(CLI_PATH)).toBe(true);
  });

  it("a tracked command exits within the cap and keeps exit code 0", () => {
    if (!existsSync(CLI_PATH)) return;
    const { stderr, status, wallMs } = runAudit(join(workDir, "package.json"));
    // The event was sent, so the stuck socket was exercised.
    expect(stderr).toMatch(/\[opena2a:telemetry\] .*"name":"audit"/);
    expect(status).toBe(0);
    expect(wallMs).toBeLessThan(MAX_WALL_MS);
  }, 40000);

  it("a tracked command that fails exits within the cap and keeps its exit code", () => {
    if (!existsSync(CLI_PATH)) return;
    const { stderr, status, wallMs } = runAudit(join(workDir, "missing.json"));
    expect(stderr).toMatch(/File not found/);
    expect(stderr).toMatch(/\[opena2a:telemetry\] .*"name":"audit"/);
    expect(status).toBe(1);
    expect(wallMs).toBeLessThan(MAX_WALL_MS);
  }, 40000);
});
