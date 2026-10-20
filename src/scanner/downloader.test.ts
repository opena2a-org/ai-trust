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
  vi.unstubAllEnvs();
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

  it("fetches the release a version names from that release's JSON API page (#224)", async () => {
    const releaseUrl = "https://pypi.org/pypi/markerpkg/0.1/json";
    const fetchMock = vi.fn(async (input: string | URL) => {
      const url = String(input);
      if (url === releaseUrl) return release([sdistEntry(sdistSha256)]);
      if (url === SDIST_URL) return new Response(sdist);
      return new Response("not found", { status: 404 });
    });
    vi.stubGlobal("fetch", fetchMock);

    const result = await downloadPackage("markerpkg", "pypi", "0.1");
    try {
      expect(readFileSync(join(result.dir, "PKG-INFO"), "utf8")).toContain("Version: 0.1");
      expect(existsSync(pipCalls)).toBe(false);
      expect(existsSync(setupMarker)).toBe(false);
      expect(fetchMock.mock.calls.map((c) => String(c[0]))).toEqual([releaseUrl, SDIST_URL]);
    } finally {
      await result.cleanup();
    }
    expect(readdirSync(scanTmp)).toEqual([]);
  });

  it("reports a release PyPI does not have as that version not found on PyPI (#224)", async () => {
    const fetchMock = vi.fn(async (input: string | URL) =>
      String(input) === JSON_URL
        ? release([sdistEntry(sdistSha256)])
        : new Response("", { status: 404 }),
    );
    vi.stubGlobal("fetch", fetchMock);

    await expect(downloadPackage("markerpkg", "pypi", "9.9.9")).rejects.toThrow(
      'Failed to download "markerpkg@9.9.9": Version "9.9.9" of "markerpkg" not found on PyPI. Verify the version and try again.',
    );
    expect(fetchMock.mock.calls.map((c) => String(c[0]))).toEqual([
      "https://pypi.org/pypi/markerpkg/9.9.9/json",
      JSON_URL,
    ]);
    expect(readdirSync(scanTmp)).toEqual([]);
  });

  it("reports a project PyPI does not have as not found on PyPI when a version is given (#224)", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => new Response("", { status: 404 })));

    await expect(downloadPackage("no-such-pkg-zzz", "pypi", "1.0")).rejects.toThrow(
      'Failed to download "no-such-pkg-zzz@1.0": Package "no-such-pkg-zzz" not found on PyPI. Verify the package name and try again.',
    );
  });

  it("refuses text after the name that is not a release version before any request (#224)", async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);

    for (const version of ["../json", "0.1/../../json", "^1.0", ">=1.0", "1.0 || 2.0", "?x=1", "%2e%2e", ""]) {
      await expect(downloadPackage("markerpkg", "pypi", version)).rejects.toThrow(
        `Failed to download "markerpkg@${version}": "${version}" is not a version ai-trust can download from PyPI. Give a release version, as in pip:markerpkg@1.2.3.`,
      );
    }
    expect(fetchMock).not.toHaveBeenCalled();
    expect(readdirSync(scanTmp)).toEqual([]);
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

  it("refuses a spec that is not a registry package name before npm runs", async () => {
    for (const name of [
      "git+file:///tmp/not-a-package",
      "https://example.test/pkg.tgz",
      "some-user/some-repo",
      "./local-dir",
      "/tmp/local-dir",
      "some-name.tgz",
      "pkg@1.0.0",
      "",
    ]) {
      await expect(downloadPackage(name, "npm")).rejects.toThrow("is not a valid npm package name");
    }
    expect(existsSync(npmArgs)).toBe(false);
    expect(readdirSync(scanTmp)).toEqual([]);
  });

  it("passes scoped and unscoped registry names to npm pack with lifecycle scripts off", async () => {
    for (const name of ["@scope/pkg-name", "Legacy.Name_1"]) {
      await expect(downloadPackage(name, "npm")).rejects.toThrow(`Package "${name}" not found on npm.`);
      const args = readFileSync(npmArgs, "utf8").trimEnd().split("\n");
      expect(args[0]).toBe("pack");
      expect(args).toContain("--ignore-scripts");
      expect(args).toContain("--no-color");
      expect(args.slice(-2)).toEqual(["--", name]);
    }
  });

  it("packs <name>@<version> after `--` for a version or a tag, with lifecycle scripts off", async () => {
    for (const [name, version] of [
      ["pkg-name", "1.2.3"],
      ["@scope/pkg-name", "2.0.0-beta.1"],
      ["pkg-name", "latest"],
    ]) {
      await expect(downloadPackage(name, "npm", version)).rejects.toThrow(
        `Failed to download "${name}@${version}": Package "${name}" not found on npm.`,
      );
      const args = readFileSync(npmArgs, "utf8").trimEnd().split("\n");
      expect(args[0]).toBe("pack");
      expect(args).toContain("--ignore-scripts");
      expect(args).toContain("--no-color");
      expect(args.slice(-2)).toEqual(["--", `${name}@${version}`]);
    }
  });

  it("refuses other text after the name before npm runs: a path, a tarball, another package, a repository or a range", async () => {
    for (const version of [
      "file:../local-dir",
      "../local-dir",
      ".",
      "local.tgz",
      "1.0.0.tar.gz",
      "npm:other-pkg",
      "github:some-user/some-repo",
      "git+https://example.test/repo.git",
      "^1.0.0",
      "1.0.0 || 2.0.0",
      "",
    ]) {
      await expect(downloadPackage("pkg-name", "npm", version)).rejects.toThrow(
        `Failed to download "pkg-name@${version}": "${version}" is not a version or tag ai-trust can download.`,
      );
    }
    expect(existsSync(npmArgs)).toBe(false);
    expect(readdirSync(scanTmp)).toEqual([]);
  });

  it("names the name, not the whole spec, when the name before a version is not an npm package name", async () => {
    await expect(downloadPackage("some-user/some-repo", "npm", "1.0.0")).rejects.toThrow(
      'Failed to download "some-user/some-repo@1.0.0": "some-user/some-repo" is not a valid npm package name.',
    );
    expect(existsSync(npmArgs)).toBe(false);
  });

  it("reports a version the package does not have as that version not found on npm", async () => {
    writeFileSync(
      join(root, "bin", "npm"),
      [
        "#!/bin/sh",
        `for a in "$@"; do printf '%s\\n' "$a"; done > "${npmArgs}"`,
        "echo 'npm error code ETARGET' >&2",
        "echo 'npm error notarget No matching version found for pkg-name@9.9.9.' >&2",
        // A log name with 404 in it does not turn a missing version into a missing package.
        "echo 'npm error A complete log of this run can be found in: /tmp/_logs/2026-10-18T15_11_17_404Z-debug-0.log' >&2",
        "exit 1",
        "",
      ].join("\n"),
      { mode: 0o755 },
    );

    await expect(downloadPackage("pkg-name", "npm", "9.9.9")).rejects.toThrow(
      'Failed to download "pkg-name@9.9.9": Version "9.9.9" of "pkg-name" not found on npm. Verify the version and try again.',
    );
    expect(readFileSync(npmArgs, "utf8").trimEnd().split("\n").slice(-2)).toEqual(["--", "pkg-name@9.9.9"]);
    expect(readdirSync(scanTmp)).toEqual([]);
  });

  it("reports a version the package does not have as that version not found on npm when npm prints the older `npm ERR!` prefix (#224)", async () => {
    writeFileSync(
      join(root, "bin", "npm"),
      [
        "#!/bin/sh",
        `for a in "$@"; do printf '%s\\n' "$a"; done > "${npmArgs}"`,
        "echo 'npm ERR! code ETARGET' >&2",
        "echo 'npm ERR! notarget No matching version found for pkg-name@9.9.9.' >&2",
        // A log name with 404 in it does not turn a missing version into a missing package.
        "echo 'npm ERR! A complete log of this run can be found in: /tmp/_logs/2026-10-18T15_11_17_404Z-debug-0.log' >&2",
        "exit 1",
        "",
      ].join("\n"),
      { mode: 0o755 },
    );

    await expect(downloadPackage("pkg-name", "npm", "9.9.9")).rejects.toThrow(
      'Failed to download "pkg-name@9.9.9": Version "9.9.9" of "pkg-name" not found on npm. Verify the version and try again.',
    );
    expect(readdirSync(scanTmp)).toEqual([]);
  });

  /** An npm stand-in that prints `stderrLines` and exits 1. */
  function npmFailsWith(stderrLines: string[]): void {
    writeFileSync(
      join(root, "bin", "npm"),
      [
        "#!/bin/sh",
        `for a in "$@"; do printf '%s\\n' "$a"; done > "${npmArgs}"`,
        "cat >&2 <<'NPM_STDERR'",
        ...stderrLines,
        "NPM_STDERR",
        "exit 1",
        "",
      ].join("\n"),
      { mode: 0o755 },
    );
  }

  // The last line of every npm error names its debug log, whose name is a
  // timestamp with milliseconds, under the user's home directory. The lines
  // below are npm 10's for a refused connection, with 404 in that timestamp
  // and in the home path.
  const REFUSED = [
    "npm error code ECONNREFUSED",
    "npm error syscall connect",
    "npm error errno ECONNREFUSED",
    "npm error FetchError: request to http://127.0.0.1:1/@scope%2fpkg-name failed, reason: connect ECONNREFUSED 127.0.0.1:1",
    "npm error     at ClientRequest.<anonymous> (/home/user404/lib/node_modules/npm/node_modules/minipass-fetch/lib/index.js:130:14)",
    "npm error     at ClientRequest.emit (node:events:524:28)",
    "npm error  {",
    "npm error   code: 'ECONNREFUSED',",
    "npm error   errno: 'ECONNREFUSED',",
    "npm error   syscall: 'connect',",
    "npm error   address: '127.0.0.1',",
    "npm error   port: 1,",
    "npm error   type: 'system'",
    "npm error }",
    "npm error",
    "npm error If you are behind a proxy, please make sure that the",
    "npm error 'proxy' config is set properly.  See: 'npm help config'",
    "npm error A complete log of this run can be found in: /home/user404/.npm/_logs/2026-10-20T05_16_44_404Z-debug-0.log",
  ];

  it("reports a refused connection as that failure, not as a missing package, when 404 is in the debug log's name or the home path", async () => {
    npmFailsWith(REFUSED);

    const failure = await downloadPackage("@scope/pkg-name", "npm").then(
      () => undefined,
      (e: unknown) => e as Error,
    );
    expect(failure?.message).toBe('Failed to download "@scope/pkg-name": code ECONNREFUSED');
    expect(readFileSync(npmArgs, "utf8").trimEnd().split("\n").slice(-2)).toEqual(["--", "@scope/pkg-name"]);
    expect(readdirSync(scanTmp)).toEqual([]);
  });

  it("reports a package the registry does not have as not found on npm, from npm's E404 lines", async () => {
    const log = "A complete log of this run can be found in: /home/user/.npm/_logs/2026-10-20T05_37_28_512Z-debug-0.log";
    for (const lines of [
      // npm 10
      [
        "npm error code E404",
        "npm error 404 Not Found - GET http://127.0.0.1:4873/@scope%2fpkg-name - Not found",
        "npm error 404",
        "npm error 404  '@scope/pkg-name@*' is not in this registry.",
        "npm error 404",
        "npm error 404 Note that you can also install from a",
        "npm error 404 tarball, folder, http url, or git url.",
        `npm error ${log}`,
      ],
      // npm 11
      [
        "npm error code E404",
        "npm error 404 Not Found - GET http://127.0.0.1:4873/@scope%2fpkg-name - Not found",
        "npm error 404",
        "npm error 404  The requested resource '@scope/pkg-name@*' could not be found or you do not have permission to access it.",
        "npm error 404",
        `npm error ${log}`,
      ],
      // older npm releases
      [
        "npm ERR! code E404",
        "npm ERR! 404 Not Found - GET http://127.0.0.1:4873/@scope%2fpkg-name - Not found",
        "npm ERR! 404",
        "npm ERR! 404  '@scope/pkg-name@*' is not in this registry.",
        `npm ERR! ${log}`,
      ],
    ]) {
      npmFailsWith(lines);
      await expect(downloadPackage("@scope/pkg-name", "npm")).rejects.toThrow(
        'Failed to download "@scope/pkg-name": Package "@scope/pkg-name" not found on npm. Verify the package name and try again.',
      );
    }
    expect(readdirSync(scanTmp)).toEqual([]);
  });

  it("reads npm's E404 lines when npm is set to colour its output, by running npm pack with --no-color", async () => {
    // With `color=always` in the npm config, or `npm_config_color=always` in
    // the environment, npm 10 and 11 wrap the `npm`, `error` and `code` words
    // of each error line in colour escape sequences, also when stderr is a
    // pipe, so no line begins `npm error`. This npm does the same unless
    // --no-color is among its arguments.
    const log = "A complete log of this run can be found in: /home/user/.npm/_logs/2026-10-20T06_16_11_629Z-debug-0.log";
    const plain = [
      "npm error code E404",
      "npm error 404 Not Found - GET http://127.0.0.1:4873/@scope%2fpkg-name - Not found",
      `npm error ${log}`,
    ];
    const prefix = "\x1b[1mnpm\x1b[22m \x1b[31merror\x1b[39m";
    const coloured = [
      `${prefix} \x1b[94mcode\x1b[39m E404`,
      `${prefix} \x1b[94m404\x1b[39m Not Found - GET http://127.0.0.1:4873/@scope%2fpkg-name - Not found`,
      `${prefix} ${log}`,
    ];
    writeFileSync(
      join(root, "bin", "npm"),
      [
        "#!/bin/sh",
        `for a in "$@"; do printf '%s\\n' "$a"; done > "${npmArgs}"`,
        "plain=no",
        'for a in "$@"; do case "$a" in --no-color) plain=yes;; esac; done',
        'if [ "$plain" = yes ]; then',
        "cat >&2 <<'NPM_STDERR'",
        ...plain,
        "NPM_STDERR",
        "else",
        "cat >&2 <<'NPM_STDERR'",
        ...coloured,
        "NPM_STDERR",
        "fi",
        "exit 1",
        "",
      ].join("\n"),
      { mode: 0o755 },
    );

    await expect(downloadPackage("@scope/pkg-name", "npm")).rejects.toThrow(
      'Failed to download "@scope/pkg-name": Package "@scope/pkg-name" not found on npm. Verify the package name and try again.',
    );
    const args = readFileSync(npmArgs, "utf8").trimEnd().split("\n");
    expect(args).toContain("--no-color");
    expect(args.slice(-2)).toEqual(["--", "@scope/pkg-name"]);
    expect(readdirSync(scanTmp)).toEqual([]);
  });

  it("reads npm's E404 and ETARGET lines when npm's loglevel is silent, by running npm pack with --loglevel=error (#250)", async () => {
    // With `loglevel=silent` in the npm config, or `npm_config_loglevel=silent`
    // in the environment, npm prints no error lines when `npm pack` does not
    // find the package or the version, and a `--loglevel` on the command line
    // takes precedence over both. This npm does the same.
    vi.stubEnv("npm_config_loglevel", "silent");
    function npmSilentUnlessLoglevelGiven(stderrLines: string[]): void {
      writeFileSync(
        join(root, "bin", "npm"),
        [
          "#!/bin/sh",
          `for a in "$@"; do printf '%s\\n' "$a"; done > "${npmArgs}"`,
          'level="${npm_config_loglevel:-notice}"',
          'for a in "$@"; do case "$a" in --loglevel=*) level="${a#--loglevel=}";; esac; done',
          '[ "$level" = silent ] && exit 1',
          "cat >&2 <<'NPM_STDERR'",
          ...stderrLines,
          "NPM_STDERR",
          "exit 1",
          "",
        ].join("\n"),
        { mode: 0o755 },
      );
    }
    const log = "A complete log of this run can be found in: /home/user/.npm/_logs/2026-10-20T08_58_05_285Z-debug-0.log";

    npmSilentUnlessLoglevelGiven([
      "npm error code E404",
      "npm error 404 Not Found - GET http://127.0.0.1:4873/@scope%2fpkg-name - Not found",
      "npm error 404",
      "npm error 404  The requested resource '@scope/pkg-name@*' could not be found or you do not have permission to access it.",
      "npm error 404",
      `npm error ${log}`,
    ]);
    await expect(downloadPackage("@scope/pkg-name", "npm")).rejects.toThrow(
      'Failed to download "@scope/pkg-name": Package "@scope/pkg-name" not found on npm. Verify the package name and try again.',
    );
    const args = readFileSync(npmArgs, "utf8").trimEnd().split("\n");
    expect(args).toContain("--loglevel=error");
    expect(args.slice(-2)).toEqual(["--", "@scope/pkg-name"]);

    npmSilentUnlessLoglevelGiven([
      "npm error code ETARGET",
      "npm error notarget No matching version found for pkg-name@9.9.9.",
      "npm error notarget In most cases you or one of your dependencies are requesting a package version that doesn't exist.",
      `npm error ${log}`,
    ]);
    await expect(downloadPackage("pkg-name", "npm", "9.9.9")).rejects.toThrow(
      'Failed to download "pkg-name@9.9.9": Version "9.9.9" of "pkg-name" not found on npm. Verify the version and try again.',
    );
    expect(readFileSync(npmArgs, "utf8").trimEnd().split("\n").slice(-2)).toEqual(["--", "pkg-name@9.9.9"]);
    expect(readdirSync(scanTmp)).toEqual([]);
  });

  it("downloads a package whose npm pack file listing is larger than 1 MiB, by running npm pack with --loglevel=error (#252)", async () => {
    // At npm's default loglevel, `notice`, npm pack lists every file of the
    // package on stderr, one `npm notice` line each. execFile keeps at most
    // 1 MiB of a child's stderr by default and stops npm when there is more.
    // This npm prints such a listing for 43,010 files unless its loglevel,
    // from npm_config_loglevel or a `--loglevel=` argument, is `warn`,
    // `error` or `silent`, then copies the tarball into the
    // --pack-destination directory and prints its file name, as npm does.
    vi.stubEnv("npm_config_loglevel", "notice");
    const listing = [
      "npm notice Tarball Contents",
      ...Array.from({ length: 43_010 }, (_, i) => `npm notice 1.1kB package/esm/Icon${i}Outlined.js`),
      "npm notice Tarball Details",
      "",
    ].join("\n");
    expect(Buffer.byteLength(listing)).toBeGreaterThan(1024 * 1024);
    const listingFile = join(root, "npm-notice-listing");
    writeFileSync(listingFile, listing);

    const pkg = join(root, "pkg", "package");
    mkdirSync(pkg, { recursive: true });
    writeFileSync(join(pkg, "package.json"), JSON.stringify({ name: "@scope/many-files", version: "1.0.0" }));
    const tarball = join(root, "scope-many-files-1.0.0.tgz");
    execFileSync("tar", ["czf", tarball, "-C", join(root, "pkg"), "package"]);

    writeFileSync(
      join(root, "bin", "npm"),
      [
        "#!/bin/sh",
        `for a in "$@"; do printf '%s\\n' "$a"; done > "${npmArgs}"`,
        'level="${npm_config_loglevel:-notice}"',
        "dest=",
        "prev=",
        'for a in "$@"; do',
        '  case "$a" in --loglevel=*) level="${a#--loglevel=}";; esac',
        '  [ "$prev" = --pack-destination ] && dest="$a"',
        '  prev="$a"',
        "done",
        `case "$level" in silent|error|warn) ;; *) cat "${listingFile}" >&2;; esac`,
        `cp "${tarball}" "$dest/" || exit 1`,
        "echo scope-many-files-1.0.0.tgz",
        "",
      ].join("\n"),
      { mode: 0o755 },
    );

    const result = await downloadPackage("@scope/many-files", "npm");
    try {
      expect(JSON.parse(readFileSync(join(result.dir, "package.json"), "utf8"))).toEqual({
        name: "@scope/many-files",
        version: "1.0.0",
      });
    } finally {
      await result.cleanup();
    }
    const args = readFileSync(npmArgs, "utf8").trimEnd().split("\n");
    expect(args).toContain("--loglevel=error");
    expect(args.slice(-2)).toEqual(["--", "@scope/many-files"]);
    expect(readdirSync(scanTmp)).toEqual([]);
  });

  it("downloads a package when npm's dry-run setting is on, by running npm pack with --dry-run=false (#255)", async () => {
    // With `dry-run=true` in the npm config, or `npm_config_dry_run=true` in
    // the environment, npm pack exits 0 and prints the tarball's file name
    // but writes no tarball, and `--dry-run=false` on the command line takes
    // precedence over both. This npm does the same: it copies the tarball
    // into the --pack-destination directory only when its dry-run setting,
    // from npm_config_dry_run or a `--dry-run` argument, is not `true`.
    vi.stubEnv("npm_config_dry_run", "true");

    const pkg = join(root, "pkg", "package");
    mkdirSync(pkg, { recursive: true });
    writeFileSync(join(pkg, "package.json"), JSON.stringify({ name: "@scope/pkg-name", version: "1.0.0" }));
    const tarball = join(root, "scope-pkg-name-1.0.0.tgz");
    execFileSync("tar", ["czf", tarball, "-C", join(root, "pkg"), "package"]);

    writeFileSync(
      join(root, "bin", "npm"),
      [
        "#!/bin/sh",
        `for a in "$@"; do printf '%s\\n' "$a"; done > "${npmArgs}"`,
        'dry="${npm_config_dry_run:-false}"',
        "dest=",
        "prev=",
        'for a in "$@"; do',
        '  case "$a" in --dry-run=*) dry="${a#--dry-run=}";; --dry-run) dry=true;; --no-dry-run) dry=false;; esac',
        '  [ "$prev" = --pack-destination ] && dest="$a"',
        '  prev="$a"',
        "done",
        `[ "$dry" = true ] || cp "${tarball}" "$dest/" || exit 1`,
        "echo scope-pkg-name-1.0.0.tgz",
        "",
      ].join("\n"),
      { mode: 0o755 },
    );

    const result = await downloadPackage("@scope/pkg-name", "npm");
    try {
      expect(JSON.parse(readFileSync(join(result.dir, "package.json"), "utf8"))).toEqual({
        name: "@scope/pkg-name",
        version: "1.0.0",
      });
    } finally {
      await result.cleanup();
    }
    const args = readFileSync(npmArgs, "utf8").trimEnd().split("\n");
    expect(args).toContain("--dry-run=false");
    expect(args.slice(-2)).toEqual(["--", "@scope/pkg-name"]);
    expect(readdirSync(scanTmp)).toEqual([]);
  });

  describe("when npm's json setting is on, by running npm pack with --json=false (#254)", () => {
    // With `json=true` in the npm config, or `npm_config_json=true` in the
    // environment, npm pack prints a JSON array that lists the tarball and
    // each of its files on stdout instead of the tarball's file name. This
    // npm does that unless a `--json=` argument turns the setting off, after
    // copying the tarball into the --pack-destination directory, as npm does.
    function npmPrintsJsonUnlessTurnedOff(fileCount: number): void {
      vi.stubEnv("npm_config_json", "true");
      const files = Array.from({ length: fileCount }, (_, i) => ({
        path: `esm/Icon${i}Outlined.js`,
        size: 1100,
        mode: 420,
      }));
      const json = `${JSON.stringify(
        [{ id: "@scope/json-pkg@1.0.0", name: "@scope/json-pkg", version: "1.0.0", filename: "scope-json-pkg-1.0.0.tgz", files }],
        null,
        2,
      )}\n`;
      const jsonFile = join(root, "npm-pack-json");
      writeFileSync(jsonFile, json);

      const pkg = join(root, "pkg", "package");
      mkdirSync(pkg, { recursive: true });
      writeFileSync(join(pkg, "package.json"), JSON.stringify({ name: "@scope/json-pkg", version: "1.0.0" }));
      const tarball = join(root, "scope-json-pkg-1.0.0.tgz");
      execFileSync("tar", ["czf", tarball, "-C", join(root, "pkg"), "package"]);

      writeFileSync(
        join(root, "bin", "npm"),
        [
          "#!/bin/sh",
          `for a in "$@"; do printf '%s\\n' "$a"; done > "${npmArgs}"`,
          'json="${npm_config_json:-false}"',
          "dest=",
          "prev=",
          'for a in "$@"; do',
          '  case "$a" in --json=*) json="${a#--json=}";; esac',
          '  [ "$prev" = --pack-destination ] && dest="$a"',
          '  prev="$a"',
          "done",
          `cp "${tarball}" "$dest/" || exit 1`,
          `if [ "$json" = true ]; then cat "${jsonFile}"; else echo scope-json-pkg-1.0.0.tgz; fi`,
          "",
        ].join("\n"),
        { mode: 0o755 },
      );
    }

    async function expectDownloaded(): Promise<void> {
      const result = await downloadPackage("@scope/json-pkg", "npm");
      try {
        expect(JSON.parse(readFileSync(join(result.dir, "package.json"), "utf8"))).toEqual({
          name: "@scope/json-pkg",
          version: "1.0.0",
        });
      } finally {
        await result.cleanup();
      }
      const args = readFileSync(npmArgs, "utf8").trimEnd().split("\n");
      expect(args).toContain("--json=false");
      expect(args.slice(-2)).toEqual(["--", "@scope/json-pkg"]);
      expect(readdirSync(scanTmp)).toEqual([]);
    }

    it("downloads the package instead of extracting a tarball named `]`", async () => {
      npmPrintsJsonUnlessTurnedOff(3);
      await expectDownloaded();
    });

    it("downloads a package whose JSON file listing is larger than 1 MiB", async () => {
      npmPrintsJsonUnlessTurnedOff(43_010);
      expect(readFileSync(join(root, "npm-pack-json")).byteLength).toBeGreaterThan(1024 * 1024);
      await expectDownloaded();
    });
  });
});
