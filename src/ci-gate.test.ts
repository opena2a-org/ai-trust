/**
 * `.github/workflows/ci.yml` — the shape of the fixed-name aggregate `gate`.
 *
 * This file exists because the property it pins is not observable from any
 * other test in this repository, and losing it silently is cheap: deleting one
 * job from a YAML file breaks no build, fails no compile, and turns a required
 * status check into a context that never reports. Branch protection then waits
 * forever for `gate` and every pull request is blocked — the failure mode is a
 * repository nobody can merge into, discovered by the first person who tries.
 *
 * The three things asserted here are one property, not three:
 *
 *   1. A job keyed `gate`, named `gate`, that needs `build-and-test` and runs
 *      `if: always()`. One name, produced on every run, whatever the matrix
 *      is — which is what branch protection can be pointed at. The cells
 *      cannot be: their check runs are named after the matrix value
 *      (`Node 20`, `Node 22`), so requiring them writes the supported Node
 *      versions into a protection rule only an admin can edit.
 *
 *   2. No `paths` (and no `paths-ignore`) on either trigger. This half is
 *      easy to lose and load-bearing. A workflow whose path filter does not
 *      match is never triggered at all: no run is created, so no check run of
 *      any name appears, and a job carrying `if: always()` inside that
 *      workflow reports nothing. Restoring `paths:` to `on.pull_request`
 *      would leave `gate` present, correct, and absent from exactly the pull
 *      requests it has to report on. So the filter's new home — the condition
 *      governing the `build-and-test` cells — is asserted too, in both of the
 *      places it is written.
 *
 *   3. The globs cover the two files that decide what the tests assert and
 *      what the gate is: `vitest.config.ts` selects which test files run, and
 *      `ci.yml` defines the gate itself. Neither was in the list at first, so
 *      a pull request touching either produced a green `gate` with zero cells
 *      run — uninformative while `gate` was advisory, and a false statement
 *      about testing once it is required. The list is written in three
 *      places (the `globs=` line of the `changes` job, the cells' `if:`, and
 *      `PATH_GLOBS` below), and the tests hold all three to the same six
 *      entries in the same order, so no one copy can drift silently.
 *
 * Parsed with `js-yaml`, which was already a devDependency (`scripts/
 * release-smoke-corpus.ts` uses it); this change adds no dependency. Note that
 * js-yaml 4 does NOT resolve the bare key `on` to boolean true the way YAML 1.1
 * would, so `workflow.on` is reachable by that name.
 */
import { describe, it, expect } from "vitest";
import { existsSync, readFileSync, readdirSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import yaml from "js-yaml";

const HERE = dirname(fileURLToPath(import.meta.url));
const WORKFLOWS_DIR = resolve(HERE, "..", ".github", "workflows");
const CI_PATH = join(WORKFLOWS_DIR, "ci.yml");

/**
 * The six globs, in the order `ci.yml` lists them. Spelled here so a change
 * to the workflow that drops or widens one of them has to change this file
 * too, in a diff a reviewer reads rather than a YAML edit they skim. The last
 * two are the files that decide what the tests run (`vitest.config.ts`) and
 * what the gate is (`ci.yml` itself); see item 3 above.
 */
const PATH_GLOBS = ["src/**", "package.json", "package-lock.json", "tsconfig.json", "vitest.config.ts", ".github/workflows/ci.yml"] as const;

/**
 * The `globs=` line of the `changes` job's `filter` step, exactly as `ci.yml`
 * has to spell it — whitespace inside the quotes and order included. A literal
 * rather than a join of `PATH_GLOBS`, so the workflow is held to this line
 * even if the constant above drifts, and the constant is held to it in turn.
 */
const GLOBS_LINE =
  "globs='src/** package.json package-lock.json tsconfig.json vitest.config.ts .github/workflows/ci.yml'";

/** The four values a needed job's `result` can take. */
const JOB_RESULTS = ["success", "failure", "cancelled", "skipped"] as const;

interface Step {
  id?: string;
  name?: string;
  uses?: string;
  run?: string;
  env?: Record<string, string>;
  with?: Record<string, unknown>;
  if?: unknown;
  "continue-on-error"?: unknown;
}

interface Job {
  name?: string;
  needs?: string | string[];
  if?: unknown;
  "runs-on"?: string;
  "continue-on-error"?: unknown;
  strategy?: { matrix?: Record<string, unknown> };
  steps?: Step[];
  outputs?: Record<string, string>;
  uses?: string;
}

interface Workflow {
  name?: string;
  on?: Record<string, { branches?: string[]; paths?: unknown; "paths-ignore"?: unknown }>;
  permissions?: unknown;
  jobs?: Record<string, Job>;
}

function loadWorkflow(path: string): Workflow {
  return (yaml.load(readFileSync(path, "utf8")) ?? {}) as Workflow;
}

/** `needs:` is a string when there is one and a list when there are several. */
function needsOf(job: Job | undefined): string[] {
  if (!job?.needs) return [];
  return Array.isArray(job.needs) ? job.needs : [job.needs];
}

/**
 * The globs the cells' `if:` names, in the order its `contains()` clauses
 * appear. One clause per glob, so a dropped entry is a dropped clause here and
 * not a substring some neighbouring clause still happens to match.
 */
function globsNamedByCondition(condition: string): string[] {
  const clause = /contains\(needs\.changes\.outputs\.matched, '([^']*)'\)/g;
  return [...condition.matchAll(clause)].map((match) => match[1]);
}

/** The lines of a workflow's text that declare a `globs=` list, trimmed. */
function globsLinesOf(raw: string): string[] {
  return raw
    .split("\n")
    .filter((line) => /^\s*globs='/.test(line))
    .map((line) => line.trim());
}

const ci = loadWorkflow(CI_PATH);
const jobs = ci.jobs ?? {};
const gate = jobs["gate"];
const cells = jobs["build-and-test"];

describe("ci.yml: the fixed-name aggregate `gate`", () => {
  // Guards the whole file against passing vacuously. Every assertion below
  // reads `ci`; if the workflow were missing, empty or unparseable, they would
  // all reduce to comparisons between two undefineds.
  it("QGF-117.AC4 parses the committed .github/workflows/ci.yml into a workflow with jobs", () => {
    expect(existsSync(CI_PATH), `${CI_PATH} does not exist`).toBe(true);
    expect(Object.keys(jobs).length).toBeGreaterThan(0);
    expect(Object.keys(jobs)).toContain("build-and-test");
  });

  it("QGF-117.AC1 declares a job keyed `gate` whose `name` is the literal `gate`", () => {
    expect(Object.keys(jobs)).toContain("gate");
    expect(gate?.name).toBe("gate");
  });

  it("QGF-117.AC1 `gate` needs `build-and-test` and carries `if: always()`", () => {
    expect(gate, "ci.yml declares no job keyed `gate`").toBeDefined();
    expect(needsOf(gate)).toContain("build-and-test");
    expect(gate?.if).toBe("always()");
  });

  it("QGF-117.AC1 `gate` is the one job whose check-run name never moves with the matrix", () => {
    expect(gate?.name).toBe("gate");
    expect(String(gate?.name)).not.toContain("matrix.");
    // The cells are the counter-example the aggregate exists for: their name
    // is a matrix value, so it is not a name protection can be pointed at.
    expect(String(cells?.name)).toContain("matrix.node-version");
  });

  it("QGF-117.AC2 neither `on.push` nor `on.pull_request` carries `paths` or `paths-ignore`", () => {
    for (const trigger of ["push", "pull_request"] as const) {
      const spec = ci.on?.[trigger];
      expect(spec, `on.${trigger} is missing`).toBeDefined();
      expect(spec?.paths, `on.${trigger} still carries a paths filter`).toBeUndefined();
      expect(
        spec?.["paths-ignore"],
        `on.${trigger} carries a paths-ignore filter`,
      ).toBeUndefined();
    }
  });

  it("QGF-117.AC2 both triggers still carry `branches: [main]`", () => {
    expect(ci.on?.push?.branches).toEqual(["main"]);
    expect(ci.on?.pull_request?.branches).toEqual(["main"]);
  });

  it("QGF-117.AC2 the path globs govern the cells, not the workflow", () => {
    expect(cells, "ci.yml declares no job keyed `build-and-test`").toBeDefined();
    // The cells are conditioned on a change-detection job they declare in
    // `needs:`, and the globs are named in their own `if:` — so the filter is
    // readable at the job it filters, without following a reference.
    expect(needsOf(cells)).toContain("changes");
    const condition = String(cells?.if ?? "");
    for (const glob of PATH_GLOBS) {
      expect(condition, `the cells' condition does not name ${glob}`).toContain(glob);
    }
  });

  it("QGF-117.AC2 the change-detection job matches exactly the same globs", () => {
    // The filter is one thing written in two languages: `case` patterns in the
    // `changes` job and `contains()` calls in the cells' `if:`. A silent
    // disagreement between them would leave the cells skipped on a change that
    // needed testing, and `gate` green over it.
    const filterStep = (jobs["changes"]?.steps ?? []).find((step) => step.id === "filter");
    expect(filterStep, "the `changes` job declares no step with id `filter`").toBeDefined();
    const declared = /globs='([^']*)'/.exec(String(filterStep?.run ?? ""));
    expect(declared, "the `filter` step declares no `globs=` list").not.toBeNull();
    expect(declared?.[1].trim().split(/\s+/)).toEqual([...PATH_GLOBS]);
  });

  it("QGF-117.AC3 `gate` names all four job results explicitly and none by default", () => {
    const steps = gate?.steps ?? [];
    const script = steps.map((step) => String(step.run ?? "")).join("\n");
    expect(script, "`gate` declares no step that runs anything").not.toBe("");
    for (const result of JOB_RESULTS) {
      expect(script, `\`gate\` never mentions the result \`${result}\``).toContain(result);
    }

    // Both needed jobs are read, so a `changes` failure cannot reach `gate` as
    // a skipped cell and be counted a pass. The results arrive through `env:`
    // rather than interpolated into the script body, so look there too.
    const wiring = steps.flatMap((step) => Object.values(step.env ?? {})).join("\n");
    expect(`${script}\n${wiring}`).toContain("needs.changes.result");
    expect(`${script}\n${wiring}`).toContain("needs['build-and-test'].result");
  });

  it("QGF-117.AC3 nothing in ci.yml lets a red cell reach `gate` as anything else", () => {
    const raw = readFileSync(CI_PATH, "utf8");
    expect(raw).not.toMatch(/continue-on-error/);
    expect(raw).not.toMatch(/if:\s*false\b/);
  });

  it("QGF-117.AC5 the cells keep their runner, their matrix and their four commands", () => {
    expect(cells?.["runs-on"]).toBe("ubuntu-latest");
    expect(cells?.strategy?.matrix?.["node-version"]).toEqual([20, 22]);

    const steps = cells?.steps ?? [];
    expect(steps.map((step) => step.uses)).toEqual(
      expect.arrayContaining(["actions/checkout@v4", "actions/setup-node@v4"]),
    );
    const setupNode = steps.find((step) => step.uses === "actions/setup-node@v4");
    expect(setupNode?.with?.["cache"]).toBe("npm");
    expect(steps.map((step) => step.run).filter(Boolean)).toEqual([
      "npm ci",
      "npm run build",
      "npm test",
      "npm run lint",
    ]);
  });

  it("QGF-117.AC5 `permissions` still reads exactly `contents: read`", () => {
    expect(ci.permissions).toEqual({ contents: "read" });
  });

  it("QGF-117.AC5 `gate` runs no action and asks for no repository contents", () => {
    const steps = gate?.steps ?? [];
    expect(steps.length).toBeGreaterThan(0);
    expect(steps.filter((step) => step.uses)).toEqual([]);
  });

  it("QGF-117.AC6 the name `gate` resolves to exactly one job in .github/workflows", () => {
    const files = readdirSync(WORKFLOWS_DIR).filter((f) => /\.ya?ml$/.test(f));
    expect(files).toContain("ci.yml");

    const owners: string[] = [];
    for (const file of files) {
      const workflow = loadWorkflow(join(WORKFLOWS_DIR, file));
      for (const [key, job] of Object.entries(workflow.jobs ?? {})) {
        if (key === "gate" || job?.name === "gate") owners.push(`${file}:${key}`);
      }
    }
    expect(owners).toEqual(["ci.yml:gate"]);
  });
});

describe("ci.yml: the path filter covers the files that decide what the tests run", () => {
  // `vitest.config.ts` selects which test files run and `ci.yml` defines the
  // gate itself. While either sat outside the globs, a change to it skipped
  // every cell and `gate` reported a pass over a run that tested nothing. The
  // filter is one thing written in three places — the `globs=` line of the
  // `changes` job, the cells' `if:`, and `PATH_GLOBS` above — and the cells
  // below hold each place to the same six entries in the same order.
  const raw = readFileSync(CI_PATH, "utf8");
  const filterStep = (jobs["changes"]?.steps ?? []).find((step) => step.id === "filter");
  const filterScript = String(filterStep?.run ?? "");
  const condition = String(cells?.if ?? "");

  it("AIT-05.AC1 the `filter` step declares its globs as exactly the six-entry line", () => {
    // The raw text, so whitespace inside the quotes and the order count, and
    // so a second `globs=` line anywhere in the file is a failure, not a tie.
    expect(globsLinesOf(raw)).toEqual([GLOBS_LINE]);
    // And through the parser, so the line YAML delivers to the step is the
    // one the file shows.
    expect(filterScript).toContain(GLOBS_LINE);
  });

  it("AIT-05.AC2 the cells' `if:` names all six globs, each in its own contains() clause", () => {
    expect(globsNamedByCondition(condition)).toEqual([...PATH_GLOBS]);
    for (const glob of ["vitest.config.ts", ".github/workflows/ci.yml"]) {
      expect(condition).toContain(`contains(needs.changes.outputs.matched, '${glob}')`);
    }
  });

  it("AIT-05.AC3 PATH_GLOBS is the six entries of the globs= line, in the same order", () => {
    const declared = /^globs='([^']*)'$/.exec(GLOBS_LINE);
    expect(declared).not.toBeNull();
    expect([...PATH_GLOBS]).toEqual(declared?.[1].split(" "));
    expect(PATH_GLOBS).toHaveLength(6);
  });

  it("AIT-05.AC5 the three copies of the filter cannot disagree silently", () => {
    // The planted-fault cell. Returning `PATH_GLOBS` to its four-entry form,
    // or deleting the two new clauses from the cells' `if:`, has to fail here
    // (and in the cells above), never pass by omission.
    const declared = /globs='([^']*)'/.exec(filterScript);
    expect(declared, "the `filter` step declares no `globs=` list").not.toBeNull();
    const fromFilter = declared?.[1].trim().split(/\s+/);
    const fromCondition = globsNamedByCondition(condition);
    expect(fromFilter).toEqual([...PATH_GLOBS]);
    expect(fromCondition).toEqual([...PATH_GLOBS]);
    expect(fromCondition).toEqual(fromFilter);
  });
});
