#!/usr/bin/env node
/**
 * docs:links: reports the URLs this repository publishes that do not lead
 * to a page.
 *
 * The URLs come from the files a reader or a user of the CLI meets: every
 * Markdown file, package.json, and the source under src/ apart from test
 * files (the strings the CLI prints, such as the documentation URL at the
 * end of each --help, and the addresses it requests). When the root is the
 * top of a git work tree the tracked files are read; otherwise the tree is
 * walked, leaving out the directories an install or a build adds.
 *
 * A URL fails when:
 *   - after redirects it answers 4xx or 5xx, or cannot be fetched (one retry
 *     for a network error, 429, 502, 503 or 504); a 405, an endpoint that
 *     refuses GET, passes when a made-up path next to it answers 404 or 410;
 *   - it redirects to a root, a host's "/" or a GitHub repository root, when
 *     it was not one itself: a moved page that sends its readers home;
 *   - it answers 2xx and so does a made-up path next to it, so the host
 *     answers 200 for any path there and the status proves nothing.
 * A fragment (#section) is not checked.
 *
 * docs/links.json lists the URLs that are not checked as written, each with
 * the reason:
 *   skip      exact URLs that are examples and are not meant to resolve;
 *   probe     exact URLs of API bases with no page at their root, each mapped
 *             to a URL under it that is checked instead;
 *   catchAll  hosts that answer 200 for any path, where only the status of
 *             the URL itself is checked.
 * An entry that no longer matches a URL in the repository is an error, so
 * the list cannot outlive the link it excuses.
 *
 * Usage: node scripts/docs-links.mjs [--root <dir>] [--manifest <file>]
 * Exit 0 when every checked URL resolves, 1 when one does not, 2 on a usage
 * error (an unknown argument, or a --root that does not exist or is not a
 * directory) or a manifest error.
 */
import { execFileSync } from "node:child_process";
import { randomBytes } from "node:crypto";
import { existsSync, readFileSync, readdirSync, realpathSync, statSync } from "node:fs";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const URL_PATTERN = /https?:\/\/[^\s<>()[\]{}"'`\\|^$]+/g;
const TRAILING_PUNCTUATION = /[.,;:!?*]+$/;
// Not part of the source tree: dependencies, build and coverage output, git.
const UNTRACKED_DIRS = new Set(["node_modules", "dist", "coverage", ".git"]);
const RETRY_STATUSES = new Set([429, 502, 503, 504]);
const MAX_REDIRECTS = 10;
const USER_AGENT = "ai-trust-docs-links";

/** Each URL in `text`, with the 1-based line it starts on. */
export function extractUrls(text) {
  const found = [];
  text.split("\n").forEach((lineText, index) => {
    for (const match of lineText.matchAll(URL_PATTERN)) {
      const url = match[0].replace(TRAILING_PUNCTUATION, "");
      if (URL.canParse(url)) found.push({ url, line: index + 1 });
    }
  });
  return found;
}

/** "host root", "repository root", or null when the URL is neither. */
export function rootKind(url) {
  const parsed = new URL(url);
  const segments = parsed.pathname.split("/").filter(Boolean);
  if (segments.length === 0) return "host root";
  if (parsed.hostname === "github.com" && segments.length === 2) return "repository root";
  return null;
}

/** True for the files whose URLs are checked, given a path relative to the root. */
export function isCheckedFile(path) {
  if (path.endsWith(".md")) return true;
  if (path === "package.json") return true;
  return /^src\/.+\.(?:ts|js|mjs)$/.test(path) && !/\.test\.[a-z]+$/.test(path);
}

function gitTrackedFiles(root) {
  try {
    const top = execFileSync("git", ["-C", root, "rev-parse", "--show-toplevel"], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
    }).trim();
    if (realpathSync(top) !== realpathSync(root)) return null;
    return execFileSync("git", ["-C", root, "ls-files", "-z"], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
    })
      .split("\0")
      .filter((path) => path.length > 0);
  } catch {
    return null;
  }
}

function walkedFiles(root, dir = "") {
  const out = [];
  for (const entry of readdirSync(join(root, dir), { withFileTypes: true })) {
    const path = dir ? `${dir}/${entry.name}` : entry.name;
    if (entry.isDirectory()) {
      if (!UNTRACKED_DIRS.has(entry.name)) out.push(...walkedFiles(root, path));
    } else if (entry.isFile()) {
      out.push(path);
    }
  }
  return out;
}

/** Map of URL to the places that cite it, as "file:line" strings. */
export function collectUrls(root) {
  const files = (gitTrackedFiles(root) ?? walkedFiles(root)).filter(isCheckedFile).sort();
  const cited = new Map();
  for (const file of files) {
    const full = join(root, file);
    if (!existsSync(full)) continue;
    for (const { url, line } of extractUrls(readFileSync(full, "utf8"))) {
      if (!cited.has(url)) cited.set(url, []);
      cited.get(url).push(`${file}:${line}`);
    }
  }
  return { files, cited };
}

/** Reads and validates the manifest; a missing file is an empty manifest. */
export function loadManifest(path) {
  const manifest = { skip: {}, probe: {}, catchAll: {} };
  if (!existsSync(path)) return manifest;
  const parsed = JSON.parse(readFileSync(path, "utf8"));
  const errors = [];
  for (const key of Object.keys(parsed)) {
    if (!key.startsWith("_") && !(key in manifest)) errors.push(`unknown key "${key}"`);
  }
  for (const [url, reason] of Object.entries(parsed.skip ?? {})) {
    if (typeof reason !== "string" || reason.trim() === "") errors.push(`skip "${url}" has no reason`);
    manifest.skip[url] = reason;
  }
  for (const [url, entry] of Object.entries(parsed.probe ?? {})) {
    if (typeof entry?.probe !== "string" || !URL.canParse(entry.probe)) {
      errors.push(`probe "${url}" has no valid probe URL`);
    }
    if (typeof entry?.reason !== "string" || entry.reason.trim() === "") {
      errors.push(`probe "${url}" has no reason`);
    }
    manifest.probe[url] = entry;
  }
  for (const [host, reason] of Object.entries(parsed.catchAll ?? {})) {
    if (typeof reason !== "string" || reason.trim() === "") errors.push(`catchAll "${host}" has no reason`);
    manifest.catchAll[host] = reason;
  }
  if (errors.length > 0) throw new Error(`${path}: ${errors.join("; ")}`);
  return manifest;
}

/** Manifest entries that match no URL the repository cites. */
export function staleEntries(manifest, cited) {
  const stale = [];
  for (const url of Object.keys(manifest.skip)) if (!cited.has(url)) stale.push(`skip "${url}"`);
  for (const url of Object.keys(manifest.probe)) if (!cited.has(url)) stale.push(`probe "${url}"`);
  const checked = [...cited.keys()].map((url) => manifest.probe[url]?.probe ?? url);
  const hosts = new Set(checked.map((url) => new URL(url).hostname));
  for (const host of Object.keys(manifest.catchAll)) {
    if (!hosts.has(host)) stale.push(`catchAll "${host}"`);
  }
  return stale;
}

const sleep = (ms) => new Promise((done) => setTimeout(done, ms));

/** Follows redirects by hand so the final URL is known. */
async function fetchFinal(url, { timeoutMs }) {
  let current = url;
  for (let hop = 0; hop <= MAX_REDIRECTS; hop++) {
    const response = await fetch(current, {
      method: "GET",
      redirect: "manual",
      headers: { "user-agent": USER_AGENT, accept: "*/*" },
      signal: AbortSignal.timeout(timeoutMs),
    });
    await response.body?.cancel();
    const location = response.headers.get("location");
    if (response.status >= 300 && response.status < 400 && location) {
      current = new URL(location, current).href;
      continue;
    }
    return { status: response.status, finalUrl: current, allow: response.headers.get("allow") };
  }
  return { error: `more than ${MAX_REDIRECTS} redirects` };
}

async function fetchWithRetry(url, options) {
  let result;
  for (let attempt = 0; attempt < 2; attempt++) {
    if (attempt > 0) await sleep(options.retryDelayMs);
    try {
      result = await fetchFinal(url, options);
    } catch (error) {
      result = { error: error?.cause?.code ?? error?.name ?? String(error) };
      continue;
    }
    if (!RETRY_STATUSES.has(result.status)) return result;
  }
  return result;
}

/**
 * A made-up path next to `url`, of the same shape: a number for a numbered
 * page (an issue), so a host that routes other names elsewhere answers it as
 * it would a missing number. It replaces the last segment, or is appended
 * under a path ending in "/".
 */
export function siblingOf(url) {
  const parsed = new URL(url);
  const segments = parsed.pathname.split("/");
  const last = segments[segments.length - 1];
  const made = /^\d+$/.test(last)
    ? `9${String(randomBytes(4).readUInt32BE(0)).padStart(10, "0")}`
    : `docs-links-${randomBytes(6).toString("hex")}`;
  segments[segments.length - 1] = made;
  parsed.pathname = segments.join("/");
  parsed.search = "";
  parsed.hash = "";
  return parsed.href;
}

/**
 * A 405 is an endpoint that refuses GET, such as an API route that takes only
 * POST. It passes only when a made-up path next to it answers 404 or 410, so a
 * host that answers 405 for every path still fails.
 */
async function checkMethodRefusal(url, { status, finalUrl, allow }, options) {
  const sibling = siblingOf(url);
  const probed = await fetchWithRetry(sibling, options);
  if (!probed.error && (probed.status === 404 || probed.status === 410)) {
    const allows = allow ? ` (Allow: ${allow})` : "";
    return {
      ok: true,
      status,
      finalUrl,
      reason: `answers 405 to GET${allows}: the endpoint takes another method, and a path that does not exist next to it answers ${probed.status}`,
    };
  }
  const answer = probed.error ? `cannot be fetched (${probed.error})` : `answers ${probed.status}`;
  return {
    ok: false,
    status,
    finalUrl,
    reason: `answers 405, and a path that does not exist next to it (${sibling}) ${answer}, not 404 or 410, so the status proves nothing`,
  };
}

/**
 * Checks one URL. Returns { ok, status, finalUrl, reason }: `reason` says why
 * a failing URL fails, or how a passing one was checked when that differs
 * from the default.
 */
export async function checkUrl(url, { catchAll = {}, timeoutMs = 15000, retryDelayMs = 2000 } = {}) {
  const options = { timeoutMs, retryDelayMs };
  const result = await fetchWithRetry(url, options);
  if (result.error) return { ok: false, status: null, finalUrl: null, reason: `not fetched: ${result.error}` };
  const { status, finalUrl } = result;
  const methodRefused = status === 405;
  if (!methodRefused && (status < 200 || status >= 300)) {
    return { ok: false, status, finalUrl, reason: `answers ${status}` };
  }
  const landed = rootKind(finalUrl);
  if (landed && !rootKind(url)) {
    return { ok: false, status, finalUrl, reason: `redirects to a ${landed}: ${finalUrl}` };
  }
  if (methodRefused) return checkMethodRefusal(url, result, options);
  if (rootKind(url) === "host root") return { ok: true, status, finalUrl, reason: null };
  const host = new URL(url).hostname;
  if (host in catchAll) return { ok: true, status, finalUrl, reason: `status only: ${catchAll[host]}` };
  const sibling = siblingOf(url);
  const probed = await fetchWithRetry(sibling, options);
  if (!probed.error && probed.status >= 200 && probed.status < 300 && !rootKind(probed.finalUrl)) {
    return {
      ok: false,
      status,
      finalUrl,
      reason: `the host answers ${probed.status} for a path that does not exist too (${sibling}), so the status proves nothing`,
    };
  }
  return { ok: true, status, finalUrl, reason: null };
}

async function mapLimit(items, limit, fn) {
  const results = new Array(items.length);
  let next = 0;
  async function worker() {
    while (next < items.length) {
      const index = next++;
      results[index] = await fn(items[index]);
    }
  }
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker));
  return results;
}

/** Runs the check over a tree; returns the report lines and the exit code. */
export async function run({ root, manifestPath, timeoutMs, retryDelayMs }) {
  const lines = [];
  let manifest;
  try {
    manifest = loadManifest(manifestPath);
  } catch (error) {
    return { lines: [`docs:links: ${error.message}`], exitCode: 2 };
  }
  const { files, cited } = collectUrls(root);
  const stale = staleEntries(manifest, cited);
  if (stale.length > 0) {
    return {
      lines: [`docs:links: ${manifestPath} lists URLs the repository no longer cites: ${stale.join(", ")}`],
      exitCode: 2,
    };
  }
  const urls = [...cited.keys()].sort();
  const toCheck = urls.filter((url) => !(url in manifest.skip));
  const results = await mapLimit(toCheck, 4, async (url) => {
    const target = manifest.probe[url]?.probe ?? url;
    return { url, target, ...(await checkUrl(target, { catchAll: manifest.catchAll, timeoutMs, retryDelayMs })) };
  });
  const failed = results.filter((result) => !result.ok);
  lines.push(
    `docs:links: ${files.length} files read, ${urls.length} distinct URLs, ${urls.length - toCheck.length} skipped by the manifest.`,
  );
  for (const result of results) {
    const via = result.target === result.url ? "" : ` (checked as ${result.target})`;
    lines.push(`${result.ok ? "ok  " : "FAIL"}  ${result.status ?? "---"}  ${result.url}${via}`);
    if (!result.ok) {
      lines.push(`      ${result.reason}`);
      lines.push(`      cited at ${cited.get(result.url).join(", ")}`);
    } else if (result.reason) {
      lines.push(`      ${result.reason}`);
    }
  }
  for (const url of urls.filter((url) => url in manifest.skip)) {
    lines.push(`skip  ---  ${url}`);
    lines.push(`      ${manifest.skip[url]}`);
  }
  lines.push(
    failed.length === 0
      ? `docs:links: ${results.length} of ${results.length} checked URLs resolve.`
      : `docs:links: ${failed.length} of ${results.length} checked URLs do not resolve.`,
  );
  return { lines, exitCode: failed.length === 0 ? 0 : 1 };
}

function parseArgs(argv) {
  const args = { root: process.cwd(), manifest: null };
  for (let i = 0; i < argv.length; i++) {
    const flag = argv[i];
    const value = argv[i + 1];
    if ((flag === "--root" || flag === "--manifest") && value) {
      args[flag.slice(2)] = value;
      i++;
    } else {
      throw new Error(`unknown argument "${flag}"`);
    }
  }
  return args;
}

/** Why `root` cannot be walked as a tree, or null when it is a directory. */
function rootProblem(root) {
  try {
    return statSync(root).isDirectory() ? null : "is not a directory";
  } catch (error) {
    if (error?.code === "ENOENT" || error?.code === "ENOTDIR") return "does not exist";
    return `cannot be read (${error?.code ?? error?.message ?? String(error)})`;
  }
}

async function main() {
  let args;
  try {
    args = parseArgs(process.argv.slice(2));
    const problem = rootProblem(resolve(args.root));
    if (problem) throw new Error(`--root "${args.root}" ${problem}`);
  } catch (error) {
    console.error(`docs:links: ${error.message}`);
    console.error("Usage: node scripts/docs-links.mjs [--root <dir>] [--manifest <file>]");
    process.exit(2);
  }
  const root = resolve(args.root);
  const manifestPath = resolve(args.manifest ?? join(root, "docs", "links.json"));
  const { lines, exitCode } = await run({ root, manifestPath });
  (exitCode === 2 ? console.error : console.log)(lines.join("\n"));
  process.exit(exitCode);
}

/**
 * Whether node was started on this file. Node resolves symbolic links in
 * import.meta.url and leaves process.argv[1] as given, so both are compared
 * as real paths: a path to the script through a link still runs it.
 */
function isMainModule() {
  if (!process.argv[1]) return false;
  try {
    return realpathSync(process.argv[1]) === realpathSync(fileURLToPath(import.meta.url));
  } catch {
    return false;
  }
}

if (isMainModule()) {
  await main();
}
