/**
 * `npm run docs:links` reports the URLs the repository publishes that do not
 * lead to a page: an error status or no answer, a redirect to a root, or a
 * host that also answers 2xx for a made-up path next to the URL.
 *
 * Every request here goes to a local HTTP server, so the suite needs no
 * network. The run over the repository's real URLs is `npm run docs:links`.
 */
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { spawn } from "node:child_process";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { tmpdir } from "node:os";
import {
  checkUrl,
  collectUrls,
  extractUrls,
  isCheckedFile,
  loadManifest,
  rootKind,
  siblingOf,
  staleEntries,
} from "../scripts/docs-links.mjs";
import { DOCS_URL } from "./utils/help-docs.js";

const ROOT = resolve(__dirname, "..");
const SCRIPT = resolve(ROOT, "scripts/docs-links.mjs");
const FAST = { retryDelayMs: 0, timeoutMs: 5000 };

let base: string;
let closedPortUrl: string;
let flakyCalls = 0;
const server = createServer((req: IncomingMessage, res: ServerResponse) => {
  const path = new URL(req.url ?? "/", "http://local").pathname;
  const send = (status: number, location?: string) => {
    res.writeHead(status, location ? { location } : {});
    res.end(status === 200 ? "page" : "");
  };
  if (path === "/" || path === "/page" || path === "/docs/live") return send(200);
  if (path === "/redirect-ok") return send(301, "/page");
  if (path === "/moved") return send(301, "/moved-again");
  if (path === "/moved-again") return send(302, "/");
  if (path === "/broken") return send(500);
  if (path === "/loop") return send(302, "/loop");
  if (path === "/flaky") return send(flakyCalls++ === 0 ? 503 : 200);
  if (path.startsWith("/spa/")) return send(200);
  // Numbered pages as GitHub serves issues: a missing number is 404, while a
  // name that is not a number redirects to a listing that answers 200.
  const issue = /^\/issues\/(.+)$/.exec(path);
  if (issue && /^\d+$/.test(issue[1])) return send(issue[1] === "7" ? 200 : 404);
  if (issue) return send(302, `/issues-listing/${issue[1]}`);
  if (path.startsWith("/issues-listing/")) return send(200);
  return send(404);
});

beforeAll(async () => {
  await new Promise<void>((done) => server.listen(0, "127.0.0.1", done));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  const closed = createServer();
  await new Promise<void>((done) => closed.listen(0, "127.0.0.1", done));
  closedPortUrl = `http://127.0.0.1:${(closed.address() as AddressInfo).port}/page`;
  await new Promise<void>((done) => closed.close(() => done()));
});

afterAll(async () => {
  await new Promise<void>((done) => server.close(() => done()));
});

describe("extractUrls", () => {
  it("ends a URL at Markdown and code delimiters and drops trailing punctuation", () => {
    const text = [
      "See [the page](https://example.org/a).",
      "Template `https://pypi.org/pypi/<name>/json` here.",
      "Angle <https://example.org/b> and plain https://example.org/c.",
      'const BASE = "https://api.example.org",',
      "**Bold https://example.org/d**",
    ].join("\n");
    expect(extractUrls(text)).toEqual([
      { url: "https://example.org/a", line: 1 },
      { url: "https://pypi.org/pypi/", line: 2 },
      { url: "https://example.org/b", line: 3 },
      { url: "https://example.org/c", line: 3 },
      { url: "https://api.example.org", line: 4 },
      { url: "https://example.org/d", line: 5 },
    ]);
  });
});

describe("rootKind and siblingOf", () => {
  it("names a host root and a GitHub repository root, and nothing deeper", () => {
    expect(rootKind("https://example.org")).toBe("host root");
    expect(rootKind("https://example.org/")).toBe("host root");
    expect(rootKind("https://github.com/opena2a-org/ai-trust")).toBe("repository root");
    expect(rootKind("https://github.com/opena2a-org/ai-trust/issues/1")).toBeNull();
    expect(rootKind("https://example.org/owner/repo")).toBeNull();
  });

  it("makes a number for a numbered page and a name otherwise", () => {
    expect(siblingOf("https://example.org/issues/123")).toMatch(/^https:\/\/example\.org\/issues\/9\d{10}$/);
    expect(siblingOf("https://example.org/docs/page?x=1#top")).toMatch(
      /^https:\/\/example\.org\/docs\/docs-links-[0-9a-f]{12}$/,
    );
    expect(siblingOf("https://example.org/docs/")).toMatch(/^https:\/\/example\.org\/docs\/docs-links-[0-9a-f]{12}$/);
  });
});

describe("isCheckedFile", () => {
  it("reads Markdown, package.json and non-test source under src/", () => {
    expect(isCheckedFile("README.md")).toBe(true);
    expect(isCheckedFile("docs/use-cases/check-before-install.md")).toBe(true);
    expect(isCheckedFile("package.json")).toBe(true);
    expect(isCheckedFile("src/utils/help-docs.ts")).toBe(true);
    expect(isCheckedFile("src/docs-links.test.ts")).toBe(false);
    expect(isCheckedFile("docs/links.json")).toBe(false);
    expect(isCheckedFile("scripts/docs-links.mjs")).toBe(false);
  });
});

describe("checkUrl", () => {
  it("passes a page whose made-up sibling answers 404", async () => {
    expect(await checkUrl(`${base}/docs/live`, FAST)).toMatchObject({ ok: true, status: 200 });
  });

  it("follows a redirect to a page and reports where it landed", async () => {
    expect(await checkUrl(`${base}/redirect-ok`, FAST)).toMatchObject({
      ok: true,
      status: 200,
      finalUrl: `${base}/page`,
    });
  });

  it("fails a 404 and a 500", async () => {
    expect(await checkUrl(`${base}/gone`, FAST)).toMatchObject({ ok: false, status: 404, reason: "answers 404" });
    expect(await checkUrl(`${base}/broken`, FAST)).toMatchObject({ ok: false, status: 500, reason: "answers 500" });
  });

  it("retries a 503 once", async () => {
    flakyCalls = 0;
    expect(await checkUrl(`${base}/flaky`, FAST)).toMatchObject({ ok: true, status: 200 });
    expect(flakyCalls).toBe(2); // 503, then 200
  });

  it("fails a page that redirects, over two hops, to the host root", async () => {
    const result = await checkUrl(`${base}/moved`, FAST);
    expect(result).toMatchObject({ ok: false, status: 200, finalUrl: `${base}/` });
    expect(result.reason).toBe(`redirects to a host root: ${base}/`);
  });

  it("passes a host root that is cited as one", async () => {
    expect(await checkUrl(`${base}/`, FAST)).toMatchObject({ ok: true, status: 200 });
  });

  it("fails a 200 under a path where a made-up name also answers 200", async () => {
    const result = await checkUrl(`${base}/spa/page`, FAST);
    expect(result.ok).toBe(false);
    expect(result.reason).toMatch(/answers 200 for a path that does not exist too .*so the status proves nothing/);
  });

  it("checks only the status on a host the manifest lists as a catch-all", async () => {
    const result = await checkUrl(`${base}/spa/page`, { ...FAST, catchAll: { "127.0.0.1": "test catch-all" } });
    expect(result).toMatchObject({ ok: true, status: 200, reason: "status only: test catch-all" });
    const missing = await checkUrl(`${base}/gone`, { ...FAST, catchAll: { "127.0.0.1": "test catch-all" } });
    expect(missing).toMatchObject({ ok: false, status: 404 });
  });

  it("passes an existing numbered page on a host that redirects names to a listing", async () => {
    expect(await checkUrl(`${base}/issues/7`, FAST)).toMatchObject({ ok: true, status: 200 });
    expect(await checkUrl(`${base}/issues/8`, FAST)).toMatchObject({ ok: false, status: 404 });
  });

  it("fails a URL that cannot be fetched and a redirect loop", async () => {
    expect(await checkUrl(closedPortUrl, FAST)).toMatchObject({
      ok: false,
      status: null,
      reason: "not fetched: ECONNREFUSED",
    });
    expect(await checkUrl(`${base}/loop`, FAST)).toMatchObject({
      ok: false,
      reason: "not fetched: more than 10 redirects",
    });
  });
});

/** Runs the script without blocking this process, which serves its requests. */
function runScript(root: string): Promise<{ code: number | null; stdout: string; stderr: string }> {
  return new Promise((done) => {
    const child = spawn(process.execPath, [SCRIPT, "--root", root], {
      env: { PATH: process.env.PATH, HOME: root },
    });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk) => (stdout += chunk));
    child.stderr.on("data", (chunk) => (stderr += chunk));
    child.on("close", (code) => done({ code, stdout, stderr }));
  });
}

describe("docs-links.mjs on a tree", () => {
  let tree: string;

  beforeAll(() => {
    tree = mkdtempSync(join(tmpdir(), "ai-trust-docs-links-"));
    mkdirSync(join(tree, "docs"));
    writeFileSync(
      join(tree, "docs", "links.json"),
      JSON.stringify({ skip: { "http://localhost:9/example": "an example address" } }),
    );
  });

  afterAll(() => {
    rmSync(tree, { recursive: true, force: true });
  });

  it("exits 1 and names the file and line of a planted dead URL", async () => {
    writeFileSync(
      join(tree, "README.md"),
      ["# Fixture", `See [the page](${base}/page).`, `Old link: ${base}/gone`, "Example: http://localhost:9/example"].join(
        "\n",
      ),
    );
    const run = await runScript(tree);
    expect(run.code, run.stdout + run.stderr).toBe(1);
    expect(run.stdout).toContain(`FAIL  404  ${base}/gone\n      answers 404\n      cited at README.md:3`);
    expect(run.stdout).toContain(`ok    200  ${base}/page`);
    expect(run.stdout).toContain("skip  ---  http://localhost:9/example");
    expect(run.stdout).toContain("docs:links: 1 of 2 checked URLs do not resolve.");
  });

  it("exits 0 once the dead URL is gone", async () => {
    writeFileSync(
      join(tree, "README.md"),
      ["# Fixture", `See [the page](${base}/page).`, "Example: http://localhost:9/example"].join("\n"),
    );
    const run = await runScript(tree);
    expect(run.code, run.stdout + run.stderr).toBe(0);
    expect(run.stdout).toContain("docs:links: 1 of 1 checked URLs resolve.");
  });

  it("exits 2 when the manifest excuses a URL the tree no longer cites", async () => {
    writeFileSync(join(tree, "README.md"), `See [the page](${base}/page).\n`);
    const run = await runScript(tree);
    expect(run.code).toBe(2);
    expect(run.stderr).toContain('lists URLs the repository no longer cites: skip "http://localhost:9/example"');
  });

  it("exits 2 with a usage error, not a stack trace, when --root names no directory", async () => {
    const missing = join(tree, "no-such-dir");
    const file = join(tree, "README.md");
    writeFileSync(file, "# Fixture\n");
    for (const [root, message] of [
      [missing, `docs:links: --root "${missing}" does not exist`],
      [file, `docs:links: --root "${file}" is not a directory`],
    ]) {
      const run = await runScript(root);
      expect(run.code, run.stdout + run.stderr).toBe(2);
      expect(run.stderr).toBe(`${message}\nUsage: node scripts/docs-links.mjs [--root <dir>] [--manifest <file>]\n`);
      expect(run.stdout).toBe("");
    }
  });
});

describe("this repository", () => {
  const { cited } = collectUrls(ROOT);
  const manifest = loadManifest(resolve(ROOT, "docs/links.json"));

  it("checks the documentation URL each --help prints", () => {
    expect(cited.get(DOCS_URL)).toContain("src/utils/help-docs.ts:11");
    expect(manifest.skip).not.toHaveProperty(DOCS_URL);
    expect(manifest.probe).not.toHaveProperty(DOCS_URL);
  });

  it("has a manifest whose every entry matches a URL the repository cites", () => {
    expect(staleEntries(manifest, cited)).toEqual([]);
  });

  it("runs the check as npm run docs:links", () => {
    const pkg = JSON.parse(readFileSync(resolve(ROOT, "package.json"), "utf8")) as {
      scripts: Record<string, string>;
    };
    expect(pkg.scripts["docs:links"]).toBe("node scripts/docs-links.mjs");
  });
});
