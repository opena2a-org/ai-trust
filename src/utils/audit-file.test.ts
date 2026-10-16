/**
 * Tests for the dependency-file probe behind the audit next step, and the
 * refusal of a file audit does not read.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { auditFileRefusal, findAuditFile } from "./audit-file.js";

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
