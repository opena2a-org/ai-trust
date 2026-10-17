/**
 * The consumer-resolution gate fails on a deprecated package in the tree a
 * user resolves.
 *
 * The published `ai-trust@0.7.6` pinned `hackmyagent@0.23.11`, deprecated by
 * its publisher with a four-line notice, and resolved a second deprecated
 * copy, `hackmyagent@0.17.11`, under it. A clean install printed eight
 * `npm warn deprecated` lines before ai-trust printed anything, and the gate
 * had nothing to say about them: it checked advisories and nested copies,
 * never the notice itself. The pin has since moved to a version without a
 * notice; this suite makes the gate refuse the next one.
 *
 * `scripts/audit-consumer-resolution.mjs` ends in a bare `main();`, which
 * performs a network install, so it is not importable here. The decision
 * lives in `scripts/lib/deprecated-resolutions.mjs` and is exercised below on
 * a lockfile shaped like the one npm wrote for `0.7.6` and on the stderr that
 * install printed. The gate's source is then read as text to confirm it calls
 * that decision and feeds its failures into its own, the way `ci-gate.test.ts`
 * reads a workflow it cannot run.
 */
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import {
  deprecatedResolutions,
  deprecationWarnings,
  judgeDeprecations,
  packageNameOf,
} from "../scripts/lib/deprecated-resolutions.mjs";

const ROOT = resolve(__dirname, "..");
const GATE_PATH = "scripts/audit-consumer-resolution.mjs";
const GATE = readFileSync(resolve(ROOT, GATE_PATH), "utf8");

/** The notice on `hackmyagent@0.23.11` and `0.17.11`, shortened to two lines, as npm records it. */
const NOTICE = "scored benign text 0% at exit 0 (issue 369).\n  0.26.0 removes that score.";

/** The lockfile npm wrote for a clean install of ai-trust@0.7.6, cut to the entries that matter. */
const PUBLISHED_LOCK = {
  name: "consumer-resolution-probe",
  version: "1.0.0",
  lockfileVersion: 3,
  requires: true,
  packages: {
    "": { name: "consumer-resolution-probe", version: "1.0.0", dependencies: { "ai-trust": "0.7.6" } },
    "node_modules/ai-trust": { version: "0.7.6", dependencies: { hackmyagent: "0.23.11" } },
    "node_modules/hackmyagent": { version: "0.23.11", deprecated: NOTICE, dependencies: { "ai-trust": "^0.2.6" } },
    "node_modules/hackmyagent/node_modules/hackmyagent": { version: "0.17.11", deprecated: NOTICE },
    "node_modules/@opena2a/shared": { version: "0.1.2" },
  },
};

/** What that install printed on stderr, with the notice shortened the same way. */
const PUBLISHED_STDERR = [
  "npm warn deprecated hackmyagent@0.17.11: scored benign text 0% at exit 0 (issue 369).",
  "npm warn deprecated   0.26.0 removes that score. Still live",
  "npm warn deprecated   in 0.26.0: attack reports SECURE for a target it never reached (#406); check --json exits 0 on",
  "npm warn deprecated   critical findings (#373).",
  "npm warn deprecated hackmyagent@0.23.11: scored benign text 0% at exit 0 (issue 369).",
  "npm warn deprecated   0.26.0 removes that score. Still live",
  "npm warn deprecated   in 0.26.0: attack reports SECURE for a target it never reached (#406); check --json exits 0 on",
  "npm warn deprecated   critical findings (#373).",
  "",
  "added 133 packages in 12s",
  "",
].join("\n");

const CLEAN_LOCK = {
  packages: {
    "": { name: "consumer-resolution-probe", version: "1.0.0", dependencies: { "ai-trust": "0.7.7" } },
    "node_modules/ai-trust": { version: "0.7.7", dependencies: { hackmyagent: "0.33.2" } },
    "node_modules/hackmyagent": { version: "0.33.2" },
  },
};

const NOTHING_WARNED = { lines: 0, packages: [] };

describe("packageNameOf", () => {
  it("names the package a lockfile path ends in, nested or scoped", () => {
    expect(packageNameOf("node_modules/hackmyagent")).toBe("hackmyagent");
    expect(packageNameOf("node_modules/hackmyagent/node_modules/hackmyagent")).toBe("hackmyagent");
    expect(packageNameOf("node_modules/@opena2a/shared")).toBe("@opena2a/shared");
  });
});

describe("deprecatedResolutions", () => {
  it("lists each entry whose lockfile record carries a notice, with its path and version", () => {
    expect(deprecatedResolutions(PUBLISHED_LOCK)).toEqual([
      { path: "node_modules/hackmyagent", name: "hackmyagent", version: "0.23.11", notice: NOTICE },
      {
        path: "node_modules/hackmyagent/node_modules/hackmyagent",
        name: "hackmyagent",
        version: "0.17.11",
        notice: NOTICE,
      },
    ]);
  });

  it("finds nothing in a tree without a notice", () => {
    expect(deprecatedResolutions(CLEAN_LOCK)).toEqual([]);
    expect(deprecatedResolutions({})).toEqual([]);
  });

  it("skips the root and an empty notice, and names an aliased package by its real name", () => {
    const lock = {
      packages: {
        "": { name: "consumer-resolution-probe", version: "1.0.0", deprecated: "the probe itself" },
        "node_modules/left": { version: "1.0.0", deprecated: "" },
        "node_modules/right": { version: "1.0.0", deprecated: "   " },
        "node_modules/string-width-cjs": { name: "string-width", version: "4.2.3", deprecated: "use string-width" },
      },
    };
    expect(deprecatedResolutions(lock)).toEqual([
      { path: "node_modules/string-width-cjs", name: "string-width", version: "4.2.3", notice: "use string-width" },
    ]);
  });
});

describe("deprecationWarnings", () => {
  it("counts the lines a user reads and names each package once", () => {
    expect(deprecationWarnings(PUBLISHED_STDERR)).toEqual({
      lines: 8,
      packages: [
        { name: "hackmyagent", version: "0.17.11" },
        { name: "hackmyagent", version: "0.23.11" },
      ],
    });
  });

  it("reads a scoped package, an upper-case WARN, a pre-release version and a repeated notice", () => {
    const stderr = [
      "npm WARN deprecated @scope/pkg@1.0.0: moved to @scope/pkg2",
      "npm warn deprecated @scope/pkg@1.0.0: moved to @scope/pkg2",
      "npm warn deprecated plain@2.0.0-rc.1: gone",
    ].join("\n");
    expect(deprecationWarnings(stderr)).toEqual({
      lines: 3,
      packages: [
        { name: "@scope/pkg", version: "1.0.0" },
        { name: "plain", version: "2.0.0-rc.1" },
      ],
    });
  });

  it("counts nothing in stderr without a deprecation line", () => {
    const stderr = "npm warn install-scripts   onnxruntime-node@1.30.0 (postinstall: node ./script/install)\nadded 133 packages in 12s\n";
    expect(deprecationWarnings(stderr)).toEqual(NOTHING_WARNED);
    expect(deprecationWarnings("")).toEqual(NOTHING_WARNED);
    expect(deprecationWarnings(undefined)).toEqual(NOTHING_WARNED);
  });
});

describe("judgeDeprecations", () => {
  const TODAY = "2026-10-17";
  const found = deprecatedResolutions(PUBLISHED_LOCK);
  const warned = deprecationWarnings(PUBLISHED_STDERR);
  const judge = (overrides: Partial<Parameters<typeof judgeDeprecations>[0]>) =>
    judgeDeprecations({ found, warned, waivers: [], today: TODAY, scriptRef: GATE_PATH, ...overrides });

  it("passes a tree with no notice and nothing warned", () => {
    expect(judge({ found: [], warned: NOTHING_WARNED })).toEqual({ failures: [], log: [] });
  });

  it("fails the 0.7.6 tree once per package, naming each copy, the notice and the npm view command", () => {
    const { failures, log } = judge({});
    expect(log).toEqual([]);
    expect(failures).toHaveLength(1);
    expect(failures[0]).toContain(
      "Deprecated package in the consumer tree: `hackmyagent` 0.23.11 at node_modules/hackmyagent, " +
        "0.17.11 at node_modules/hackmyagent/node_modules/hackmyagent.",
    );
    expect(failures[0]).toContain('"scored benign text 0% at exit 0 (issue 369)."');
    expect(failures[0]).toContain("`npm view hackmyagent@0.23.11 deprecated`");
    expect(failures[0]).toContain(`DEPRECATION_WAIVERS in ${GATE_PATH}`);
  });

  it("judges a package npm warned about that the lockfile does not record", () => {
    const { failures } = judge({ found: [], warned: { lines: 4, packages: [{ name: "left-pad", version: "1.3.0" }] } });
    expect(failures).toHaveLength(1);
    expect(failures[0]).toContain("`left-pad` 1.3.0 (warned on install, not in the lockfile)");
    expect(failures[0]).toContain("`npm view left-pad@1.3.0 deprecated`");
  });

  it("allows a waiver that names every copy's version and is in date, and logs it", () => {
    const waiver = {
      name: "hackmyagent",
      versions: ["0.23.11", "0.17.11"],
      reason: "upstream has no release without the notice",
      reviewBy: "2026-12-31",
    };
    expect(judge({ waivers: [waiver] })).toEqual({
      failures: [],
      log: [
        "  allowed  deprecated hackmyagent  (review by 2026-12-31)",
        "           present: 0.23.11 at node_modules/hackmyagent, 0.17.11 at node_modules/hackmyagent/node_modules/hackmyagent",
        "           upstream has no release without the notice",
        "",
      ],
    });
  });

  it("fails a copy at a version the waiver does not name", () => {
    const waiver = { name: "hackmyagent", versions: ["0.23.11"], reason: "a reason", reviewBy: "2026-12-31" };
    const { failures, log } = judge({ waivers: [waiver] });
    expect(log).toEqual([]);
    expect(failures).toHaveLength(1);
    expect(failures[0]).toContain(
      "Deprecated `hackmyagent` at a version its waiver does not cover: " +
        "0.17.11 at node_modules/hackmyagent/node_modules/hackmyagent. Waived versions are [0.23.11].",
    );
  });

  it("fails a waiver past its review date", () => {
    const waiver = { name: "hackmyagent", versions: ["0.23.11", "0.17.11"], reason: "a reason", reviewBy: "2026-10-16" };
    const { failures, log } = judge({ waivers: [waiver] });
    expect(log).toEqual([]);
    expect(failures).toEqual([
      expect.stringContaining("Deprecation waiver for `hackmyagent` passed its review date 2026-10-16."),
    ]);
  });

  it("fails a waiver that matches nothing", () => {
    const waiver = { name: "hackmyagent", versions: ["0.23.11"], reason: "a reason", reviewBy: "2026-12-31" };
    const { failures, log } = judge({ found: [], warned: NOTHING_WARNED, waivers: [waiver] });
    expect(log).toEqual([]);
    expect(failures).toEqual([
      expect.stringContaining("Stale deprecation waiver: no deprecated `hackmyagent` is in the consumer tree any more."),
    ]);
  });
});

describe("the gate", () => {
  // Read as text, because the script is not importable (see the header). Each
  // line asserted here is one the check cannot work without.
  it("imports the decision and feeds its failures into its own", () => {
    expect(GATE).toContain("from './lib/deprecated-resolutions.mjs'");
    expect(GATE).toContain("deprecatedResolutions(lock)");
    expect(GATE).toContain("deprecationWarnings(installStderr)");
    expect(GATE).toContain("waivers: DEPRECATION_WAIVERS,");
    expect(GATE).toContain("failures.push(...deprecation.failures)");
  });

  it("captures the probe install's stderr, where npm prints the notice", () => {
    expect(GATE).toMatch(/const install = spawnSync\(\s*'npm',\s*\['install'/);
    expect(GATE).toContain("const installStderr = install.stderr ?? ''");
    expect(GATE).toContain("return { report, lock, counts, liveness, installStderr }");
  });
});

describe("this repository's lockfile", () => {
  it("records no deprecation notice", () => {
    const lock = JSON.parse(readFileSync(resolve(ROOT, "package-lock.json"), "utf8"));
    expect(deprecatedResolutions(lock)).toEqual([]);
  });
});
