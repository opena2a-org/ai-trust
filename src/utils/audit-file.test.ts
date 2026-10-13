/**
 * Tests for the dependency-file probe behind the audit next step.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { findAuditFile } from "./audit-file.js";

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
