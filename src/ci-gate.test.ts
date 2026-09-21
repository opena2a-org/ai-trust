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
 * The two things asserted here are one property, not two:
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
 * The aggregate's result mapping is then checked by running it, not by reading
 * it. The `gate` step's script is taken from the parsed YAML — the very text CI
 * hands to bash — and executed under `bash -c` for all 25 combinations of the
 * two needed jobs' results, asserting the process exit status of each. Two
 * faults are then planted in that text, in memory only (a red cell reported as
 * green; an unrecognised result failing open), and shown to flip exactly the
 * rows they should: a positive control that the executing check is live. A
 * check that merely looked for the four result words in the script would pass
 * both faults, and did.
 *
 * Parsed with `js-yaml`, which was already a devDependency (`scripts/
 * release-smoke-corpus.ts` uses it); this change adds no dependency. Note that
 * js-yaml 4 does NOT resolve the bare key `on` to boolean true the way YAML 1.1
 * would, so `workflow.on` is reachable by that name.
 */
import { describe, it, expect } from "vitest";
import { spawnSync } from "node:child_process";
import { existsSync, readFileSync, readdirSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import yaml from "js-yaml";

const HERE = dirname(fileURLToPath(import.meta.url));
const WORKFLOWS_DIR = resolve(HERE, "..", ".github", "workflows");
const CI_PATH = join(WORKFLOWS_DIR, "ci.yml");

/**
 * The four globs, in the order `ci.yml` lists them. Spelled here so a change
 * to the workflow that drops or widens one of them has to change this file
 * too, in a diff a reviewer reads rather than a YAML edit they skim.
 */
const PATH_GLOBS = ["src/**", "package.json", "package-lock.json", "tsconfig.json"] as const;

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

  it("QGF-117.AC2 the four path globs govern the cells, not the workflow", () => {
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

  it("QGF-117.AC2 the change-detection job matches exactly the same four globs", () => {
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

/**
 * Every value a needed job's `result` can carry today, plus one it cannot yet:
 * `some-future-result` stands for whatever GitHub adds next, and the aggregate
 * has to fail closed on it rather than pass it by default.
 */
const GATE_RESULTS = ["success", "skipped", "failure", "cancelled", "some-future-result"] as const;
type GateResult = (typeof GATE_RESULTS)[number];

/** A process exit status the `gate` step's script may end with. */
type ExitStatus = 0 | 1;

interface GateRow {
  changes: GateResult;
  cells: GateResult;
  expected: ExitStatus;
}

/**
 * The aggregate's result mapping as a table of asserted exit statuses: 0
 * exactly when both results are in {success, skipped}, 1 otherwise. Spelled out
 * row by row rather than derived from that rule, so the table is the
 * specification a reviewer reads, and a change to the mapping has to change it
 * here, in a diff.
 */
const GATE_TRUTH_TABLE: readonly GateRow[] = [
  { changes: "success", cells: "success", expected: 0 },
  { changes: "success", cells: "skipped", expected: 0 },
  { changes: "success", cells: "failure", expected: 1 },
  { changes: "success", cells: "cancelled", expected: 1 },
  { changes: "success", cells: "some-future-result", expected: 1 },
  { changes: "skipped", cells: "success", expected: 0 },
  { changes: "skipped", cells: "skipped", expected: 0 },
  { changes: "skipped", cells: "failure", expected: 1 },
  { changes: "skipped", cells: "cancelled", expected: 1 },
  { changes: "skipped", cells: "some-future-result", expected: 1 },
  { changes: "failure", cells: "success", expected: 1 },
  { changes: "failure", cells: "skipped", expected: 1 },
  { changes: "failure", cells: "failure", expected: 1 },
  { changes: "failure", cells: "cancelled", expected: 1 },
  { changes: "failure", cells: "some-future-result", expected: 1 },
  { changes: "cancelled", cells: "success", expected: 1 },
  { changes: "cancelled", cells: "skipped", expected: 1 },
  { changes: "cancelled", cells: "failure", expected: 1 },
  { changes: "cancelled", cells: "cancelled", expected: 1 },
  { changes: "cancelled", cells: "some-future-result", expected: 1 },
  { changes: "some-future-result", cells: "success", expected: 1 },
  { changes: "some-future-result", cells: "skipped", expected: 1 },
  { changes: "some-future-result", cells: "failure", expected: 1 },
  { changes: "some-future-result", cells: "cancelled", expected: 1 },
  { changes: "some-future-result", cells: "some-future-result", expected: 1 },
];

/**
 * The one `gate` step that runs a script. Its `run:` text is what CI hands to
 * bash, so it is what the cases below execute: taken from the parsed YAML and
 * never copied into this file, so it cannot drift from what CI runs.
 */
const gateRunSteps = (gate?.steps ?? []).filter((step) => typeof step.run === "string");
const gateStep: Step | undefined = gateRunSteps[0];
const gateScript = String(gateStep?.run ?? "");

/**
 * Runs the `gate` step's script the way its job does: under `bash -c`, with the
 * two results arriving through the environment and nothing else in it, and
 * answers with the process exit status.
 */
function runGate(script: string, results: { changes: string; cells: string }): number {
  const child = spawnSync("bash", ["-c", script], {
    env: { PATH: process.env.PATH ?? "", CHANGES_RESULT: results.changes, CELLS_RESULT: results.cells },
    encoding: "utf8",
  });
  if (child.error) throw child.error;
  if (child.status === null) throw new Error(`the gate script was killed by ${child.signal}`);
  return child.status;
}

/**
 * Plants a fault in the script, in memory only: on the line two below the line
 * whose trimmed text is `anchor`, `status=1` becomes `status=0`. It throws when
 * the anchor is missing or the assignment is not where the script keeps it, so
 * a restructured script fails the fault cases instead of passing them vacuously.
 */
function plantFault(script: string, anchor: string): string {
  const lines = script.split("\n");
  const at = lines.findIndex((line) => line.trim() === anchor);
  if (at < 0) throw new Error(`no line of the gate script reads \`${anchor}\``);
  const target = lines[at + 2];
  if (target === undefined || !target.includes("status=1")) {
    throw new Error(`the line two below \`${anchor}\` does not set status=1: ${JSON.stringify(target)}`);
  }
  lines[at + 2] = target.replace("status=1", "status=0");
  return lines.join("\n");
}

function rowKey(row: { changes: string; cells: string }): string {
  return `${row.changes}/${row.cells}`;
}

describe("ci.yml: the `gate` aggregate's script, executed", () => {
  it("AIT-04.AC1 `gate` runs exactly one script, fed exactly CHANGES_RESULT and CELLS_RESULT", () => {
    expect(gateRunSteps, "`gate` must declare exactly one step with a `run:` script").toHaveLength(1);
    const env = gateStep?.env ?? {};
    expect(Object.keys(env).sort()).toEqual(["CELLS_RESULT", "CHANGES_RESULT"]);
    expect(env["CHANGES_RESULT"]).toContain("needs.changes.result");
    expect(env["CELLS_RESULT"]).toContain("needs['build-and-test'].result");
  });

  it("AIT-04.AC1 the truth table is the full product of the five results, each pair once", () => {
    expect(GATE_TRUTH_TABLE).toHaveLength(25);
    const keys = new Set(GATE_TRUTH_TABLE.map(rowKey));
    expect(keys.size).toBe(25);
    for (const changes of GATE_RESULTS) {
      for (const cells of GATE_RESULTS) {
        expect(keys.has(rowKey({ changes, cells })), `the table has no row for ${changes}/${cells}`).toBe(true);
      }
    }
  });

  for (const row of GATE_TRUTH_TABLE) {
    it(`AIT-04.AC1 exits ${row.expected} when changes=${row.changes} and build-and-test=${row.cells}`, () => {
      expect(gateScript, "`gate` declares no step with a `run:` script").not.toBe("");
      expect(runGate(gateScript, row)).toBe(row.expected);
    });
  }

  /**
   * The rows each planted fault turns green, measured rather than reasoned
   * about. The script folds both results into one `status` in order, so the
   * branch taken for `build-and-test` overwrites whatever `changes` set: a
   * branch faulted to `status=0` reaches the exit when it runs last, or when it
   * runs first and a passing branch follows. Seven rows each, every one a row
   * the table says must exit 1.
   */
  const FAULT_A_GREEN: readonly string[] = [
    "success/failure",
    "skipped/failure",
    "failure/success",
    "failure/skipped",
    "failure/failure",
    "cancelled/failure",
    "some-future-result/failure",
  ];
  const FAULT_B_GREEN: readonly string[] = [
    "success/some-future-result",
    "skipped/some-future-result",
    "failure/some-future-result",
    "cancelled/some-future-result",
    "some-future-result/success",
    "some-future-result/skipped",
    "some-future-result/some-future-result",
  ];

  /** Re-runs the whole table on a mutant and pins exactly which rows it lets through. */
  function expectFaultToTurnGreenExactly(mutant: string, green: readonly string[]): void {
    expect(mutant, "the fault changed nothing").not.toBe(gateScript);
    const flipped: string[] = [];
    for (const row of GATE_TRUTH_TABLE) {
      const key = rowKey(row);
      const status = runGate(mutant, row);
      if (green.includes(key)) {
        expect(row.expected, `${key} is not a row the table says must fail`).toBe(1);
        expect(status, `the fault should let ${key} through as green`).toBe(0);
      } else {
        expect(status, `the fault must not change the verdict for ${key}`).toBe(row.expected);
      }
      if (status !== row.expected) flipped.push(key);
    }
    expect([...flipped].sort()).toEqual([...green].sort());
    expect(flipped).toHaveLength(7);
  }

  it("AIT-04.AC2 fault A, the `failure)` branch set to status=0, turns exactly 7 rows green", () => {
    expectFaultToTurnGreenExactly(plantFault(gateScript, "failure)"), FAULT_A_GREEN);
  });

  it("AIT-04.AC2 fault B, the catch-all `*)` set to status=0, turns exactly 7 rows green", () => {
    expectFaultToTurnGreenExactly(plantFault(gateScript, "*)"), FAULT_B_GREEN);
  });

  it("AIT-04.AC2 a fault whose anchor line is absent fails the case instead of passing vacuously", () => {
    expect(() => plantFault(gateScript, "some-future-result)")).toThrow(/no line of the gate script reads/);
    expect(() => plantFault("failure)\n\n\n", "failure)")).toThrow(/does not set status=1/);
  });
});

describe("ci.yml: the change filter's `case` pattern", () => {
  it("AIT-04.AC3 `$glob)` stays unquoted, with the SC2254 directive and its reason directly above the `case`", () => {
    const filterStep = (jobs["changes"]?.steps ?? []).find((step) => step.id === "filter");
    expect(filterStep, "the `changes` job declares no step with id `filter`").toBeDefined();
    const lines = String(filterStep?.run ?? "")
      .split("\n")
      .map((line) => line.trim());
    const caseAt = lines.indexOf('case "$file" in');
    expect(caseAt, 'the `filter` step has no `case "$file" in`').toBeGreaterThan(2);
    // Quoting the pattern is the obvious "fix" for SC2254, and it would make
    // every glob match literally: no changed file is named `src/**`, so a
    // source-only change would match nothing, the cells would be skipped and
    // `gate` would go green over untested code. The directive silences the
    // warning where it is raised; the two comment lines say why it is wrong.
    expect(lines[caseAt - 1], "the line above the `case` is not the SC2254 directive").toBe(
      "# shellcheck disable=SC2254",
    );
    expect(lines[caseAt - 2], "the reason's second line is not directly above the directive").toBe(
      "# patterns match `/` with `*`, so `src/**` covers `src/a/b.ts`.",
    );
    expect(lines[caseAt - 3], "the reason's first line is not directly above its second").toBe(
      "# `$glob` is unquoted on purpose: it is the pattern. `case`",
    );
    expect(lines[caseAt + 1], "the pattern line is not the bare, unquoted `$glob)`").toBe("$glob)");
    const raw = readFileSync(CI_PATH, "utf8");
    expect(raw).not.toContain('"$glob")');
    expect(raw).not.toContain("'$glob')");
  });
});
