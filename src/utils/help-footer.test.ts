import { describe, it, expect } from "vitest";
import { helpFooter, onKeptOffByVariable, withEnableSteps } from "./help-footer.js";

/** The first line under the "Telemetry:" heading. */
function telemetryLine(footer: string): string {
  const lines = footer.split("\n");
  return lines[lines.indexOf("Telemetry:") + 1];
}

describe("helpFooter", () => {
  it("says usage telemetry is on, names the install ID and gives the opt-out", () => {
    expect(telemetryLine(helpFooter(true))).toBe(
      "  Usage telemetry is on and each event carries a persistent install ID. Disable: OPENA2A_TELEMETRY=off",
    );
  });

  it("says usage telemetry is off, and how to turn it on, when it is disabled", () => {
    expect(telemetryLine(helpFooter(false))).toBe(
      "  Usage telemetry is off. Enable: unset OPENA2A_TELEMETRY and run ai-trust telemetry on",
    );
  });

  it("never reports the state it was not given", () => {
    expect(helpFooter(true)).not.toMatch(/telemetry is off/i);
    expect(helpFooter(false)).not.toMatch(/telemetry is on/i);
  });

  it.each([true, false])("does not call usage telemetry anonymous (enabled=%s)", (enabled) => {
    expect(helpFooter(enabled)).not.toMatch(/anonymous/i);
  });

  it("changes only the usage telemetry line between states", () => {
    const on = helpFooter(true).split("\n");
    const off = helpFooter(false).split("\n");
    expect(off).toHaveLength(on.length);

    const differing = on.flatMap((line, i) => (line === off[i] ? [] : [i]));
    expect(differing).toEqual([on.indexOf("Telemetry:") + 1]);
  });

  it("keeps the scan contribution disclosure in both states", () => {
    for (const footer of [helpFooter(true), helpFooter(false)]) {
      expect(footer).toMatch(/^\nTelemetry:\n/);
      expect(footer).toMatch(/Local scans may contribute to the OpenA2A Registry/);
      expect(footer).toMatch(/--no-contribute/);
      expect(footer).toMatch(/or ai-trust config contribute off \(saved\)\n$/);
      // During an ai-trust scan the bundled scanner sends no telemetry and no
      // scan results, and with ANTHROPIC_API_KEY set it sends no request to
      // the LLM provider (src/scanner/hma-saved-state.test.ts measures both),
      // so there is no exception to --no-contribute to state.
      expect(footer).not.toMatch(/classification|--no-deep/);
      expect(footer).not.toMatch(/opena2a config/);
    }
  });
});

describe("withEnableSteps", () => {
  it("replaces the OPENA2A_TELEMETRY=on hint with the steps the help footer gives", () => {
    const status = "ai-trust telemetry\n  state:       off\n\n  toggle: 'ai-trust telemetry on'  or  OPENA2A_TELEMETRY=on";
    expect(withEnableSteps(status)).toBe(
      "ai-trust telemetry\n  state:       off\n\n  toggle: unset OPENA2A_TELEMETRY and run ai-trust telemetry on",
    );
  });

  it("leaves the hint for turning telemetry off unchanged", () => {
    const status = "  toggle: 'ai-trust telemetry off'  or  OPENA2A_TELEMETRY=off";
    expect(withEnableSteps(status)).toBe(status);
  });
});

describe("onKeptOffByVariable", () => {
  it("says the saved choice is on, keeps the state lines and names the step left (#141)", () => {
    const status = "ai-trust telemetry\n  state:       off\n\n  toggle: 'ai-trust telemetry on'  or  OPENA2A_TELEMETRY=on";
    expect(onKeptOffByVariable(status)).toBe(
      "Telemetry saved as on for ai-trust, but OPENA2A_TELEMETRY keeps it off.\n  state:       off\n\n  Enable: unset OPENA2A_TELEMETRY",
    );
  });
});
