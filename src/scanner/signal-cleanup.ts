/**
 * Clean-up for a scan that a signal stops.
 *
 * A scan works in directories it creates in the temporary directory: the
 * download directory (`ai-trust-scan-*`) and the scanner's temporary home
 * (`ai-trust-scanner-*`). The `finally` blocks that remove them do not run
 * when SIGINT (Ctrl+C), SIGTERM or SIGHUP ends the process, which is what
 * Node does on each of them when no listener is installed, and an `npm pack`
 * or scanner run that only ai-trust was sent the signal for keeps running.
 *
 * While a path is registered here, ai-trust listens for those three signals.
 * On one, it passes the signal on to each child process registered here that
 * is still running and waits for it to exit, removes the registered paths,
 * newest first, and then ends itself by the same signal, so its exit status
 * still names that signal. A child still running CHILD_EXIT_MS after the
 * signal, or when a second signal arrives, is killed, and the paths are
 * removed without waiting further.
 */

import type { ChildProcess } from "node:child_process";
import { rmSync } from "node:fs";
import { constants } from "node:os";

const STOP_SIGNALS = ["SIGINT", "SIGTERM", "SIGHUP"] as const;
type StopSignal = (typeof STOP_SIGNALS)[number];

/** How long a child process has to exit after the signal is passed on. */
const CHILD_EXIT_MS = 2000;

/** The registered paths, in the order they were created. */
const paths = new Set<string>();
const children = new Set<ChildProcess>();
/** The signal being handled, once one has arrived. */
let stopping: StopSignal | undefined;
let listening = false;

/** True for a child that was started and has not exited. */
function running(child: ChildProcess): boolean {
  return child.pid !== undefined && child.exitCode === null && child.signalCode === null;
}

function listen(): void {
  if (listening) return;
  listening = true;
  for (const signal of STOP_SIGNALS) process.on(signal, onStopSignal);
}

function unlisten(): void {
  if (!listening) return;
  listening = false;
  for (const signal of STOP_SIGNALS) process.removeListener(signal, onStopSignal);
}

/** Remove the registered paths, newest first, then end the process by `signal`. */
function removeAndExit(signal: StopSignal): never {
  for (const path of [...paths].reverse()) {
    try {
      rmSync(path, { recursive: true, force: true });
    } catch {
      // Nothing more can be done for it while the process stops.
    }
  }
  paths.clear();
  unlisten();
  // With no listener left, the signal ends the process as it would have
  // without this module. Another listener would keep it from doing so, and
  // a platform that cannot send the signal throws; either way the process
  // exits with the code a shell reports for that signal.
  if (process.listenerCount(signal) === 0) {
    try {
      process.kill(process.pid, signal);
    } catch {
      // Exits below.
    }
  }
  process.exit(128 + constants.signals[signal]);
}

/** Kill the children still running and remove the paths now. */
function killAndExit(signal: StopSignal): never {
  for (const child of children) if (running(child)) child.kill("SIGKILL");
  return removeAndExit(signal);
}

function onStopSignal(received: NodeJS.Signals): void {
  // A second signal: the children are not waited for any longer.
  if (stopping !== undefined) return killAndExit(stopping);
  const signal = received as StopSignal;
  stopping = signal;
  const live = [...children].filter(running);
  if (live.length === 0) return removeAndExit(signal);
  let left = live.length;
  const timer = setTimeout(() => killAndExit(signal), CHILD_EXIT_MS);
  for (const child of live) {
    child.once("exit", () => {
      left -= 1;
      if (left > 0) return;
      clearTimeout(timer);
      removeAndExit(signal);
    });
    child.kill(signal);
  }
}

/**
 * Create a path with `create` and register it, to be removed if a signal
 * stops ai-trust before pathRemoved() is called for it. ai-trust listens for
 * the signals before `create` runs, so no signal between the two leaves the
 * path behind. Returns what `create` returned; an error it throws is thrown.
 */
export function removeOnSignal(create: () => string): string {
  listen();
  try {
    const path = create();
    paths.add(path);
    return path;
  } finally {
    if (paths.size === 0 && stopping === undefined) unlisten();
  }
}

/** ai-trust has removed `path`, or tried to: a signal no longer removes it. */
export function pathRemoved(path: string): void {
  paths.delete(path);
  if (paths.size === 0 && stopping === undefined) unlisten();
}

/**
 * Register the child process of `run`, an execFile call from
 * util.promisify, to be sent the signal that stops ai-trust and waited for
 * before the registered paths are removed. Returns `run`. A call that has no
 * `child`, or whose child did not start or has exited, is not registered.
 */
export function stopOnSignal<T extends Promise<unknown>>(run: T): T {
  const child = (run as { child?: ChildProcess } | null | undefined)?.child;
  if (child === undefined || !running(child)) return run;
  if (stopping !== undefined) {
    child.kill("SIGKILL");
    return run;
  }
  children.add(child);
  child.once("exit", () => children.delete(child));
  return run;
}
