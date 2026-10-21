/**
 * Tests for `ai-trust config contribute on|off|status`.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import * as fs from "fs";
import * as path from "path";
import * as os from "os";
import { Command } from "commander";
import { registerConfigCommand } from "./config.js";
import { _resetBackend } from "../telemetry/opt-in.js";

const REPO_ROOT = path.resolve(__dirname, "..", "..");

function createProgram(): Command {
  const program = new Command();
  program
    .name("ai-trust")
    .exitOverride()
    .configureOutput({ writeOut: () => {}, writeErr: () => {} })
    .option("--json", "output raw JSON", false);
  registerConfigCommand(program);
  return program;
}

async function run(args: string[]): Promise<void> {
  await createProgram().parseAsync(["node", "ai-trust", ...args]);
}

function readConfig(home: string): Record<string, unknown> {
  const configPath = path.join(home, "config.json");
  if (!fs.existsSync(configPath)) return {};
  return JSON.parse(fs.readFileSync(configPath, "utf-8"));
}

describe("config contribute command", () => {
  let tempHome: string;
  let logSpy: ReturnType<typeof vi.spyOn>;
  let errSpy: ReturnType<typeof vi.spyOn>;
  let savedExitCode: typeof process.exitCode;

  beforeEach(() => {
    tempHome = fs.mkdtempSync(path.join(os.tmpdir(), "ai-trust-config-"));
    process.env.OPENA2A_HOME = tempHome;
    _resetBackend(true);
    logSpy = vi.spyOn(console, "log").mockImplementation(() => {});
    errSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    savedExitCode = process.exitCode;
    process.exitCode = undefined;
  });

  afterEach(() => {
    logSpy.mockRestore();
    errSpy.mockRestore();
    process.exitCode = savedExitCode;
    fs.rmSync(tempHome, { recursive: true, force: true });
    delete process.env.OPENA2A_HOME;
    _resetBackend();
  });

  function stdout(): string {
    return logSpy.mock.calls.map((c) => c.join(" ")).join("\n");
  }

  it("`on` saves contribute.enabled = true", async () => {
    await run(["config", "contribute", "on"]);
    expect(readConfig(tempHome)).toMatchObject({ contribute: { enabled: true } });
    expect(stdout()).toContain("Community contribution enabled");
    expect(process.exitCode).toBeUndefined();
  });

  it("`off` saves contribute.enabled = false and silences the consent tip", async () => {
    await run(["config", "contribute", "on"]);
    await run(["config", "contribute", "off"]);
    const config = readConfig(tempHome) as {
      contribute?: { enabled?: boolean };
      telemetry?: { contributePromptDismissedAt?: string };
    };
    expect(config.contribute?.enabled).toBe(false);
    expect(config.telemetry?.contributePromptDismissedAt).toBeTypeOf("string");
    expect(stdout()).toContain("Community contribution disabled");
  });

  it("keeps unrelated keys in the shared config file", async () => {
    fs.writeFileSync(
      path.join(tempHome, "config.json"),
      JSON.stringify({ otherTool: { setting: 1 } })
    );
    await run(["config", "contribute", "on"]);
    expect(readConfig(tempHome)).toMatchObject({
      otherTool: { setting: 1 },
      contribute: { enabled: true },
    });
  });

  it("status (and no action) reports the saved choice without writing", async () => {
    await run(["config", "contribute"]);
    expect(stdout()).toContain("Community contribution: not set");
    expect(fs.existsSync(path.join(tempHome, "config.json"))).toBe(false);

    await run(["config", "contribute", "on"]);
    logSpy.mockClear();
    await run(["config", "contribute", "status"]);
    expect(stdout()).toContain("Community contribution: enabled");
    expect(stdout()).toContain("ai-trust config contribute off");
  });

  it("--json prints the saved choice", async () => {
    await run(["--json", "config", "contribute", "off"]);
    expect(JSON.parse(stdout())).toEqual({ contribute: false });
  });

  it("status reports not set after a scan saved the shared defaults", async () => {
    // What the bundled scanner leaves in a fresh home after one scan.
    const scannerDefaults = {
      version: 1,
      contribute: { enabled: false, consentedAt: null, consentVersion: "1.0" },
      telemetry: { scanCount: 1, contributePromptDismissedAt: null },
    };
    fs.writeFileSync(path.join(tempHome, "config.json"), JSON.stringify(scannerDefaults));

    await run(["config", "contribute", "status"]);
    expect(stdout()).toContain("Community contribution: not set");
    logSpy.mockClear();
    await run(["--json", "config", "contribute", "status"]);
    expect(JSON.parse(stdout())).toEqual({ contribute: null });

    logSpy.mockClear();
    await run(["config", "contribute", "off"]);
    logSpy.mockClear();
    await run(["config", "contribute", "status"]);
    expect(stdout()).toContain("Community contribution: disabled");
  });

  it("status reports a no that an earlier ai-trust saved as disabled, and marks it (#133)", async () => {
    // What ai-trust 0.7.6 saves for a "no" to audit's "Share these scans with
    // the community?": the same pair the bundled scanner saves, plus a
    // dismissal, which the consent tip writes only from the third scan on.
    const earlierNo = {
      version: 1,
      contribute: { enabled: false, consentedAt: null, consentVersion: "1.0" },
      telemetry: { scanCount: 2, contributePromptDismissedAt: "2026-06-20T10:00:00.000Z" },
    };
    const configPath = path.join(tempHome, "config.json");
    fs.writeFileSync(configPath, JSON.stringify(earlierNo));
    const hint = "Answered no in an earlier ai-trust version?";

    await run(["config", "contribute", "status"]);
    expect(stdout()).toContain("Community contribution: disabled");
    expect(stdout()).not.toContain(hint);
    expect(readConfig(tempHome)).toMatchObject({
      contribute: { enabled: false, decidedAt: "2026-06-20T10:00:00.000Z" },
    });

    // Later scans raise the count past the consent tip's; the mark keeps the no.
    const marked = readConfig(tempHome) as { telemetry: { scanCount: number } };
    marked.telemetry.scanCount = 5;
    fs.writeFileSync(configPath, JSON.stringify(marked));
    logSpy.mockClear();
    await run(["--json", "config", "contribute", "status"]);
    expect(JSON.parse(stdout())).toEqual({ contribute: false });
  });

  it("status says how to record a no it cannot tell from the consent tip", async () => {
    // The consent tip writes the same dismissal once the scan count is 3.
    const tipOrNo = {
      version: 1,
      contribute: { enabled: false, consentedAt: null, consentVersion: "1.0" },
      telemetry: { scanCount: 3, contributePromptDismissedAt: "2026-06-20T10:00:00.000Z" },
    };
    fs.writeFileSync(path.join(tempHome, "config.json"), JSON.stringify(tipOrNo));
    const hint = "Answered no in an earlier ai-trust version? Record it: ai-trust config contribute off";

    await run(["config", "contribute", "status"]);
    expect(stdout()).toContain("Community contribution: not set");
    expect(stdout()).toContain(hint);
    logSpy.mockClear();
    await run(["--json", "config", "contribute", "status"]);
    expect(JSON.parse(stdout())).toEqual({ contribute: null });

    logSpy.mockClear();
    await run(["config", "contribute", "off"]);
    expect(stdout()).not.toContain(hint);
    logSpy.mockClear();
    await run(["config", "contribute", "status"]);
    expect(stdout()).toContain("Community contribution: disabled");
    expect(stdout()).not.toContain(hint);
  });

  it("status gives no earlier-version hint without an unmarked off", async () => {
    const hint = "Answered no in an earlier ai-trust version?";
    await run(["config", "contribute", "status"]);
    expect(stdout()).not.toContain(hint);

    await run(["config", "contribute", "on"]);
    logSpy.mockClear();
    await run(["config", "contribute", "status"]);
    expect(stdout()).toContain("Community contribution: enabled");
    expect(stdout()).not.toContain(hint);
  });

  it("rejects an unknown action with exit code 1 and writes nothing", async () => {
    await run(["config", "contribute", "maybe"]);
    expect(process.exitCode).toBe(1);
    expect(errSpy.mock.calls.join(" ")).toContain("on | off | status");
    expect(fs.existsSync(path.join(tempHome, "config.json"))).toBe(false);
  });
});

describe("contribution docs cite commands that exist", () => {
  const docs = ["README.md", "docs/use-cases/contribute-scans.md"];

  function citedLines(file: string, prefix: string): string[] {
    return fs
      .readFileSync(path.join(REPO_ROOT, file), "utf-8")
      .split("\n")
      .map((line) => line.split("#")[0].trim())
      .filter((line) => line.startsWith(prefix));
  }

  let tempHome: string;

  beforeEach(() => {
    tempHome = fs.mkdtempSync(path.join(os.tmpdir(), "ai-trust-config-docs-"));
    process.env.OPENA2A_HOME = tempHome;
    _resetBackend(true);
    vi.spyOn(console, "log").mockImplementation(() => {});
    vi.spyOn(console, "error").mockImplementation(() => {});
  });

  afterEach(() => {
    vi.restoreAllMocks();
    process.exitCode = undefined;
    fs.rmSync(tempHome, { recursive: true, force: true });
    delete process.env.OPENA2A_HOME;
    _resetBackend();
  });

  it.each(docs)("every `ai-trust config` line in %s runs", async (file) => {
    for (const line of citedLines(file, "ai-trust config")) {
      process.exitCode = undefined;
      await expect(run(line.split(/\s+/).slice(1)), line).resolves.toBeUndefined();
      expect(process.exitCode, line).toBeUndefined();
    }
  });

  it.each(docs)("every `opena2a config` line in %s uses `config contribute on|off`", (file) => {
    for (const line of citedLines(file, "opena2a config")) {
      expect(line).toMatch(/^opena2a config contribute (on|off)$/);
    }
  });

  it("the docs cite the ai-trust command for both directions", () => {
    const cited = docs.flatMap((file) => citedLines(file, "ai-trust config"));
    expect(cited).toEqual(
      expect.arrayContaining(["ai-trust config contribute on", "ai-trust config contribute off"])
    );
  });
});

// `opena2a config contribute off` saves an off that ai-trust reads as no
// choice when no choice was saved before it (src/telemetry/opt-in.test.ts).
describe("the contribution guide on an off saved by opena2a-cli (#141)", () => {
  const guide = fs.readFileSync(
    path.join(REPO_ROOT, "docs/use-cases/contribute-scans.md"),
    "utf-8"
  );

  it("names it in each paragraph that says when `audit` asks", () => {
    const paragraphs = guide
      .split(/\n\s*\n/)
      .filter((p) => /`(?:ai-trust )?audit` on a terminal asks/.test(p));
    expect(paragraphs).toHaveLength(2);
    for (const paragraph of paragraphs) {
      expect(paragraph).toContain("An off saved by `opena2a config contribute off`");
    }
  });

  it("says after its `opena2a config contribute off` command that `audit` still asks", () => {
    const [, after = ""] = guide.split("```bash\nopena2a config contribute off\n```");
    const section = after.split("\n## ")[0];
    expect(section).toContain("`audit` on a terminal still asks");
  });
});

describe("config with no subcommand (#177)", () => {
  interface Captured {
    out: string;
    err: string;
    exit?: { code: string; exitCode: number };
  }

  async function capture(args: string[]): Promise<Captured> {
    const captured: Captured = { out: "", err: "" };
    const program = new Command();
    program
      .name("ai-trust")
      .exitOverride()
      .configureOutput({
        writeOut: (s) => (captured.out += s),
        writeErr: (s) => (captured.err += s),
      })
      .option("--json", "output raw JSON", false);
    registerConfigCommand(program);
    try {
      await program.parseAsync(["node", "ai-trust", ...args]);
    } catch (e) {
      const { code, exitCode } = e as { code: string; exitCode: number };
      captured.exit = { code, exitCode };
    }
    return captured;
  }

  it("prints the config help to stdout and exits 0, as the root help does", async () => {
    const { out, err, exit } = await capture(["config"]);
    expect(exit).toEqual({ code: "commander.help", exitCode: 0 });
    expect(out).toContain("Usage: ai-trust config [options] [command]");
    expect(out).toMatch(/contribute \[action\]/);
    expect(out).toMatch(/help \[command\]/);
    expect(err).toBe("");
  });

  it("keeps `config help` and `config help contribute`", async () => {
    const bare = await capture(["config", "help"]);
    expect(bare.exit).toEqual({ code: "commander.help", exitCode: 0 });
    expect(bare.out).toContain("Usage: ai-trust config [options] [command]");

    const sub = await capture(["config", "help", "contribute"]);
    expect(sub.exit).toEqual({ code: "commander.help", exitCode: 0 });
    expect(sub.out).toContain("Usage: ai-trust config contribute [options] [action]");
  });

  it("an unknown subcommand stays an error with exit 1 and a suggestion", async () => {
    const { out, err, exit } = await capture(["config", "contribut"]);
    expect(exit).toEqual({ code: "commander.unknownCommand", exitCode: 1 });
    expect(err).toContain("error: unknown command 'contribut'");
    expect(err).toContain("(Did you mean contribute?)");
    expect(out).toBe("");
  });

  it("an unknown option stays an error with exit 1", async () => {
    const { exit, err } = await capture(["config", "--bogus"]);
    expect(exit).toEqual({ code: "commander.unknownOption", exitCode: 1 });
    expect(err).toContain("error: unknown option '--bogus'");
  });
});
