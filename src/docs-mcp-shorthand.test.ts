/**
 * The MCP shorthand the docs describe is the shorthand `check` resolves.
 *
 * The MCP-server guide once said `mcp-server-fetch` and `stripe` expand to
 * `@modelcontextprotocol/*` names, and showed `check stripe` printing
 * `@modelcontextprotocol/server-stripe`. `resolvePackageName` passes both
 * names through unchanged; only `server-*` (and `mcp/server-*`) expand. These
 * checks read README.md and every Markdown file under docs/ and hold three
 * kinds of claim to the resolver:
 *
 *   1. an `ai-trust check <arg>  # resolves to <name>` comment;
 *   2. a sentence saying a `<prefix>*` pattern resolves to
 *      `@modelcontextprotocol/server-*`;
 *   3. a sample output block whose package name follows an
 *      `ai-trust check <arg>` command block.
 */
import { describe, it, expect } from "vitest";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { parsePackageTarget, resolvePackageName } from "./utils/resolve.js";

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(HERE, "..");

function markdownUnder(dir: string): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir)) {
    const path = join(dir, entry);
    if (statSync(path).isDirectory()) out.push(...markdownUnder(path));
    else if (entry.endsWith(".md")) out.push(path);
  }
  return out;
}

const DOCS = [join(ROOT, "README.md"), ...markdownUnder(join(ROOT, "docs"))].map((path) => ({
  file: relative(ROOT, path),
  text: readFileSync(path, "utf8"),
}));

/** What `check <target>` looks up: ecosystem prefix stripped, then MCP shorthand expanded. */
function lookupName(target: string): string {
  return resolvePackageName(parsePackageTarget(target).name);
}

/** The first non-flag argument after `ai-trust check` on a line, if any. */
function checkTarget(line: string): string | undefined {
  const match = line.match(/\bai-trust check\s+([^\s|)]+)/);
  return match && !match[1].startsWith("-") ? match[1] : undefined;
}

interface Block {
  info: string;
  body: string[];
  line: number;
}

function fencedBlocks(text: string): Block[] {
  const blocks: Block[] = [];
  let open: Block | undefined;
  text.split("\n").forEach((line, i) => {
    const fence = line.match(/^```(\S*)\s*$/);
    if (!fence) {
      open?.body.push(line);
      return;
    }
    if (open) {
      blocks.push(open);
      open = undefined;
    } else {
      open = { info: fence[1], body: [], line: i + 1 };
    }
  });
  return blocks;
}

const SHELL = new Set(["bash", "sh", "shell", "console"]);
const PACKAGE_NAME = /^(@[a-z0-9][a-z0-9._-]*\/)?[a-z0-9][a-z0-9._-]*$/;

/** The package name a sample output block reports, if it reports one. */
function sampleName(body: string[]): string | undefined {
  const joined = body.join("\n");
  const json = joined.match(/"name":\s*"([^"]+)"/);
  if (json) return json[1];
  const resolved = joined.match(/^Resolved: \S+ -> (\S+)$/m);
  if (resolved) return resolved[1];
  const first = body.find((line) => line.trim() !== "")?.trim().split(/\s+/)[0];
  return first && PACKAGE_NAME.test(first) ? first : undefined;
}

describe("MCP shorthand claims in the docs match resolvePackageName", () => {
  it("every `# resolves to` comment names what the resolver returns", () => {
    const claims: string[] = [];
    const wrong: string[] = [];
    for (const { file, text } of DOCS) {
      text.split("\n").forEach((line, i) => {
        const claim = line.match(/#\s*resolves to\s+`?([^`\s]+)`?/);
        const target = checkTarget(line);
        if (!claim || !target) return;
        claims.push(`${file}:${i + 1}`);
        const actual = lookupName(target);
        if (actual !== claim[1]) {
          wrong.push(`${file}:${i + 1} says ${target} resolves to ${claim[1]}; it resolves to ${actual}`);
        }
      });
    }
    expect(claims.length).toBeGreaterThan(0);
    expect(wrong).toEqual([]);
  });

  it("every prefix rule that resolves to @modelcontextprotocol/server-* holds", () => {
    const claims: string[] = [];
    const wrong: string[] = [];
    for (const { file, text } of DOCS) {
      text.split("\n").forEach((line, i) => {
        for (const sentence of line.split(/(?<=\.)\s+/)) {
          const verb = sentence.match(/\bresolves?\s+to\s+`@modelcontextprotocol\/server-\*`/);
          if (!verb || verb.index === undefined) continue;
          const subject = sentence.slice(0, verb.index);
          if (/\bnot\b|n't\b|\bnever\b/.test(subject)) continue;
          for (const [, prefix] of subject.matchAll(/`([^`\s]+)\*`/g)) {
            claims.push(`${file}:${i + 1} ${prefix}*`);
            const actual = resolvePackageName(`${prefix}example`);
            if (actual !== "@modelcontextprotocol/server-example") {
              wrong.push(`${file}:${i + 1} says \`${prefix}*\` resolves to @modelcontextprotocol/server-*; ${prefix}example resolves to ${actual}`);
            }
          }
        }
      });
    }
    expect(claims.length).toBeGreaterThan(0);
    expect(wrong).toEqual([]);
  });

  it("every sample output after a check command names the package that command looks up", () => {
    const wrong: string[] = [];
    for (const { file, text } of DOCS) {
      let target: string | undefined;
      for (const block of fencedBlocks(text)) {
        if (SHELL.has(block.info)) {
          target = block.body.map(checkTarget).filter((t): t is string => t !== undefined).pop();
          continue;
        }
        const shown = target ? sampleName(block.body) : undefined;
        if (target && shown && shown !== lookupName(target)) {
          wrong.push(`${file}:${block.line} shows ${shown} for \`check ${target}\`, which looks up ${lookupName(target)}`);
        }
        target = undefined;
      }
    }
    expect(wrong).toEqual([]);
  });
});
