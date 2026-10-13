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
 * Exercises the built `dist/index.js` end-to-end.
 */
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { resolve, join } from "node:path";
import { tmpdir } from "node:os";

const CLI_PATH = resolve(__dirname, "../dist/index.js");
const STRIP_ANSI = /\x1b\[[0-9;]*m/g;

// @opena2a/telemetry reads its saved choice from XDG_CONFIG_HOME, so each
// state under test gets its own fresh directory: no telemetry.json means the
// default (on) applies, whatever the machine running the suite has saved.
// Made in a hook, not at module scope, so nothing is left behind by a run
// that only lists tests.
let freshConfigHome: string;
let savedChoiceConfigHome: string;

beforeAll(() => {
  freshConfigHome = mkdtempSync(join(tmpdir(), "ai-trust-help-telemetry-"));
  savedChoiceConfigHome = mkdtempSync(join(tmpdir(), "ai-trust-help-telemetry-saved-"));
});

afterAll(() => {
  rmSync(freshConfigHome, { recursive: true, force: true });
  rmSync(savedChoiceConfigHome, { recursive: true, force: true });
});

interface RunOptions {
  /** Value for OPENA2A_TELEMETRY; omitted means the variable is not set. */
  telemetry?: string;
  configHome?: string;
}

function run(args: string[], options: RunOptions = {}): { stdout: string; stderr: string; status: number } {
  const env: NodeJS.ProcessEnv = {
    ...process.env,
    NODE_OPTIONS: "",
    NO_COLOR: "1",
    XDG_CONFIG_HOME: options.configHome ?? freshConfigHome,
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
