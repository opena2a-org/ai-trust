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
    const message = err instanceof Error ? err.message : String(err);
    throw new Error(`Failed to download package "${name}": ${message}`);
  }
}
