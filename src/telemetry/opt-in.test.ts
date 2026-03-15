/**
 * Tests for contribution opt-in prompt and config management.
 */

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import * as fs from "fs";
import * as path from "path";
import * as os from "os";
import {
  isContributeEnabled,
  shouldPromptContribute,
  incrementScanCount,
  saveContributeChoice,
  _resetBackend,
} from "./opt-in.js";

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

describe("isContributeEnabled", () => {
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
    expect(isContributeEnabled()).toBeUndefined();
  });

  it("returns undefined when config has no contribute section", () => {
    writeConfig(tempHome, { someOtherKey: true });
    expect(isContributeEnabled()).toBeUndefined();
  });

  it("returns true when contribute.enabled is true", () => {
    writeConfig(tempHome, { contribute: { enabled: true } });
    expect(isContributeEnabled()).toBe(true);
  });

  it("returns false when contribute.enabled is false", () => {
    writeConfig(tempHome, { contribute: { enabled: false } });
    expect(isContributeEnabled()).toBe(false);
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

  it("creates config with scanCount=1 on first call", () => {
    incrementScanCount();
    const config = readConfig(tempHome);
    expect((config.contribute as Record<string, unknown>).scanCount).toBe(1);
  });

  it("increments scanCount on subsequent calls", () => {
    incrementScanCount();
    incrementScanCount();
    incrementScanCount();
    const config = readConfig(tempHome);
    expect((config.contribute as Record<string, unknown>).scanCount).toBe(3);
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
    expect((config.contribute as Record<string, unknown>).scanCount).toBe(1);
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
    expect(isContributeEnabled()).toBe(true);
  });

  it("saves enabled=false", () => {
    saveContributeChoice(false);
    expect(isContributeEnabled()).toBe(false);
  });

  it("sets promptedAtTen when scanCount >= 9", () => {
    writeConfig(tempHome, { contribute: { scanCount: 10 } });
    saveContributeChoice(false);
    const config = readConfig(tempHome);
    expect(
      (config.contribute as Record<string, unknown>).promptedAtTen
    ).toBe(true);
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
  const origStdinIsTTY = process.stdin.isTTY;
  const origStdoutIsTTY = process.stdout.isTTY;

  function setTTY(isTTY: boolean): void {
    Object.defineProperty(process.stdin, "isTTY", {
      value: isTTY,
      writable: true,
      configurable: true,
    });
    Object.defineProperty(process.stdout, "isTTY", {
      value: isTTY,
      writable: true,
      configurable: true,
    });
  }

  beforeEach(() => {
    tempHome = createTempDir();
    process.env.OPENA2A_HOME = tempHome;
    _resetBackend(true);
  });

  afterEach(() => {
    cleanupDir(tempHome);
    delete process.env.OPENA2A_HOME;
    _resetBackend();
    Object.defineProperty(process.stdin, "isTTY", {
      value: origStdinIsTTY,
      writable: true,
      configurable: true,
    });
    Object.defineProperty(process.stdout, "isTTY", {
      value: origStdoutIsTTY,
      writable: true,
      configurable: true,
    });
  });

  it("returns false in non-TTY environment", () => {
    setTTY(false);
    expect(shouldPromptContribute()).toBe(false);
  });

  it("returns false when already opted in", () => {
    setTTY(true);
    writeConfig(tempHome, { contribute: { enabled: true } });
    expect(shouldPromptContribute()).toBe(false);
  });

  it("returns false when already opted out", () => {
    setTTY(true);
    writeConfig(tempHome, { contribute: { enabled: false } });
    expect(shouldPromptContribute()).toBe(false);
  });

  it("returns true on first scan (scanCount=0) in TTY", () => {
    setTTY(true);
    expect(shouldPromptContribute()).toBe(true);
  });

  it("returns true at scan #10 if not yet prompted", () => {
    setTTY(true);
    writeConfig(tempHome, { contribute: { scanCount: 10 } });
    expect(shouldPromptContribute()).toBe(true);
  });

  it("returns false at scan #10 if already prompted", () => {
    setTTY(true);
    writeConfig(tempHome, {
      contribute: { scanCount: 10, promptedAtTen: true },
    });
    expect(shouldPromptContribute()).toBe(false);
  });

  it("returns false between scan 1 and scan 9", () => {
    setTTY(true);
    writeConfig(tempHome, { contribute: { scanCount: 5 } });
    expect(shouldPromptContribute()).toBe(false);
  });
});
