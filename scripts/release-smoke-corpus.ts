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
 *   - This harness IS wired (per [CHIEF-CSR-019] gate-lift contract).
 *   - It reports each applicable surface as `skipped: ai-trust does not
 *     support local-path scanning for surface=<X>`.
 *   - The skip is the honest signal — surfaces become `ok` when ai-trust
 *     gains either a local-scan mode or when Phase 3 delivers npm
 *     fixtures (synthetic published packages) that ai-trust can look up
 *     by name.
 *
 * Per [CHIEF-CDS-028] OPENA2A_CORPUS_DETERMINISTIC=1 is set so output is
 * stable across runs. Per [CHIEF-CA-044] this script is consumer-local;
 * it does NOT share code with HMA's release-smoke-corpus.
 *
 * Exit code 0 = green (no actual failures), 1 = drift, 2 = setup error.
 */
import { spawnSync } from 'node:child_process';
import { readFileSync, existsSync, statSync, readdirSync, mkdirSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import yaml from 'js-yaml';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

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

function runAiTrustScanPath(label: string, dir: string): AiTrustResult {
  const env = { ...process.env, OPENA2A_CORPUS_DETERMINISTIC: '1' };
  const r = spawnSync(
    process.execPath,
    [AI_TRUST_CLI, 'check', label, '--scan-path', dir, '--json'],
    { encoding: 'utf8', env, maxBuffer: 16 * 1024 * 1024 },
  );
  const stdout = r.stdout ?? '';
  const jsonStart = stdout.indexOf('{');
  if (jsonStart < 0) {
    return { score: -1, trustLevel: -1, verdict: 'error', findings: [], severities: {} };
  }
  try {
    const data = JSON.parse(stdout.slice(jsonStart));
    const fails = (data.scan?.findings ?? []).filter(
      (f: { passed?: boolean }) => f.passed === false,
    ) as { checkId: string; severity: string }[];
    const findings = [...new Set(fails.map((f) => f.checkId))].sort();
    const severities = fails.reduce<Record<string, number>>((acc, f) => {
      acc[f.severity] = (acc[f.severity] ?? 0) + 1;
      return acc;
    }, {});
    return {
      score: typeof data.scan?.score === 'number' ? data.scan.score : -1,
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

function main(): void {
  if (!existsSync(AI_TRUST_CLI)) {
    fail(`dist/index.js not built. run \`npm run build\` first.`);
  }
  const corpus = loadCorpusManifest();
  const surfaces = consumerSurfaces(corpus);
  process.stdout.write(
    `release-smoke-corpus: ${corpus.corpusName} ${corpus.corpusVersion}\n` +
      `consumer: ${CONSUMER_NAME}, surfaces: ${surfaces.join(',')}\n` +
      `corpus path: ${CORPUS_ROOT}\n` +
      `scannable surfaces today: ${[...SCANNABLE_SURFACES].join(',') || '(none)'}\n\n`,
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
        const result = runAiTrustScanPath(fixtureRel, fixtureDir);
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

main();
