/**
 * Process plumbing for scripts/release-smoke-corpus.ts: the environment each
 * child runs with, how children run, how the harness temp directory is
 * removed, and how a failed classifier model download is reported. Kept apart
 * from the harness so it can be tested without a corpus checkout or a scan.
 */
import { spawn, type ChildProcess } from 'node:child_process';
import { rmSync } from 'node:fs';
import { constants as osConstants } from 'node:os';

/**
 * The only variables a child inherits from the caller. Everything else is
 * dropped, so a variable that would point the scanner at the caller's state,
 * a registry, a telemetry endpoint, a classifier daemon or a remote model
 * (ANTHROPIC_API_KEY, OPENA2A_HOME, NANOMIND_URL, NANOMIND_GUARD_SOCK,
 * XDG_CONFIG_HOME, REGISTRY_URL, OPENA2A_TELEMETRY_URL, and any added later)
 * never reaches a scan. PATH finds executables, the temp variables keep the
 * caller's temp directory, SystemRoot lets Node start on Windows, and the
 * proxy and CA variables carry the network route for the classifier model
 * download; none of them changes what a scan finds.
 */
export const INHERITED_ENV: readonly string[] = [
  'PATH',
  'TMPDIR',
  'TMP',
  'TEMP',
  'SystemRoot',
  'HTTPS_PROXY',
  'https_proxy',
  'HTTP_PROXY',
  'http_proxy',
  'NO_PROXY',
  'no_proxy',
  'NODE_USE_ENV_PROXY',
  'NODE_EXTRA_CA_CERTS',
];

/**
 * The environment every child runs with: the inherited variables above plus
 * the harness's own. HOME (USERPROFILE on Windows) is the harness home, so
 * the caller's classifier model files and state directory are invisible.
 * OPENA2A_CORPUS_DETERMINISTIC keeps output stable for goldens. Usage
 * telemetry is off: a harness home holds no saved opt-out, and test runs are
 * not users.
 */
export function harnessChildEnv(
  caller: NodeJS.ProcessEnv,
  home: string,
): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {};
  for (const name of INHERITED_ENV) {
    const value = caller[name];
    if (value !== undefined) env[name] = value;
  }
  env.HOME = home;
  env.USERPROFILE = home;
  env.OPENA2A_CORPUS_DETERMINISTIC = '1';
  env.OPENA2A_TELEMETRY = 'off';
  return env;
}

export interface ChildRun {
  status: number | null;
  signal: NodeJS.Signals | null;
  stdout: string;
  stderr: string;
  timedOut: boolean;
  error?: Error;
}

// Children still running, so a signal handler can stop them before the
// harness removes the directory they may be writing into.
const running = new Set<ChildProcess>();

// On POSIX each child leads its own process group, so a signal reaches the
// scanner processes a child starts as well, not only the child.
const OWN_GROUP = process.platform !== 'win32';

function signalChild(child: ChildProcess, signal: NodeJS.Signals): void {
  if (OWN_GROUP && child.pid !== undefined) {
    try {
      process.kill(-child.pid, signal);
      return;
    } catch {
      /* group already gone */
    }
  }
  child.kill(signal);
}

/**
 * Run `node <args>` and collect its output. Asynchronous on purpose: while a
 * child runs the event loop stays free, so a SIGINT or SIGTERM handler runs
 * at once instead of after the scan.
 */
export function runNode(
  args: string[],
  env: NodeJS.ProcessEnv,
  timeoutMs?: number,
): Promise<ChildRun> {
  return new Promise((resolveRun) => {
    const child = spawn(process.execPath, args, {
      env,
      stdio: ['ignore', 'pipe', 'pipe'],
      detached: OWN_GROUP,
    });
    running.add(child);
    let stdout = '';
    let stderr = '';
    let timedOut = false;
    let error: Error | undefined;
    let settled = false;
    const timer =
      timeoutMs === undefined
        ? undefined
        : setTimeout(() => {
            timedOut = true;
            signalChild(child, 'SIGTERM');
          }, timeoutMs);
    const settle = (status: number | null, signal: NodeJS.Signals | null) => {
      if (settled) return;
      settled = true;
      if (timer) clearTimeout(timer);
      running.delete(child);
      resolveRun({ status, signal, stdout, stderr, timedOut, error });
    };
    child.stdout?.setEncoding('utf8').on('data', (chunk: string) => {
      stdout += chunk;
    });
    child.stderr?.setEncoding('utf8').on('data', (chunk: string) => {
      stderr += chunk;
    });
    child.on('error', (err) => {
      error = err;
      // A child that never started emits no 'close'.
      if (child.pid === undefined) settle(null, null);
    });
    child.on('close', (status, signal) => settle(status, signal));
  });
}

// How long a child gets to exit after the harness forwards a signal to it.
const SIGNAL_GRACE_MS = 5_000;

/**
 * Remove `dir` when the harness exits, including on SIGINT (Ctrl-C) and
 * SIGTERM. On either signal the running children and the processes they
 * started get the same signal, the harness waits for the children to close
 * (SIGKILL after a grace period), then exits 128 + the signal number through
 * the exit handler that removes `dir`. A second signal while waiting gets the
 * default action.
 */
export function removeOnExitOrSignal(dir: string): void {
  process.on('exit', () => {
    try {
      rmSync(dir, { recursive: true, force: true });
    } catch {
      /* best effort */
    }
  });
  const onSignal = (signal: NodeJS.Signals): void => {
    const code = 128 + (osConstants.signals[signal] ?? 0);
    const children = [...running];
    if (children.length === 0) process.exit(code);
    let open = children.length;
    for (const child of children) {
      child.once('close', () => {
        open -= 1;
        if (open === 0) process.exit(code);
      });
      setTimeout(() => signalChild(child, 'SIGKILL'), SIGNAL_GRACE_MS).unref();
      signalChild(child, signal);
    }
  };
  process.once('SIGINT', onSignal);
  process.once('SIGTERM', onSignal);
}

/**
 * Run the scanner's own classifier model downloader into `modelDir`. It skips
 * files already present, verifies the sha256 of each file it fetches and
 * removes a file that fails. It runs with progress output on, because that is
 * the only place it reports why a download failed (an HTTP status, a network
 * error or an integrity failure); `modelDownloadDetail` turns the result into
 * text for the setup-error message.
 */
export function downloadClassifierModels(
  classifierSource: string,
  modelDir: string,
  env: NodeJS.ProcessEnv,
  timeoutMs: number,
): Promise<ChildRun> {
  const script =
    'require(process.argv[1]).TMEClassifier.downloadModel(process.argv[2], false)' +
    '.then((ok) => process.exit(ok ? 0 : 1), (err) => {' +
    ' console.error(String((err && err.stack) || err)); process.exit(1); });';
  return runNode(['-e', script, classifierSource, modelDir], env, timeoutMs);
}

/** What the downloader reported, one indented line per line of output. */
export function modelDownloadDetail(run: ChildRun, timeoutMs: number): string {
  const lines = run.stderr
    .split(/\r?\n/)
    .map((line) => line.trimEnd())
    .filter((line) => line.length > 0);
  if (run.error) lines.push(`the downloader did not start: ${run.error.message}`);
  if (run.timedOut) lines.push(`the downloader was stopped after ${timeoutMs / 1000} s`);
  else if (run.signal) lines.push(`the downloader was ended by ${run.signal}`);
  if (lines.length === 0) lines.push(`the downloader exited ${run.status} with no output`);
  return lines.map((line) => `  ${line}`).join('\n');
}
