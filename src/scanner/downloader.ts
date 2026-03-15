/**
 * Package downloader - fetch npm tarballs and extract to temp directories.
 */

import { mkdtemp, rm } from "node:fs/promises";
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
 * Download an npm package tarball and extract it to a temp directory.
 * Uses `npm pack --pack-destination` to fetch the tarball, then extracts it.
 */
export async function downloadPackage(
  name: string
): Promise<DownloadResult> {
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
    const extractDir = join(tempDir, "package");
    await execFileAsync("tar", ["xzf", tarballPath, "-C", tempDir], {
      timeout: 30_000,
    });

    return {
      dir: extractDir,
      cleanup: async () => {
        await rm(tempDir, { recursive: true, force: true });
      },
    };
  } catch (err) {
    // Clean up on failure
    await rm(tempDir, { recursive: true, force: true });

    // Extract a clean error message from npm's verbose stderr
    let message: string;
    if (
      err &&
      typeof err === "object" &&
      "stderr" in err &&
      typeof (err as { stderr: unknown }).stderr === "string"
    ) {
      const stderr = (err as { stderr: string }).stderr;
      const notFound = stderr.includes("404") || stderr.includes("Not Found");
      if (notFound) {
        message = `Package "${name}" not found on npm. Verify the package name and try again.`;
      } else {
        // Extract the first meaningful npm error line
        const errorLine = stderr
          .split("\n")
          .find((l) => l.startsWith("npm error") && !l.includes("A complete log"));
        message = errorLine
          ? errorLine.replace(/^npm error\s*/, "")
          : (err instanceof Error ? err.message : String(err));
      }
    } else {
      message = err instanceof Error ? err.message : String(err);
    }

    throw new Error(`Failed to download "${name}": ${message}`);
  }
}
