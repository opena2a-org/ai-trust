/**
 * The consumer-resolution gate labels a `--target` that names a tarball as
 * the CANDIDATE run whether or not the file is there, and fails a missing one
 * before anything is installed.
 *
 * It took the CANDIDATE label only for a tarball that existed. A mistyped
 * path fell through to the PUBLISHED label and was handed to `npm install`,
 * so the run failed under the headline and closing line of the run that
 * measures what users install from npm, which says a failure there is not
 * fixable by merging.
 *
 * `scripts/audit-consumer-resolution.mjs` ends in a bare `main();`, so it
 * runs here as a process. The `npm` on its PATH is a stub that prints its
 * arguments and exits 1: no run reaches the registry, and a run that installs
 * prints what it handed to `npm install`.
 */
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { spawnSync } from "node:child_process";
import { chmodSync, mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

const GATE = resolve(__dirname, "../scripts/audit-consumer-resolution.mjs");
const NPM_CALLED = "stub npm called:";
const INSTALL = `${NPM_CALLED} install --omit=dev --ignore-scripts --no-audit --no-fund`;

let scratch: string;

beforeAll(() => {
  // A relative target resolves against the gate's working directory, which
  // the OS reports with symlinks resolved, so the expected paths are too.
  scratch = realpathSync(mkdtempSync(join(tmpdir(), "ai-trust-consumer-target-")));
  for (const dir of ["bin", "home", "tmp", "packed"]) mkdirSync(join(scratch, dir));
  const npm = join(scratch, "bin", "npm");
  writeFileSync(npm, `#!/bin/sh\necho "${NPM_CALLED} $*" >&2\nexit 1\n`);
  chmodSync(npm, 0o755);
  writeFileSync(join(scratch, "packed", "ai-trust-0.0.0.tgz"), "");
});

afterAll(() => {
  rmSync(scratch, { recursive: true, force: true });
});

function gate(target: string, cwd = scratch) {
  const res = spawnSync(process.execPath, [GATE, "--target", target], {
    cwd,
    encoding: "utf8",
    timeout: 60_000,
    env: { PATH: join(scratch, "bin"), HOME: join(scratch, "home"), TMPDIR: join(scratch, "tmp") },
  });
  return { stdout: res.stdout ?? "", stderr: res.stderr ?? "", status: res.status };
}

function expectMissingCandidate(run: ReturnType<typeof gate>, tarball: string) {
  expect(run.status).toBe(1);
  expect(run.stdout).toContain(`[CANDIDATE] Target: ${tarball}\n`);
  expect(run.stderr).toContain("[CANDIDATE] Consumer-resolution audit FAILED");
  expect(run.stderr).toContain(`the tarball ${tarball} does not exist`);
  expect(run.stderr).toContain("This is the CANDIDATE run");
  expect(`${run.stdout}${run.stderr}`).not.toContain("PUBLISHED");
  expect(run.stderr).not.toContain(NPM_CALLED);
}

// The stub is a POSIX shell script.
describe.skipIf(process.platform === "win32")("consumer-resolution gate --target", () => {
  it("fails a tarball path that does not exist as the CANDIDATE run, without running npm", () => {
    const missing = join(scratch, "missing", "ai-trust-0.0.0.tgz");
    expectMissingCandidate(gate(missing), missing);
  });

  it("fails a missing tarball named by a file: spec or a relative .tar.gz path the same way", () => {
    const missing = join(scratch, "missing", "ai-trust-0.0.0.tgz");
    expectMissingCandidate(gate(`file:${missing}`), missing);
    expectMissingCandidate(
      gate("ai-trust-0.0.0.tar.gz", join(scratch, "packed")),
      join(scratch, "packed", "ai-trust-0.0.0.tar.gz"),
    );
  });

  it("installs a tarball that exists, named by path or by file: spec, as the CANDIDATE run", () => {
    const packed = join(scratch, "packed", "ai-trust-0.0.0.tgz");
    for (const target of [packed, `file:${packed}`]) {
      const run = gate(target);
      expect(run.status).toBe(1);
      expect(run.stdout).toContain(`[CANDIDATE] Target: ${packed}\n`);
      expect(run.stderr).toContain(`${INSTALL} ${packed}\n`);
      expect(run.stderr).not.toContain("does not exist");
    }
  });

  it("hands a registry spec and a tarball URL to npm as given, as the PUBLISHED run", () => {
    for (const spec of ["ai-trust@0.7.6", "https://registry.npmjs.org/ai-trust/-/ai-trust-0.7.6.tgz"]) {
      const run = gate(spec);
      expect(run.status).toBe(1);
      expect(run.stdout).toContain(`[PUBLISHED] Target: ${spec}\n`);
      expect(run.stderr).toContain(`${INSTALL} ${spec}\n`);
      expect(`${run.stdout}${run.stderr}`).not.toContain("CANDIDATE");
    }
  });
});
