/**
 * The release pipeline's SHAPE, asserted against the committed YAML.
 *
 * These are not tests of code, they are tests of a workflow file, and that is
 * deliberate. The properties below — which job holds the publish identity,
 * what runs before `npm publish`, whether an install is guarded — are enforced
 * nowhere else. They live in a file that is edited by hand, is never executed
 * on a pull request (the release workflow triggers on tag pushes only), and
 * whose failure mode is discovered after an irreversible publish. So they are
 * asserted here, on every `npm test`, where breaking one is free to find.
 *
 * Covers AIT-03.AC1 (the `review` job between build and publish) and
 * AIT-03.AC4 (the package-manager-config guard before every `npm ci`).
 */
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { resolve } from "node:path";
import yaml from "js-yaml";

const REPO_ROOT = resolve(__dirname, "..", "..");
const RELEASE_YML = resolve(REPO_ROOT, ".github/workflows/release.yml");
const CI_YML = resolve(REPO_ROOT, ".github/workflows/ci.yml");

/**
 * The guard's grep pattern and the guard's whole command line, defined once so
 * the workflow assertion and the pattern assertion cannot drift apart. The
 * workflow must contain this text verbatim.
 */
const GUARD_PATTERN = String.raw`(^|/)(\.npmrc|\.yarnrc(\.yml)?|\.pnpmfile\.cjs|\.envrc)$`;
const GUARD_COMMAND = `git ls-files | grep -E '${GUARD_PATTERN}'`;

interface Step {
  name?: string;
  uses?: string;
  run?: string;
  env?: Record<string, string>;
  if?: unknown;
  "continue-on-error"?: unknown;
}
interface Job {
  needs?: string | string[];
  permissions?: Record<string, string> | string;
  steps?: Step[];
  outputs?: Record<string, string>;
}
interface Workflow {
  permissions?: Record<string, string> | string;
  jobs: Record<string, Job>;
}

function load(path: string): Workflow {
  return yaml.load(readFileSync(path, "utf8")) as Workflow;
}

/** `needs:` as a list, whichever of the two spellings the file uses. */
function needsOf(job: Job): string[] {
  if (!job.needs) return [];
  return Array.isArray(job.needs) ? job.needs : [job.needs];
}

function steps(job: Job): Step[] {
  return job.steps ?? [];
}

const release = load(RELEASE_YML);
const ci = load(CI_YML);

describe("release.yml — the tarball review job (AIT-03.AC1)", () => {
  it("AIT-03.AC1 release.yml orders the jobs consumer-audit, build, review, publish", () => {
    const order = Object.keys(release.jobs);
    for (const job of ["consumer-audit", "build", "review", "publish"]) {
      expect(order, `release.yml has no \`${job}\` job`).toContain(job);
    }
    expect(order.indexOf("review")).toBeGreaterThan(order.indexOf("build"));
    expect(order.indexOf("publish")).toBeGreaterThan(order.indexOf("review"));
  });

  it("AIT-03.AC1 the needs chain runs consumer-audit -> build -> review -> publish", () => {
    expect(needsOf(release.jobs["build"])).toContain("consumer-audit");
    expect(needsOf(release.jobs["review"])).toContain("build");
    // The load-bearing edge: `publish` may not be reachable without `review`.
    expect(needsOf(release.jobs["publish"])).toContain("review");
    expect(needsOf(release.jobs["github-release"])).toContain("publish");
  });

  it("AIT-03.AC1 the review job carries `contents: read` and nothing else", () => {
    expect(release.jobs["review"].permissions).toEqual({ contents: "read" });
  });

  it("AIT-03.AC1 no job except publish carries `id-token: write`", () => {
    // The workflow-level grant is empty, so a job that does not declare a
    // permission block gets `none` rather than inheriting one.
    expect(release.permissions).toEqual({});
    for (const [name, job] of Object.entries(release.jobs)) {
      const permissions = (job.permissions ?? {}) as Record<string, string>;
      if (name === "publish") {
        expect(permissions).toEqual({ "id-token": "write" });
        continue;
      }
      expect(permissions["id-token"], `job \`${name}\` carries id-token`).toBeUndefined();
    }
  });

  it("AIT-03.AC1 the publish job still checks out nothing", () => {
    const checkouts = steps(release.jobs["publish"]).filter((s) => (s.uses ?? "").startsWith("actions/checkout"));
    expect(checkouts).toEqual([]);
  });

  it("AIT-03.AC1 the review job downloads the build artifact and re-checks its sha256", () => {
    const reviewSteps = steps(release.jobs["review"]);
    const download = reviewSteps.find((s) => (s.uses ?? "").startsWith("actions/download-artifact"));
    expect(download, "review does not download the build artifact").toBeDefined();

    const shaStep = reviewSteps.find((s) => (s.run ?? "").includes("sha256sum -c -"));
    expect(shaStep, "review does not verify the artifact's sha256").toBeDefined();
    // The expected digest must come from `build`, not be recomputed here — a
    // digest of whatever arrived proves nothing about what was packed.
    expect(JSON.stringify(shaStep)).toContain("needs.build.outputs.sha256");
  });

  it("AIT-03.AC1 the review job runs release-artifact-review.mjs and fails on a non-zero exit", () => {
    const reviewSteps = steps(release.jobs["review"]);
    const runner = reviewSteps.find((s) => (s.run ?? "").includes("scripts/release-artifact-review.mjs"));
    expect(runner, "review never runs scripts/release-artifact-review.mjs").toBeDefined();
    expect(runner!.run).toContain("--tarball");
    // Nothing may swallow the exit code: no `|| true`, no `continue-on-error`,
    // no `if:` that can route around the step.
    expect(runner!.run).not.toMatch(/\|\|\s*true/);
    expect(runner!["continue-on-error"]).toBeUndefined();
    expect(runner!.if).toBeUndefined();

    // The download must happen before the review, or the review has no bytes.
    const downloadAt = reviewSteps.findIndex((s) => (s.uses ?? "").startsWith("actions/download-artifact"));
    const reviewAt = reviewSteps.indexOf(runner!);
    expect(downloadAt).toBeGreaterThanOrEqual(0);
    expect(reviewAt).toBeGreaterThan(downloadAt);
  });

  it("AIT-03.AC1 the review step carries GH_TOKEN and runs after `npm ci --ignore-scripts` in its job", () => {
    const reviewSteps = steps(release.jobs["review"]);
    const runner = reviewSteps.find((s) => (s.run ?? "").includes("scripts/release-artifact-review.mjs"));
    expect(runner, "review never runs scripts/release-artifact-review.mjs").toBeDefined();

    // GH_TOKEN feeds the consumer-closure check's advisory reads; without it
    // the shared unauthenticated rate budget turns into a blocking
    // `precondition` on busy runner IPs.
    expect(runner!.env?.GH_TOKEN).toBe("${{ github.token }}");
    // The workflow reads published advisories only — draft/triage advisories
    // of other repositories are not readable by this repository's token.
    expect(runner!.run).toContain("--advisory-states published");

    // `npm ci --ignore-scripts` must precede the review in the SAME job, or
    // `node_modules/.bin/hackmyagent` does not resolve and the credential
    // scan reports a precondition on every release.
    const installAt = reviewSteps.findIndex((s) => (s.run ?? "").includes("npm ci --ignore-scripts"));
    expect(installAt, "review has no `npm ci --ignore-scripts` step").toBeGreaterThanOrEqual(0);
    expect(reviewSteps.indexOf(runner!)).toBeGreaterThan(installAt);
  });

  it("AIT-03.AC1 the review job is ordered after the sha256 check, so it reviews the verified bytes", () => {
    const reviewSteps = steps(release.jobs["review"]);
    const shaAt = reviewSteps.findIndex((s) => (s.run ?? "").includes("sha256sum -c -"));
    const reviewAt = reviewSteps.findIndex((s) => (s.run ?? "").includes("scripts/release-artifact-review.mjs"));
    expect(shaAt).toBeGreaterThanOrEqual(0);
    expect(reviewAt).toBeGreaterThan(shaAt);
  });
});

describe("the package-manager-config guard (AIT-03.AC4)", () => {
  const files: [string, Workflow][] = [
    [".github/workflows/release.yml", release],
    [".github/workflows/ci.yml", ci],
  ];

  it("AIT-03.AC4 every job that runs `npm ci` guards first, in both workflow files", () => {
    let guarded = 0;
    for (const [label, workflow] of files) {
      for (const [jobName, job] of Object.entries(workflow.jobs)) {
        const jobSteps = steps(job);
        const installAt = jobSteps.findIndex((s) => /(^|\s|&&\s*)npm ci(\s|$)/.test(s.run ?? ""));
        if (installAt === -1) continue;
        const guardAt = jobSteps.findIndex((s) => (s.run ?? "").includes(GUARD_COMMAND));
        expect(guardAt, `${label} job \`${jobName}\` runs npm ci with no guard step`).toBeGreaterThanOrEqual(0);
        expect(
          guardAt,
          `${label} job \`${jobName}\` guards AFTER its install, which guards nothing`,
        ).toBeLessThan(installAt);
        guarded += 1;
      }
    }
    // Both files must actually have contributed a job, or this test passes by
    // finding nothing to check.
    expect(guarded).toBeGreaterThanOrEqual(2);
  });

  it("AIT-03.AC4 the guard carries no `if:` and no `continue-on-error:`", () => {
    let seen = 0;
    for (const [label, workflow] of files) {
      for (const [jobName, job] of Object.entries(workflow.jobs)) {
        for (const step of steps(job)) {
          if (!(step.run ?? "").includes(GUARD_COMMAND)) continue;
          seen += 1;
          expect(step.if, `${label} \`${jobName}\` guard carries an if:`).toBeUndefined();
          expect(
            step["continue-on-error"],
            `${label} \`${jobName}\` guard carries continue-on-error:`,
          ).toBeUndefined();
        }
      }
    }
    expect(seen).toBeGreaterThanOrEqual(2);
  });

  it("AIT-03.AC4 ci.yml build-and-test and release.yml build both carry the guard", () => {
    const ciGuard = steps(ci.jobs["build-and-test"]).some((s) => (s.run ?? "").includes(GUARD_COMMAND));
    const releaseGuard = steps(release.jobs["build"]).some((s) => (s.run ?? "").includes(GUARD_COMMAND));
    expect(ciGuard).toBe(true);
    expect(releaseGuard).toBe(true);
  });

  it("AIT-03.AC4 the release build job still installs with --ignore-scripts", () => {
    const install = steps(release.jobs["build"]).find((s) => (s.run ?? "").includes("npm ci"));
    expect(install?.run).toContain("npm ci --ignore-scripts");
  });

  it("AIT-03.AC4 the guard's pattern matches the package-manager-config class and nothing else", () => {
    const pattern = new RegExp(GUARD_PATTERN);
    for (const hit of [
      ".npmrc",
      "packages/a/.npmrc",
      ".yarnrc",
      ".yarnrc.yml",
      "sub/dir/.yarnrc.yml",
      ".pnpmfile.cjs",
      ".envrc",
    ]) {
      expect(pattern.test(hit), `${hit} should be caught by the guard`).toBe(true);
    }
    for (const miss of [
      "package.json",
      "src/npmrc.ts",
      "docs/npmrc-notes.md",
      ".env",
      ".npmrc.example",
      "not.envrc.bak",
    ]) {
      expect(pattern.test(miss), `${miss} should NOT be caught by the guard`).toBe(false);
    }
  });

  it("AIT-03.AC4 this tree tracks zero package-manager-config paths — the green reading", () => {
    const tracked = execFileSync("git", ["ls-files"], { cwd: REPO_ROOT, encoding: "utf8" })
      .split("\n")
      .filter((line) => new RegExp(GUARD_PATTERN).test(line));
    expect(tracked).toEqual([]);
  });
});
