/**
 * Tests for the scan orchestrator (scanPackage, trust derivation,
 * package-identity guard, scanLocalPath).
 */

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, symlinkSync } from "node:fs";
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
import { scanPackage, scanLocalPath, assertPackageMatchesName, readPackageVersion } from "./index.js";

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

    expect(downloadPackage).toHaveBeenCalledWith("test-pkg", "npm", undefined);
    expect(runHmaScan).toHaveBeenCalled();
    expect(mockCleanup).toHaveBeenCalled();

    expect(result.packageName).toBe("test-pkg");
    expect(result.trustScore).toBeCloseTo(0.95);
    expect(result.trustLevel).toBe(3);
    expect(result.verdict).toBe("safe");
  });

  it("carries the version from the downloaded package's own manifest", async () => {
    setupDownload("test-pkg");
    vi.mocked(runHmaScan).mockResolvedValue({
      score: 95,
      maxScore: 100,
      findings: [],
      projectType: "mcp",
      timestamp: "2026-03-14T00:00:00Z",
    });

    const result = await scanPackage("test-pkg");
    expect(result.packageVersion).toBe("1.0.0");
  });

  it("downloads the version asked for, checks the tarball against the name alone and names the scan <name>@<version>", async () => {
    setupDownload("test-pkg");
    vi.mocked(runHmaScan).mockResolvedValue({
      score: 95,
      maxScore: 100,
      findings: [],
      projectType: "mcp",
      timestamp: "2026-03-14T00:00:00Z",
    });

    const result = await scanPackage("test-pkg", { version: "1.0.0" });

    expect(downloadPackage).toHaveBeenCalledWith("test-pkg", "npm", "1.0.0");
    expect(runHmaScan).toHaveBeenCalled();
    expect(mockCleanup).toHaveBeenCalled();
    expect(result.packageName).toBe("test-pkg@1.0.0");
    expect(result.packageVersion).toBe("1.0.0");
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

  it("drops the absent-artifact advisories DEP-001 and SANDBOX-001 and recomputes the score", async () => {
    setupDownload("@modelcontextprotocol/server-memory");
    vi.mocked(runHmaScan).mockResolvedValue({
      score: 85,
      maxScore: 100,
      findings: [
        {
          checkId: "DEP-001",
          name: "Dependency Lock File",
          description: "",
          category: "dependencies",
          severity: "medium",
          passed: false,
          message: "No lock file found - dependency versions may vary between installs",
          file: "package-lock.json",
        },
        {
          checkId: "SANDBOX-001",
          name: "Container Isolation",
          description: "",
          category: "sandboxing",
          severity: "medium",
          passed: false,
          message: "Consider running in Docker containers for isolation",
          file: "Dockerfile",
        },
        {
          // Same category as DEP-001: the exclusion is by check id, so a
          // real detection in "dependencies" stays.
          checkId: "DEP-900",
          name: "Real medium detection",
          description: "",
          category: "dependencies",
          severity: "medium",
          passed: false,
          message: "A real finding",
          file: "package.json",
        },
      ],
      projectType: "mcp",
      timestamp: "2026-10-11T00:00:00Z",
    });

    const result = await scanPackage("@modelcontextprotocol/server-memory");
    expect(result.scan.findings.map((f) => f.checkId)).toEqual(["DEP-900"]);
    // One medium: round(100 * exp(-8 / 150)) = 95.
    expect(result.scan.score).toBe(95);
    expect(result.trustScore).toBeCloseTo(0.95);
    expect(result.trustLevel).toBe(3);
    expect(result.verdict).toBe("safe");
  });

  it("keeps a passing SANDBOX-001 record", async () => {
    setupDownload("ships-a-dockerfile");
    vi.mocked(runHmaScan).mockResolvedValue({
      score: 100,
      maxScore: 100,
      findings: [
        {
          checkId: "SANDBOX-001",
          name: "Container Isolation",
          description: "",
          category: "sandboxing",
          severity: "medium",
          passed: true,
          message: "Container configuration detected",
        },
      ],
      projectType: "mcp",
      timestamp: "2026-10-11T00:00:00Z",
    });

    const result = await scanPackage("ships-a-dockerfile");
    expect(result.scan.findings.map((f) => f.checkId)).toEqual(["SANDBOX-001"]);
    expect(result.scan.score).toBe(100);
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

describe("readPackageVersion", () => {
  it("reads version from an npm package.json", async () => {
    const dir = setupDownloadRaw(JSON.stringify({ name: "a", version: "2.3.4-beta.1" }));
    await expect(readPackageVersion(dir, "npm")).resolves.toBe("2.3.4-beta.1");
  });

  it("returns undefined when package.json has no version or cannot be parsed", async () => {
    const dir = setupDownloadRaw(JSON.stringify({ name: "a" }));
    await expect(readPackageVersion(dir, "npm")).resolves.toBeUndefined();
    writeFileSync(join(dir, "package.json"), "{ not json");
    await expect(readPackageVersion(dir, "npm")).resolves.toBeUndefined();
  });

  it("drops a version field that is not version-shaped instead of sending it", async () => {
    const dir = setupDownloadRaw(
      JSON.stringify({ name: "a", version: '1.0.0 "mcpServers": { "leaky": {} }' }),
    );
    await expect(readPackageVersion(dir, "npm")).resolves.toBeUndefined();
  });

  it("reads Version from a PyPI sdist PKG-INFO header", async () => {
    const dir = setupDownloadRaw(null);
    writeFileSync(
      join(dir, "PKG-INFO"),
      "Metadata-Version: 2.1\nName: demo\nVersion: 0.9.1\n\nVersion: 9.9.9 in the body is ignored\n",
    );
    await expect(readPackageVersion(dir, "pypi")).resolves.toBe("0.9.1");
  });

  it("reads Version from a PyPI wheel dist-info METADATA", async () => {
    const dir = setupDownloadRaw(null);
    mkdirSync(join(dir, "demo-1.4.0.dist-info"), { recursive: true });
    writeFileSync(
      join(dir, "demo-1.4.0.dist-info", "METADATA"),
      "Metadata-Version: 2.1\r\nName: demo\r\nVersion: 1.4.0\r\n",
    );
    await expect(readPackageVersion(dir, "pypi")).resolves.toBe("1.4.0");
  });

  it("returns undefined for a PyPI tree with no metadata file", async () => {
    const dir = setupDownloadRaw(null);
    await expect(readPackageVersion(dir, "pypi")).resolves.toBeUndefined();
  });

  it("reads a 200 KB Version header with a lone CR in it without stalling", async () => {
    // The header comes from the downloaded package. A pattern whose parts
    // overlap backtracks quadratically on this line (seconds at 200 KB).
    const dir = setupDownloadRaw(null);
    writeFileSync(
      join(dir, "PKG-INFO"),
      `Metadata-Version: 2.1\nName: demo\nVersion:${" ".repeat(200_000)}a\rb\n`,
    );
    const started = performance.now();
    await expect(readPackageVersion(dir, "pypi")).resolves.toBeUndefined();
    expect(performance.now() - started).toBeLessThan(1000);
  });

  it("does not follow a manifest symlink out of the extracted package", async () => {
    const outside = join(tmpRoot, "outside");
    mkdirSync(join(outside, "elsewhere.dist-info"), { recursive: true });
    writeFileSync(join(outside, "PKG-INFO"), "Metadata-Version: 2.1\nName: other\nVersion: 6.6.6\n");
    writeFileSync(join(outside, "elsewhere.dist-info", "METADATA"), "Name: other\nVersion: 6.6.7\n");
    writeFileSync(join(outside, "package.json"), JSON.stringify({ name: "other", version: "6.6.8" }));

    const dir = setupDownloadRaw(null);
    symlinkSync(join(outside, "PKG-INFO"), join(dir, "PKG-INFO"));
    symlinkSync(join(outside, "elsewhere.dist-info"), join(dir, "demo-1.0.dist-info"));
    symlinkSync(join(outside, "package.json"), join(dir, "package.json"));

    await expect(readPackageVersion(dir, "pypi")).resolves.toBeUndefined();
    await expect(readPackageVersion(dir, "npm")).resolves.toBeUndefined();
  });

  it("skips a symlinked PKG-INFO and still reads a regular dist-info METADATA", async () => {
    const outside = join(tmpRoot, "outside-PKG-INFO");
    writeFileSync(outside, "Metadata-Version: 2.1\nName: other\nVersion: 6.6.6\n");
    const dir = setupDownloadRaw(null);
    symlinkSync(outside, join(dir, "PKG-INFO"));
    mkdirSync(join(dir, "demo-1.4.0.dist-info"));
    writeFileSync(join(dir, "demo-1.4.0.dist-info", "METADATA"), "Name: demo\nVersion: 1.4.0\n");

    await expect(readPackageVersion(dir, "pypi")).resolves.toBe("1.4.0");
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

  it("rejects when package.json is a symlink, without reading its target", async () => {
    const outside = join(tmpRoot, "outside-package.json");
    writeFileSync(outside, JSON.stringify({ name: "foo", version: "1.0.0" }));
    const dir = setupDownloadRaw(null);
    symlinkSync(outside, join(dir, "package.json"));
    await expect(assertPackageMatchesName(dir, "foo")).rejects.toThrow(
      /package\.json is not a regular file/,
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

  it("keeps DEP-001 and SANDBOX-001 on a local tree", async () => {
    const dir = join(tmpRoot, "local-tree");
    mkdirSync(dir, { recursive: true });
    vi.mocked(runHmaScan).mockResolvedValue({
      score: 90,
      maxScore: 100,
      findings: [
        {
          checkId: "DEP-001",
          name: "Dependency Lock File",
          description: "",
          category: "dependencies",
          severity: "medium",
          passed: false,
          message: "No lock file found - dependency versions may vary between installs",
          file: "package-lock.json",
        },
        {
          checkId: "SANDBOX-001",
          name: "Container Isolation",
          description: "",
          category: "sandboxing",
          severity: "medium",
          passed: false,
          message: "Consider running in Docker containers for isolation",
          file: "Dockerfile",
        },
      ],
      projectType: "mcp",
      timestamp: "2026-10-11T00:00:00Z",
    });

    const result = await scanLocalPath(dir);
    expect(result.scan.findings.map((f) => f.checkId)).toEqual([
      "DEP-001",
      "SANDBOX-001",
    ]);
    expect(result.scan.score).toBe(90);
  });
});
