/**
 * scripts/release-artifact-review.mjs, exercised RED FIRST, one poisoned
 * tarball per check.
 *
 * A gate is only worth its runtime if it has been seen to fail. So every class
 * the script claims to catch gets a tarball that carries exactly that defect
 * and nothing else, and the assertion is not merely "non-zero" — it is that
 * the census names THAT check as the failing one and no other. A script that
 * failed everything would pass a weaker test and catch nothing.
 *
 * The tarballs are built here with a ~40-line ustar writer rather than by
 * shelling out to `tar` or `npm pack`. Both of those normalise: `npm pack`
 * will not put a dotfile in a tarball for you, which is precisely the fixture
 * needed. Hand-writing the archive is the only way to produce the artifact a
 * compromised or misconfigured packer would produce.
 *
 * Covers AIT-03.AC2 (the checks and the census) and AIT-03.AC3 (red per check,
 * then green on the delivered tree).
 */
import { describe, it, expect } from "vitest";
import { spawnSync } from "node:child_process";
import { gzipSync } from "node:zlib";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

const REPO_ROOT = resolve(__dirname, "..", "..");
const SCRIPT = resolve(REPO_ROOT, "scripts", "release-artifact-review.mjs");
const BUILT_CLI = resolve(REPO_ROOT, "dist", "index.js");

/**
 * The census contract: these names, in this order, on every run whatever the
 * outcome. Hardcoded here rather than read back out of the script, because a
 * check quietly disappearing from the census is one of the failures this
 * suite exists to catch, and a test that reads its expectation from the thing
 * under test cannot catch it.
 */
const DECLARED_CHECKS = [
  "entry-allowlist",
  "no-dotfiles",
  "no-test-material",
  "no-install-scripts",
  "pinned-first-party-deps",
  "global-install-smoke",
  "dependency-advisories",
  "credential-scan",
  "consumer-closure",
];

/** The checks that may honestly report `precondition` (each exits non-zero). */
const PRECONDITION_CAPABLE = [
  "global-install-smoke",
  "dependency-advisories",
  "credential-scan",
  "consumer-closure",
];

/**
 * The checks whose verdict needs no network reading (AIT-03.AC3): on the
 * tarball packed from this tree, every one of these must be `pass`.
 * `global-install-smoke` is in the list because its measurement is offline —
 * but installing THIS package's closure does need a registry, so a run with
 * no network reports it as a precondition, which the lenient branch below
 * tolerates and the strict branch does not.
 */
const NETWORK_FREE_CHECKS = [
  "entry-allowlist",
  "no-dotfiles",
  "no-test-material",
  "no-install-scripts",
  "pinned-first-party-deps",
  "global-install-smoke",
  "credential-scan",
];

/** The checks whose verdict genuinely reads the network. */
const NETWORK_READING_CHECKS = ["global-install-smoke", "dependency-advisories", "consumer-closure"];

/**
 * PROVISIONAL — see qgf/refs/rev2-provisional-ci-clause-note.md. AC3's
 * sentence "under CI=true or GITHUB_ACTIONS=true a precondition ... is a test
 * failure, never a skip" collides with HMA-18's no-CI-reads-in-tests
 * meta-gate, and the CISO is ruling on that one sentence. This repo carries
 * no such meta-gate, so the CI read is kept — but isolated HERE, in one
 * helper, so the pending amendment (either direction) is a one-line change.
 * When strict, a network-dependent check reporting `precondition` fails the
 * suite; when lenient (a developer machine with no network), it is tolerated
 * on the network-reading checks only, and loudly logged, never silent.
 */
function strictNetworkAssertions(): boolean {
  return process.env.CI === "true" || process.env.GITHUB_ACTIONS === "true";
}

/**
 * The control's class, assembled at runtime from parts so this repository
 * never contains a credential-shaped literal (the assembled form only ever
 * exists inside tarballs built into the suite's temp directory).
 */
function controlClassValue(): string {
  return ["sk-", "proj-"].join("") + "A".repeat(48);
}

// ---------------------------------------------------------------------------
// a minimal ustar writer
// ---------------------------------------------------------------------------

function tarHeader(name: string, size: number): Buffer {
  const header = Buffer.alloc(512);
  header.write(name, 0, 100, "utf8");
  header.write("0000644\0", 100, 8);
  header.write("0000000\0", 108, 8);
  header.write("0000000\0", 116, 8);
  header.write(size.toString(8).padStart(11, "0") + "\0", 124, 12);
  header.write("00000000000\0", 136, 12);
  header.write("        ", 148, 8); // checksum field is spaces while summing
  header.write("0", 156, 1); // regular file
  header.write("ustar\0", 257, 6);
  header.write("00", 263, 2);
  let sum = 0;
  for (const byte of header) sum += byte;
  header.write(sum.toString(8).padStart(6, "0") + "\0 ", 148, 8);
  return header;
}

function writeTarball(outPath: string, files: Record<string, string>): string {
  const blocks: Buffer[] = [];
  for (const [name, content] of Object.entries(files)) {
    const body = Buffer.from(content, "utf8");
    blocks.push(tarHeader(name, body.length), body);
    const padding = (512 - (body.length % 512)) % 512;
    if (padding) blocks.push(Buffer.alloc(padding));
  }
  blocks.push(Buffer.alloc(1024)); // two zero blocks close the archive
  writeFileSync(outPath, gzipSync(Buffer.concat(blocks)));
  return outPath;
}

// ---------------------------------------------------------------------------
// fixtures
// ---------------------------------------------------------------------------

const WORKING_CLI = '#!/usr/bin/env node\nconsole.log("ait03-review-fixture 1.0.0");\n';

interface FixtureOptions {
  manifest?: Record<string, unknown>;
  index?: string;
  extra?: Record<string, string>;
}

/**
 * A tarball that passes every static check, so a fixture differs from clean in
 * exactly one way. Dependency-free on purpose: `npm install -g <tarball>`
 * then needs no registry, so the smoke check measures the CLI rather than the
 * runner's network.
 */
function fixture(options: FixtureOptions = {}): Record<string, string> {
  const manifest = {
    name: "ait03-review-fixture",
    version: "1.0.0",
    bin: { "ait03-review-fixture": "dist/index.js" },
    files: ["dist", "README.md"],
    ...options.manifest,
  };
  return {
    "package/package.json": JSON.stringify(manifest, null, 2) + "\n",
    "package/README.md": "# ait03-review-fixture\n",
    "package/LICENSE": "Apache-2.0\n",
    "package/dist/index.js": options.index ?? WORKING_CLI,
    ...options.extra,
  };
}

// ---------------------------------------------------------------------------
// running the script
// ---------------------------------------------------------------------------

interface Review {
  status: number;
  output: string;
  census: Map<string, string>;
}

function review(tarball: string): Review {
  const run = spawnSync(process.execPath, [SCRIPT, "--tarball", tarball], {
    encoding: "utf8",
    cwd: REPO_ROOT,
    timeout: 20 * 60 * 1000,
    maxBuffer: 64 * 1024 * 1024,
  });
  const output = `${run.stdout ?? ""}${run.stderr ?? ""}`;
  const line = output.split("\n").find((l) => l.startsWith("census: "));
  const census = new Map<string, string>();
  for (const pair of (line ?? "").replace("census: ", "").trim().split(/\s+/)) {
    const [name, status] = pair.split("=");
    if (name) census.set(name, status);
  }
  return { status: run.status ?? -1, output, census };
}

function failing(result: Review): string[] {
  return [...result.census.entries()].filter(([, status]) => status === "fail").map(([name]) => name);
}

function blocked(result: Review): string[] {
  return [...result.census.entries()].filter(([, status]) => status === "precondition").map(([name]) => name);
}

/** One scratch directory for the whole suite; every tarball is built into it. */
const scratch = mkdtempSync(join(tmpdir(), "ait03-review-tests-"));

function build(label: string, files: Record<string, string>): string {
  return writeTarball(join(scratch, `${label}.tgz`), files);
}

// ---------------------------------------------------------------------------
// RED — one poisoned tarball per check
// ---------------------------------------------------------------------------

const MINUTES = 60 * 1000;

describe("release-artifact-review: red first, per check (AIT-03.AC3)", () => {
  /**
   * Each case names the ONE check it is allowed to break. The assertion is an
   * equality on the set of failing checks, not a `toContain`: a script that
   * failed every check would satisfy `toContain` while catching nothing.
   */
  const cases: [string, string, Record<string, string>][] = [
    // Inside dist/, so `entry-allowlist` still passes and only the dotfile
    // rule can be the one that fires.
    ["no-dotfiles", "a dotfile entry", fixture({ extra: { "package/dist/.hidden-key": "sk-not-a-real-key\n" } })],
    [
      "no-test-material",
      "a fixtures/ entry",
      fixture({ extra: { "package/dist/fixtures/sample.js": "module.exports = {};\n" } }),
    ],
    [
      "no-install-scripts",
      "a postinstall script",
      fixture({ manifest: { scripts: { postinstall: "node -e \"0\"" } } }),
    ],
    [
      "pinned-first-party-deps",
      "a caret on an @opena2a/ dependency",
      fixture({ manifest: { dependencies: { "@opena2a/cli-ui": "^0.5.2" } } }),
    ],
    [
      "global-install-smoke",
      "a dist/index.js that exits 1 on --version",
      fixture({
        index:
          "#!/usr/bin/env node\n" +
          'if (process.argv.includes("--version")) { console.error("boom"); process.exit(1); }\n' +
          'console.log("ait03-review-fixture 1.0.0");\n',
      }),
    ],
    [
      "entry-allowlist",
      "an entry outside dist/ and the three metadata files",
      fixture({ extra: { "package/scripts/leftover.js": "module.exports = {};\n" } }),
    ],
    // The file name sorts BEFORE the planted control (`zz-…`) on purpose: the
    // scanner collapses duplicate checkIds onto the first file in walk order,
    // so this is the shadowing case the check's fail-before-precondition
    // ordering exists for. The value is assembled here at runtime — the
    // repository carries no credential-shaped literal.
    [
      "credential-scan",
      "a dist/ file carrying a value of the control's class",
      fixture({
        extra: { "package/dist/leaked-config.js": `const OPENAI_API_KEY = "${controlClassValue()}";\n` },
      }),
    ],
  ];

  for (const [check, description, files] of cases) {
    it(
      `AIT-03.AC3 ${description} makes the review exit non-zero naming \`${check}\` and nothing else`,
      () => {
        const result = review(build(check, files));
        expect(result.status, result.output).not.toBe(0);
        expect(failing(result), result.output).toEqual([check]);
        // Naming it is the point: an operator reading the log has to be told
        // which check refused, not just that something did.
        expect(result.output).toContain(`FAILED CHECK ${check}`);
      },
      10 * MINUTES,
    );
  }

  it(
    "AIT-03.AC3 a dependency on a deprecated hackmyagent makes `consumer-closure` fail, naming it",
    () => {
      // The deprecated version is read from the registry AT TEST TIME, not
      // hardcoded as a truth: the test names the version it used, and if the
      // registry stops reporting any candidate as deprecated the fixture
      // cannot be built and the test says so instead of passing vacuously.
      const candidates = ["0.25.0", "0.17.11"];
      let deprecatedVersion: string | undefined;
      let lastProbe = "";
      for (const version of candidates) {
        const probe = spawnSync("npm", ["view", `hackmyagent@${version}`, "deprecated"], {
          encoding: "utf8",
          timeout: 2 * MINUTES,
        });
        lastProbe = `${probe.stdout ?? ""}${probe.stderr ?? ""}`;
        if (probe.status === 0 && (probe.stdout ?? "").trim()) {
          deprecatedVersion = version;
          break;
        }
      }

      if (!deprecatedVersion) {
        if (strictNetworkAssertions()) {
          throw new Error(
            `no hackmyagent candidate (${candidates.join(", ")}) reads as deprecated via npm view — ` +
              `cannot build the consumer-closure red fixture: ${lastProbe.slice(0, 300)}`,
          );
        }
        // Lenient (no registry reachable): the red reading cannot be taken,
        // so take the honest one instead — the review must refuse loudly, as
        // a precondition, never go green. Say so in the log.
        console.warn(
          "consumer-closure red case: registry unreachable, asserting the precondition path instead " +
            "of the fail path — under CI this branch is a hard failure",
        );
        const offline = review(build("consumer-closure", fixture({ manifest: { dependencies: { hackmyagent: candidates[0] } } })));
        expect(offline.status, offline.output).not.toBe(0);
        expect(offline.census.get("consumer-closure"), offline.output).toBe("precondition");
        return;
      }

      console.log(
        `consumer-closure red fixture depends on hackmyagent@${deprecatedVersion} ` +
          `(npm view reports it deprecated at test time)`,
      );
      const result = review(
        build("consumer-closure", fixture({ manifest: { dependencies: { hackmyagent: deprecatedVersion } } })),
      );
      expect(result.status, result.output).not.toBe(0);
      // A `precondition` is not a pass for this case: the census must say FAIL.
      expect(failing(result), result.output).toEqual(["consumer-closure"]);
      expect(result.output).toContain("FAILED CHECK consumer-closure");
      expect(result.output).toContain(`hackmyagent@${deprecatedVersion}`);
    },
    20 * MINUTES,
  );

  it(
    "AIT-03.AC3 a tarball with no dist/ exits non-zero and says `precondition`",
    () => {
      const result = review(
        build("no-dist", {
          "package/package.json":
            JSON.stringify({ name: "ait03-review-fixture", version: "1.0.0" }, null, 2) + "\n",
          "package/README.md": "# ait03-review-fixture\n",
        }),
      );
      expect(result.status, result.output).not.toBe(0);
      expect(result.output).toContain("precondition");
      // The checks that need a built CLI must say they could not run — not
      // pass, and not vanish from the census.
      expect(result.census.get("global-install-smoke")).toBe("precondition");
      expect(result.census.get("credential-scan")).toBe("precondition");
    },
    10 * MINUTES,
  );
});

// ---------------------------------------------------------------------------
// The census contract
// ---------------------------------------------------------------------------

describe("release-artifact-review: the census (AIT-03.AC2)", () => {
  it(
    "AIT-03.AC2 every declared check appears in the census whatever its outcome",
    () => {
      const result = review(build("census-clean", fixture()));
      expect([...result.census.keys()]).toEqual(DECLARED_CHECKS);
      for (const [name, status] of result.census) {
        expect(["pass", "fail", "precondition"], `${name} reported "${status}"`).toContain(status);
      }
    },
    10 * MINUTES,
  );

  it(
    "AIT-03.AC2 a poisoned tarball still reports the full census, passes included",
    () => {
      const result = review(build("census-poisoned", fixture({ manifest: { scripts: { install: "true" } } })));
      expect([...result.census.keys()]).toEqual(DECLARED_CHECKS);
      expect(result.census.get("no-install-scripts")).toBe("fail");
      // The checks that PASSED are still named. A census that only lists
      // failures cannot answer "was that check even run".
      expect(result.census.get("entry-allowlist")).toBe("pass");
      expect(result.output).toContain("census: ");
    },
    10 * MINUTES,
  );

  it(
    "AIT-03.AC2 a check that cannot run is `precondition` with a reason, never a pass, and exits non-zero",
    () => {
      // A tarball with no dist/ deterministically removes two instruments —
      // there is no CLI to smoke-run and nothing to scan — so the checks must
      // say so rather than report a clean artifact, and the run must not go
      // green.
      const result = review(
        build("precondition-reasons", {
          "package/package.json":
            JSON.stringify({ name: "ait03-review-fixture", version: "1.0.0" }, null, 2) + "\n",
          "package/README.md": "# ait03-review-fixture\n",
        }),
      );
      expect(result.status).not.toBe(0);
      expect(result.census.get("global-install-smoke")).toBe("precondition");
      expect(result.census.get("credential-scan")).toBe("precondition");
      for (const name of blocked(result)) {
        expect(PRECONDITION_CAPABLE, `${name} reported a precondition but is not precondition-capable`).toContain(
          name,
        );
        expect(result.output).toMatch(new RegExp(`BLOCKED CHECK ${name}: precondition: \\S`));
      }
    },
    10 * MINUTES,
  );
});

// ---------------------------------------------------------------------------
// GREEN — the tarball this tree would actually publish
// ---------------------------------------------------------------------------

describe("release-artifact-review: the clean fixture and the delivered tree (AIT-03.AC3)", () => {
  it(
    "AIT-03.AC3 a clean fixture tarball exits 0 with every check pass",
    () => {
      const result = review(build("all-green", fixture()));

      // Whatever the environment, nothing about the clean fixture may FAIL,
      // and the network-free checks must actually pass.
      expect(failing(result), result.output).toEqual([]);
      for (const name of NETWORK_FREE_CHECKS) {
        expect(result.census.get(name), `${name}: ${result.output}`).toBe("pass");
      }

      if (strictNetworkAssertions()) {
        // The full criterion: every check pass, exit 0. A precondition here
        // is a test failure, never a skip.
        expect(blocked(result), result.output).toEqual([]);
        expect(result.status, result.output).toBe(0);
        return;
      }
      // Lenient (no CI env): a machine without network cannot take the
      // advisory or closure readings. Tolerate `precondition` on the
      // network-reading checks ONLY, say so loudly, and keep the exit-code
      // invariant — the review itself must still refuse to go green.
      const blockedNames = blocked(result);
      for (const name of blockedNames) {
        expect(NETWORK_READING_CHECKS, `${name}: ${result.output}`).toContain(name);
      }
      if (blockedNames.length > 0) {
        console.warn(
          `clean-fixture case: network checks not exercised here (${blockedNames.join(", ")}) — ` +
            `under CI these are hard failures`,
        );
      }
      expect(result.status === 0, result.output).toBe(blockedNames.length === 0);
    },
    20 * MINUTES,
  );

  it(
    "AIT-03.AC3 the tarball packed from this tree passes every network-free check, and the exit code tracks the census",
    () => {
      // Both workflows run `npm run build` before `npm test` because several
      // suites here exercise the built CLI. Say so plainly rather than
      // skipping: a green run that silently measured nothing is the exact
      // failure this whole file is about.
      expect(existsSync(BUILT_CLI), "run `npm run build` before `npm test` — dist/index.js is missing").toBe(true);

      const packDir = join(scratch, "packed");
      // npm 11 does not create --pack-destination; r1 died here with ENOENT
      // before the review ever ran (the one red case in the r1 verification).
      mkdirSync(packDir, { recursive: true });
      const packed = spawnSync(
        "npm",
        ["pack", "--ignore-scripts", "--pack-destination", packDir, "--silent"],
        { cwd: REPO_ROOT, encoding: "utf8", timeout: 10 * MINUTES },
      );
      expect(packed.status, `${packed.stdout ?? ""}${packed.stderr ?? ""}`).toBe(0);
      const tarball = readdirSync(packDir).find((f) => f.endsWith(".tgz"));
      expect(tarball, "npm pack produced no tarball").toBeDefined();

      const result = review(join(packDir, tarball!));

      // Quoted verbatim into the log so the delivery report can carry the
      // census line and the consumer-closure rows exactly as measured.
      for (const line of result.output.split("\n")) {
        if (line.startsWith("census: ") || line.includes("consumer-closure fail:")) console.log(line);
      }

      // The exit-code rule holds in every environment: 0 exactly when no
      // check is `fail` or `precondition`.
      expect(result.status === 0, result.output).toBe(
        failing(result).length === 0 && blocked(result).length === 0,
      );

      if (strictNetworkAssertions()) {
        // A precondition on ANY check in the own-tarball case is a test
        // failure, never a skip.
        expect(blocked(result), result.output).toEqual([]);
        for (const name of NETWORK_FREE_CHECKS) {
          expect(result.census.get(name), `${name}: ${result.output}`).toBe("pass");
        }
        // `consumer-closure` is pass or fail — a FAIL names our own pinned
        // deprecated/advisory-covered copies and blocks the RELEASE job; it
        // is not a failure of this suite.
        expect(["pass", "fail"], result.output).toContain(result.census.get("consumer-closure"));
        expect(failing(result).filter((name) => name !== "consumer-closure"), result.output).toEqual([]);
        return;
      }
      // Lenient (no CI env): tolerate `precondition` only where the network
      // was genuinely needed, loudly; everything else must pass, and nothing
      // but consumer-closure may fail.
      const blockedNames = blocked(result);
      for (const name of blockedNames) {
        expect(NETWORK_READING_CHECKS, `${name}: ${result.output}`).toContain(name);
      }
      if (blockedNames.length > 0) {
        console.warn(
          `own-tarball case: network checks not exercised here (${blockedNames.join(", ")}) — ` +
            `under CI these are hard failures`,
        );
      }
      for (const [name, status] of result.census) {
        if (blockedNames.includes(name)) continue;
        expect(
          name === "consumer-closure" ? ["pass", "fail"] : ["pass"],
          `${name} reported "${status}": ${result.output}`,
        ).toContain(status);
      }
    },
    20 * MINUTES,
  );
});

// The scratch directory outlives the individual tests because several of them
// pack into it; removing it per-test would race the ones vitest interleaves.
process.on("exit", () => rmSync(scratch, { recursive: true, force: true }));
