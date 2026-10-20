/**
 * Package downloader - fetch npm tarballs or PyPI sdists and extract to temp directories.
 */

import { mkdtemp, mkdir, rm, readdir } from "node:fs/promises";
import { createWriteStream } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { Readable, Transform } from "node:stream";
import { pipeline } from "node:stream/promises";
import type { ReadableStream as WebReadableStream } from "node:stream/web";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

/**
 * PyPI JSON API base: `${PYPI_JSON_API}/<name>/json` describes the latest
 * release, and `${PYPI_JSON_API}/<name>/<version>/json` the release
 * `<version>`.
 */
const PYPI_JSON_API = "https://pypi.org/pypi";

/** PEP 508 project name. Anything else is refused before a request is made. */
const PYPI_NAME_PATTERN = /^([A-Za-z0-9]|[A-Za-z0-9][A-Za-z0-9._-]*[A-Za-z0-9])$/;

/**
 * A release to download after a PyPI project name, as in `<name>@2.0.0`:
 * letters, digits, `.`, `_`, `+`, `!` and `-`, beginning with a letter or
 * digit, the characters a PEP 440 version is written with. Anything else,
 * a `/` included, is refused before a request is made: the version becomes
 * a segment of the JSON API path.
 */
const PYPI_VERSION_PATTERN = /^[0-9A-Za-z][0-9A-Za-z.!+_-]*$/;

/**
 * An npm registry package name: an optional `@scope/` and a name of letters,
 * digits, `.`, `_` and `-`. Anything else is refused before `npm pack` runs.
 * `npm pack` also accepts specs that are not registry names, such as a git
 * URL, whose `prepare` script it runs while packing.
 */
const NPM_NAME_PATTERN = /^(?:@[A-Za-z0-9-][A-Za-z0-9._-]*\/)?[A-Za-z0-9-][A-Za-z0-9._-]*$/;

/** `npm pack` reads a name ending `.tgz`, `.tar` or `.tar.gz` as a local file. */
const NPM_TARBALL_SUFFIX = /\.(?:tgz|tar|tar\.gz)$/i;

/**
 * A version or dist-tag to pack after an npm package name, as in
 * `<name>@1.2.3` or `<name>@latest`: letters, digits, `.`, `_`, `+` and `-`,
 * beginning with a letter or digit, with no `.tgz`, `.tar` or `.tar.gz`
 * ending. Anything else is refused before `npm pack` runs: it reads
 * `<name>@file:<dir>` as a local directory, `<name>@<file>.tgz` as a local
 * tarball and `<name>@npm:<other>` as another package.
 */
const NPM_VERSION_PATTERN = /^[0-9A-Za-z][0-9A-Za-z.+_-]*$/;

/** One file of a release, as listed in the `urls` array of the PyPI JSON API. */
export interface PypiReleaseFile {
  filename: string;
  url: string;
  packagetype: string;
  yanked?: boolean;
  digests?: { sha256?: string };
}

export interface DownloadResult {
  /** Temporary directory containing the extracted package */
  dir: string;
  /** Cleanup function to remove the temp directory */
  cleanup: () => Promise<void>;
}

/**
 * Download a package and extract it to a temp directory.
 * Routes to npm or PyPI based on the ecosystem parameter. `version` is an npm
 * version or dist-tag, or a PyPI release, to download instead of the latest
 * version.
 */
export async function downloadPackage(
  name: string,
  ecosystem: "npm" | "pypi" = "npm",
  version?: string
): Promise<DownloadResult> {
  if (ecosystem === "pypi") return downloadPypiPackage(name, version);
  return downloadNpmPackage(name, version);
}

/**
 * Download an npm package tarball and extract it to a temp directory.
 * Uses `npm pack --pack-destination` to fetch the tarball, then extracts it.
 * The name and the version are checked apart, then packed as
 * `<name>@<version>`.
 */
async function downloadNpmPackage(name: string, version?: string): Promise<DownloadResult> {
  const spec = version === undefined ? name : `${name}@${version}`;
  if (!NPM_NAME_PATTERN.test(name) || NPM_TARBALL_SUFFIX.test(name)) {
    throw new Error(
      `Failed to download "${spec}": "${name}" is not a valid npm package name.`
    );
  }
  if (
    version !== undefined &&
    (!NPM_VERSION_PATTERN.test(version) || NPM_TARBALL_SUFFIX.test(version))
  ) {
    throw new Error(
      `Failed to download "${spec}": "${version}" is not a version or tag ai-trust can download. Give an exact version, as in ${name}@1.2.3, or a tag, as in ${name}@latest.`
    );
  }

  const tempDir = await mkdtemp(join(tmpdir(), "ai-trust-scan-"));

  try {
    // Use npm pack to download the tarball. `--` ends option parsing, so a
    // dependency name from a package.json that starts with "-" is looked up
    // as a package instead of being read as an npm option. `--no-color`
    // keeps npm's error lines plain: with `color=always` in the user's npm
    // config or environment npm wraps the `npm`, `error` and `code` words of
    // each line in colour escape sequences, also when stderr is a pipe, and
    // extractNpmError would not recognise them.
    const { stdout } = await execFileAsync(
      "npm",
      ["pack", "--ignore-scripts", "--no-color", "--pack-destination", tempDir, "--", spec],
      { timeout: 60_000 }
    );

    const tarball = stdout.trim().split("\n").pop()!;
    const tarballPath = join(tempDir, tarball);

    // Extract the tarball
    await execFileAsync("tar", ["xzf", tarballPath, "-C", tempDir], {
      timeout: 30_000,
    });

    // Detect the actual extracted directory (usually "package" but some
    // tarballs like @types/* extract to a different name)
    let extractedDir = join(tempDir, "package");
    try {
      const entries = await readdir(tempDir, { withFileTypes: true });
      const dirs = entries.filter(
        (e) => e.isDirectory() && e.name !== "node_modules"
      );
      // If "package" doesn't exist, use the first directory found
      const hasPackage = dirs.some((d) => d.name === "package");
      if (!hasPackage && dirs.length > 0) {
        extractedDir = join(tempDir, dirs[0].name);
      }
    } catch {
      // Fall back to "package" if readdir fails
    }

    return {
      dir: extractedDir,
      cleanup: async () => {
        await rm(tempDir, { recursive: true, force: true });
      },
    };
  } catch (err) {
    await rm(tempDir, { recursive: true, force: true });
    throw new Error(`Failed to download "${spec}": ${extractNpmError(name, version, err)}`);
  }
}

/**
 * Download a Python package from PyPI and extract it to a temp directory.
 * The archive is fetched from the URL the PyPI JSON API lists for the latest
 * release, or for the release `version` when one is given (the sdist, or a
 * wheel when the release has none), and checked against the SHA-256 digest
 * listed beside it. pip is not used: `pip download` prepares an sdist's
 * metadata by running the package's build backend, which executes the code
 * this scan is meant to inspect.
 */
async function downloadPypiPackage(name: string, version?: string): Promise<DownloadResult> {
  const spec = version === undefined ? name : `${name}@${version}`;
  if (!PYPI_NAME_PATTERN.test(name)) {
    throw new Error(
      `Failed to download "${spec}": "${name}" is not a valid PyPI package name.`
    );
  }
  if (version !== undefined && !PYPI_VERSION_PATTERN.test(version)) {
    throw new Error(
      `Failed to download "${spec}": "${version}" is not a version ai-trust can download from PyPI. Give a release version, as in pip:${name}@1.2.3.`
    );
  }

  const tempDir = await mkdtemp(join(tmpdir(), "ai-trust-scan-"));

  try {
    const latestUrl = `${PYPI_JSON_API}/${name}/json`;
    const res = await fetchFromPypi(
      version === undefined ? latestUrl : `${PYPI_JSON_API}/${name}/${version}/json`,
      30_000
    );
    if (res.status === 404) {
      // PyPI answers 404 for a release when the project has no such release
      // and when there is no such project: the project's own page tells the
      // two apart.
      if (version !== undefined && (await pypiStatus(latestUrl)) !== 404) {
        throw new Error(
          `Version "${version}" of "${name}" not found on PyPI. Verify the version and try again.`
        );
      }
      throw new Error(
        `Package "${name}" not found on PyPI. Verify the package name and try again.`
      );
    }
    if (!res.ok) {
      throw new Error(`PyPI returned HTTP ${res.status}.`);
    }
    const urls = ((await res.json()) as { urls?: unknown } | null)?.urls;
    const file = pickPypiFile(Array.isArray(urls) ? urls : []);
    if (!file) {
      throw new Error(`No downloadable archive found for "${spec}" on PyPI`);
    }

    // Saved under a fixed name, so the listed filename never becomes a path.
    const ext = archiveExtension(file.filename);
    const archivePath = join(tempDir, `archive${ext}`);
    await fetchPypiArchive(file, archivePath);

    const extractDir = join(tempDir, "package");
    await mkdir(extractDir);
    if (ext === ".tar.gz") {
      await execFileAsync(
        "tar",
        ["xzf", archivePath, "-C", extractDir, "--strip-components=1"],
        { timeout: 30_000 }
      );
    } else {
      // .whl files are zip archives
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
    const message = err instanceof Error ? err.message : String(err);
    throw new Error(`Failed to download "${spec}": ${message}`);
  }
}

function archiveExtension(filename: string): ".tar.gz" | ".zip" | ".whl" | undefined {
  if (filename.endsWith(".tar.gz")) return ".tar.gz";
  if (filename.endsWith(".zip")) return ".zip";
  if (filename.endsWith(".whl")) return ".whl";
  return undefined;
}

function isReleaseFile(value: unknown): value is PypiReleaseFile {
  if (!value || typeof value !== "object") return false;
  const f = value as Record<string, unknown>;
  return (
    typeof f.filename === "string" &&
    typeof f.url === "string" &&
    typeof f.packagetype === "string"
  );
}

/**
 * Choose the file to scan from a release's `urls` list: the sdist (it holds
 * the source), else a pure-Python wheel, else any wheel. Yanked files and
 * formats that cannot be extracted are skipped.
 */
export function pickPypiFile(files: unknown[]): PypiReleaseFile | undefined {
  const usable = files.filter(isReleaseFile).filter((f) => f.yanked !== true);
  const sdist = usable.find((f) => {
    const ext = archiveExtension(f.filename);
    return f.packagetype === "sdist" && (ext === ".tar.gz" || ext === ".zip");
  });
  if (sdist) return sdist;
  const wheels = usable.filter(
    (f) => f.packagetype === "bdist_wheel" && archiveExtension(f.filename) === ".whl"
  );
  return wheels.find((f) => f.filename.endsWith("-none-any.whl")) ?? wheels[0];
}

/** The HTTP status PyPI answers `url` with. The body is not read. */
async function pypiStatus(url: string): Promise<number> {
  const res = await fetchFromPypi(url, 30_000);
  await res.body?.cancel();
  return res.status;
}

async function fetchFromPypi(url: string, timeoutMs: number): Promise<Response> {
  try {
    return await fetch(url, { signal: AbortSignal.timeout(timeoutMs) });
  } catch (err) {
    const cause = (err as { cause?: { code?: unknown } }).cause;
    const detail =
      typeof cause?.code === "string"
        ? cause.code
        : err instanceof Error
          ? err.message
          : String(err);
    throw new Error(`could not reach ${new URL(url).host} (${detail}).`);
  }
}

/**
 * Stream a release file to `dest` and refuse it unless its SHA-256 matches
 * the digest PyPI lists for it.
 */
async function fetchPypiArchive(file: PypiReleaseFile, dest: string): Promise<void> {
  let url: URL | undefined;
  try {
    url = new URL(file.url);
  } catch {
    url = undefined;
  }
  if (url?.protocol !== "https:") {
    throw new Error(`PyPI lists no HTTPS URL for ${file.filename}.`);
  }
  const expected = file.digests?.sha256?.toLowerCase();
  if (!expected) {
    throw new Error(`PyPI lists no SHA-256 digest for ${file.filename}.`);
  }

  const res = await fetchFromPypi(url.href, 120_000);
  if (!res.ok || !res.body) {
    throw new Error(`downloading ${file.filename} returned HTTP ${res.status}.`);
  }
  const hash = createHash("sha256");
  await pipeline(
    Readable.fromWeb(res.body as unknown as WebReadableStream<Uint8Array>),
    new Transform({
      transform(chunk: Buffer, _encoding, callback) {
        hash.update(chunk);
        callback(null, chunk);
      },
    }),
    createWriteStream(dest, { flags: "wx" })
  );
  if (hash.digest("hex") !== expected) {
    throw new Error(
      `${file.filename} does not match the SHA-256 digest PyPI lists for it.`
    );
  }
}

/**
 * Extract a clean error message from npm's verbose stderr. npm reports a
 * version or tag the package does not have as `code ETARGET`, and a package
 * the registry does not have as `code E404` followed by lines that begin
 * `404`, each on a line that begins `npm error`, or `npm ERR!` in older npm
 * releases. Both matches are anchored to those lines: the last line of an
 * npm error names its debug log, `<timestamp>-debug-0.log` under the user's
 * home directory (unless `logs-max` is 0), and a `404` in that timestamp or
 * in the home path is not a missing package. The lines are plain because
 * npm pack runs with `--no-color`: under `color=always` npm would wrap the
 * `npm`, `error` and `code` words in colour escape sequences, which neither
 * match nor the `npm error` fallback below would recognise.
 */
function extractNpmError(name: string, version: string | undefined, err: unknown): string {
  if (
    err &&
    typeof err === "object" &&
    "stderr" in err &&
    typeof (err as { stderr: unknown }).stderr === "string"
  ) {
    const stderr = (err as { stderr: string }).stderr;
    if (version !== undefined && /^npm (?:error|ERR!) code ETARGET\b/m.test(stderr)) {
      return `Version "${version}" of "${name}" not found on npm. Verify the version and try again.`;
    }
    if (/^npm (?:error|ERR!) (?:code E404\b|404\b)/m.test(stderr)) {
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
