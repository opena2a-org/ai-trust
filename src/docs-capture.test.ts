/**
 * `npm run docs:capture` re-captures the README's first command from the
 * build into docs/captures/quick-start.txt, records the run in
 * docs/captures/quick-start.json and copies the capture's lines into the
 * README sample; `--check` reports where those three files disagree.
 *
 * The committed files are checked as they are. Every capture here runs
 * against a local registry that serves docs/demo/registry-fixture.json, into
 * a scratch directory that holds copies of the files the script writes, so
 * the suite needs no network and writes nothing in the repository.
 */
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { spawn } from "node:child_process";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { copyFileSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { tmpdir } from "node:os";
import {
  CAPTURE,
  COMMAND,
  README,
  SIDECAR,
  checkCapture,
  defaultRegistry,
  readmeSample,
  sha256,
} from "../scripts/docs-capture.mjs";

const ROOT = resolve(__dirname, "..");
const SCRIPT = join(ROOT, "scripts/docs-capture.mjs");
const CLI_PATH = join(ROOT, "dist/index.js");
const VERSION = (JSON.parse(readFileSync(join(ROOT, "package.json"), "utf8")) as { version: string }).version;
const FIXTURE = JSON.parse(readFileSync(join(ROOT, "docs/demo/registry-fixture.json"), "utf8")) as {
  query: Record<string, unknown>;
};
const WRITTEN = [CAPTURE, SIDECAR, README];

let server: Server;
let registryUrl: string;
let scratch: string;

const read = (root: string, rel: string) => readFileSync(join(root, rel), "utf8");
const digests = (root: string) => WRITTEN.map((rel) => sha256(readFileSync(join(root, rel))));

/**
 * A directory holding copies of the files docs:capture reads and writes, with
 * dist/ linked to the build, or with a dist/index.js that runs `stub` instead.
 */
function scratchRoot(stub?: string): string {
  const root = mkdtempSync(join(scratch, "root-"));
  mkdirSync(join(root, "docs/captures"), { recursive: true });
  for (const rel of ["package.json", ...WRITTEN]) copyFileSync(join(ROOT, rel), join(root, rel));
  if (stub === undefined) {
    symlinkSync(join(ROOT, "dist"), join(root, "dist"));
  } else {
    mkdirSync(join(root, "dist"));
    writeFileSync(join(root, "dist/index.js"), stub);
  }
  return root;
}

function run(
  file: string,
  args: string[],
  options: { cwd?: string; env?: NodeJS.ProcessEnv } = {},
): Promise<{ stdout: string; stderr: string; status: number | null }> {
  return new Promise((done, reject) => {
    // Async spawn, not spawnSync: the fixture registry runs in this process.
    const child = spawn(process.execPath, [file, ...args], {
      cwd: options.cwd ?? ROOT,
      env: options.env ?? { PATH: process.env.PATH, HOME: scratch, TMPDIR: scratch },
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk) => (stdout += chunk));
    child.stderr.on("data", (chunk) => (stderr += chunk));
    child.on("error", reject);
    child.on("close", (status) => done({ stdout, stderr, status }));
  });
}

function listen(srv: Server): Promise<string> {
  return new Promise((done) => srv.listen(0, "127.0.0.1", () => done(`http://127.0.0.1:${(srv.address() as AddressInfo).port}`)));
}

let committed: string[];

beforeAll(async () => {
  scratch = mkdtempSync(join(tmpdir(), "ai-trust-docs-capture-test-"));
  committed = digests(ROOT);
  server = createServer((req, res) => {
    const url = new URL(req.url ?? "/", "http://127.0.0.1");
    const answer = url.pathname === "/api/v1/trust/query" ? FIXTURE.query[url.searchParams.get("name") ?? ""] : undefined;
    res.writeHead(answer === undefined ? 404 : 200, { "Content-Type": "application/json" });
    res.end(JSON.stringify(answer ?? { error: "not in the fixture" }));
  });
  registryUrl = await listen(server);
});

afterAll(async () => {
  await new Promise((done) => server.close(done));
  rmSync(scratch, { recursive: true, force: true });
});

describe("the committed quick-start capture", () => {
  it("agrees with its record and with the README sample", () => {
    expect(checkCapture(ROOT)).toEqual([]);
  });

  it("is recorded as a run of the README's first command by the version in package.json", () => {
    const sidecar = JSON.parse(read(ROOT, SIDECAR));
    expect(sidecar.command).toBe(COMMAND);
    expect(sidecar.artifact.version).toBe(VERSION);
    expect(sidecar.exitCode).toBe(0);
  });

  it("passes npm run docs:capture -- --check, exit 0", async () => {
    const { stdout, status } = await run(SCRIPT, ["--check"]);
    expect(status).toBe(0);
    expect(stdout).toContain("agree");
  });
});

describe("docs:capture --check reports a hand edit", () => {
  it("to the capture, with the README sample edited to match", () => {
    const root = scratchRoot();
    const text = read(root, CAPTURE);
    const at = text.search(/\d/);
    const edited = text.slice(0, at) + (text[at] === "9" ? "8" : "9") + text.slice(at + 1);
    const start = text.lastIndexOf("\n", at) + 1;
    const end = text.indexOf("\n", at);
    writeFileSync(join(root, CAPTURE), edited);
    writeFileSync(join(root, README), read(root, README).replace(text.slice(start, end), edited.slice(start, end)));

    expect(checkCapture(root)).toEqual([expect.stringContaining(`${CAPTURE} hashes to`)]);
  });

  it("to the capture's length", () => {
    const root = scratchRoot();
    writeFileSync(join(root, CAPTURE), `${read(root, CAPTURE)}\n`);

    expect(checkCapture(root)).toEqual([
      expect.stringContaining(`${CAPTURE} is ${readFileSync(join(root, CAPTURE)).length} bytes`),
      expect.stringContaining(`${CAPTURE} hashes to`),
    ]);
  });

  it("to the record's command and exit code", () => {
    const root = scratchRoot();
    const sidecar = JSON.parse(read(root, SIDECAR));
    writeFileSync(join(root, SIDECAR), JSON.stringify({ ...sidecar, command: "npx ai-trust check express", exitCode: 2 }));

    expect(checkCapture(root)).toEqual([
      expect.stringContaining('records the command "npx ai-trust check express"'),
      expect.stringContaining("records exit code 2, not 0"),
    ]);
  });

  it("to the README sample", async () => {
    const root = scratchRoot();
    const sample = readmeSample(read(root, README));
    if ("error" in sample) throw new Error(sample.error);
    sample.lines[sample.open + 1] += " edited";
    writeFileSync(join(root, README), sample.lines.join("\n"));

    expect(checkCapture(root)).toEqual([expect.stringContaining(`the ${README} sample at lines`)]);
    const { stderr, status } = await run(SCRIPT, ["--check", "--root", root]);
    expect(status).toBe(1);
    expect(stderr).toContain("run npm run build, then npm run docs:capture");
  });

  it("to the version in package.json, with no new capture", () => {
    const root = scratchRoot();
    const pkg = JSON.parse(read(root, "package.json"));
    writeFileSync(join(root, "package.json"), JSON.stringify({ ...pkg, version: "0.0.0-not-captured" }));

    expect(checkCapture(root)).toEqual([expect.stringContaining('package.json holds 0.0.0-not-captured')]);
  });
});

describe("npm run docs:capture", { timeout: 60000 }, () => {
  it("writes what dist/index.js prints for the README's first command, its record and the README sample", async () => {
    const root = scratchRoot();
    const before = readmeSample(read(root, README));
    const { stdout, stderr, status } = await run(SCRIPT, ["--root", root, "--registry-url", registryUrl]);
    expect(stderr).toBe("");
    expect(status).toBe(0);
    expect(stdout).toContain(`wrote ${CAPTURE}`);
    expect(checkCapture(root)).toEqual([]);

    // The capture is the CLI's stdout for the same command in the same environment.
    const home = mkdtempSync(join(scratch, "home-"));
    const cwd = mkdtempSync(join(scratch, "cwd-"));
    const args = [...COMMAND.split(" ").slice(2), "--registry-url", registryUrl];
    const direct = await run(CLI_PATH, args, {
      cwd,
      env: { PATH: process.env.PATH, HOME: home, CI: "true", TERM: "dumb", LANG: "en_US.UTF-8", OPENA2A_TELEMETRY: "off" },
    });
    expect(direct.status).toBe(0);
    const captured = readFileSync(join(root, CAPTURE));
    expect(captured.toString("utf8")).toBe(direct.stdout);
    expect(captured.toString("utf8")).toContain("@modelcontextprotocol/server-filesystem");

    const sidecar = JSON.parse(read(root, SIDECAR));
    expect(sidecar.command).toBe(COMMAND);
    expect(sidecar.artifact).toMatchObject({
      package: "ai-trust",
      version: VERSION,
      commit: null,
      taggedRelease: false,
      invokedAs: `node dist/index.js ${args.join(" ")}`,
    });
    expect(sidecar.registry).toBe(registryUrl);
    expect(sidecar.exitCode).toBe(0);
    expect(sidecar.outputs).toMatchObject({ bytes: captured.length, sha256: sha256(captured), stderr: "empty" });

    // Only the sample block of the README changes.
    const after = readmeSample(read(root, README));
    if ("error" in before || "error" in after) throw new Error("the README sample block is missing");
    expect(after.lines.slice(0, after.open + 1)).toEqual(before.lines.slice(0, before.open + 1));
    expect(after.lines.slice(after.close)).toEqual(before.lines.slice(before.close));
  });

  it("writes nothing when the CLI run fails", async () => {
    const root = scratchRoot();
    const closed = createServer();
    const deadUrl = await listen(closed);
    await new Promise((done) => closed.close(done));
    const before = digests(root);

    const { stderr, status } = await run(SCRIPT, ["--root", root, "--registry-url", deadUrl]);
    expect(status).toBe(1);
    expect(stderr).toContain("exited 1");
    expect(stderr).toContain("nothing written");
    expect(digests(root)).toEqual(before);
  });

  for (const [what, stub, message] of [
    [
      "prints on stderr and exits 0",
      'process.stderr.write("a note\\n"); process.stdout.write("\\n  output\\n\\n");',
      "exited 0 and printed on stderr; nothing written",
    ],
    ["prints nothing on stdout and exits 0", "", "printed nothing on stdout; nothing written"],
  ]) {
    it(`writes nothing when the CLI ${what}`, async () => {
      const root = scratchRoot(stub);
      const before = digests(root);
      const { stderr, status } = await run(SCRIPT, ["--root", root, "--registry-url", registryUrl]);
      expect(status).toBe(1);
      expect(stderr).toContain(message);
      expect(digests(root)).toEqual(before);
    });
  }

  it("refuses an unknown argument, a flag with no value, --check with --registry-url, and a --root that is missing or a file, exit 2", async () => {
    for (const args of [
      ["--json"],
      ["--registry-url"],
      ["--check", "--registry-url", registryUrl],
      ["--root", join(scratch, "no-such-directory")],
      ["--root", join(ROOT, "package.json")],
    ]) {
      const { stderr, status } = await run(SCRIPT, args);
      expect(status, args.join(" ")).toBe(2);
      expect(stderr).toContain("Usage: node scripts/docs-capture.mjs");
    }
  });

  it("reads the registry the CLI asks by default from its --help", () => {
    expect(defaultRegistry(CLI_PATH, { PATH: process.env.PATH, HOME: scratch, OPENA2A_TELEMETRY: "off" })).toBe(
      "https://api.oa2a.org",
    );
  });

  it("left the committed capture, record and README as they were", () => {
    expect(digests(ROOT)).toEqual(committed);
  });
});
