/**
 * Tests for the scan orchestrator (scanPackage, trust derivation,
 * package-identity guard, scanLocalPath).
 */

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

vi.mock("./downloader.js", () => ({
  downloadPackage: vi.fn(),
}));

vi.mock("./hma.js", () => ({
  runHmaScan: vi.fn(),
  isHmaAvailable: vi.fn(),
}));

import { downloadPackage } from "./downloader.js";
import { runHmaScan } from "./hma.js";
import { scanPackage, scanLocalPath, assertPackageMatchesName } from "./index.js";

let tmpRoot: string;
const mockCleanup = vi.fn().mockResolvedValue(undefined);

function setupDownload(packageJsonName: string): string {
  const dir = join(tmpRoot, "package");
  mkdirSync(dir, { recursive: true });
  writeFileSync(
    join(dir, "package.json"),
    JSON.stringify({ name: packageJsonName, version: "1.0.0" }),
  );
  vi.mocked(downloadPackage).mockResolvedValue({ dir, cleanup: mockCleanup });
  return dir;
}

function setupDownloadRaw(content: string | null): string {
  const dir = join(tmpRoot, "package");
  mkdirSync(dir, { recursive: true });
  if (content !== null) {
    writeFileSync(join(dir, "package.json"), content);
  }
  vi.mocked(downloadPackage).mockResolvedValue({ dir, cleanup: mockCleanup });
  return dir;
}

beforeEach(() => {
  vi.clearAllMocks();
  tmpRoot = mkdtempSync(join(tmpdir(), "ai-trust-test-"));
});

afterEach(() => {
  rmSync(tmpRoot, { recursive: true, force: true });
});

describe("scanPackage", () => {
  it("downloads, scans, and cleans up", async () => {
    setupDownload("test-pkg");
    vi.mocked(runHmaScan).mockResolvedValue({
      score: 95,
      maxScore: 100,
      findings: [],
      projectType: "mcp",
      timestamp: "2026-03-14T00:00:00Z",
    });

    const result = await scanPackage("test-pkg");

    expect(downloadPackage).toHaveBeenCalledWith("test-pkg", "npm");
    expect(runHmaScan).toHaveBeenCalled();
    expect(mockCleanup).toHaveBeenCalled();

    expect(result.packageName).toBe("test-pkg");
    expect(result.trustScore).toBeCloseTo(0.95);
    expect(result.trustLevel).toBe(3);
    expect(result.verdict).toBe("safe");
  });

  it("derives warning verdict for high-severity findings", async () => {
    setupDownload("risky-pkg");
    vi.mocked(runHmaScan).mockResolvedValue({
      score: 75,
      maxScore: 100,
      findings: [
        {
          checkId: "SEC-001",
          name: "High issue",
          description: "",
          category: "secrets",
          severity: "high",
          passed: false,
          message: "Found issue",
        },
      ],
      projectType: "library",
      timestamp: "2026-03-14T00:00:00Z",
    });

    const result = await scanPackage("risky-pkg");
    expect(result.verdict).toBe("warning");
  });

  it("derives blocked verdict for critical findings", async () => {
    setupDownload("bad-pkg");
    vi.mocked(runHmaScan).mockResolvedValue({
      score: 20,
      maxScore: 100,
      findings: [
        {
          checkId: "SEC-002",
          name: "Critical issue",
          description: "",
          category: "secrets",
          severity: "critical",
          passed: false,
          message: "Critical problem",
        },
      ],
      projectType: "library",
      timestamp: "2026-03-14T00:00:00Z",
    });

    const result = await scanPackage("bad-pkg");
    expect(result.verdict).toBe("blocked");
    expect(result.trustLevel).toBe(0);
  });

  it("derives warning (not blocked) for high score with critical findings", async () => {
    setupDownload("@modelcontextprotocol/server-filesystem");
    vi.mocked(runHmaScan).mockResolvedValue({
      score: 92,
      maxScore: 100,
      findings: [
        {
          checkId: "SEC-010",
          name: "SQL Injection Protection",
          description: "",
          category: "security",
          severity: "critical",
          passed: false,
          message: "No parameterized queries found",
        },
        {
          checkId: "SEC-011",
          name: "Password Hashing",
          description: "",
          category: "security",
          severity: "critical",
          passed: false,
          message: "No bcrypt/argon2 found",
        },
      ],
      projectType: "mcp",
      timestamp: "2026-04-07T00:00:00Z",
    });

    const result = await scanPackage("@modelcontextprotocol/server-filesystem");
    expect(result.verdict).toBe("warning");
    expect(result.trustScore).toBeCloseTo(0.92);
    expect(result.trustLevel).toBe(3);
  });

  it("cleans up even when scan fails", async () => {
    setupDownload("crash-pkg");
    vi.mocked(runHmaScan).mockRejectedValue(new Error("scan crashed"));

    await expect(scanPackage("crash-pkg")).rejects.toThrow("scan crashed");
    expect(mockCleanup).toHaveBeenCalled();
  });

  it("derives trust levels correctly", async () => {
    const baseScan = (score: number) => ({
      score,
      maxScore: 100,
      findings: [],
      projectType: "library" as const,
      timestamp: "2026-03-14T00:00:00Z",
    });

    setupDownload("pkg-a");
    vi.mocked(runHmaScan).mockResolvedValue(baseScan(90));
    let result = await scanPackage("pkg-a");
    expect(result.trustLevel).toBe(3);

    setupDownload("pkg-b");
    vi.mocked(runHmaScan).mockResolvedValue(baseScan(70));
    result = await scanPackage("pkg-b");
    expect(result.trustLevel).toBe(2);

    setupDownload("pkg-c");
    vi.mocked(runHmaScan).mockResolvedValue(baseScan(40));
    result = await scanPackage("pkg-c");
    expect(result.trustLevel).toBe(1);

    setupDownload("pkg-d");
    vi.mocked(runHmaScan).mockResolvedValue(baseScan(30));
    result = await scanPackage("pkg-d");
    expect(result.trustLevel).toBe(0);
  });
});

describe("assertPackageMatchesName (package identity guard)", () => {
  it("accepts an exact match", async () => {
    const dir = setupDownload("foo");
    await expect(assertPackageMatchesName(dir, "foo")).resolves.toBeUndefined();
  });

  it("accepts a case-insensitive match", async () => {
    const dir = setupDownload("FOO");
    await expect(assertPackageMatchesName(dir, "foo")).resolves.toBeUndefined();
  });

  it("accepts the legitimate scope shorthand (server-filesystem → @modelcontextprotocol/server-filesystem)", async () => {
    const dir = setupDownload("@modelcontextprotocol/server-filesystem");
    await expect(
      assertPackageMatchesName(dir, "server-filesystem"),
    ).resolves.toBeUndefined();
  });

  it("accepts an exact-match scoped name", async () => {
    const dir = setupDownload("@scope/foo");
    await expect(
      assertPackageMatchesName(dir, "@scope/foo"),
    ).resolves.toBeUndefined();
  });

  // Bypass attempts for the central guard claim — these MUST throw.
  it("rejects unscoped prefix-with-slash (evil-corp/foo)", async () => {
    const dir = setupDownload("evil-corp/foo");
    await expect(assertPackageMatchesName(dir, "foo")).rejects.toThrow(
      /requested "foo" but tarball contains "evil-corp\/foo"/,
    );
  });

  it("rejects multi-slash names (foo/bar/baz)", async () => {
    const dir = setupDownload("foo/bar/baz");
    await expect(assertPackageMatchesName(dir, "baz")).rejects.toThrow(
      /requested "baz" but tarball contains "foo\/bar\/baz"/,
    );
  });

  it("rejects malformed scopes (@a/b/c with extra slash)", async () => {
    const dir = setupDownload("@a/b/c");
    await expect(assertPackageMatchesName(dir, "c")).rejects.toThrow(
      /requested "c"/,
    );
  });

  it("rejects leading-slash names (/foo)", async () => {
    const dir = setupDownload("/foo");
    await expect(assertPackageMatchesName(dir, "foo")).rejects.toThrow(
      /requested "foo" but tarball contains "\/foo"/,
    );
  });

  it("rejects scope-only names (@scope/)", async () => {
    const dir = setupDownload("@scope/");
    await expect(assertPackageMatchesName(dir, "")).rejects.toThrow(
      /no "name" field|requested ""/,
    );
  });

  it("rejects mismatched names", async () => {
    const dir = setupDownload("alpha");
    await expect(assertPackageMatchesName(dir, "beta")).rejects.toThrow(
      /requested "beta" but tarball contains "alpha"/,
    );
  });

  it("rejects when the request is scoped but the tarball is unscoped", async () => {
    const dir = setupDownload("foo");
    await expect(
      assertPackageMatchesName(dir, "@scope/foo"),
    ).rejects.toThrow(/requested "@scope\/foo" but tarball contains "foo"/);
  });

  it("rejects when package.json is missing", async () => {
    const dir = setupDownloadRaw(null);
    await expect(assertPackageMatchesName(dir, "foo")).rejects.toThrow(
      /could not be read \(ENOENT\)/,
    );
  });

  it("rejects when package.json is not valid JSON", async () => {
    const dir = setupDownloadRaw("{ this is not json");
    await expect(assertPackageMatchesName(dir, "foo")).rejects.toThrow(
      /not valid JSON/,
    );
  });

  it("rejects when name field is missing", async () => {
    const dir = setupDownloadRaw(JSON.stringify({ version: "1.0.0" }));
    await expect(assertPackageMatchesName(dir, "foo")).rejects.toThrow(
      /no "name" field/,
    );
  });

  it("rejects when name field is non-string (array)", async () => {
    const dir = setupDownloadRaw(
      JSON.stringify({ name: ["foo"], version: "1.0.0" }),
    );
    await expect(assertPackageMatchesName(dir, "foo")).rejects.toThrow(
      /no "name" field/,
    );
  });

  it("rejects when name field is non-string (number)", async () => {
    const dir = setupDownloadRaw(
      JSON.stringify({ name: 42, version: "1.0.0" }),
    );
    await expect(assertPackageMatchesName(dir, "foo")).rejects.toThrow(
      /no "name" field/,
    );
  });
});

describe("scanLocalPath", () => {
  it("rejects non-existent target directory", async () => {
    await expect(
      scanLocalPath(join(tmpRoot, "does-not-exist")),
    ).rejects.toThrow(/could not be read \(ENOENT\)/);
  });

  it("rejects target that is a file, not a directory", async () => {
    const filePath = join(tmpRoot, "file.txt");
    writeFileSync(filePath, "hello");
    await expect(scanLocalPath(filePath)).rejects.toThrow(
      /is not a directory/,
    );
  });

  it("scans a real directory and returns a verdict", async () => {
    const dir = join(tmpRoot, "real-dir");
    mkdirSync(dir, { recursive: true });
    vi.mocked(runHmaScan).mockResolvedValue({
      score: 80,
      maxScore: 100,
      findings: [],
      projectType: "library",
      timestamp: "2026-04-28T00:00:00Z",
    });

    const result = await scanLocalPath(dir);
    expect(runHmaScan).toHaveBeenCalledWith(dir, {});
    expect(result.packageName).toBe(dir);
    expect(result.trustScore).toBeCloseTo(0.8);
    expect(result.verdict).toBe("safe");
  });
});
