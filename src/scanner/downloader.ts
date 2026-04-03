/**
 * Package downloader - fetch npm tarballs or PyPI sdists and extract to temp directories.
 */

import { mkdtemp, rm, readdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

export interface DownloadResult {
  /** Temporary directory containing the extracted package */
  dir: string;
  /** Cleanup function to remove the temp directory */
  cleanup: () => Promise<void>;
}

/**
 * Download a package and extract it to a temp directory.
 * Routes to npm or pip based on the ecosystem parameter.
 */
export async function downloadPackage(
  name: string,
  ecosystem: "npm" | "pypi" = "npm"
): Promise<DownloadResult> {
  if (ecosystem === "pypi") {
    return downloadPypiPackage(name);
  }
  return downloadNpmPackage(name);
}

/**
 * Download an npm package tarball and extract it to a temp directory.
 * Uses `npm pack --pack-destination` to fetch the tarball, then extracts it.
 */
async function downloadNpmPackage(name: string): Promise<DownloadResult> {
  const tempDir = await mkdtemp(join(tmpdir(), "ai-trust-scan-"));

  try {
    // Use npm pack to download the tarball
    const { stdout } = await execFileAsync(
      "npm",
      ["pack", name, "--pack-destination", tempDir],
      { timeout: 60_000 }
    );

    const tarball = stdout.trim().split("\n").pop()!;
    const tarballPath = join(tempDir, tarball);

    // Extract the tarball
    await execFileAsync("tar", ["xzf", tarballPath, "-C", tempDir], {
      timeout: 30_000,
    });

    return {
      dir: join(tempDir, "package"),
      cleanup: async () => {
        await rm(tempDir, { recursive: true, force: true });
      },
    };
  } catch (err) {
    await rm(tempDir, { recursive: true, force: true });
    throw new Error(`Failed to download "${name}": ${extractNpmError(name, err)}`);
  }
}

/**
 * Download a Python package from PyPI and extract it to a temp directory.
 * Uses `pip download --no-deps --no-binary :all:` to fetch the sdist,
 * falling back to `--only-binary :all:` for wheel-only packages.
 */
async function downloadPypiPackage(name: string): Promise<DownloadResult> {
  const tempDir = await mkdtemp(join(tmpdir(), "ai-trust-scan-"));

  try {
    // Try sdist first (contains actual source code for scanning)
    try {
      await execFileAsync(
        "pip",
        ["download", name, "--no-deps", "--no-binary", ":all:", "-d", tempDir],
        { timeout: 120_000 }
      );
    } catch {
      // Some packages only publish wheels; fall back to wheel download
      await execFileAsync(
        "pip",
        ["download", name, "--no-deps", "--only-binary", ":all:", "-d", tempDir],
        { timeout: 120_000 }
      );
    }

    // Find the downloaded file
    const files = await readdir(tempDir);
    const archive = files.find(
      (f) => f.endsWith(".tar.gz") || f.endsWith(".zip") || f.endsWith(".whl")
    );

    if (!archive) {
      throw new Error(`No downloadable archive found for "${name}" on PyPI`);
    }

    const archivePath = join(tempDir, archive);
    const extractDir = join(tempDir, "package");

    if (archive.endsWith(".tar.gz")) {
      await execFileAsync("mkdir", ["-p", extractDir]);
      await execFileAsync(
        "tar",
        ["xzf", archivePath, "-C", extractDir, "--strip-components=1"],
        { timeout: 30_000 }
      );
    } else if (archive.endsWith(".zip") || archive.endsWith(".whl")) {
      // .whl files are zip archives
      await execFileAsync("mkdir", ["-p", extractDir]);
      await execFileAsync("unzip", ["-q", "-o", archivePath, "-d", extractDir], {
        timeout: 30_000,
      });
    }

    return {
      dir: extractDir,
      cleanup: async () => {
        await rm(tempDir, { recursive: true, force: true });
      },
    };
  } catch (err) {
    await rm(tempDir, { recursive: true, force: true });

    let message: string;
    if (
      err &&
      typeof err === "object" &&
      "stderr" in err &&
      typeof (err as { stderr: unknown }).stderr === "string"
    ) {
      const stderr = (err as { stderr: string }).stderr;
      const notFound =
        stderr.includes("No matching distribution") ||
        stderr.includes("Could not find a version") ||
        stderr.includes("404");
      if (notFound) {
        message = `Package "${name}" not found on PyPI. Verify the package name and try again.`;
      } else {
        message = err instanceof Error ? err.message : String(err);
      }
    } else {
      message = err instanceof Error ? err.message : String(err);
    }

    throw new Error(`Failed to download "${name}": ${message}`);
  }
}

/**
 * Extract a clean error message from npm's verbose stderr.
 */
function extractNpmError(name: string, err: unknown): string {
  if (
    err &&
    typeof err === "object" &&
    "stderr" in err &&
    typeof (err as { stderr: unknown }).stderr === "string"
  ) {
    const stderr = (err as { stderr: string }).stderr;
    const notFound = stderr.includes("404") || stderr.includes("Not Found");
    if (notFound) {
      return `Package "${name}" not found on npm. Verify the package name and try again.`;
    }
    const errorLine = stderr
      .split("\n")
      .find((l) => l.startsWith("npm error") && !l.includes("A complete log"));
    if (errorLine) {
      return errorLine.replace(/^npm error\s*/, "");
    }
  }
  return err instanceof Error ? err.message : String(err);
}
