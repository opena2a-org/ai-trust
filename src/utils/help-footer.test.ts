import { describe, it, expect } from "vitest";
import { describeContributeChoice, helpFooter, onKeptOffByVariable, withEnableSteps } from "./help-footer.js";

/** The first line under the "Telemetry:" heading. */
function telemetryLine(footer: string): string {
  const lines = footer.split("\n");
  return lines[lines.indexOf("Telemetry:") + 1];
}

/** The second line under the "Telemetry:" heading: the saved contribution choice. */
function contributionLine(footer: string): string {
  const lines = footer.split("\n");
  return lines[lines.indexOf("Telemetry:") + 2];
}

// The saved contribution choices readContributeChoice() returns: on, off and
// none saved.
const CHOICES = [true, false, undefined];

describe("helpFooter", () => {
  it("says usage telemetry is on, names the install ID and gives the opt-out", () => {
    expect(telemetryLine(helpFooter(true, undefined))).toBe(
      "  Usage telemetry is on and each event carries a persistent install ID. Disable: OPENA2A_TELEMETRY=off",
    );
  });

  it("says usage telemetry is off, and how to turn it on, when it is disabled", () => {
    expect(telemetryLine(helpFooter(false, undefined))).toBe(
      "  Usage telemetry is off. Enable: unset OPENA2A_TELEMETRY and run ai-trust telemetry on",
    );
  });

  it("never reports the state it was not given", () => {
    for (const choice of CHOICES) {
      expect(helpFooter(true, choice)).not.toMatch(/telemetry is off/i);
      expect(helpFooter(false, choice)).not.toMatch(/telemetry is on/i);
    }
  });

  it.each([true, false])("does not call usage telemetry anonymous (enabled=%s)", (enabled) => {
    for (const choice of CHOICES) {
      expect(helpFooter(enabled, choice)).not.toMatch(/anonymous/i);
    }
  });

  // OPENA2A_TELEMETRY decides the usage telemetry state, never the
  // contribution line.
  it.each(CHOICES)("changes only the usage telemetry line between usage telemetry states (contribution %s)", (choice) => {
    const on = helpFooter(true, choice).split("\n");
    const off = helpFooter(false, choice).split("\n");
    expect(off).toHaveLength(on.length);

    const differing = on.flatMap((line, i) => (line === off[i] ? [] : [i]));
    expect(differing).toEqual([on.indexOf("Telemetry:") + 1]);
  });

  it("keeps the scan contribution disclosure in every state", () => {
    for (const enabled of [true, false]) {
      for (const choice of CHOICES) {
        const footer = helpFooter(enabled, choice);
        expect(footer).toMatch(/^\nTelemetry:\n/);
        expect(footer).toMatch(/\n {2}Community contribution: [^\n]+\n$/);
        // During an ai-trust scan the bundled scanner sends no telemetry and no
        // scan results, and with ANTHROPIC_API_KEY set it sends no request to
        // the LLM provider (src/scanner/hma-saved-state.test.ts measures both),
        // so there is no exception to --no-contribute to state.
        expect(footer).not.toMatch(/classification|--no-deep/);
        expect(footer).not.toMatch(/opena2a config/);
      }
    }
  });
});

describe("helpFooter contribution line", () => {
  it("gives a different line for each saved choice", () => {
    const lines = CHOICES.map((choice) => contributionLine(helpFooter(true, choice)));
    expect(new Set(lines).size).toBe(3);
  });

  it("with no choice saved, says scan results are not shared and how to share them", () => {
    expect(contributionLine(helpFooter(true, undefined))).toBe(
      "  Community contribution: not set (scan results are not shared). Enable: ai-trust config contribute on, or pass --contribute to check or audit for one scan",
    );
  });

  it("with off saved, says scan results are not shared, that off is saved, and how to turn it on", () => {
    expect(contributionLine(helpFooter(true, false))).toBe(
      "  Community contribution: disabled. Saved as off, so scan results are not shared. Enable: ai-trust config contribute on",
    );
  });

  it("with on saved, says scan results are shared, how to keep one scan's results local and how to turn it off", () => {
    const line = contributionLine(helpFooter(true, true));
    expect(line).toBe(
      "  Community contribution: enabled. Package scan results are shared with the OpenA2A Registry. Keep a scan's results on this machine: --no-contribute. Disable: ai-trust config contribute off",
    );
    expect(line).toContain("--no-contribute");
    expect(line).toContain("config contribute off");
  });

  it.each([false, undefined])("does not say scans may contribute or give a Disable step when nothing is shared (choice %s)", (choice) => {
    const line = contributionLine(helpFooter(true, choice));
    expect(line).not.toMatch(/may contribute/);
    expect(line).not.toMatch(/Disable:/);
  });

  // `ai-trust config contribute status` prints "Community contribution: " and
  // the same words, so the two cannot disagree.
  it.each(CHOICES)("starts with the words `config contribute status` prints (choice %s)", (choice) => {
    expect(contributionLine(helpFooter(true, choice)).startsWith(
      `  Community contribution: ${describeContributeChoice(choice)}. `,
    )).toBe(true);
  });
});

describe("describeContributeChoice", () => {
  it("words each saved choice", () => {
    expect(describeContributeChoice(true)).toBe("enabled");
    expect(describeContributeChoice(false)).toBe("disabled");
    expect(describeContributeChoice(undefined)).toBe("not set (scan results are not shared)");
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
