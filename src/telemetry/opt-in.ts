/**
 * Contribution Opt-In Prompt
 *
 * Handles the user's consent to share anonymized scan findings
 * with the OpenA2A Registry.
 *
 * Config/counting is delegated to @opena2a/shared (the canonical
 * source for ~/.opena2a/config.json). If @opena2a/shared is not
 * available at runtime, falls back to a local implementation.
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync } from "fs";
import { join } from "path";

// ---------------------------------------------------------------------------
// Shared-library delegation with graceful fallback
// ---------------------------------------------------------------------------

interface ConfigBackend {
  isContributeEnabled(): boolean | undefined;
  setContributeEnabled(enabled: boolean): void;
  incrementScanCount(): number;
  shouldPromptContribute(): boolean;
  dismissContributePrompt(): void;
}

/** Resolved backend -- lazy-initialized on first call. */
let _backend: ConfigBackend | undefined;

function resolveBackend(): ConfigBackend {
  if (_backend) return _backend;

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
        // Shared returns boolean (false when not configured).
        // ai-trust callers expect undefined for "not yet configured",
        // but shouldPromptContribute() handles that distinction via
        // scan-count thresholds, so returning false here is acceptable.
        isContributeEnabled: shared.isContributeEnabled,
        setContributeEnabled: shared.setContributeEnabled,
        incrementScanCount: shared.incrementScanCount,
        shouldPromptContribute: shared.shouldPromptContribute,
        dismissContributePrompt: shared.dismissContributePrompt,
      };
      return _backend;
    }
  } catch {
    // @opena2a/shared not installed -- fall through to local backend
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
    scanCount?: number;
    promptedAtTen?: boolean;
  };
  [key: string]: unknown;
}

function getConfigPath(): string {
  const home =
    process.env.OPENA2A_HOME || join(require("os").homedir(), ".opena2a");
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
  const dir = require("path").dirname(configPath);
  mkdirSync(dir, { recursive: true });
  writeFileSync(configPath, JSON.stringify(config, null, 2) + "\n", {
    mode: 0o600,
  });
}

function createLocalBackend(): ConfigBackend {
  return {
    isContributeEnabled(): boolean | undefined {
      const config = readConfig();
      if (config.contribute?.enabled === true) return true;
      if (config.contribute?.enabled === false) return false;
      return undefined;
    },

    setContributeEnabled(enabled: boolean): void {
      const config = readConfig();
      if (!config.contribute) config.contribute = {};
      config.contribute.enabled = enabled;
      const scanCount = config.contribute.scanCount ?? 0;
      if (scanCount >= 9) config.contribute.promptedAtTen = true;
      writeConfig(config);
    },

    incrementScanCount(): number {
      const config = readConfig();
      if (!config.contribute) config.contribute = {};
      config.contribute.scanCount = (config.contribute.scanCount ?? 0) + 1;
      writeConfig(config);
      return config.contribute.scanCount;
    },

    shouldPromptContribute(): boolean {
      const config = readConfig();
      if (
        config.contribute?.enabled === true ||
        config.contribute?.enabled === false
      ) {
        return false;
      }
      const scanCount = config.contribute?.scanCount ?? 0;
      if (scanCount === 0) return true;
      if (scanCount >= 9 && !config.contribute?.promptedAtTen) return true;
      return false;
    },

    dismissContributePrompt(): void {
      const config = readConfig();
      if (!config.contribute) config.contribute = {};
      config.contribute.promptedAtTen = true;
      writeConfig(config);
    },
  };
}

// ---------------------------------------------------------------------------
// Public API (signatures preserved for backward compatibility)
// ---------------------------------------------------------------------------

/**
 * Check whether the contribution setting is enabled.
 *
 * Returns:
 *   true  - user explicitly opted in
 *   false - user explicitly opted out (or default in shared backend)
 *   undefined - not yet configured (local fallback only; shared backend
 *               defaults to false, so callers should rely on
 *               shouldPromptContribute() for prompt logic)
 */
export function isContributeEnabled(): boolean | undefined {
  return resolveBackend().isContributeEnabled();
}

/**
 * Check whether we should show the contribution prompt.
 *
 * ai-trust-specific: also checks for TTY (non-interactive environments
 * should never prompt). The backend handles scan-count thresholds
 * and cooldown/dismiss logic.
 */
export function shouldPromptContribute(): boolean {
  if (!process.stdin.isTTY || !process.stdout.isTTY) return false;
  return resolveBackend().shouldPromptContribute();
}

/**
 * Increment the scan count. Called after each scan completes,
 * regardless of contribution setting.
 */
export function incrementScanCount(): void {
  resolveBackend().incrementScanCount();
}

/**
 * Save the user's contribution choice to the config file.
 */
export function saveContributeChoice(enabled: boolean): void {
  resolveBackend().setContributeEnabled(enabled);
  if (!enabled) {
    resolveBackend().dismissContributePrompt();
  }
}

/**
 * Display the contribution opt-in prompt and return the user's choice.
 *
 * Uses raw stdin to read a single keypress (Y/N).
 * Returns true if the user opted in, false otherwise.
 */
export async function showContributePrompt(): Promise<boolean> {
  const lines = [
    "",
    "Help improve security for the AI agent community.",
    "",
    "Share anonymized scan findings with the OpenA2A Registry?",
    "No personal data. No source code. Only check pass/fail results.",
    "You can opt out anytime: opena2a config set contribute false",
    "",
    "[Y] Yes, contribute   [N] No thanks",
  ];

  for (const line of lines) {
    process.stderr.write(line + "\n");
  }

  const answer = await readSingleKey();
  const enabled = answer.toLowerCase() === "y";
  saveContributeChoice(enabled);

  if (enabled) {
    process.stderr.write("\nContribution enabled. Thank you.\n");
  } else {
    process.stderr.write(
      "\nContribution disabled. You can enable it later: opena2a config set contribute true\n"
    );
  }

  return enabled;
}

/**
 * Read a single keypress from stdin.
 * Falls back to 'n' after a 30-second timeout.
 */
function readSingleKey(): Promise<string> {
  return new Promise((resolve) => {
    const stdin = process.stdin;
    const wasRaw = stdin.isRaw;

    // Timeout after 30 seconds -- default to 'n'
    const timer = setTimeout(() => {
      cleanup();
      resolve("n");
    }, 30_000);

    function cleanup(): void {
      clearTimeout(timer);
      stdin.removeListener("data", onData);
      if (stdin.isRaw !== wasRaw) {
        stdin.setRawMode(wasRaw ?? false);
      }
      stdin.pause();
    }

    function onData(data: Buffer): void {
      const char = data.toString().trim().toLowerCase();
      cleanup();
      resolve(char || "n");
    }

    stdin.setRawMode(true);
    stdin.resume();
    stdin.once("data", onData);
  });
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
