import { describe, it, expect } from "vitest";
import { analystLayerNote } from "./analyst-note.js";

describe("analystLayerNote", () => {
  it("says the analyst layer ran, with the findings analyzed and the files checked", () => {
    expect(analystLayerNote({ ran: true, findingsAnalyzed: 1, sweep: { swept: 3, nullVerdicts: 0 } })).toBe(
      "AnaLM: the analyst layer ran (1 finding analyzed, 3 files checked).",
    );
  });

  it("names the files that came back without a verdict", () => {
    expect(analystLayerNote({ ran: true, findingsAnalyzed: 2, sweep: { swept: 3, nullVerdicts: 1 } })).toBe(
      "AnaLM: the analyst layer ran (2 findings analyzed, 3 files checked, 1 without a verdict).",
    );
  });

  it("says the analyst layer ran when the report has analyst findings and no sweep", () => {
    expect(analystLayerNote({ ran: true, findingsAnalyzed: 1 })).toBe(
      "AnaLM: the analyst layer ran (1 finding analyzed).",
    );
  });

  it("does not call a sweep with no verdict at all a run that worked", () => {
    expect(analystLayerNote({ ran: true, findingsAnalyzed: 0, sweep: { swept: 2, nullVerdicts: 2 } })).toBe(
      "AnaLM: the analyst daemon answered but returned no verdict for the 2 files it was sent; check the daemon's logs.",
    );
  });

  it("says why it did not run when the scanner returned no analyst output, and how to set one up", () => {
    const note = analystLayerNote({ ran: false, reason: "no-analyst-output" });
    expect(note).toBe(
      "AnaLM: the analyst layer did not run; the scanner runs it only when a NanoMind analyst daemon answers on this machine. Set one up: npx hackmyagent nanomind setup",
    );
    expect(analystLayerNote(undefined)).toBe(note);
  });

  it("names --no-deep when the scan was static-only", () => {
    expect(analystLayerNote({ ran: false, reason: "static-only" })).toBe(
      "AnaLM: the analyst layer did not run: --no-deep turns off the scanner's semantic layer, which the analyst runs inside.",
    );
  });

  it("names the scanner when it refused --analm", () => {
    expect(analystLayerNote({ ran: false, reason: "flag-rejected" })).toBe(
      "AnaLM: the analyst layer did not run: the installed hackmyagent does not accept --analm.",
    );
  });

  it("names --no-scan and a registry library, where no local scan ran", () => {
    expect(analystLayerNote("no-scan")).toBe(
      "AnaLM: the analyst layer did not run: --no-scan skips the local scan it runs in.",
    );
    expect(analystLayerNote("registry-library")).toBe(
      "AnaLM: the analyst layer did not run: the registry lists this package as a library, so no local scan ran.",
    );
  });
});
