/**
 * Tests for contribution opt-in and scan counting.
 *
 * The new behavior:
 * - Config uses `telemetry.scanCount` and `telemetry.contributePromptDismissedAt`
 * - Tip shown after 3rd scan (non-interactive)
 * - No interactive Y/N prompt
 */

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import * as fs from "fs";
import * as path from "path";
import * as os from "os";
import { createRequire } from "node:module";
import {
  readContributeChoice,
  shouldPromptContribute,
  incrementScanCount,
  saveContributeChoice,
  recordScanAndMaybeShowTip,
  hasUnmarkedOff,
  recordEarlierNo,
  _resetBackend,
} from "./opt-in.js";
import { decideContribution } from "./decision.js";

function createTempDir(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), "ai-trust-optin-test-"));
}

function cleanupDir(dir: string): void {
  fs.rmSync(dir, { recursive: true, force: true });
}

function readConfig(tempHome: string): Record<string, unknown> {
  const configPath = path.join(tempHome, "config.json");
  if (!fs.existsSync(configPath)) return {};
  return JSON.parse(fs.readFileSync(configPath, "utf-8"));
}

function writeConfig(
  tempHome: string,
  config: Record<string, unknown>
): void {
  fs.writeFileSync(
    path.join(tempHome, "config.json"),
    JSON.stringify(config, null, 2)
  );
}

describe("readContributeChoice", () => {
  let tempHome: string;

  beforeEach(() => {
    tempHome = createTempDir();
    process.env.OPENA2A_HOME = tempHome;
    _resetBackend(true);
  });

  afterEach(() => {
    cleanupDir(tempHome);
    delete process.env.OPENA2A_HOME;
    _resetBackend();
  });

  it("returns undefined when no config exists", () => {
    expect(readContributeChoice()).toBeUndefined();
  });

  it("returns undefined when config has no contribute section", () => {
    writeConfig(tempHome, { someOtherKey: true });
    expect(readContributeChoice()).toBeUndefined();
  });

  it("returns true when contribute.enabled is true", () => {
    writeConfig(tempHome, { contribute: { enabled: true } });
    expect(readContributeChoice()).toBe(true);
  });

  it("returns false when contribute.enabled is false", () => {
    // readContributeChoice() correctly distinguishes explicit opt-out (false)
    // from not-yet-configured (undefined)
    writeConfig(tempHome, { contribute: { enabled: false } });
    expect(readContributeChoice()).toBe(false);
  });

  it("returns undefined for the defaults @opena2a/shared writes on any save", () => {
    // The bundled scanner saves the file on every run, filling in these
    // defaults; no choice was made.
    writeConfig(tempHome, {
      version: 1,
      contribute: { enabled: false, consentedAt: null, consentVersion: "1.0" },
      telemetry: { scanCount: 1, contributePromptDismissedAt: null },
    });
    expect(readContributeChoice()).toBeUndefined();
  });
});

describe("readContributeChoice with the @opena2a/shared backend", () => {
  const sharedConfig = createRequire(import.meta.url)("@opena2a/shared") as {
    incrementScanCount(): number;
    shouldPromptContribute(): boolean;
  };
  let tempHome: string;
  let savedHome: string | undefined;

  beforeEach(() => {
    tempHome = createTempDir();
    savedHome = process.env.HOME;
    process.env.HOME = tempHome;
    delete process.env.OPENA2A_HOME;
    _resetBackend();
  });

  afterEach(() => {
    process.env.HOME = savedHome;
    cleanupDir(tempHome);
    _resetBackend();
  });

  function homeConfig(): { contribute?: Record<string, unknown> } {
    return readConfig(path.join(tempHome, ".opena2a"));
  }

  // The saved files of src/contribution-decision-table.test.ts, read as
  // decision.test.ts reads them. First in this block: @opena2a/shared returns
  // a shallow copy of its defaults when there is no file, so a later save of
  // true with no file changes the defaults this process reads.
  it.each([
    ["no", undefined, null],
    ["a true", true, '{"contribute":{"enabled":true,"decidedAt":"2026-01-01T00:00:00.000Z"}}\n'],
    ["a false", false, '{"contribute":{"enabled":false,"decidedAt":"2026-01-01T00:00:00.000Z"}}\n'],
    ['a "true"', undefined, '{"contribute":{"enabled":"true","decidedAt":"2026-01-01T00:00:00.000Z"}}\n'],
    ['a "false"', undefined, '{"contribute":{"enabled":"false","decidedAt":"2026-01-01T00:00:00.000Z"}}\n'],
    ["a not JSON", undefined, '{"contribute":'],
  ])("reads %s config file as %s", (_name, reading, file) => {
    if (file !== null) {
      fs.mkdirSync(path.join(tempHome, ".opena2a"), { recursive: true });
      fs.writeFileSync(path.join(tempHome, ".opena2a", "config.json"), file);
    }
    expect(readContributeChoice()).toBe(reading);
  });

  it("stays not set after another tool's scan saves the file", () => {
    sharedConfig.incrementScanCount();
    expect(homeConfig().contribute).toMatchObject({ enabled: false, consentedAt: null });
    expect(readContributeChoice()).toBeUndefined();
  });

  it.each(["false", "true", 1])(
    "does not read a saved enabled of %j, which is not the boolean true, as consent (#141)",
    (value) => {
      fs.mkdirSync(path.join(tempHome, ".opena2a"), { recursive: true });
      writeConfig(path.join(tempHome, ".opena2a"), { contribute: { enabled: value } });
      expect(readContributeChoice()).toBeUndefined();
      const decision = decideContribution({
        command: "check",
        flag: undefined,
        saved: readContributeChoice(),
        interactive: false,
        scanned: 1,
      });
      expect(decision.send).toBe(false);
    },
  );

  it("keeps a saved off choice through later saves by another tool", () => {
    sharedConfig.incrementScanCount();
    saveContributeChoice(false);
    expect(readContributeChoice()).toBe(false);
    sharedConfig.incrementScanCount();
    expect(readContributeChoice()).toBe(false);
  });

  // ai-trust 0.7.6 saved a "no" with these two calls and nothing else.
  const shared = sharedConfig as typeof sharedConfig & {
    setContributeEnabled(enabled: boolean): void;
    dismissContributePrompt(): void;
  };

  /**
   * Start from the file the bundled scanner leaves after `scans` scans with
   * no choice made. Written out, because @opena2a/shared changes its own
   * defaults in place when it saves with no file, as earlier tests here do.
   */
  function scannerFile(scans: number): void {
    fs.mkdirSync(path.join(tempHome, ".opena2a"), { recursive: true });
    writeConfig(path.join(tempHome, ".opena2a"), {
      version: 1,
      contribute: { enabled: false, consentedAt: null, consentVersion: "1.0" },
      telemetry: { scanCount: scans, contributePromptDismissedAt: null },
    });
  }

  it("reads a no saved by ai-trust 0.7.6 before the third scan as off, and marks it (#133)", () => {
    scannerFile(0);
    expect(hasUnmarkedOff()).toBe(true);
    expect(readContributeChoice()).toBeUndefined();
    shared.setContributeEnabled(false);
    shared.dismissContributePrompt();
    const dismissedAt = (readConfig(path.join(tempHome, ".opena2a")) as {
      telemetry: { contributePromptDismissedAt: string };
    }).telemetry.contributePromptDismissedAt;

    expect(readContributeChoice()).toBe(false);
    expect(homeConfig().contribute).toMatchObject({ enabled: false, decidedAt: dismissedAt });
    expect(hasUnmarkedOff()).toBe(false);

    // Three more scans would have hidden the no without the mark.
    for (let i = 0; i < 3; i++) sharedConfig.incrementScanCount();
    expect(readContributeChoice()).toBe(false);
  });

  it("marks that no before a bundled scanner scan, not only on a read (#133)", () => {
    scannerFile(2);
    shared.setContributeEnabled(false);
    shared.dismissContributePrompt();
    expect(recordEarlierNo()).toBe(true);
    // The scan that follows raises the count to 3, the consent tip's.
    sharedConfig.incrementScanCount();
    expect(readContributeChoice()).toBe(false);
    expect(recordEarlierNo()).toBe(false);
  });

  it("cannot tell a no saved from the third scan on from the consent tip, and flags it", () => {
    scannerFile(3);
    shared.setContributeEnabled(false);
    shared.dismissContributePrompt();
    expect(recordEarlierNo()).toBe(false);
    expect(readContributeChoice()).toBeUndefined();
    expect(hasUnmarkedOff()).toBe(true);

    saveContributeChoice(false);
    expect(readContributeChoice()).toBe(false);
    expect(hasUnmarkedOff()).toBe(false);
  });

  it("reads the consent tip's dismissal as no choice", () => {
    scannerFile(2);
    // The scanner's third scan counts first, then shows the tip and dismisses it.
    sharedConfig.incrementScanCount();
    expect(sharedConfig.shouldPromptContribute()).toBe(true);
    shared.dismissContributePrompt();
    expect(readContributeChoice()).toBeUndefined();
    expect(homeConfig().contribute).not.toHaveProperty("decidedAt");
  });

  it("keeps a saved on choice", () => {
    saveContributeChoice(true);
    sharedConfig.incrementScanCount();
    expect(readContributeChoice()).toBe(true);
  });
});

describe("incrementScanCount", () => {
  let tempHome: string;

  beforeEach(() => {
    tempHome = createTempDir();
    process.env.OPENA2A_HOME = tempHome;
    _resetBackend(true);
  });

  afterEach(() => {
    cleanupDir(tempHome);
    delete process.env.OPENA2A_HOME;
    _resetBackend();
  });

  it("creates config with telemetry.scanCount=1 on first call", () => {
    incrementScanCount();
    const config = readConfig(tempHome);
    expect(
      (config.telemetry as Record<string, unknown>).scanCount
    ).toBe(1);
  });

  it("increments telemetry.scanCount on subsequent calls", () => {
    incrementScanCount();
    incrementScanCount();
    incrementScanCount();
    const config = readConfig(tempHome);
    expect(
      (config.telemetry as Record<string, unknown>).scanCount
    ).toBe(3);
  });

  it("preserves existing config fields", () => {
    writeConfig(tempHome, {
      registry: { url: "https://custom.registry" },
    });
    incrementScanCount();
    const config = readConfig(tempHome);
    expect(
      (config.registry as Record<string, unknown>).url
    ).toBe("https://custom.registry");
    expect(
      (config.telemetry as Record<string, unknown>).scanCount
    ).toBe(1);
  });
});

describe("saveContributeChoice", () => {
  let tempHome: string;

  beforeEach(() => {
    tempHome = createTempDir();
    process.env.OPENA2A_HOME = tempHome;
    _resetBackend(true);
  });

  afterEach(() => {
    cleanupDir(tempHome);
    delete process.env.OPENA2A_HOME;
    _resetBackend();
  });

  it("saves enabled=true", () => {
    saveContributeChoice(true);
    expect(readContributeChoice()).toBe(true);
  });

  it("saves enabled=false and dismisses prompt", () => {
    saveContributeChoice(false);
    const config = readConfig(tempHome);
    expect(
      (config.contribute as Record<string, unknown>).enabled
    ).toBe(false);
    // Dismissing sets contributePromptDismissedAt
    expect(
      (config.telemetry as Record<string, unknown>).contributePromptDismissedAt
    ).toBeTruthy();
  });

  it("creates config file with restricted permissions", () => {
    saveContributeChoice(true);
    const configPath = path.join(tempHome, "config.json");
    const stat = fs.statSync(configPath);
    const mode = (stat.mode & 0o777).toString(8);
    expect(mode).toBe("600");
  });
});

describe("shouldPromptContribute", () => {
  let tempHome: string;

  beforeEach(() => {
    tempHome = createTempDir();
    process.env.OPENA2A_HOME = tempHome;
    _resetBackend(true);
  });

  afterEach(() => {
    cleanupDir(tempHome);
    delete process.env.OPENA2A_HOME;
    _resetBackend();
  });

  it("returns false when already opted in", () => {
    writeConfig(tempHome, { contribute: { enabled: true } });
    expect(shouldPromptContribute()).toBe(false);
  });

  it("returns false when already opted out", () => {
    writeConfig(tempHome, { contribute: { enabled: false } });
    expect(shouldPromptContribute()).toBe(false);
  });

  it("returns false when scan count is below 3", () => {
    writeConfig(tempHome, { telemetry: { scanCount: 2 } });
    expect(shouldPromptContribute()).toBe(false);
  });

  it("returns true when scan count reaches 3 and not dismissed", () => {
    writeConfig(tempHome, { telemetry: { scanCount: 3 } });
    expect(shouldPromptContribute()).toBe(true);
  });

  it("returns false when dismissed within cooldown period", () => {
    writeConfig(tempHome, {
      telemetry: {
        scanCount: 5,
        contributePromptDismissedAt: new Date().toISOString(),
      },
    });
    expect(shouldPromptContribute()).toBe(false);
  });

  it("returns true when dismissed more than 30 days ago", () => {
    const oldDate = new Date(Date.now() - 31 * 24 * 60 * 60 * 1000);
    writeConfig(tempHome, {
      telemetry: {
        scanCount: 10,
        contributePromptDismissedAt: oldDate.toISOString(),
      },
    });
    expect(shouldPromptContribute()).toBe(true);
  });
});

describe("recordScanAndMaybeShowTip", () => {
  let tempHome: string;

  beforeEach(() => {
    tempHome = createTempDir();
    process.env.OPENA2A_HOME = tempHome;
    _resetBackend(true);
  });

  afterEach(() => {
    cleanupDir(tempHome);
    delete process.env.OPENA2A_HOME;
    _resetBackend();
  });

  it("returns null before 3rd scan", () => {
    expect(recordScanAndMaybeShowTip()).toBeNull(); // scan 1
    expect(recordScanAndMaybeShowTip()).toBeNull(); // scan 2
  });

  it("returns tip string on 3rd scan", () => {
    recordScanAndMaybeShowTip(); // scan 1
    recordScanAndMaybeShowTip(); // scan 2
    const tip = recordScanAndMaybeShowTip(); // scan 3
    expect(tip).toBeTruthy();
    expect(tip).toContain("Tip:");
    expect(tip).toContain("npx ai-trust check --contribute");
  });

  it("calls shared results pseudonymous, not anonymized (#141)", () => {
    // A contribution carries a per-device contributor token.
    recordScanAndMaybeShowTip(); // scan 1
    recordScanAndMaybeShowTip(); // scan 2
    const tip = recordScanAndMaybeShowTip(); // scan 3
    expect(tip).toContain("Share pseudonymous results");
    expect(tip).not.toMatch(/anonym/i);
  });

  it("returns null after tip is shown (cooldown)", () => {
    recordScanAndMaybeShowTip(); // 1
    recordScanAndMaybeShowTip(); // 2
    recordScanAndMaybeShowTip(); // 3 -> tip shown
    const fourth = recordScanAndMaybeShowTip(); // 4 -> cooldown
    expect(fourth).toBeNull();
  });

  it("increments scan count each time", () => {
    recordScanAndMaybeShowTip();
    recordScanAndMaybeShowTip();
    const config = readConfig(tempHome);
    expect(
      (config.telemetry as Record<string, unknown>).scanCount
    ).toBe(2);
  });
});
