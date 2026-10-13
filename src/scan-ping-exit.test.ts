/**
 * The exit cap does not end a scan ping the registry is still answering (#129).
 *
 * index.ts ends the process 2 s after a command finishes. The scan ping that
 * `check` sends after a local scan is not awaited by the command, so a
 * registry that answered it later than that had its request cut off. The
 * exit now waits for a ping in flight, and the ping's own 5 s timeout bounds
 * that wait.
 *
 * One local server plays both registries, so the suite runs offline: the npm
 * registry `npm pack` downloads the package from (a packument and a tarball
 * packed here from two files), and the trust registry (no trust data, so
 * `check` scans; the scan ping answered late or never).
 * Exercises the built `dist/index.js` end-to-end.
 */
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { spawn, execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { createServer, type Server, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { join, resolve } from "node:path";
import { tmpdir } from "node:os";

const CLI_PATH = resolve(__dirname, "../dist/index.js");
const PACKAGE = "scan-ping-fixture-pkg";
// TELEMETRY_EXIT_CAP_MS in index.ts, and SCAN_PING_TIMEOUT_MS in contribute.ts.
const EXIT_CAP_MS = 2000;
const SCAN_PING_TIMEOUT_MS = 5000;
// Later than the cap, earlier than the ping's timeout.
const LATE_ANSWER_MS = EXIT_CAP_MS + 1000;

interface PingRecord {
  receivedAt: number;
  /** When the registry answered; undefined when it never did. */
  answeredAt?: number;
  /** When the client closed the connection. */
  clientClosedAt?: number;
}

let scratch: string;
let server: Server;
let baseUrl: string;
let tarballName: string;
let tarball: Buffer;
let pings: PingRecord[];
/** How the trust registry treats the next scan ping. */
let pingAnswerDelayMs: number | "never";
const unanswered: ServerResponse[] = [];

function isolatedEnv(): NodeJS.ProcessEnv {
  // No host config, no consent file, no telemetry; npm reads the fixture
  // registry and keeps its cache in the scratch directory.
  const env: NodeJS.ProcessEnv = {
    PATH: process.env.PATH,
    HOME: join(scratch, "home"),
    XDG_CONFIG_HOME: join(scratch, "home"),
    NO_COLOR: "1",
    CI: "true",
    OPENA2A_TELEMETRY: "off",
    npm_config_registry: baseUrl,
    npm_config_cache: join(scratch, "npm-cache"),
    npm_config_update_notifier: "false",
  };
  if (process.env.TMPDIR) env.TMPDIR = process.env.TMPDIR;
  return env;
}

function startServer(): Promise<Server> {
  const srv = createServer((req, res) => {
    const url = new URL(req.url ?? "/", "http://127.0.0.1");
    const send = (status: number, body: unknown) => {
      res.writeHead(status, { "Content-Type": "application/json" });
      res.end(JSON.stringify(body));
    };
    // npm registry: packument and tarball.
    if (req.method === "GET" && url.pathname === `/${PACKAGE}`) {
      return send(200, {
        name: PACKAGE,
        "dist-tags": { latest: "1.0.0" },
        versions: {
          "1.0.0": {
            name: PACKAGE,
            version: "1.0.0",
            dist: {
              tarball: `${baseUrl}/${PACKAGE}/-/${tarballName}`,
              integrity: `sha512-${createHash("sha512").update(tarball).digest("base64")}`,
            },
          },
        },
      });
    }
    if (req.method === "GET" && url.pathname === `/${PACKAGE}/-/${tarballName}`) {
      res.writeHead(200, { "Content-Type": "application/octet-stream" });
      return res.end(tarball);
    }
    // Trust registry: no data for the package, so `check` scans it.
    if (req.method === "GET") return send(404, { error: "package not found" });
    let body = "";
    req.on("data", (chunk) => (body += chunk));
    req.on("end", () => {
      const isPing = url.pathname === "/api/v1/contribute" && body.includes('"scan_ping"');
      if (!isPing) return send(200, {});
      const ping: PingRecord = { receivedAt: Date.now() };
      pings.push(ping);
      req.socket.on("close", () => (ping.clientClosedAt = Date.now()));
      if (pingAnswerDelayMs === "never") {
        unanswered.push(res);
        return;
      }
      setTimeout(() => {
        ping.answeredAt = Date.now();
        send(200, {});
      }, pingAnswerDelayMs);
    });
  });
  return new Promise((resolveServer) => srv.listen(0, "127.0.0.1", () => resolveServer(srv)));
}

function runCheck(): Promise<{ stdout: string; status: number | null; exitedAt: number }> {
  return new Promise((resolveRun, reject) => {
    // Async spawn, not spawnSync: the fixture server runs in this process.
    const child = spawn(
      process.execPath,
      [CLI_PATH, "check", PACKAGE, "--no-deep", "--contribute", "--json", "--registry-url", baseUrl],
      { cwd: scratch, env: isolatedEnv(), stdio: ["ignore", "pipe", "ignore"] },
    );
    let stdout = "";
    child.stdout.on("data", (chunk) => (stdout += chunk));
    child.on("error", reject);
    child.on("close", (status) => resolveRun({ stdout, status, exitedAt: Date.now() }));
  });
}

beforeAll(async () => {
  scratch = mkdtempSync(join(tmpdir(), "ai-trust-ping-"));
  mkdirSync(join(scratch, "home"));
  server = await startServer();
  baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;

  // The package the fixture npm registry serves, packed from two files.
  const source = join(scratch, "source");
  mkdirSync(source);
  writeFileSync(join(source, "package.json"), JSON.stringify({ name: PACKAGE, version: "1.0.0" }));
  writeFileSync(join(source, "index.js"), "module.exports = 1;\n");
  execFileSync("npm", ["pack", "--pack-destination", scratch], {
    cwd: source,
    env: isolatedEnv(),
    stdio: "pipe",
  });
  tarballName = readdirSync(scratch).find((f) => f.endsWith(".tgz")) ?? "";
  tarball = readFileSync(join(scratch, tarballName));
}, 60000);

afterAll(async () => {
  for (const res of unanswered) res.destroy();
  server.closeAllConnections();
  await new Promise((done) => server.close(done));
  rmSync(scratch, { recursive: true, force: true });
});

describe("exit with a scan ping in flight", () => {
  it("dist/index.js exists and the fixture package was packed", () => {
    expect(existsSync(CLI_PATH)).toBe(true);
    expect(tarballName).toBe(`${PACKAGE}-1.0.0.tgz`);
  });

  it("waits for a ping the registry answers after the cap, then exits", async () => {
    if (!existsSync(CLI_PATH)) return;
    pings = [];
    pingAnswerDelayMs = LATE_ANSWER_MS;
    const { stdout, status, exitedAt } = await runCheck();

    expect(status).toBe(0);
    expect(JSON.parse(stdout).source).toBe("scan");
    expect(pings).toHaveLength(1);
    const [ping] = pings;
    // The registry answered, and the client was still connected when it did.
    expect(ping.answeredAt).toBeDefined();
    expect(ping.clientClosedAt ?? Infinity).toBeGreaterThanOrEqual(ping.answeredAt as number);
    expect(exitedAt).toBeGreaterThanOrEqual(ping.answeredAt as number);
    // Answered: the process does not go on waiting for the ping's timeout.
    expect(exitedAt - ping.receivedAt).toBeLessThan(SCAN_PING_TIMEOUT_MS);
  }, 60000);

  it("gives up on a ping the registry never answers when the ping's timeout fires", async () => {
    if (!existsSync(CLI_PATH)) return;
    pings = [];
    pingAnswerDelayMs = "never";
    const { stdout, status, exitedAt } = await runCheck();

    expect(status).toBe(0);
    expect(JSON.parse(stdout).source).toBe("scan");
    expect(pings).toHaveLength(1);
    const waitedMs = exitedAt - pings[0].receivedAt;
    // Past the cap, since the ping was in flight; ended by the ping's timeout.
    expect(waitedMs).toBeGreaterThan(SCAN_PING_TIMEOUT_MS - 1500);
    expect(waitedMs).toBeLessThan(SCAN_PING_TIMEOUT_MS + 3000);
  }, 60000);
});
