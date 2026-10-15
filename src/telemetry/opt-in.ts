/**
 * Contribution Consent and Scan Counting
 *
 * Manages the user's consent to share pseudonymous scan findings
 * with the OpenA2A Registry. Uses a delayed consent tip shown
 * after the 3rd scan (non-interactive, no blocking prompts).
 *
 * Config/counting is delegated to @opena2a/shared (the canonical
 * source for ~/.opena2a/config.json). If @opena2a/shared is not
 * available at runtime, falls back to a local implementation.
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync } from "fs";
import { join, dirname } from "path";
import { homedir } from "os";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);

// ---------------------------------------------------------------------------
// Shared-library delegation with graceful fallback
// ---------------------------------------------------------------------------

interface ConfigBackend {
  isContributeEnabled(): boolean;
  setContributeEnabled(enabled: boolean): void;
  incrementScanCount(): number;
  getScanCount(): number;
  shouldPromptContribute(): boolean;
  dismissContributePrompt(): void;
}

/** Resolved backend -- lazy-initialized on first call. */
let _backend: ConfigBackend | undefined;

function resolveBackend(): ConfigBackend {
  if (_backend) return _backend;

  // When OPENA2A_HOME is set, always use local backend so the custom
  // home directory is respected (important for testing and isolation).
  if (!process.env.OPENA2A_HOME) {
    try {
      // eslint-disable-next-line @typescript-eslint/no-require-imports
      const shared = require("@opena2a/shared");
      if (
        typeof shared.isContributeEnabled === "function" &&
        typeof shared.setContributeEnabled === "function" &&
        typeof shared.incrementScanCount === "function" &&
        typeof shared.shouldPromptContribute === "function" &&
        typeof shared.dismissContributePrompt === "function"
      ) {
        _backend = {
          isContributeEnabled: shared.isContributeEnabled,
          setContributeEnabled: shared.setContributeEnabled,
          incrementScanCount: shared.incrementScanCount,
          getScanCount: shared.getScanCount || (() => 0),
          shouldPromptContribute: shared.shouldPromptContribute,
          dismissContributePrompt: shared.dismissContributePrompt,
        };
        return _backend;
      }
    } catch {
      // @opena2a/shared not installed -- fall through to local backend
    }
  }

  _backend = createLocalBackend();
  return _backend;
}

// ---------------------------------------------------------------------------
// Local fallback (preserves original ai-trust behavior for environments
// where @opena2a/shared is not installed)
// ---------------------------------------------------------------------------

interface Opena2aConfig {
  contribute?: {
    enabled?: boolean;
    consentedAt?: string | null;
    /** When ai-trust last saved an explicit on/off choice. */
    decidedAt?: string;
  };
  telemetry?: {
    scanCount?: number;
    contributePromptDismissedAt?: string;
  };
  [key: string]: unknown;
}

function getConfigPath(): string {
  const home =
    process.env.OPENA2A_HOME || join(homedir(), ".opena2a");
  return join(home, "config.json");
}

function readConfig(): Opena2aConfig {
  const configPath = getConfigPath();
  try {
    if (existsSync(configPath)) {
      return JSON.parse(readFileSync(configPath, "utf-8"));
    }
  } catch {
    // Corrupt config -- treat as empty
  }
  return {};
}

function writeConfig(config: Opena2aConfig): void {
  const configPath = getConfigPath();
  const dir = dirname(configPath);
  mkdirSync(dir, { recursive: true });
  writeFileSync(configPath, JSON.stringify(config, null, 2) + "\n", {
    mode: 0o600,
  });
}

/** Cooldown for the consent tip: 30 days after dismissal. */
const TIP_COOLDOWN_MS = 30 * 24 * 60 * 60 * 1000;

/** The consent tip is shown from this scan count on, as in @opena2a/shared. */
const TIP_SCAN_THRESHOLD = 3;

function createLocalBackend(): ConfigBackend {
  return {
    isContributeEnabled(): boolean {
      const config = readConfig();
      return config.contribute?.enabled === true;
    },

    setContributeEnabled(enabled: boolean): void {
      const config = readConfig();
      if (!config.contribute) config.contribute = {};
      config.contribute.enabled = enabled;
      writeConfig(config);
    },

    incrementScanCount(): number {
      const config = readConfig();
      if (!config.telemetry) config.telemetry = {};
      config.telemetry.scanCount = (config.telemetry.scanCount ?? 0) + 1;
      writeConfig(config);
      return config.telemetry.scanCount;
    },

    getScanCount(): number {
      const config = readConfig();
      return config.telemetry?.scanCount ?? 0;
    },

    shouldPromptContribute(): boolean {
      const config = readConfig();
      // Already decided -- do not prompt
      if (
        config.contribute?.enabled === true ||
        config.contribute?.enabled === false
      ) {
        return false;
      }
      const count = config.telemetry?.scanCount ?? 0;
      if (count < TIP_SCAN_THRESHOLD) return false;

      // Check cooldown
      const dismissed = config.telemetry?.contributePromptDismissedAt;
      if (dismissed) {
        const dismissedMs = new Date(dismissed).getTime();
        if (Date.now() - dismissedMs < TIP_COOLDOWN_MS) return false;
      }

      return true;
    },

    dismissContributePrompt(): void {
      const config = readConfig();
      if (!config.telemetry) config.telemetry = {};
      config.telemetry.contributePromptDismissedAt = new Date().toISOString();
      writeConfig(config);
    },
  };
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Read the saved contribution choice.
 *
 * Returns:
 *   true  - user explicitly opted in
 *   false - user explicitly opted out
 *   undefined - not yet configured
 *
 * Whether a scan is shared is decided by decideContribution (decision.ts)
 * from this value and the command's flags.
 */
export function readContributeChoice(): boolean | undefined {
  const backend = resolveBackend();
  const enabled = backend.isContributeEnabled();
  // If the user hasn't configured yet, return undefined (not false).
  // The local backend returns true only if explicitly enabled;
  // check the raw config to distinguish "not configured" from "opted out".
  // The @opena2a/shared backend returns the saved value as it is, so only
  // the boolean true is consent: a string such as "false" is not.
  if (enabled === true) return true;
  // Check if there's an explicit choice saved
  const contribute = readConfig().contribute;
  if (contribute?.enabled === true) return true;
  if (contribute?.enabled !== false) return undefined;
  if (recordEarlierNo()) return false;
  if (hasUnmarkedOff()) return undefined;
  return false;
}

/**
 * True when the config holds `enabled: false, consentedAt: null` with no
 * `decidedAt`. @opena2a/shared writes that pair as its defaults whenever it
 * saves the file, and the bundled scanner saves it on every run, so on its
 * own it is not a choice. A choice saved through ai-trust carries
 * `decidedAt`, but a "no" saved by ai-trust 0.7.6 does not. That "no" also
 * writes the dismissal timestamp, which the consent tip writes too from the
 * third counted scan on, so only earlierNoTime() tells some of them apart.
 */
export function hasUnmarkedOff(): boolean {
  return isUnmarkedOff(readConfig());
}

function isUnmarkedOff(config: Opena2aConfig): boolean {
  const contribute = config.contribute;
  return (
    contribute?.enabled === false &&
    contribute.consentedAt === null &&
    typeof contribute.decidedAt !== "string"
  );
}

/**
 * The time of a "no" saved without `decidedAt`, or undefined when the config
 * does not show one. Saving a "no" through @opena2a/shared, as ai-trust 0.7.6
 * and `config contribute off` before `decidedAt` did, writes the dismissal
 * timestamp at once. The consent tip writes it only once the scan count is
 * TIP_SCAN_THRESHOLD or more, in @opena2a/shared, in the bundled scanner and
 * in the local backend above. So an unmarked off with that timestamp and a
 * lower scan count was saved as a "no".
 */
function earlierNoTime(config: Opena2aConfig): string | undefined {
  const dismissedAt = config.telemetry?.contributePromptDismissedAt;
  if (!isUnmarkedOff(config) || typeof dismissedAt !== "string") return undefined;
  const scanCount = config.telemetry?.scanCount ?? 0;
  if (typeof scanCount !== "number" || scanCount >= TIP_SCAN_THRESHOLD) return undefined;
  return dismissedAt;
}

/**
 * Mark a "no" that earlierNoTime() finds with `decidedAt`, set to the time
 * that "no" was saved, and return true; return false when there is none.
 * Each later scan raises the scan count, so without the mark the same file
 * would read as no choice again from the third counted scan on. Called by
 * readContributeChoice() on a saved off, and by runHmaScan() before the
 * bundled scanner runs.
 */
export function recordEarlierNo(): boolean {
  const config = readConfig();
  const decidedAt = earlierNoTime(config);
  if (decidedAt === undefined) return false;
  try {
    config.contribute = { ...config.contribute, decidedAt };
    writeConfig(config);
  } catch {
    // A config that cannot be written still reads as that "no" in this run.
  }
  return true;
}

/**
 * True when the config holds a contribution value that is truthy but not
 * the boolean true, such as the string "false". ai-trust reads that value
 * as no choice, while @opena2a/shared returns it as it is, so a caller that
 * tests the returned value for truth reads it as consent.
 */
export function hasTruthyNonBooleanChoice(): boolean {
  const enabled: unknown = readConfig().contribute?.enabled;
  return Boolean(enabled) && enabled !== true;
}

/**
 * Check whether we should show the contribution tip.
 *
 * Returns true after the 3rd scan if the user hasn't opted in,
 * opted out, or dismissed the tip within the last 30 days.
 */
export function shouldPromptContribute(): boolean {
  return resolveBackend().shouldPromptContribute();
}

/**
 * Increment the scan count. Called after each scan completes,
 * regardless of contribution setting.
 */
export function incrementScanCount(): number {
  return resolveBackend().incrementScanCount();
}

/**
 * Save the user's contribution choice to the config file.
 */
export function saveContributeChoice(enabled: boolean): void {
  resolveBackend().setContributeEnabled(enabled);
  if (!enabled) {
    resolveBackend().dismissContributePrompt();
  }
  // Mark the choice as made, so readContributeChoice() can tell a saved
  // "off" from the defaults other writers of this file fill in.
  const config = readConfig();
  config.contribute = { ...config.contribute, decidedAt: new Date().toISOString() };
  writeConfig(config);
}

/**
 * Record a scan and return a consent tip string if the threshold is reached.
 *
 * After the 3rd scan, returns a non-interactive tip encouraging the user
 * to enable contribution. Returns null if tip should not be shown.
 * This replaces the previous interactive Y/N prompt.
 */
export function recordScanAndMaybeShowTip(): string | null {
  incrementScanCount();

  if (!shouldPromptContribute()) return null;

  // Mark as shown so we respect the 30-day cooldown
  resolveBackend().dismissContributePrompt();

  return [
    "",
    "  Tip: Your scans help build community trust data for MCP servers and AI agents.",
    "  Share pseudonymous results so other developers can make informed security decisions.",
    "  Enable: npx ai-trust check --contribute  (or: ai-trust config contribute on)",
    "",
  ].join("\n");
}

/**
 * Reset the backend (for testing).
 * When forceLocal is true, skips @opena2a/shared resolution and uses the
 * local file-based backend. This allows tests to control config via
 * OPENA2A_HOME without the shared backend ignoring that env var.
 */
export function _resetBackend(forceLocal = false): void {
  _backend = undefined;
  if (forceLocal) {
    _backend = createLocalBackend();
  }
}
