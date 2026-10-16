/**
 * `npm run docs:capture` re-captures the README's first command from the
 * build into docs/captures/quick-start.txt, records the run in
 * docs/captures/quick-start.json and copies the capture's lines into the
 * README sample; `--check` reports where those three files disagree.
 *
 * The committed files are checked as they are. Every capture here runs
 * against a local registry that serves docs/demo/registry-fixture.json, into
 * a scratch directory that holds copies of the files the script writes, so
 * the suite needs no network and writes nothing in the repository.
 */
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { execFileSync, spawn } from "node:child_process";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { basename, dirname, join, resolve } from "node:path";
import { tmpdir } from "node:os";
import { pathToFileURL } from "node:url";
import {
  CAPTURE,
  COMMAND,
  README,
  SIDECAR,
  checkCapture,
  defaultRegistry,
  readmeSample,
  sha256,
} from "../scripts/docs-capture.mjs";

const ROOT = resolve(__dirname, "..");
const SCRIPT = join(ROOT, "scripts/docs-capture.mjs");
const CLI_PATH = join(ROOT, "dist/index.js");
const VERSION = (JSON.parse(readFileSync(join(ROOT, "package.json"), "utf8")) as { version: string }).version;
const FIXTURE = JSON.parse(readFileSync(join(ROOT, "docs/demo/registry-fixture.json"), "utf8")) as {
  query: Record<string, unknown>;
};
const WRITTEN = [CAPTURE, SIDECAR, README];

let server: Server;
let registryUrl: string;
let scratch: string;

const read = (root: string, rel: string) => readFileSync(join(root, rel), "utf8");
const digests = (root: string) => WRITTEN.map((rel) => sha256(readFileSync(join(root, rel))));

/**
 * A directory holding copies of the files docs:capture reads and writes, with
 * dist/ linked to the build, or with a dist/index.js that runs `stub` instead.
 */
function scratchRoot(stub?: string): string {
  const root = mkdtempSync(join(scratch, "root-"));
  mkdirSync(join(root, "docs/captures"), { recursive: true });
  for (const rel of ["package.json", ...WRITTEN]) copyFileSync(join(ROOT, rel), join(root, rel));
  if (stub === undefined) {
    symlinkSync(join(ROOT, "dist"), join(root, "dist"));
  } else {
    mkdirSync(join(root, "dist"));
    writeFileSync(join(root, "dist/index.js"), stub);
  }
  return root;
}

/** Runs git in `cwd` with no system or user configuration; returns its stdout less the final newline. */
function git(cwd: string, ...args: string[]): string {
  const name = "docs-capture test";
  const email = "docs-capture@example.invalid";
  return execFileSync("git", args, {
    cwd,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
    env: {
      PATH: process.env.PATH,
      HOME: scratch,
      GIT_CONFIG_NOSYSTEM: "1",
      GIT_AUTHOR_NAME: name,
      GIT_AUTHOR_EMAIL: email,
      GIT_COMMITTER_NAME: name,
      GIT_COMMITTER_EMAIL: email,
    },
  }).replace(/\n$/, "");
}

/** A scratch root that is also a git work tree with one commit of the files it copies; returns it and that commit. */
function gitRoot(): { root: string; head: string } {
  const root = scratchRoot();
  git(root, "init", "-q");
  git(root, "add", "--", "package.json", ...WRITTEN);
  git(root, "commit", "-q", "-m", "copies");
  return { root, head: git(root, "rev-parse", "HEAD") };
}

/** Rewrites the record under `root` to name `commit` as the commit captured. */
function recordCommit(root: string, commit: unknown) {
  const sidecar = JSON.parse(read(root, SIDECAR));
  writeFileSync(join(root, SIDECAR), JSON.stringify({ ...sidecar, artifact: { ...sidecar.artifact, commit } }));
}

function run(
  file: string,
  args: string[],
  options: { cwd?: string; env?: NodeJS.ProcessEnv } = {},
): Promise<{ stdout: string; stderr: string; status: number | null }> {
  return new Promise((done, reject) => {
    // Async spawn, not spawnSync: the fixture registry runs in this process.
    const child = spawn(process.execPath, [file, ...args], {
      cwd: options.cwd ?? ROOT,
      env: options.env ?? { PATH: process.env.PATH, HOME: scratch, TMPDIR: scratch },
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk) => (stdout += chunk));
    child.stderr.on("data", (chunk) => (stderr += chunk));
    child.on("error", reject);
    child.on("close", (status) => done({ stdout, stderr, status }));
  });
}

function listen(srv: Server): Promise<string> {
  return new Promise((done) => srv.listen(0, "127.0.0.1", () => done(`http://127.0.0.1:${(srv.address() as AddressInfo).port}`)));
}

let committed: string[];

beforeAll(async () => {
  scratch = mkdtempSync(join(tmpdir(), "ai-trust-docs-capture-test-"));
  committed = digests(ROOT);
  server = createServer((req, res) => {
    const url = new URL(req.url ?? "/", "http://127.0.0.1");
    const answer = url.pathname === "/api/v1/trust/query" ? FIXTURE.query[url.searchParams.get("name") ?? ""] : undefined;
    res.writeHead(answer === undefined ? 404 : 200, { "Content-Type": "application/json" });
    res.end(JSON.stringify(answer ?? { error: "not in the fixture" }));
  });
  registryUrl = await listen(server);
});

afterAll(async () => {
  await new Promise((done) => server.close(done));
  rmSync(scratch, { recursive: true, force: true });
});

describe("the committed quick-start capture", () => {
  it("agrees with its record and with the README sample", () => {
    expect(checkCapture(ROOT)).toEqual([]);
  });

  it("is recorded as a run of the README's first command by the version in package.json", () => {
    const sidecar = JSON.parse(read(ROOT, SIDECAR));
    expect(sidecar.command).toBe(COMMAND);
    expect(sidecar.artifact.version).toBe(VERSION);
    expect(sidecar.exitCode).toBe(0);
  });

  it("passes npm run docs:capture -- --check, exit 0", async () => {
    const { stdout, status } = await run(SCRIPT, ["--check"]);
    expect(status).toBe(0);
    expect(stdout).toContain("agree");
  });
});

describe("docs:capture --check reports a hand edit", () => {
  it("to the capture, with the README sample edited to match", () => {
    const root = scratchRoot();
    const text = read(root, CAPTURE);
    const at = text.search(/\d/);
    const edited = text.slice(0, at) + (text[at] === "9" ? "8" : "9") + text.slice(at + 1);
    const start = text.lastIndexOf("\n", at) + 1;
    const end = text.indexOf("\n", at);
    writeFileSync(join(root, CAPTURE), edited);
    writeFileSync(join(root, README), read(root, README).replace(text.slice(start, end), edited.slice(start, end)));

    expect(checkCapture(root)).toEqual([expect.stringContaining(`${CAPTURE} hashes to`)]);
  });

  it("to the capture's length", () => {
    const root = scratchRoot();
    writeFileSync(join(root, CAPTURE), `${read(root, CAPTURE)}\n`);

    expect(checkCapture(root)).toEqual([
      expect.stringContaining(`${CAPTURE} is ${readFileSync(join(root, CAPTURE)).length} bytes`),
      expect.stringContaining(`${CAPTURE} hashes to`),
    ]);
  });

  it("to the record's command and exit code", () => {
    const root = scratchRoot();
    const sidecar = JSON.parse(read(root, SIDECAR));
    writeFileSync(join(root, SIDECAR), JSON.stringify({ ...sidecar, command: "npx ai-trust check express", exitCode: 2 }));

    expect(checkCapture(root)).toEqual([
      expect.stringContaining('records the command "npx ai-trust check express"'),
      expect.stringContaining("records exit code 2, not 0"),
    ]);
  });

  it("to the README sample", async () => {
    const root = scratchRoot();
    const sample = readmeSample(read(root, README));
    if ("error" in sample) throw new Error(sample.error);
    sample.lines[sample.open + 1] += " edited";
    writeFileSync(join(root, README), sample.lines.join("\n"));

    expect(checkCapture(root)).toEqual([expect.stringContaining(`the ${README} sample at lines`)]);
    const { stderr, status } = await run(SCRIPT, ["--check", "--root", root]);
    expect(status).toBe(1);
    expect(stderr).toContain("run npm run build, then npm run docs:capture");
  });

  it("to the version in package.json, with no new capture", () => {
    const root = scratchRoot();
    const pkg = JSON.parse(read(root, "package.json"));
    writeFileSync(join(root, "package.json"), JSON.stringify({ ...pkg, version: "0.0.0-not-captured" }));

    expect(checkCapture(root)).toEqual([expect.stringContaining('package.json holds 0.0.0-not-captured')]);
  });
});

describe("docs:capture --check and the commit the record names", { timeout: 30000 }, () => {
  const notInHistory = (commit: string) =>
    `${SIDECAR} records commit ${commit}, which is not HEAD or an ancestor of it; run npm run build, then npm run docs:capture`;

  it("reports a commit the repository holds off the history of HEAD, and one it does not hold, exit 1", async () => {
    const { root, head } = gitRoot();
    // A child of HEAD that no branch points at: in the repository, not in the history of HEAD.
    const offHistory = git(root, "commit-tree", `${head}^{tree}`, "-p", head, "-m", "rebased away");
    const notHeld = "0".repeat(40);
    for (const commit of [offHistory, notHeld]) {
      recordCommit(root, commit);
      expect(checkCapture(root)).toEqual([notInHistory(commit)]);
    }

    recordCommit(root, offHistory);
    const { stderr, status } = await run(SCRIPT, ["--check", "--root", root]);
    expect(status).toBe(1);
    expect(stderr).toContain(notInHistory(offHistory));
  });

  it("reports a recorded commit that is not a full commit hash", () => {
    const { root, head } = gitRoot();
    for (const commit of ["HEAD", head.slice(0, 12), `--${head}`, null]) {
      recordCommit(root, commit);
      expect(checkCapture(root), String(commit)).toEqual([
        expect.stringContaining(`${SIDECAR} records commit ${JSON.stringify(commit)}, not a full commit hash`),
      ]);
    }
  });

  it("accepts HEAD, and a commit that is an ancestor of HEAD", () => {
    const { root, head } = gitRoot();
    recordCommit(root, head);
    const notes: string[] = [];
    expect(checkCapture(root, notes)).toEqual([]);

    writeFileSync(join(root, "later.txt"), "a later change\n");
    git(root, "add", "--", "later.txt");
    git(root, "commit", "-q", "-m", "later");
    expect(git(root, "rev-parse", "HEAD")).not.toBe(head);
    expect(checkCapture(root, notes)).toEqual([]);
    expect(notes).toEqual([]);
  });

  it("leaves the commit unchecked, and says so, in a shallow clone that finds no path from HEAD to it", async () => {
    const { root, head } = gitRoot();
    recordCommit(root, head);
    git(root, "add", "--", SIDECAR);
    git(root, "commit", "-q", "-m", "record");
    const shallow = join(mkdtempSync(join(scratch, "clone-")), "depth-1");
    git(scratch, "clone", "-q", "--depth", "1", pathToFileURL(root).href, shallow);
    expect(git(shallow, "rev-parse", "--is-shallow-repository")).toBe("true");

    const notes: string[] = [];
    expect(checkCapture(shallow, notes)).toEqual([]);
    expect(notes).toEqual([expect.stringContaining(`this clone is shallow and finds no path from HEAD to commit ${head}`)]);
    const { stdout, status } = await run(SCRIPT, ["--check", "--root", shallow]);
    expect(status).toBe(0);
    expect(stdout).toContain("run git fetch --unshallow, then the check again");
    expect(stdout).toContain("agree");

    // A shallow clone deep enough to hold the commit checks it.
    const deeper = join(mkdtempSync(join(scratch, "clone-")), "depth-2");
    git(scratch, "clone", "-q", "--depth", "2", pathToFileURL(root).href, deeper);
    const deeperNotes: string[] = [];
    expect(checkCapture(deeper, deeperNotes)).toEqual([]);
    expect(deeperNotes).toEqual([]);
  });

  it("leaves the commit unchecked, and says so, when the root is not the top of a git work tree", () => {
    const root = scratchRoot();
    const notes: string[] = [];
    expect(checkCapture(root, notes)).toEqual([]);
    expect(notes).toEqual([`the record's commit was not checked: ${root} is not the top of a git work tree`]);
  });

  it("checks the commit, and a capture records it, when the root is typed in another letter case on a case-insensitive file system", async (ctx) => {
    const { root, head } = gitRoot();
    const swapped = basename(root).replace(/[a-z]/gi, (c) => (c === c.toLowerCase() ? c.toUpperCase() : c.toLowerCase()));
    const otherCase = join(dirname(root), swapped);
    expect(otherCase).not.toBe(root);
    // On a case-sensitive file system no directory has that name.
    if (!existsSync(otherCase)) ctx.skip();

    const offHistory = git(root, "commit-tree", `${head}^{tree}`, "-p", head, "-m", "rebased away");
    recordCommit(root, offHistory);
    const notes: string[] = [];
    expect(checkCapture(otherCase, notes)).toEqual([notInHistory(offHistory)]);
    expect(notes).toEqual([]);
    const check = await run(SCRIPT, ["--check", "--root", otherCase]);
    expect(check.stdout).not.toContain("was not checked");
    expect(check.stderr).toContain(notInHistory(offHistory));
    expect(check.status).toBe(1);

    const capture = await run(SCRIPT, ["--root", otherCase, "--registry-url", registryUrl]);
    expect(capture.stderr).toBe("");
    expect(capture.status).toBe(0);
    expect(JSON.parse(read(root, SIDECAR)).artifact.commit).toBe(head);
  });

  it("reads the repository at the root when GIT_DIR or GIT_WORK_TREE is exported to it, as git does to hooks and in a linked work tree", async () => {
    const { root, head } = gitRoot();
    recordCommit(root, head);
    const plain = scratchRoot();
    const other = gitRoot();
    const names = ["GIT_DIR", "GIT_WORK_TREE"];
    const shapes: NodeJS.ProcessEnv[] = [
      { GIT_DIR: join(other.root, ".git") },
      { GIT_WORK_TREE: join(scratch, "no-such-work-tree") },
    ];
    for (const exported of shapes) {
      const saved = Object.fromEntries(names.map((name) => [name, process.env[name]]));
      Object.assign(process.env, exported);
      try {
        const notes: string[] = [];
        expect(checkCapture(root, notes), JSON.stringify(exported)).toEqual([]);
        expect(notes).toEqual([]);
        const plainNotes: string[] = [];
        expect(checkCapture(plain, plainNotes)).toEqual([]);
        expect(plainNotes).toEqual([`the record's commit was not checked: ${plain} is not the top of a git work tree`]);
      } finally {
        for (const name of names) {
          if (saved[name] === undefined) delete process.env[name];
          else process.env[name] = saved[name];
        }
      }
      const env = { PATH: process.env.PATH, HOME: scratch, TMPDIR: scratch, ...exported };
      const check = await run(SCRIPT, ["--check", "--root", root], { env });
      expect(check.stderr, JSON.stringify(exported)).toBe("");
      expect(check.status).toBe(0);
    }

    const env = { PATH: process.env.PATH, HOME: scratch, TMPDIR: scratch, ...shapes[0] };
    const capture = await run(SCRIPT, ["--root", root, "--registry-url", registryUrl], { env });
    expect(capture.stderr).toBe("");
    expect(capture.status).toBe(0);
    expect(JSON.parse(read(root, SIDECAR)).artifact.commit).toBe(head);
  });
});

describe("docs:capture reports a file it cannot read on one line, exit 1", () => {
  for (const [check, rel, damage] of [
    [true, "package.json", "missing"],
    [true, README, "missing"],
    [true, "package.json", "not JSON"],
    [false, README, "missing"],
    [false, "package.json", "missing"],
    [false, "package.json", "not JSON"],
  ] as const) {
    it(`${check ? "--check" : "a capture"}, with ${rel} ${damage}`, async () => {
      const root = scratchRoot(check ? undefined : 'process.stdout.write("output\\n");');
      if (damage === "missing") rmSync(join(root, rel));
      else writeFileSync(join(root, rel), "{");
      const kept = WRITTEN.filter((other) => other !== rel);
      const before = kept.map((other) => read(root, other));
      const reason = `cannot read ${rel}: ${damage === "missing" ? "ENOENT" : ""}`;

      if (check) expect(checkCapture(root)).toEqual([expect.stringContaining(reason)]);
      const { stderr, status } = await run(SCRIPT, [...(check ? ["--check"] : ["--registry-url", registryUrl]), "--root", root]);
      expect(status).toBe(1);
      expect(stderr.split("\n"), stderr).toEqual([expect.stringContaining(`docs:capture${check ? " --check" : ""}: ${reason}`), ""]);
      expect(kept.map((other) => read(root, other))).toEqual(before);
    });
  }

  it("--check, with a record that is valid JSON but not an object", async () => {
    for (const [content, kind] of [
      ["null", "null"],
      ["[]", "an array"],
      ["5", "a number"],
      ['"record"', "a string"],
    ]) {
      const root = scratchRoot();
      writeFileSync(join(root, SIDECAR), `${content}\n`);
      const reason = `${SIDECAR} holds ${kind}, not a record object; run npm run build, then npm run docs:capture`;

      expect(checkCapture(root), content).toEqual([reason]);
      const { stderr, status } = await run(SCRIPT, ["--check", "--root", root]);
      expect(stderr.split("\n"), stderr).toEqual([`docs:capture --check: ${reason}`, ""]);
      expect(status).toBe(1);
    }
  });
});

describe("npm run docs:capture", { timeout: 60000 }, () => {
  it("writes what dist/index.js prints for the README's first command, its record and the README sample", async () => {
    const root = scratchRoot();
    const before = readmeSample(read(root, README));
    const { stdout, stderr, status } = await run(SCRIPT, ["--root", root, "--registry-url", registryUrl]);
    expect(stderr).toBe("");
    expect(status).toBe(0);
    expect(stdout).toContain(`wrote ${CAPTURE}`);
    expect(checkCapture(root)).toEqual([]);

    // The capture is the CLI's stdout for the same command in the same environment.
    const home = mkdtempSync(join(scratch, "home-"));
    const cwd = mkdtempSync(join(scratch, "cwd-"));
    const args = [...COMMAND.split(" ").slice(2), "--registry-url", registryUrl];
    const direct = await run(CLI_PATH, args, {
      cwd,
      env: { PATH: process.env.PATH, HOME: home, CI: "true", TERM: "dumb", LANG: "en_US.UTF-8", OPENA2A_TELEMETRY: "off" },
    });
    expect(direct.status).toBe(0);
    const captured = readFileSync(join(root, CAPTURE));
    expect(captured.toString("utf8")).toBe(direct.stdout);
    expect(captured.toString("utf8")).toContain("@modelcontextprotocol/server-filesystem");

    const sidecar = JSON.parse(read(root, SIDECAR));
    expect(sidecar.command).toBe(COMMAND);
    expect(sidecar.artifact).toMatchObject({
      package: "ai-trust",
      version: VERSION,
      commit: null,
      taggedRelease: false,
      invokedAs: `node dist/index.js ${args.join(" ")}`,
    });
    expect(sidecar.registry).toBe(registryUrl);
    expect(sidecar.exitCode).toBe(0);
    expect(sidecar.outputs).toMatchObject({ bytes: captured.length, sha256: sha256(captured), stderr: "empty" });

    // Only the sample block of the README changes.
    const after = readmeSample(read(root, README));
    if ("error" in before || "error" in after) throw new Error("the README sample block is missing");
    expect(after.lines.slice(0, after.open + 1)).toEqual(before.lines.slice(0, before.open + 1));
    expect(after.lines.slice(after.close)).toEqual(before.lines.slice(before.close));
  });

  it("records the commit a git work tree has checked out, which --check then accepts", async () => {
    const { root, head } = gitRoot();
    const { stderr, status } = await run(SCRIPT, ["--root", root, "--registry-url", registryUrl]);
    expect(stderr).toBe("");
    expect(status).toBe(0);
    expect(JSON.parse(read(root, SIDECAR)).artifact.commit).toBe(head);
    const notes: string[] = [];
    expect(checkCapture(root, notes)).toEqual([]);
    expect(notes).toEqual([]);
  });

  it("writes nothing when the CLI run fails", async () => {
    const root = scratchRoot();
    const closed = createServer();
    const deadUrl = await listen(closed);
    await new Promise((done) => closed.close(done));
    const before = digests(root);

    const { stderr, status } = await run(SCRIPT, ["--root", root, "--registry-url", deadUrl]);
    expect(status).toBe(1);
    expect(stderr).toContain("exited 1");
    expect(stderr).toContain("nothing written");
    expect(digests(root)).toEqual(before);
  });

  for (const [what, stub, message] of [
    [
      "prints on stderr and exits 0",
      'process.stderr.write("a note\\n"); process.stdout.write("\\n  output\\n\\n");',
      "exited 0 and printed on stderr; nothing written",
    ],
    ["prints nothing on stdout and exits 0", "", "printed nothing on stdout; nothing written"],
  ]) {
    it(`writes nothing when the CLI ${what}`, async () => {
      const root = scratchRoot(stub);
      const before = digests(root);
      const { stderr, status } = await run(SCRIPT, ["--root", root, "--registry-url", registryUrl]);
      expect(status).toBe(1);
      expect(stderr).toContain(message);
      expect(digests(root)).toEqual(before);
    });
  }

  it("refuses an unknown argument, a flag with no value, --check with --registry-url, and a --root that is missing or a file, exit 2", async () => {
    for (const args of [
      ["--json"],
      ["--registry-url"],
      ["--check", "--registry-url", registryUrl],
      ["--root", join(scratch, "no-such-directory")],
      ["--root", join(ROOT, "package.json")],
    ]) {
      const { stderr, status } = await run(SCRIPT, args);
      expect(status, args.join(" ")).toBe(2);
      expect(stderr).toContain("Usage: node scripts/docs-capture.mjs");
    }
  });

  it("reads the registry the CLI asks by default from its --help", () => {
    expect(defaultRegistry(CLI_PATH, { PATH: process.env.PATH, HOME: scratch, OPENA2A_TELEMETRY: "off" })).toBe(
      "https://api.oa2a.org",
    );
  });

  it("left the committed capture, record and README as they were", () => {
    expect(digests(ROOT)).toEqual(committed);
  });
});
