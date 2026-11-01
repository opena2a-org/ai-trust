/**
 * Tests for the dependency-file probe behind the audit next step, and the
 * refusal of a file audit does not read.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { auditFileRefusal, findAuditFile, isRequirementsFile } from "./audit-file.js";

describe("findAuditFile", () => {
  let dir: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "ai-trust-audit-file-"));
  });

  afterEach(() => {
    vi.restoreAllMocks();
    rmSync(dir, { recursive: true, force: true });
  });

  it("returns null when neither file exists", () => {
    expect(findAuditFile(dir)).toBeNull();
  });

  it("returns package.json when only package.json exists", () => {
    writeFileSync(join(dir, "package.json"), "{}");
    expect(findAuditFile(dir)).toBe("package.json");
  });

  it("returns requirements.txt when only requirements.txt exists", () => {
    writeFileSync(join(dir, "requirements.txt"), "");
    expect(findAuditFile(dir)).toBe("requirements.txt");
  });

  it("prefers package.json when both exist", () => {
    writeFileSync(join(dir, "package.json"), "{}");
    writeFileSync(join(dir, "requirements.txt"), "");
    expect(findAuditFile(dir)).toBe("package.json");
  });

  it("does not count a directory with a supported name", () => {
    mkdirSync(join(dir, "package.json"));
    expect(findAuditFile(dir)).toBeNull();
  });

  it("does not look in a parent directory", () => {
    writeFileSync(join(dir, "package.json"), "{}");
    const child = join(dir, "child");
    mkdirSync(child);
    expect(findAuditFile(child)).toBeNull();
  });

  it("defaults to the current working directory", () => {
    writeFileSync(join(dir, "requirements.txt"), "");
    vi.spyOn(process, "cwd").mockReturnValue(dir);
    expect(findAuditFile()).toBe("requirements.txt");
  });

  it("returns null when the working directory cannot be read", () => {
    vi.spyOn(process, "cwd").mockImplementation(() => {
      throw new Error("ENOENT: process.cwd failed");
    });
    expect(findAuditFile()).toBeNull();
  });
});

describe("auditFileRefusal", () => {
  let dir: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "ai-trust-audit-refusal-"));
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it("refuses a file of another name", () => {
    const readme = join(dir, "README.md");
    writeFileSync(readme, "# DVAA\n");
    expect(auditFileRefusal(readme)?.message).toBe(
      "audit reads package.json or requirements.txt; README.md is neither."
    );
  });

  it.each(["package.json", "requirements.txt", "requirements-dev.txt", "requirements"])(
    "accepts %s",
    (name) => {
      const file = join(dir, name);
      writeFileSync(file, "");
      expect(auditFileRefusal(file)).toBeNull();
    }
  );

  it.each(["dev-requirements.txt", "test-requirements.txt"])(
    "accepts %s, a .txt file whose name contains requirements",
    (name) => {
      const file = join(dir, name);
      writeFileSync(file, "requests\n");
      expect(auditFileRefusal(file)).toBeNull();
    }
  );

  it.each(["dev.txt", "prod.txt"])(
    "accepts requirements/%s, a .txt file in a requirements directory",
    (name) => {
      mkdirSync(join(dir, "requirements"));
      const file = join(dir, "requirements", name);
      writeFileSync(file, "requests\n");
      expect(auditFileRefusal(file)).toBeNull();
    }
  );

  it("accepts dev.txt named from inside a requirements directory", () => {
    const reqDir = join(dir, "requirements");
    mkdirSync(reqDir);
    writeFileSync(join(reqDir, "dev.txt"), "requests\n");
    const cwd = process.cwd();
    process.chdir(reqDir);
    try {
      expect(auditFileRefusal("dev.txt")).toBeNull();
    } finally {
      process.chdir(cwd);
    }
  });

  it("refuses a .txt file in a directory of another name", () => {
    mkdirSync(join(dir, "deps"));
    const file = join(dir, "deps", "dev.txt");
    writeFileSync(file, "requests\n");
    expect(auditFileRefusal(file)?.message).toBe(
      "audit reads package.json or requirements.txt; dev.txt is neither."
    );
  });

  it("refuses a file in a requirements directory that is not a .txt file", () => {
    mkdirSync(join(dir, "requirements"));
    const file = join(dir, "requirements", "README.md");
    writeFileSync(file, "# Requirements\n");
    expect(auditFileRefusal(file)?.message).toBe(
      "audit reads package.json or requirements.txt; README.md is neither."
    );
  });

  it("leaves a path that does not exist to the read", () => {
    expect(auditFileRefusal(join(dir, "README.md"))).toBeNull();
  });

  it("leaves a directory to the read, whatever its name", () => {
    const sub = join(dir, "dvaa");
    mkdirSync(sub);
    expect(auditFileRefusal(sub)).toBeNull();
    expect(auditFileRefusal(`${sub}/`)).toBeNull();
  });
});

// The time of a decision on a long name is measured against the same decision
// on PIECES names of the same shape, each a PIECES-th of the length, run in
// turn at the same moment. Both sides run the same code for about as long, so
// a loaded machine that slows the process slows both alike. When the time is
// linear in the length, the one name takes about as long as the PIECES
// (isRequirementsFile: 0.5 to 2.2 times, measured on these names); when it
// grows with the square of the length, up to PIECES times as long
// (`rereadingDecision`: 30 times or more on the name of 36,000 characters).
// The bound of 6 sits between the two.
const PIECES = 100;
const LINEAR_BOUND = 6;

/**
 * The CPU time of the process, in milliseconds, which leaves out the time the
 * process waits for a CPU. Windows counts that time in steps of its clock
 * tick, about 15.6 ms, so there it is the elapsed time.
 */
const now =
  process.platform === "win32"
    ? () => performance.now()
    : () => {
        const { user, system } = process.cpuUsage();
        return (user + system) / 1000;
      };

/**
 * The time `decide` takes on `name` over the time it takes on `piece` PIECES
 * times: the fastest of five runs of each, taken in turn, so that a pause of
 * the process during one run does not decide the ratio. A slow spell of the
 * machine over a whole measurement can, so the ratio is measured up to three
 * times while it is at or over the bound.
 */
function timeRatio(decide: (path: string) => boolean, name: string, piece: string): number {
  const measure = (): number => {
    const fastest = { name: Infinity, pieces: Infinity };
    for (let run = 0; run < 5; run++) {
      let start = now();
      decide(name);
      fastest.name = Math.min(fastest.name, now() - start);
      start = now();
      for (let count = 0; count < PIECES; count++) decide(piece);
      fastest.pieces = Math.min(fastest.pieces, now() - start);
    }
    return fastest.name / fastest.pieces;
  };
  let ratio = measure();
  for (let attempt = 1; attempt < 3 && ratio >= LINEAR_BOUND; attempt++) {
    ratio = Math.min(ratio, measure());
  }
  return ratio;
}

/**
 * A decision that reads the rest of the name again from each `requirements`
 * in it, as /requirements.*\.txt$/ does, before it decides as
 * isRequirementsFile does: the same answer, in time that grows with the
 * square of the length.
 */
function rereadingDecision(path: string): boolean {
  const restOfLine = /[^\n\r\p{Zl}\p{Zp}]*/uy;
  for (let at = path.indexOf("requirements"); at !== -1; at = path.indexOf("requirements", at + 1)) {
    restOfLine.lastIndex = at;
    restOfLine.exec(path);
  }
  return isRequirementsFile(path);
}

describe("isRequirementsFile", () => {
  const lineSeparator = String.fromCharCode(0x2028);
  const paragraphSeparator = String.fromCharCode(0x2029);

  it.each([
    "requirements.txt",
    "requirements-dev.txt",
    "dev-requirements.txt",
    "test-requirements.txt",
    "requirements",
    "requirements.tx",
    "requirements.txt.bak",
    "requirementstxt",
    "requirement.txt",
    "Requirements.txt",
    "requirements.TXT",
    "deps.txt",
    ".txt",
    "requirements\n.txt",
    "requirements\r.txt",
    `requirements${lineSeparator}.txt`,
    `requirements${paragraphSeparator}.txt`,
    "x\nrequirements.txt",
    "requirements.txt\n",
  ])("decides %j as the pattern /requirements.*\\.txt$/ does", (name) => {
    const expected = name === "requirements" || /requirements.*\.txt$/.test(name);
    expect(isRequirementsFile(`/deps/${name}`)).toBe(expected);
  });

  it(`decides a 300,000-character name of repeated requirements in less than ${LINEAR_BOUND} times the time of ${PIECES} names of 3,000`, ({
    task,
  }) => {
    const name = "requirements".repeat(25_000) + ".tx";
    const piece = "requirements".repeat(25_000 / PIECES) + ".tx";
    expect(isRequirementsFile(name)).toBe(false);
    expect(isRequirementsFile(piece)).toBe(false);
    const ratio = timeRatio(isRequirementsFile, name, piece);
    // The measured ratio, for a report that reads the test's meta.
    Object.assign(task.meta, { ratios: [ratio] });
    expect(ratio).toBeLessThan(LINEAR_BOUND);
  }, 120_000);

  it(`holds a decision that reads the rest of the name again from each requirements in it to ${LINEAR_BOUND} times or more, on a name isRequirementsFile decides in less`, ({
    task,
  }) => {
    const name = "requirements".repeat(3_000) + ".tx";
    const piece = "requirements".repeat(3_000 / PIECES) + ".tx";
    expect(rereadingDecision(name)).toBe(false);
    const ratios = {
      isRequirementsFile: timeRatio(isRequirementsFile, name, piece),
      rereadingDecision: timeRatio(rereadingDecision, name, piece),
    };
    Object.assign(task.meta, { ratios: [ratios] });
    expect(ratios.isRequirementsFile).toBeLessThan(LINEAR_BOUND);
    expect(ratios.rereadingDecision).toBeGreaterThanOrEqual(LINEAR_BOUND);
  }, 120_000);
});
