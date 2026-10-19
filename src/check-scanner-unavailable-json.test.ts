/**
 * With `--json`, a `check` whose pinned scanner cannot be started prints one
 * JSON object with the error on stdout, not text on stderr (#235): with
 * `--scan-path`, and in the default flow, which asks the registry first.
 *
 * Exercises the built `dist/index.js` end-to-end, from a copy of the package
 * whose node_modules links every dependency except hackmyagent. In its place
 * is a stand-in that writes one line to standard error and exits 1 on any
 * run, `--version` included. The registry is a server on 127.0.0.1 that
 * answers every request with 404.
 */
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { spawn } from "node:child_process";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import {
  cpSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  realpathSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { join, resolve } from "node:path";
import { tmpdir } from "node:os";
import { shellArg } from "./utils/shell-arg.js";

const ROOT = resolve(__dirname, "..");
const CLI_PATH = join(ROOT, "dist/index.js");

const STAND_IN_SCANNER = [
  'process.stderr.write("stand-in scanner: cannot start\\n");',
  "process.exit(1);",
  "",
].join("\n");

const NOT_RUN =
  "ai-trust runs the hackmyagent version it pins as a dependency, and that copy could not be run. Reinstall it:";

// Empty until installWithStandInScanner() has made the directory.
let scratch = "";
let install = "";
let registry: Server | undefined;
let registryUrl = "";
const requests: string[] = [];

/**
 * A copy of the package in a new directory: package.json, dist, and a
 * node_modules that links every dependency except hackmyagent, which is
 * the stand-in scanner.
 */
function installWithStandInScanner(): void {
  // The real path, so the paths below match the ones the CLI prints.
  scratch = realpathSync(mkdtempSync(join(tmpdir(), "ai-trust-scanner-unavailable-")));
  install = join(scratch, "install");
  mkdirSync(join(scratch, "home"));
  mkdirSync(join(scratch, "fx"));
  writeFileSync(join(scratch, "fx", "package.json"), JSON.stringify({ name: "fx", version: "1.0.0" }));

  cpSync(join(ROOT, "package.json"), join(install, "package.json"));
  cpSync(join(ROOT, "dist"), join(install, "dist"), { recursive: true });
  const modules = join(install, "node_modules");
  const scanner = join(modules, "hackmyagent");
  mkdirSync(join(scanner, "dist"), { recursive: true });
  for (const entry of readdirSync(join(ROOT, "node_modules"))) {
    if (entry === "hackmyagent" || entry.startsWith(".")) continue;
    symlinkSync(join(ROOT, "node_modules", entry), join(modules, entry));
  }
  writeFileSync(
    join(scanner, "package.json"),
    JSON.stringify({ name: "hackmyagent", version: "0.0.0", main: "dist/index.js", bin: { hackmyagent: "dist/cli.js" } }),
  );
  writeFileSync(join(scanner, "dist", "index.js"), "module.exports = {};\n");
  writeFileSync(join(scanner, "dist", "cli.js"), STAND_IN_SCANNER);
}

/** A registry that has no package: every request is answered 404. */
function startRegistry(): Promise<Server> {
  const srv = createServer((req, res) => {
    requests.push(`${req.method} ${new URL(req.url ?? "/", "http://127.0.0.1").pathname}`);
    res.writeHead(404, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ error: "package not found" }));
  });
  return new Promise((resolveServer) => srv.listen(0, "127.0.0.1", () => resolveServer(srv)));
}

function runCli(args: string[]): Promise<{ stdout: string; stderr: string; status: number | null }> {
  return new Promise((resolveRun, reject) => {
    // Async spawn, not spawnSync: the registry runs in this process.
    const child = spawn(process.execPath, [join(install, "dist", "index.js"), ...args], {
      env: {
        PATH: process.env.PATH,
        HOME: join(scratch, "home"),
        XDG_CONFIG_HOME: join(scratch, "home", ".config"),
        TMPDIR: tmpdir(),
        NO_COLOR: "1",
        CI: "true",
        OPENA2A_TELEMETRY: "off",
      },
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk) => (stdout += chunk));
    child.stderr.on("data", (chunk) => (stderr += chunk));
    child.on("error", reject);
    child.on("close", (status) => resolveRun({ stdout, stderr, status }));
  });
}

// Linking a dependency directory on Windows needs a junction.
describe.skipIf(process.platform === "win32")("check --json when the pinned scanner cannot be started", () => {
  beforeAll(async () => {
    if (!existsSync(CLI_PATH)) return;
    installWithStandInScanner();
    registry = await startRegistry();
    registryUrl = `http://127.0.0.1:${(registry.address() as AddressInfo).port}`;
  });

  afterAll(async () => {
    if (registry) await new Promise((done) => registry!.close(done));
    // Removes the links in node_modules, not what they point to.
    if (scratch) rmSync(scratch, { recursive: true, force: true });
  });

  it("dist/index.js exists", () => {
    expect(existsSync(CLI_PATH)).toBe(true);
  });

  it("check --scan-path prints one object with the error on stdout, nothing on stderr, and exits 2", async () => {
    if (!existsSync(CLI_PATH)) return;

    const { stdout, stderr, status } = await runCli([
      "--json", "check", "fx", "--scan-path", join(scratch, "fx"), "--no-deep",
    ]);

    expect(JSON.parse(stdout)).toEqual({
      name: "fx",
      found: false,
      error: `HMA is not available. ${NOT_RUN} cd ${shellArg(install)} && npm install`,
    });
    expect(stderr).toBe("");
    expect(status).toBe(2);
  }, 30_000);

  it("check <package> prints one object with the error on stdout, nothing on stderr, and exits 1", async () => {
    if (!existsSync(CLI_PATH)) return;

    const { stdout, stderr, status } = await runCli([
      "--json", "--registry-url", registryUrl, "check", "fx", "--no-deep",
    ]);

    // The registry was asked first and does not have the package.
    expect(requests).toContain("GET /api/v1/trust/query");
    expect(JSON.parse(stdout)).toEqual({
      name: "fx",
      found: false,
      error: `HMA (HackMyAgent) is required for scanning. ${NOT_RUN} cd ${shellArg(install)} && npm install`,
      ecosystem: "npm",
    });
    expect(stderr).toBe("");
    expect(status).toBe(1);
  }, 30_000);
});
