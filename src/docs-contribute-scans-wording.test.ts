/**
 * The contribute-scans page says what a shared re-scan sends.
 *
 * A re-scan with sharing on sends the Registry the newer findings. The page
 * says that in one line, says nothing about trust data being kept current,
 * and keeps its statement that each scan you run shares its results.
 */
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

const PAGE = resolve(__dirname, "..", "docs", "use-cases", "contribute-scans.md");
const RESCAN_LINE =
  "- **Re-scans are shared too.** When you re-scan a package with sharing on, the Registry receives your newer findings.";
const SHARING_LINE =
  "With contribution enabled, every scan you run automatically shares results with the OpenA2A Registry:";

function pageLines(): string[] {
  return readFileSync(PAGE, "utf8").split("\n");
}

describe("docs/use-cases/contribute-scans.md", () => {
  it("says nothing about keeping trust data current", () => {
    expect(pageLines().filter((line) => line.includes("keeping trust data current"))).toEqual([]);
  });

  it("says once that a re-scan with sharing on sends the Registry the newer findings", () => {
    expect(pageLines().filter((line) => line === RESCAN_LINE)).toHaveLength(1);
  });

  it("still says that each scan you run with sharing on shares its results", () => {
    expect(pageLines()).toContain(SHARING_LINE);
  });
});
