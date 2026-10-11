#!/usr/bin/env tsx
/**
 * release-smoke-corpus.ts — opena2a-corpus consumer harness for ai-trust.
 *
 * Walks ~/.opena2a/corpus/, finds fixtures whose surface is in our consumer
 * block of corpus-manifest.yaml, and asserts ai-trust's output against the
 * fixture's manifest expectations + a per-fixture golden snapshot.
 *
 * Phase 2 scope note: ai-trust's `check` command is a registry lookup
 * (package name → trust record). It cannot scan local-path fixtures
 * directly. The corpus's mcp/skill/soul/repo fixtures are on-disk
 * artifacts, not published packages. So in Phase 2:
 *
 *   - This harness IS wired (per the corpus gate-lift contract).
 *   - It reports each applicable surface as `skipped: ai-trust does not
 *     support local-path scanning for surface=<X>`.
 *   - The skip is the honest signal — surfaces become `ok` when ai-trust
 *     gains either a local-scan mode or when Phase 3 delivers npm
 *     fixtures (synthetic published packages) that ai-trust can look up
 *     by name.
 *
 * OPENA2A_CORPUS_DETERMINISTIC=1 is set so output is stable across runs,
 * which keeps golden snapshots comparable. This script is consumer-local;
 * it does NOT share code with HMA's release-smoke-corpus.
 *
 * Exit code 0 = green (no actual failures), 1 = drift, 2 = setup error,
 * 130/143 = interrupted by SIGINT/SIGTERM (temp directory removed).
 */
import { createHash } from 'node:crypto';
import {
  readFileSync,
  existsSync,
  statSync,
  readdirSync,
  mkdirSync,
  mkdtempSync,
  copyFileSync,
  writeFileSync,
} from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import yaml from 'js-yaml';
import {
  downloadClassifierModels,
  harnessChildEnv,
  modelDownloadDetail,
  removeOnExitOrSignal,
  runNode,
} from './lib/corpus-harness.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

// Every scan runs with a HOME owned by this harness, under its own temp
// directory, removed on exit and on SIGINT or SIGTERM. The scanner's NanoMind
// classifier picks its model files up from the scanning user's home
// (`~/.nanomind/models` and `~/.opena2a/nanomind/models`), and which files sit
// there decides which classifier tier answers and therefore which findings a
// fixture gets. The goldens are recorded with the scanner's own pinned,
// downloaded set and no other model files, so the caller's home must be
// invisible to the scan.
const HARNESS_TMP = mkdtempSync(join(tmpdir(), 'ai-trust-corpus-'));
const HARNESS_HOME = join(HARNESS_TMP, 'home');
removeOnExitOrSignal(HARNESS_TMP);

interface FixtureManifest {
  fixture: string;
  surface: string;
  intent: string;
  expected?: {
    aiTrust?: {
      score?: { min: number; max: number };
      verdict?: string;
      tier?: string;
    };
  };
}

interface CorpusManifest {
  corpusName: string;
  corpusVersion: string;
  consumers: { name: string; surfaces: string[] }[];
  surfaceIndex: Record<string, Record<string, string[]>>;
}

const CORPUS_ROOT =
  process.env.OPENA2A_CORPUS_PATH ?? join(homedir(), '.opena2a', 'corpus');
const AI_TRUST_CLI = resolve(__dirname, '..', 'dist', 'index.js');
const CONSUMER_NAME = 'ai-trust';
const UPDATE_GOLDEN = process.env.OPENA2A_CORPUS_UPDATE_GOLDEN === '1';
const GOLDEN_ROOT = resolve(__dirname, '..', 'golden', 'ai-trust');

// The scanner ai-trust runs is the hackmyagent this package pins, so the
// classifier model set the goldens depend on is the one that scanner pins:
// three files with sha256 values in its tier-1 classifier source, downloaded
// into `~/.nanomind/models` when missing. The harness reads the pins from the
// installed scanner rather than keeping a copy, so a pin bump cannot leave
// the harness checking a stale set.
const SCANNER_CLASSIFIER_SOURCE = resolve(
  __dirname,
  '..',
  'node_modules',
  'hackmyagent',
  'dist',
  'nanomind-core',
  'inference',
  'tme-classifier.js',
);
// The scanner's model directory inside the harness home.
const HARNESS_MODEL_DIR = join(HARNESS_HOME, '.nanomind', 'models');
// The caller's copy of the same directory, read only, used as a cache when
// its files carry the pinned hashes.
const CALLER_MODEL_DIR = join(homedir(), '.nanomind', 'models');

interface PinnedModelFile {
  name: string;
  sha256: string;
}

function sha256Of(path: string): string {
  return createHash('sha256').update(readFileSync(path)).digest('hex');
}

function pinnedModelFiles(): PinnedModelFile[] {
  if (!existsSync(SCANNER_CLASSIFIER_SOURCE)) {
    fail(
      `scanner classifier source not found at ${SCANNER_CLASSIFIER_SOURCE}\n` +
        `run \`npm ci\` so the pinned hackmyagent is installed.`,
    );
  }
  const source = readFileSync(SCANNER_CLASSIFIER_SOURCE, 'utf8');
  const pins: PinnedModelFile[] = [];
  const entry = /\{\s*name:\s*'([^']+)',\s*sha256:\s*'([0-9a-f]{64})'\s*\}/g;
  for (const m of source.matchAll(entry)) pins.push({ name: m[1], sha256: m[2] });
  if (pins.length === 0) {
    fail(
      `no pinned classifier model files found in ${SCANNER_CLASSIFIER_SOURCE}\n` +
        `the installed scanner does not pin its model set the way this harness expects.`,
    );
  }
  return pins;
}

// The environment every child runs with is an allow-list (see
// harnessChildEnv): PATH, the temp, proxy and CA variables, and the harness's
// own. The caller's API key never reaches a scan, so the scanner's semantic
// layer (a remote model call behind --deep) never runs; HOME points at the
// harness home; usage telemetry is switched off with OPENA2A_TELEMETRY, the
// variable @opena2a/telemetry reads in both ai-trust and the scanner.
function childEnv(): NodeJS.ProcessEnv {
  return harnessChildEnv(process.env, HARNESS_HOME);
}

const MODEL_DOWNLOAD_TIMEOUT_MS = 300_000;

/**
 * Put the scanner's pinned classifier model set into the harness home and
 * verify every file's sha256 against the pin before any scan runs. Files are
 * copied from the caller's `~/.nanomind/models` when their hashes match;
 * otherwise the scanner's own downloader fetches them into the harness home.
 * A set that cannot be obtained is a setup error (exit 2), not drift; the
 * message carries what the downloader reported.
 */
async function prepareClassifierModels(): Promise<PinnedModelFile[]> {
  const pins = pinnedModelFiles();
  mkdirSync(HARNESS_MODEL_DIR, { recursive: true });
  const toFetch: PinnedModelFile[] = [];
  for (const pin of pins) {
    const cached = join(CALLER_MODEL_DIR, pin.name);
    if (existsSync(cached) && sha256Of(cached) === pin.sha256) {
      copyFileSync(cached, join(HARNESS_MODEL_DIR, pin.name));
    } else {
      toFetch.push(pin);
    }
  }
  const download =
    toFetch.length > 0
      ? await downloadClassifierModels(
          SCANNER_CLASSIFIER_SOURCE,
          HARNESS_MODEL_DIR,
          childEnv(),
          MODEL_DOWNLOAD_TIMEOUT_MS,
        )
      : undefined;
  for (const pin of pins) {
    const dest = join(HARNESS_MODEL_DIR, pin.name);
    if (!existsSync(dest)) {
      const detail = download
        ? `the scanner's downloader could not fetch it:\n` +
          modelDownloadDetail(download, MODEL_DOWNLOAD_TIMEOUT_MS)
        : `no download was attempted.`;
      fail(
        `classifier model file ${pin.name} is missing (pinned sha256 ${pin.sha256} in ` +
          `${SCANNER_CLASSIFIER_SOURCE}); it was not in ${CALLER_MODEL_DIR} with that hash ` +
          `and ${detail}\nNo golden was compared.`,
      );
    }
    const got = sha256Of(dest);
    if (got !== pin.sha256) {
      fail(
        `classifier model file ${pin.name} has sha256 ${got}, pinned ${pin.sha256} in ` +
          `${SCANNER_CLASSIFIER_SOURCE}. No golden was compared.`,
      );
    }
  }
  return pins;
}

// All surfaces are scannable now via `ai-trust check <name> --scan-path <dir>`
// (added 2026-04-28 alongside this harness). The `npm` surface arrives in
// Phase 3 and will be exercised by `--scan-if-missing` once those fixtures
// are synthetic published packages.
const SCANNABLE_SURFACES = new Set<string>(['mcp', 'skill', 'soul', 'repo', 'a2a', 'npm']);

function fail(msg: string, code = 2): never {
  process.stderr.write(`release-smoke-corpus: ${msg}\n`);
  process.exit(code);
}

function loadCorpusManifest(): CorpusManifest {
  const path = join(CORPUS_ROOT, 'corpus-manifest.yaml');
  if (!existsSync(path)) {
    fail(
      `corpus not found at ${CORPUS_ROOT}\n` +
        `clone it: git clone https://github.com/opena2a-org/opena2a-corpus.git ${CORPUS_ROOT}\n` +
        `or set OPENA2A_CORPUS_PATH to a local checkout.`,
    );
  }
  return yaml.load(readFileSync(path, 'utf8')) as CorpusManifest;
}

function loadFixtureManifest(path: string): FixtureManifest {
  return yaml.load(readFileSync(path, 'utf8')) as FixtureManifest;
}

function consumerSurfaces(corpus: CorpusManifest): string[] {
  const me = corpus.consumers.find((c) => c.name === CONSUMER_NAME);
  if (!me) fail(`consumer '${CONSUMER_NAME}' not in corpus-manifest.yaml`);
  return me.surfaces;
}

interface AiTrustResult {
  score: number;
  trustLevel: number;
  verdict: string;
  findings: string[];
  severities: Record<string, number>;
}

async function runAiTrustScanPath(label: string, dir: string): Promise<AiTrustResult> {
  // With ANTHROPIC_API_KEY present the scanner's --deep path calls a remote
  // model, which can change the score and finding set (and can exceed the
  // deep-scan timeout). Goldens must not depend on whether the caller's shell
  // holds a key, so the child never sees it; see childEnv for the rest.
  const r = await runNode(
    [AI_TRUST_CLI, 'check', label, '--scan-path', dir, '--json'],
    childEnv(),
  );
  const stdout = r.stdout;
  const jsonStart = stdout.indexOf('{');
  if (jsonStart < 0) {
    return { score: -1, trustLevel: -1, verdict: 'error', findings: [], severities: {} };
  }
  try {
    const data = JSON.parse(stdout.slice(jsonStart));
    // The curated `check --json` (issue #61) emits score/findings at the TOP
    // level; older/uncurated output nested them under `scan`. Prefer top-level,
    // fall back to nested so the harness reads either shape. Top-level findings
    // are already failed-only but still carry `passed: false`, so the filter is
    // a no-op safety net.
    const rawFindings = (data.findings ?? data.scan?.findings ?? []) as {
      checkId: string;
      severity: string;
      passed?: boolean;
    }[];
    const fails = rawFindings.filter((f) => f.passed !== true);
    const findings = [...new Set(fails.map((f) => f.checkId))].sort();
    const severities = fails.reduce<Record<string, number>>((acc, f) => {
      acc[f.severity] = (acc[f.severity] ?? 0) + 1;
      return acc;
    }, {});
    const score =
      typeof data.score === 'number'
        ? data.score
        : typeof data.scan?.score === 'number'
          ? data.scan.score
          : -1;
    return {
      score,
      trustLevel: typeof data.trustLevel === 'number' ? data.trustLevel : -1,
      verdict: typeof data.verdict === 'string' ? data.verdict : 'unknown',
      findings,
      severities,
    };
  } catch {
    return { score: -1, trustLevel: -1, verdict: 'parse-error', findings: [], severities: {} };
  }
}

function renderGolden(r: AiTrustResult): string {
  const sevSorted = Object.fromEntries(Object.entries(r.severities).sort());
  return [
    `score=${r.score}`,
    `trustLevel=${r.trustLevel}`,
    `verdict=${r.verdict}`,
    `severities=${JSON.stringify(sevSorted)}`,
    `checkIds=${r.findings.join(',')}`,
    '',
  ].join('\n');
}

async function main(): Promise<void> {
  if (!existsSync(AI_TRUST_CLI)) {
    fail(`dist/index.js not built. run \`npm run build\` first.`);
  }
  const corpus = loadCorpusManifest();
  const surfaces = consumerSurfaces(corpus);
  const pins = await prepareClassifierModels();
  process.stdout.write(
    `release-smoke-corpus: ${corpus.corpusName} ${corpus.corpusVersion}\n` +
      `consumer: ${CONSUMER_NAME}, surfaces: ${surfaces.join(',')}\n` +
      `corpus path: ${CORPUS_ROOT}\n` +
      `scannable surfaces today: ${[...SCANNABLE_SURFACES].join(',') || '(none)'}\n` +
      `scan home: isolated (no API key, no caller model files)\n` +
      `classifier model set: ${pins.length} file(s) verified against the scanner's pins\n` +
      pins.map((p) => `  ${p.sha256}  ${p.name}\n`).join('') +
      '\n',
  );

  let pass = 0;
  let fail_ = 0;
  let skip = 0;

  for (const surface of surfaces) {
    const surfaceDir = join(CORPUS_ROOT, surface);
    if (!existsSync(surfaceDir)) {
      process.stdout.write(`  skip ${surface}/* — surface absent (Phase 3?)\n`);
      skip++;
      continue;
    }
    for (const intent of ['benign', 'buggy', 'malicious']) {
      const intentDir = join(surfaceDir, intent);
      if (!existsSync(intentDir)) continue;
      for (const fixtureName of readdirSync(intentDir)) {
        const fixtureDir = join(intentDir, fixtureName);
        if (!statSync(fixtureDir).isDirectory()) continue;
        const manifestPath = join(fixtureDir, 'manifest.yaml');
        if (!existsSync(manifestPath)) continue;
        const manifest = loadFixtureManifest(manifestPath);
        const fixtureRel = `${surface}/${intent}/${fixtureName}`;
        const expected = manifest.expected?.aiTrust;
        if (!expected) {
          process.stdout.write(
            `  skip ${fixtureRel} — manifest declares no aiTrust expectation\n`,
          );
          skip++;
          continue;
        }
        const result = await runAiTrustScanPath(fixtureRel, fixtureDir);
        const reasons: string[] = [];
        if (result.score === -1) {
          reasons.push(`ai-trust returned no parsable result (verdict=${result.verdict})`);
        }
        if (expected.score && result.score >= 0) {
          if (
            result.score < expected.score.min ||
            result.score > expected.score.max
          ) {
            reasons.push(
              `score ${result.score} outside [${expected.score.min}, ${expected.score.max}]`,
            );
          }
        }
        const goldenPath = join(GOLDEN_ROOT, fixtureRel, 'output.txt');
        const rendered = renderGolden(result);
        if (UPDATE_GOLDEN) {
          mkdirSync(dirname(goldenPath), { recursive: true });
          writeFileSync(goldenPath, rendered);
        } else if (existsSync(goldenPath)) {
          if (readFileSync(goldenPath, 'utf8') !== rendered) {
            reasons.push(
              `golden mismatch — re-run with OPENA2A_CORPUS_UPDATE_GOLDEN=1 to update`,
            );
          }
        } else {
          reasons.push(
            `golden missing — run with OPENA2A_CORPUS_UPDATE_GOLDEN=1 to bake`,
          );
        }
        if (reasons.length === 0) {
          process.stdout.write(`  ok   ${fixtureRel}\n`);
          pass++;
        } else {
          process.stdout.write(`  FAIL ${fixtureRel}\n`);
          for (const r of reasons) process.stdout.write(`         ${r}\n`);
          fail_++;
        }
      }
    }
  }
  process.stdout.write(
    `\n${pass} passed, ${fail_} failed, ${skip} skipped\n`,
  );
  process.exit(fail_ === 0 ? 0 : 1);
}

main().catch((err: unknown) => {
  fail(err instanceof Error ? (err.stack ?? err.message) : String(err));
});
