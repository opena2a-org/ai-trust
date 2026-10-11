/**
 * Process plumbing of the `release-smoke:corpus` harness
 * (scripts/lib/corpus-harness.ts): the child environment is an allow-list,
 * a failed classifier model download reports what the downloader said, and
 * the harness temp directory is removed when the harness is interrupted.
 */
import { afterEach, describe, expect, it } from "vitest";
import { spawn } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import {
  downloadClassifierModels,
  harnessChildEnv,
  modelDownloadDetail,
} from "../scripts/lib/corpus-harness.js";

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const LIB = join(REPO_ROOT, "scripts", "lib", "corpus-harness.ts");

const made: string[] = [];
function scratch(): string {
  const dir = mkdtempSync(join(tmpdir(), "ai-trust-harness-test-"));
  made.push(dir);
  return dir;
}
afterEach(() => {
  for (const dir of made.splice(0)) rmSync(dir, { recursive: true, force: true });
});

describe("harnessChildEnv", () => {
  it("passes only allow-listed caller variables plus the harness's own", () => {
    const caller: NodeJS.ProcessEnv = {
      PATH: "/usr/bin:/bin",
      TMPDIR: "/tmp/caller",
      HTTPS_PROXY: "http://127.0.0.1:3128",
      HOME: "/home/caller",
      OPENA2A_TELEMETRY: "on",
      ANTHROPIC_API_KEY: "not-a-real-key",
      OPENA2A_HOME: "/home/caller/.opena2a",
      NANOMIND_URL: "http://127.0.0.1:1",
      NANOMIND_GUARD_SOCK: "/tmp/caller/guard.sock",
      XDG_CONFIG_HOME: "/home/caller/.config",
      OPENA2A_TELEMETRY_URL: "http://127.0.0.1:2",
      REGISTRY_URL: "http://127.0.0.1:3",
      REGISTRY_API_KEY: "not-a-real-key",
      SOME_VARIABLE_ADDED_LATER: "x",
    };
    expect(harnessChildEnv(caller, "/harness/home")).toEqual({
      PATH: "/usr/bin:/bin",
      TMPDIR: "/tmp/caller",
      HTTPS_PROXY: "http://127.0.0.1:3128",
      HOME: "/harness/home",
      USERPROFILE: "/harness/home",
      OPENA2A_CORPUS_DETERMINISTIC: "1",
      OPENA2A_TELEMETRY: "off",
    });
  });
});

describe("classifier model download failure", () => {
  // Stands in for the scanner's classifier source: same export shape, prints
  // the way the real downloader does only when not quiet.
  function fakeClassifier(body: string): string {
    const path = join(scratch(), "fake-classifier.cjs");
    writeFileSync(
      path,
      `exports.TMEClassifier = { downloadModel(dir, quiet) { ${body} } };\n`,
    );
    return path;
  }

  it("carries the downloader's own error line into the detail", async () => {
    const source = fakeClassifier(
      "if (!quiet) console.error('  Failed to download tokenizer.json: HTTP 503 for https://models.example.invalid/tokenizer.json');" +
        " return Promise.resolve(false);",
    );
    const run = await downloadClassifierModels(
      source,
      scratch(),
      harnessChildEnv(process.env, scratch()),
      30_000,
    );
    expect(run.status).toBe(1);
    expect(modelDownloadDetail(run, 30_000)).toContain(
      "Failed to download tokenizer.json: HTTP 503 for https://models.example.invalid/tokenizer.json",
    );
  });

  it("reports a rejected download with its error", async () => {
    const source = fakeClassifier(
      "return Promise.reject(new Error('getaddrinfo ENOTFOUND models.example.invalid'));",
    );
    const run = await downloadClassifierModels(
      source,
      scratch(),
      harnessChildEnv(process.env, scratch()),
      30_000,
    );
    expect(run.status).toBe(1);
    expect(modelDownloadDetail(run, 30_000)).toContain(
      "getaddrinfo ENOTFOUND models.example.invalid",
    );
  });

  it("reports a download stopped at the timeout", async () => {
    const source = fakeClassifier("setInterval(() => {}, 1000); return new Promise(() => {});");
    const run = await downloadClassifierModels(
      source,
      scratch(),
      harnessChildEnv(process.env, scratch()),
      500,
    );
    expect(run.timedOut).toBe(true);
    expect(modelDownloadDetail(run, 500)).toContain("the downloader was stopped after 0.5 s");
  });

  it("says so when the downloader printed nothing", () => {
    const detail = modelDownloadDetail(
      { status: 1, signal: null, stdout: "", stderr: "", timedOut: false },
      30_000,
    );
    expect(detail).toBe("  the downloader exited 1 with no output");
  });
});

describe("removeOnExitOrSignal", () => {
  // A stand-in harness: owns a temp directory holding a model file, runs one
  // long child the way the harness runs a scan, and is then signalled.
  const DRIVER = [
    'import { mkdirSync, writeFileSync } from "node:fs";',
    'import { join } from "node:path";',
    "const [libUrl, dir, scan, pidFile] = process.argv.slice(2);",
    "const lib = await import(libUrl);",
    'mkdirSync(join(dir, "home", ".nanomind", "models"), { recursive: true });',
    'writeFileSync(join(dir, "home", ".nanomind", "models", "model.onnx"), "placeholder");',
    "lib.removeOnExitOrSignal(dir);",
    "await lib.runNode([scan, pidFile], {});",
    'process.stdout.write("continued after the child\\n");',
  ].join("\n");
  // A stand-in scan: starts a process of its own, as ai-trust starts the
  // scanner, records both pids and runs until stopped.
  const SCAN = [
    'const { spawn } = require("node:child_process");',
    'const { writeFileSync } = require("node:fs");',
    'const sub = spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)"], { stdio: "ignore" });',
    'writeFileSync(process.argv[2], `${process.pid} ${sub.pid}`);',
    "setInterval(() => {}, 1000);",
  ].join("\n");

  async function waitFor(path: string): Promise<void> {
    const deadline = Date.now() + 15_000;
    while (!existsSync(path) || readFileSync(path, "utf8") === "") {
      if (Date.now() > deadline) throw new Error(`timed out waiting for ${path}`);
      await new Promise((r) => setTimeout(r, 50));
    }
  }

  function alive(pid: number): boolean {
    try {
      process.kill(pid, 0);
      return true;
    } catch {
      return false;
    }
  }

  // A process whose parent died is reaped by the system, not at once.
  async function gone(pid: number): Promise<boolean> {
    const deadline = Date.now() + 5_000;
    while (alive(pid)) {
      if (Date.now() > deadline) return false;
      await new Promise((r) => setTimeout(r, 50));
    }
    return true;
  }

  it.each([
    ["SIGINT", 130],
    ["SIGTERM", 143],
  ] as const)(
    "on %s stops the running child and its process, removes the directory and exits %i",
    async (signal, expectedCode) => {
      const work = scratch();
      const harnessTmp = join(work, "ai-trust-corpus-test");
      const pidFile = join(work, "child.pid");
      const driver = join(work, "driver.mjs");
      const scan = join(work, "scan.cjs");
      writeFileSync(driver, DRIVER);
      writeFileSync(scan, SCAN);

      const proc = spawn(
        process.execPath,
        ["--import", "tsx", driver, pathToFileURL(LIB).href, harnessTmp, scan, pidFile],
        { cwd: REPO_ROOT, stdio: ["ignore", "pipe", "pipe"] },
      );
      let output = "";
      proc.stdout.on("data", (c) => (output += c));
      proc.stderr.on("data", (c) => (output += c));
      const closed = new Promise<[number | null, NodeJS.Signals | null]>((r) =>
        proc.on("close", (code, sig) => r([code, sig])),
      );

      let pids: number[] = [];
      try {
        await waitFor(pidFile);
        expect(existsSync(join(harnessTmp, "home", ".nanomind", "models", "model.onnx"))).toBe(true);
        pids = readFileSync(pidFile, "utf8").split(" ").map(Number);

        proc.kill(signal);
        const [code, sig] = await closed;

        expect({ code, sig, output }).toEqual({ code: expectedCode, sig: null, output: "" });
        expect(existsSync(harnessTmp)).toBe(false);
        expect(alive(pids[0])).toBe(false);
        expect(await gone(pids[1])).toBe(true);
      } finally {
        if (proc.exitCode === null && proc.signalCode === null) proc.kill("SIGKILL");
        for (const pid of pids) if (pid > 0 && alive(pid)) process.kill(pid, "SIGKILL");
      }
    },
    30_000,
  );
});
