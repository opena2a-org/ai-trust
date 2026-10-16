/**
 * `ai-trust --json telemetry [on|off|status]` prints one JSON object (#177).
 *
 * The global --json flag applies to the telemetry subcommand as it does to
 * `config contribute`: the state the text output shows (on or off, the install
 * ID, the config file and the policy URL) as camelCase JSON on stdout. An
 * unknown action is a JSON error object and exit 1. Without --json the text
 * output is unchanged.
 *
 * Exercises the built `dist/index.js` end-to-end.
 */
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { resolve, join } from "node:path";
import { tmpdir } from "node:os";

const CLI_PATH = resolve(__dirname, "../dist/index.js");
const STRIP_ANSI = /\x1b\[[0-9;]*m/g;

// @opena2a/telemetry reads its saved choice from XDG_CONFIG_HOME: each test
// gets a fresh directory, so the default (on) applies until a test saves one.
let configHome: string;

beforeEach(() => {
  configHome = mkdtempSync(join(tmpdir(), "ai-trust-telemetry-json-"));
});

afterEach(() => {
  rmSync(configHome, { recursive: true, force: true });
});

function run(
  args: string[],
  telemetryVariable?: string,
): { stdout: string; stderr: string; status: number } {
  const env: NodeJS.ProcessEnv = {
    ...process.env,
    NODE_OPTIONS: "",
    NO_COLOR: "1",
    XDG_CONFIG_HOME: configHome,
    // No command here sends an event; an unreachable endpoint keeps it so.
    OPENA2A_TELEMETRY_URL: "http://127.0.0.1:1/never",
  };
  delete env.OPENA2A_TELEMETRY;
  if (telemetryVariable !== undefined) env.OPENA2A_TELEMETRY = telemetryVariable;
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

describe("ai-trust --json telemetry", () => {
  it("dist/index.js exists", () => {
    expect(existsSync(CLI_PATH)).toBe(true);
  });

  it.each([
    [["--json", "telemetry", "status"]],
    [["telemetry", "status", "--json"]],
    [["--json", "telemetry"]],
  ])("%j prints the status as JSON", (args) => {
    const res = run(args);
    expect(res.status).toBe(0);
    const json = JSON.parse(res.stdout);
    expect(json).toEqual({
      tool: "ai-trust",
      enabled: true,
      installId: expect.stringMatching(/\S/),
      configPath: expect.stringContaining(configHome),
      policyUrl: "https://opena2a.org/telemetry",
    });
  });

  it("reports the install ID and config file the text status names", () => {
    const json = JSON.parse(run(["--json", "telemetry", "status"]).stdout);
    const text = run(["telemetry", "status"]).stdout;
    expect(text).toContain(`install_id:  ${json.installId}`);
    expect(text).toContain(`config:      ${json.configPath}`);
  });

  it("`off` saves the choice and reports it off; status then reads off", () => {
    const off = run(["--json", "telemetry", "off"]);
    expect(off.status).toBe(0);
    expect(JSON.parse(off.stdout)).toMatchObject({ tool: "ai-trust", enabled: false });

    const status = run(["--json", "telemetry", "status"]);
    expect(JSON.parse(status.stdout)).toMatchObject({ enabled: false });
  });

  it("`on` with OPENA2A_TELEMETRY=off reports it still off and names the variable", () => {
    run(["telemetry", "off"]);
    const on = run(["--json", "telemetry", "on"], "off");
    expect(on.status).toBe(0);
    expect(JSON.parse(on.stdout)).toMatchObject({
      enabled: false,
      keptOffBy: "OPENA2A_TELEMETRY",
    });
  });

  it("`on` without the variable reports it on, with no keptOffBy", () => {
    run(["telemetry", "off"]);
    const json = JSON.parse(run(["--json", "telemetry", "on"]).stdout);
    expect(json.enabled).toBe(true);
    expect(json).not.toHaveProperty("keptOffBy");
  });

  it("an unknown action is a JSON error and exit 1", () => {
    const res = run(["--json", "telemetry", "bogus"]);
    expect(res.status).toBe(1);
    expect(JSON.parse(res.stdout)).toEqual({
      error: "Unknown action 'bogus'. Use: ai-trust telemetry on | off | status",
    });
  });

  it("without --json the status stays text", () => {
    const res = run(["telemetry", "status"]);
    expect(res.status).toBe(0);
    expect(res.stdout.startsWith("ai-trust telemetry\n  state:       on")).toBe(true);
  });
});
