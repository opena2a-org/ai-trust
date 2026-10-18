/**
 * `--help` reports the usage telemetry state that is in effect.
 *
 * The root help ends with a "Telemetry:" block whose first line says whether
 * usage telemetry is on or off. That line follows the same resolved state
 * `--version` and `telemetry status` print: the OPENA2A_TELEMETRY variable
 * first, then the saved choice, then the default (on). Every usage event
 * carries a persistent install_id (kept in the telemetry config file and shown
 * by `ai-trust telemetry status`), so the help names the install ID instead of
 * calling the telemetry anonymous.
 *
 * The second line of the block states the saved contribution choice in the
 * words `ai-trust config contribute status` prints, and OPENA2A_TELEMETRY
 * does not change it.
 *
 * Exercises the built `dist/index.js` end-to-end.
 */
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { resolve, join } from "node:path";
import { tmpdir } from "node:os";

const CLI_PATH = resolve(__dirname, "../dist/index.js");
const STRIP_ANSI = /\x1b\[[0-9;]*m/g;

// @opena2a/telemetry reads its saved choice from XDG_CONFIG_HOME, so each
// state under test gets its own fresh directory: no telemetry.json means the
// default (on) applies, whatever the machine running the suite has saved.
// ai-trust reads the saved contribution choice from $OPENA2A_HOME/config.json,
// so every run gets an OPENA2A_HOME too, empty unless a test writes to it.
// Made in a hook, not at module scope, so nothing is left behind by a run
// that only lists tests.
let freshConfigHome: string;
let savedChoiceConfigHome: string;
let freshOpena2aHome: string;

beforeAll(() => {
  freshConfigHome = mkdtempSync(join(tmpdir(), "ai-trust-help-telemetry-"));
  savedChoiceConfigHome = mkdtempSync(join(tmpdir(), "ai-trust-help-telemetry-saved-"));
  freshOpena2aHome = mkdtempSync(join(tmpdir(), "ai-trust-help-contribute-"));
});

afterAll(() => {
  rmSync(freshConfigHome, { recursive: true, force: true });
  rmSync(savedChoiceConfigHome, { recursive: true, force: true });
  rmSync(freshOpena2aHome, { recursive: true, force: true });
});

interface RunOptions {
  /** Value for OPENA2A_TELEMETRY; omitted means the variable is not set. */
  telemetry?: string;
  configHome?: string;
  opena2aHome?: string;
}

function run(args: string[], options: RunOptions = {}): { stdout: string; stderr: string; status: number } {
  const env: NodeJS.ProcessEnv = {
    ...process.env,
    NODE_OPTIONS: "",
    NO_COLOR: "1",
    XDG_CONFIG_HOME: options.configHome ?? freshConfigHome,
    OPENA2A_HOME: options.opena2aHome ?? freshOpena2aHome,
    // No command here sends an event; an unreachable endpoint keeps it so.
    OPENA2A_TELEMETRY_URL: "http://127.0.0.1:1/never",
  };
  delete env.OPENA2A_TELEMETRY;
  if (options.telemetry !== undefined) env.OPENA2A_TELEMETRY = options.telemetry;

  const res = spawnSync(process.execPath, [CLI_PATH, ...args], {
    encoding: "utf8",
    timeout: 20000,
    env,
  });
  return {
    stdout: (res.stdout ?? "").replace(STRIP_ANSI, ""),
    stderr: (res.stderr ?? "").replace(STRIP_ANSI, ""),
    status: res.status ?? 1,
  };
}

/** The first line of the help's "Telemetry:" block. */
function telemetryLine(help: string): string {
  const lines = help.split("\n");
  const heading = lines.indexOf("Telemetry:");
  return heading === -1 ? "" : (lines[heading + 1] ?? "").trim();
}

/** The second line of the help's "Telemetry:" block: the saved contribution choice. */
function contributionLine(help: string): string {
  const lines = help.split("\n");
  const heading = lines.indexOf("Telemetry:");
  return heading === -1 ? "" : (lines[heading + 2] ?? "").trim();
}

const ON = /^Usage telemetry is on\b/;
const OFF = /^Usage telemetry is off\b/;

describe("--help telemetry line follows the resolved state", { timeout: 60000 }, () => {
  it("dist/index.js exists", () => {
    expect(existsSync(CLI_PATH)).toBe(true);
  });

  it("reports on and names the install ID when nothing opts out", () => {
    if (!existsSync(CLI_PATH)) return;
    const { stdout, status } = run(["--help"]);
    expect(status).toBe(0);

    const line = telemetryLine(stdout);
    expect(line).toMatch(ON);
    expect(line).toMatch(/persistent install ID/);
    expect(line).toMatch(/OPENA2A_TELEMETRY=off/);
  });

  // Every spelling @opena2a/telemetry accepts as an opt-out.
  it.each(["off", "OFF", "0", "false", "no"])("reports off under OPENA2A_TELEMETRY=%s", (value) => {
    if (!existsSync(CLI_PATH)) return;
    const { stdout, status } = run(["--help"], { telemetry: value });
    expect(status).toBe(0);

    const line = telemetryLine(stdout);
    expect(line).toMatch(OFF);
    expect(stdout).not.toMatch(/telemetry is on/i);
  });

  it("reports off after `telemetry off` is saved, and on again after `telemetry on`", () => {
    if (!existsSync(CLI_PATH)) return;
    const configHome = savedChoiceConfigHome;

    expect(run(["telemetry", "off"], { configHome }).status).toBe(0);
    expect(telemetryLine(run(["--help"], { configHome }).stdout)).toMatch(OFF);

    expect(run(["telemetry", "on"], { configHome }).status).toBe(0);
    expect(telemetryLine(run(["--help"], { configHome }).stdout)).toMatch(ON);
  });

  it("prints the same line when run with no arguments", () => {
    if (!existsSync(CLI_PATH)) return;
    expect(telemetryLine(run([]).stdout)).toMatch(ON);
    expect(telemetryLine(run([], { telemetry: "off" }).stdout)).toMatch(OFF);
  });

  it.each([
    { variable: "unset", telemetry: undefined, state: "on" },
    { variable: "off", telemetry: "off", state: "off" },
  ])("agrees with the --version disclosure (OPENA2A_TELEMETRY $variable: $state)", ({ telemetry, state }) => {
    if (!existsSync(CLI_PATH)) return;
    const version = run(["--version"], { telemetry });
    const help = run(["--help"], { telemetry });

    expect(version.stderr).toMatch(new RegExp(`Telemetry: ${state}\\b`));
    expect(telemetryLine(help.stdout)).toMatch(new RegExp(`^Usage telemetry is ${state}\\b`));
  });
});

describe("`telemetry status` gives steps that turn usage telemetry back on", { timeout: 60000 }, () => {
  const ENABLE = "  toggle: unset OPENA2A_TELEMETRY and run ai-trust telemetry on";

  it("after `telemetry off` is saved, and OPENA2A_TELEMETRY=on leaves it off", () => {
    if (!existsSync(CLI_PATH)) return;
    const configHome = mkdtempSync(join(tmpdir(), "ai-trust-telemetry-status-"));
    try {
      expect(run(["telemetry", "off"], { configHome }).status).toBe(0);

      const { stdout, status } = run(["telemetry", "status"], { configHome, telemetry: "on" });
      expect(status).toBe(0);
      expect(stdout).toMatch(/^ {2}state: +off$/m);
      expect(stdout.split("\n")).toContain(ENABLE);
      expect(stdout).not.toContain("OPENA2A_TELEMETRY=on");
    } finally {
      rmSync(configHome, { recursive: true, force: true });
    }
  });

  it("under OPENA2A_TELEMETRY=off", () => {
    if (!existsSync(CLI_PATH)) return;
    const { stdout, status } = run(["telemetry", "status"], { telemetry: "off" });
    expect(status).toBe(0);
    expect(stdout.split("\n")).toContain(ENABLE);
    expect(stdout).not.toContain("OPENA2A_TELEMETRY=on");
  });

  it("and still names the variable that turns it off while it is on", () => {
    if (!existsSync(CLI_PATH)) return;
    const { stdout } = run(["telemetry", "status"]);
    expect(stdout).toMatch(/^ {2}state: +on$/m);
    expect(stdout).toContain("toggle: 'ai-trust telemetry off'  or  OPENA2A_TELEMETRY=off");
  });
});

describe("`telemetry on` reports the state in effect (#141)", { timeout: 60000 }, () => {
  const KEPT_OFF = "Telemetry saved as on for ai-trust, but OPENA2A_TELEMETRY keeps it off.";

  it("under OPENA2A_TELEMETRY=off, says the variable keeps it off and agrees with `telemetry status`", () => {
    if (!existsSync(CLI_PATH)) return;
    const configHome = mkdtempSync(join(tmpdir(), "ai-trust-telemetry-on-"));
    try {
      expect(run(["telemetry", "off"], { configHome }).status).toBe(0);

      const on = run(["telemetry", "on"], { configHome, telemetry: "off" });
      expect(on.status).toBe(0);
      expect(on.stdout.split("\n")[0]).toBe(KEPT_OFF);
      expect(on.stdout).not.toContain("Telemetry enabled");
      expect(on.stdout).toMatch(/^ {2}state: +off$/m);
      expect(on.stdout.split("\n")).toContain("  Enable: unset OPENA2A_TELEMETRY");

      const status = run(["telemetry", "status"], { configHome, telemetry: "off" });
      expect(status.stdout).toMatch(/^ {2}state: +off$/m);

      // The choice was saved: without the variable, usage telemetry is on.
      expect(run(["telemetry", "status"], { configHome }).stdout).toMatch(/^ {2}state: +on$/m);
    } finally {
      rmSync(configHome, { recursive: true, force: true });
    }
  });

  it("without the variable, says telemetry is enabled and on", () => {
    if (!existsSync(CLI_PATH)) return;
    const configHome = mkdtempSync(join(tmpdir(), "ai-trust-telemetry-on-"));
    try {
      const on = run(["telemetry", "on"], { configHome });
      expect(on.status).toBe(0);
      expect(on.stdout.split("\n")[0]).toBe("Telemetry enabled for ai-trust.");
      expect(on.stdout).toMatch(/^ {2}state: +on$/m);
      expect(on.stdout).not.toContain(KEPT_OFF);
    } finally {
      rmSync(configHome, { recursive: true, force: true });
    }
  });
});

describe("usage telemetry is not called anonymous", { timeout: 60000 }, () => {
  it.each([
    { variable: "unset", telemetry: undefined },
    { variable: "off", telemetry: "off" },
  ])("--help does not say anonymous (OPENA2A_TELEMETRY $variable)", ({ telemetry }) => {
    if (!existsSync(CLI_PATH)) return;
    const { stdout, stderr, status } = run(["--help"], { telemetry });
    expect(status).toBe(0);
    expect(stdout + stderr).not.toMatch(/anonymous/i);
  });

  it.each([
    ["telemetry", "--help"],
    ["help", "telemetry"],
  ])("`%s %s` describes the subcommand without calling it anonymous", (...args) => {
    if (!existsSync(CLI_PATH)) return;
    const { stdout, stderr, status } = run(args);
    expect(status).toBe(0);
    expect(stdout).toMatch(/Inspect or toggle usage telemetry/);
    expect(stdout + stderr).not.toMatch(/anonymous/i);
  });
});

describe("--help contribution line follows the saved choice", { timeout: 60000 }, () => {
  const SAVED_ON = {
    contribute: { enabled: true, consentedAt: "2026-10-18T00:00:00Z", decidedAt: "2026-10-18T00:00:00Z" },
  };

  // One OPENA2A_HOME per saved choice: none, off saved by
  // `config contribute off`, and on written to config.json.
  let notSetHome: string;
  let offHome: string;
  let onHome: string;
  let savedOff: { status: number } | undefined;

  beforeAll(() => {
    notSetHome = mkdtempSync(join(tmpdir(), "ai-trust-help-contribute-none-"));
    offHome = mkdtempSync(join(tmpdir(), "ai-trust-help-contribute-off-"));
    onHome = mkdtempSync(join(tmpdir(), "ai-trust-help-contribute-on-"));
    writeFileSync(join(onHome, "config.json"), JSON.stringify(SAVED_ON));
    if (existsSync(CLI_PATH)) {
      savedOff = run(["config", "contribute", "off"], { opena2aHome: offHome, telemetry: "off" });
    }
  });

  afterAll(() => {
    for (const home of [notSetHome, offHome, onHome]) rmSync(home, { recursive: true, force: true });
  });

  const STATES = [
    { state: "not set", home: () => notSetHome },
    { state: "off", home: () => offHome },
    { state: "on", home: () => onHome },
  ];

  it("with no choice saved, says scan results are not shared and how to share them", () => {
    if (!existsSync(CLI_PATH)) return;
    const { stdout, status } = run(["--help"], { opena2aHome: notSetHome });
    expect(status).toBe(0);

    const line = contributionLine(stdout);
    expect(line).toMatch(/^Community contribution: not set \(scan results are not shared\)\. /);
    expect(line).toContain("Enable: ai-trust config contribute on, ");
    expect(line).toContain("--contribute to check or audit for one scan");
    expect(line).not.toMatch(/may contribute|Disable:/);
  });

  it("after `config contribute off`, says scan results are not shared and how to turn it on", () => {
    if (!existsSync(CLI_PATH)) return;
    expect(savedOff?.status).toBe(0);
    const { stdout, status } = run(["--help"], { opena2aHome: offHome });
    expect(status).toBe(0);

    const line = contributionLine(stdout);
    expect(line).toMatch(/^Community contribution: disabled\. Saved as off, so scan results are not shared\. /);
    expect(line).toMatch(/Enable: ai-trust config contribute on$/);
    expect(line).not.toMatch(/may contribute|Disable:/);
  });

  it("with on saved, says scan results are shared, how to keep one scan's results local and how to turn it off", () => {
    if (!existsSync(CLI_PATH)) return;
    const { stdout, status } = run(["--help"], { opena2aHome: onHome });
    expect(status).toBe(0);

    const line = contributionLine(stdout);
    expect(line).toMatch(/^Community contribution: enabled\. Package scan results are shared with the OpenA2A Registry\. /);
    expect(line).toContain("Keep a scan's results on this machine: --no-contribute. ");
    expect(line).toMatch(/Disable: ai-trust config contribute off$/);
  });

  it.each(STATES)("starts with the line `config contribute status` prints ($state)", ({ home }) => {
    if (!existsSync(CLI_PATH)) return;
    const status = run(["config", "contribute", "status"], { opena2aHome: home(), telemetry: "off" });
    expect(status.status).toBe(0);
    const statusLine = status.stdout.split("\n")[0];
    expect(statusLine).toMatch(/^Community contribution: /);

    const line = contributionLine(run(["--help"], { opena2aHome: home() }).stdout);
    expect(line.startsWith(`${statusLine}. `)).toBe(true);
  });

  it.each(STATES)("does not change with OPENA2A_TELEMETRY; only the usage telemetry line does ($state)", ({ home }) => {
    if (!existsSync(CLI_PATH)) return;
    const unset = run(["--help"], { opena2aHome: home() }).stdout.split("\n");
    const off = run(["--help"], { opena2aHome: home(), telemetry: "off" }).stdout.split("\n");
    expect(off).toHaveLength(unset.length);

    const differing = unset.flatMap((line, i) => (line === off[i] ? [] : [i]));
    expect(differing).toEqual([unset.indexOf("Telemetry:") + 1]);
  });

  it("cites ai-trust commands that run and flags that check and audit accept", () => {
    if (!existsSync(CLI_PATH)) return;
    const lines = STATES.map(({ home }) => contributionLine(run(["--help"], { opena2aHome: home() }).stdout));
    const cited = (pattern: RegExp) =>
      [...new Set(lines.flatMap((line) => [...line.matchAll(pattern)].map((m) => m[1])))];
    const commands = cited(/\bai-trust ([a-z]+(?: [a-z]+)*)/g);
    const flags = cited(/(?<![\w-])(--[a-z][a-z-]*)/g);
    expect(commands.sort()).toEqual(["config contribute off", "config contribute on"]);
    expect(flags.sort()).toEqual(["--contribute", "--no-contribute"]);

    // Each command runs in an OPENA2A_HOME of its own.
    for (const command of commands) {
      const opena2aHome = mkdtempSync(join(tmpdir(), "ai-trust-help-contribute-cited-"));
      try {
        expect(run(command.split(" "), { opena2aHome, telemetry: "off" }).status).toBe(0);
      } finally {
        rmSync(opena2aHome, { recursive: true, force: true });
      }
    }
    for (const subcommand of ["check", "audit"]) {
      const help = run([subcommand, "--help"]).stdout;
      for (const flag of flags) expect(help).toMatch(new RegExp(`^ +${flag} `, "m"));
    }
  });
});
