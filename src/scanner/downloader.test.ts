/**
 * Tests for the package downloader. Nothing here reaches the network: fetch
 * is stubbed, and `pip`, `pip3` and `npm` on PATH are stand-ins that record
 * that they were run.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { downloadPackage, pickPypiFile } from "./downloader.js";

const JSON_URL = "https://pypi.org/pypi/markerpkg/json";
const SDIST_URL = "https://files.pythonhosted.org/packages/ab/cd/markerpkg-0.1.tar.gz";

let root: string;
let scanTmp: string;
let pipCalls: string;
let setupMarker: string;
let npmArgs: string;
let sdist: Buffer;
let sdistSha256: string;
const saved = { PATH: process.env.PATH, TMPDIR: process.env.TMPDIR };

function release(files: object[]): Response {
  return new Response(JSON.stringify({ info: { version: "0.1" }, urls: files }), {
    headers: { "content-type": "application/json" },
  });
}

function sdistEntry(sha256: string): object {
  return {
    filename: "markerpkg-0.1.tar.gz",
    packagetype: "sdist",
    url: SDIST_URL,
    yanked: false,
    digests: { sha256 },
  };
}

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "dl-test-"));
  scanTmp = join(root, "tmp");
  mkdirSync(scanTmp);
  pipCalls = join(root, "pip-calls");
  setupMarker = join(root, "setup-ran");
  npmArgs = join(root, "npm-args");

  const bin = join(root, "bin");
  mkdirSync(bin);
  for (const tool of ["pip", "pip3"]) {
    writeFileSync(
      join(bin, tool),
      `#!/bin/sh\necho "${tool} $*" >> "${pipCalls}"\nexit 1\n`,
      { mode: 0o755 },
    );
  }
  writeFileSync(
    join(bin, "npm"),
    `#!/bin/sh\nfor a in "$@"; do printf '%s\\n' "$a"; done > "${npmArgs}"\necho "npm error 404 Not Found" >&2\nexit 1\n`,
    { mode: 0o755 },
  );

  // A source archive whose build script leaves a marker if anything runs it.
  const src = join(root, "src", "markerpkg-0.1");
  mkdirSync(src, { recursive: true });
  writeFileSync(
    join(src, "setup.py"),
    `open(${JSON.stringify(setupMarker)}, "w").write("ran")\nfrom setuptools import setup\nsetup(name="markerpkg", version="0.1")\n`,
  );
  writeFileSync(join(src, "PKG-INFO"), "Metadata-Version: 2.1\nName: markerpkg\nVersion: 0.1\n");
  const archive = join(root, "markerpkg-0.1.tar.gz");
  execFileSync("tar", ["czf", archive, "-C", join(root, "src"), "markerpkg-0.1"]);
  sdist = readFileSync(archive);
  sdistSha256 = createHash("sha256").update(sdist).digest("hex");

  process.env.PATH = `${bin}:${saved.PATH ?? ""}`;
  process.env.TMPDIR = scanTmp;
});

afterEach(() => {
  vi.unstubAllGlobals();
  process.env.PATH = saved.PATH;
  if (saved.TMPDIR === undefined) delete process.env.TMPDIR;
  else process.env.TMPDIR = saved.TMPDIR;
  rmSync(root, { recursive: true, force: true });
});

describe("downloadPackage (PyPI)", () => {
  it("fetches the sdist listed by the PyPI JSON API and never runs pip or the build script", async () => {
    const fetchMock = vi.fn(async (input: string | URL) => {
      const url = String(input);
      if (url === JSON_URL) return release([sdistEntry(sdistSha256)]);
      if (url === SDIST_URL) return new Response(sdist);
      return new Response("not found", { status: 404 });
    });
    vi.stubGlobal("fetch", fetchMock);

    const result = await downloadPackage("markerpkg", "pypi");
    try {
      expect(readFileSync(join(result.dir, "PKG-INFO"), "utf8")).toContain("Version: 0.1");
      expect(existsSync(join(result.dir, "setup.py"))).toBe(true);
      expect(existsSync(pipCalls)).toBe(false);
      expect(existsSync(setupMarker)).toBe(false);
      expect(fetchMock.mock.calls.map((c) => String(c[0]))).toEqual([JSON_URL, SDIST_URL]);
    } finally {
      await result.cleanup();
    }
    expect(readdirSync(scanTmp)).toEqual([]);
  });

  it("refuses an archive that does not match the listed SHA-256 digest and removes it", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: string | URL) =>
        String(input) === JSON_URL
          ? release([sdistEntry("0".repeat(64))])
          : new Response(sdist),
      ),
    );

    await expect(downloadPackage("markerpkg", "pypi")).rejects.toThrow(
      'Failed to download "markerpkg": markerpkg-0.1.tar.gz does not match the SHA-256 digest PyPI lists for it.',
    );
    expect(readdirSync(scanTmp)).toEqual([]);
  });

  it("refuses a release file listed without a digest", async () => {
    const entry = { ...sdistEntry(sdistSha256), digests: {} };
    const fetchMock = vi.fn(async () => release([entry]));
    vi.stubGlobal("fetch", fetchMock);

    await expect(downloadPackage("markerpkg", "pypi")).rejects.toThrow(
      "PyPI lists no SHA-256 digest for markerpkg-0.1.tar.gz.",
    );
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("reports a package PyPI does not have as not found on PyPI", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => new Response("", { status: 404 })));

    await expect(downloadPackage("no-such-pkg-zzz", "pypi")).rejects.toThrow(
      'Package "no-such-pkg-zzz" not found on PyPI. Verify the package name and try again.',
    );
  });

  it("names the host when PyPI cannot be reached", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => {
        throw Object.assign(new TypeError("fetch failed"), { cause: { code: "ENOTFOUND" } });
      }),
    );

    await expect(downloadPackage("markerpkg", "pypi")).rejects.toThrow(
      'Failed to download "markerpkg": could not reach pypi.org (ENOTFOUND).',
    );
  });

  it("refuses a name that is not a PyPI project name before any request", async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);

    for (const name of ["--index-url=https://example.test", "../markerpkg", "pkg name"]) {
      await expect(downloadPackage(name, "pypi")).rejects.toThrow("is not a valid PyPI package name");
    }
    expect(fetchMock).not.toHaveBeenCalled();
    expect(existsSync(pipCalls)).toBe(false);
  });
});

describe("pickPypiFile", () => {
  const wheel = (filename: string, extra: object = {}) => ({
    filename,
    packagetype: "bdist_wheel",
    url: `https://files.pythonhosted.org/packages/${filename}`,
    digests: { sha256: "0".repeat(64) },
    ...extra,
  });

  it("prefers the sdist over wheels", () => {
    const picked = pickPypiFile([wheel("p-1-py3-none-any.whl"), sdistEntry("0".repeat(64))]);
    expect(picked?.filename).toBe("markerpkg-0.1.tar.gz");
  });

  it("falls back to a pure-Python wheel, then to any wheel", () => {
    expect(
      pickPypiFile([wheel("p-1-cp312-cp312-manylinux_x86_64.whl"), wheel("p-1-py3-none-any.whl")])?.filename,
    ).toBe("p-1-py3-none-any.whl");
    expect(pickPypiFile([wheel("p-1-cp312-cp312-manylinux_x86_64.whl")])?.filename).toBe(
      "p-1-cp312-cp312-manylinux_x86_64.whl",
    );
  });

  it("skips yanked files, unknown formats and malformed entries", () => {
    expect(
      pickPypiFile([
        { ...sdistEntry("0".repeat(64)), yanked: true },
        { filename: "p-1.egg", packagetype: "bdist_egg", url: "https://files.pythonhosted.org/p-1.egg" },
        { filename: 42, packagetype: "sdist", url: "https://files.pythonhosted.org/x.tar.gz" },
        null,
      ]),
    ).toBeUndefined();
  });
});

describe("downloadPackage (npm)", () => {
  it("passes the package name after `--`, so a name that looks like an option is not read as one", async () => {
    await expect(downloadPackage("--version", "npm")).rejects.toThrow(
      'Package "--version" not found on npm.',
    );

    const args = readFileSync(npmArgs, "utf8").trimEnd().split("\n");
    expect(args[0]).toBe("pack");
    expect(args.slice(-2)).toEqual(["--", "--version"]);
    expect(args.filter((a) => a === "--version")).toHaveLength(1);
    expect(readdirSync(scanTmp)).toEqual([]);
  });
});
