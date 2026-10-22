import { describe, it, expect } from "vitest";
import type { CheckRichBlockInput } from "@opena2a/cli-ui";
import { citeCommandsInText, citeRegistryCommand, citeRegistryCommands } from "./registry-command.js";
import { foreignVoice } from "../../scripts/foreign-voice.mjs";

describe("citeRegistryCommand", () => {
  const rewritten: Array<[string, string]> = [
    ["hackmyagent check mcp:demo-mcp", "npx hackmyagent check mcp:demo-mcp"],
    ["opena2a protect .", "npx opena2a-cli protect ."],
    ["npx opena2a review", "npx opena2a-cli review"],
    ["npx -y opena2a review", "npx -y opena2a-cli review"],
    ["npx --yes opena2a review", "npx --yes opena2a-cli review"],
    ["secretless-ai scan .", "npx secretless-ai scan ."],
    ["  hackmyagent secure .", "  npx hackmyagent secure ."],
    ["hackmyagent", "npx hackmyagent"],
    ["cd pkg && hackmyagent secure .", "cd pkg && npx hackmyagent secure ."],
    ["true; opena2a review", "true; npx opena2a-cli review"],
    ["false || secretless-ai scan", "false || npx secretless-ai scan"],
    ["cat x | hackmyagent secure --stdin", "cat x | npx hackmyagent secure --stdin"],
  ];
  for (const [sent, printed] of rewritten) {
    it(`prints "${sent}" as "${printed}"`, () => {
      expect(citeRegistryCommand(sent)).toBe(printed);
      expect(foreignVoice(citeRegistryCommand(sent))).toEqual([]);
    });
  }

  const kept = [
    "npx hackmyagent check mcp:demo-mcp",
    "npx -y hackmyagent secure .",
    "npx opena2a-cli review",
    "npx secretless-ai scan .",
    "ai-trust check mcp:demo-mcp",
    "npm install -g opena2a-cli",
    "npx hackmyagent check opena2a",
    "hackmyagent-extra run",
    "aws iam update-access-key --status Inactive",
    "",
  ];
  for (const command of kept) {
    it(`keeps "${command}"`, () => {
      expect(citeRegistryCommand(command)).toBe(command);
    });
  }
});

describe("citeCommandsInText", () => {
  const rewritten: Array<[string, string]> = [
    [
      "opena2a protect . — migrates hardcoded secrets into the Secretless vault.",
      "npx opena2a-cli protect . — migrates hardcoded secrets into the Secretless vault.",
    ],
    ["opena2a protect .  — scans for hardcoded secrets", "npx opena2a-cli protect .  — scans for hardcoded secrets"],
    ["secretless-ai scan .", "npx secretless-ai scan ."],
    ["hackmyagent secure --fix", "npx hackmyagent secure --fix"],
    [
      "Add a SOUL.md with safety boundaries. Run: hackmyagent scan-soul to generate one.",
      "Add a SOUL.md with safety boundaries. Run: npx hackmyagent scan-soul to generate one.",
    ],
    ["Rotate the key, then run opena2a protect .", "Rotate the key, then run npx opena2a-cli protect ."],
    ["Run `secretless-ai init` in the project root", "Run `npx secretless-ai init` in the project root"],
    ["Run npx opena2a review again", "Run npx opena2a-cli review again"],
    ["Run npx -y opena2a review", "Run npx -y opena2a-cli review"],
    ["hackmyagent harden-soul . (adds the missing sections)", "npx hackmyagent harden-soul . (adds the missing sections)"],
    ["Rotate the project's key, then run opena2a protect .", "Rotate the project's key, then run npx opena2a-cli protect ."],
    ["grep -n \"x\" a.js && opena2a protect .", "grep -n \"x\" a.js && npx opena2a-cli protect ."],
    ["Run 'hackmyagent secure . to fix", "Run 'npx hackmyagent secure . to fix"],
  ];
  for (const [sent, printed] of rewritten) {
    it(`prints "${sent}" as "${printed}"`, () => {
      expect(citeCommandsInText(sent)).toBe(printed);
      expect(foreignVoice(citeCommandsInText(sent))).toEqual([]);
    });
  }

  const kept = [
    "Run npx hackmyagent secure --fix, or add the patterns by hand",
    "docker exec <sandbox-container> npx hackmyagent scan --ci /app",
    "npx -y hackmyagent secure .",
    "npx opena2a-cli protect .",
    "npx secretless-ai init",
    "hackmyagent is the scanner ai-trust runs for a local scan.",
    "Report it to opena2a.org/security",
    "Install @opena2a/cli-ui first",
    "See node_modules/hackmyagent dist for the rules",
    "Add .env to .gitignore to prevent committing secrets",
    "xxd 'hackmyagent check.js' | grep -iE \"e280[8-9a-e]|efbb|efb8|f3a0\"",
    "xxd 'opena2a protect.js'",
    "xxd 'src/x hackmyagent check.js'",
    "xxd 'it'\\''s hackmyagent check.js'",
    "cat \"secretless-ai scan.js\"",
    "cat \"a \\\" hackmyagent check.js\"",
    "",
  ];
  for (const text of kept) {
    it(`keeps "${text}"`, () => {
      expect(citeCommandsInText(text)).toBe(text);
    });
  }

  it("keeps a quoted file name and rewrites the command after it", () => {
    expect(citeCommandsInText("cat 'opena2a protect.js' | hackmyagent secure --stdin")).toBe(
      "cat 'opena2a protect.js' | npx hackmyagent secure --stdin",
    );
  });
});

describe("citeRegistryCommands", () => {
  const input = {
    name: "demo-mcp",
    artifactType: "mcp",
    header: { trustVerdict: "LISTED_UNSCANNED", findingsCount: 0 },
    hardcodedSecrets: {
      scanCovered: true,
      detected: [
        {
          type: "demo_token",
          typeLabel: "Demo token",
          file: "src/index.js",
          maskedValue: "FAKE****",
          shownChars: 4,
          totalChars: 12,
          shipsInArtifact: true,
          severity: "high",
          rotationCommand: "secretless-ai scan .",
        },
        {
          type: "demo_url",
          typeLabel: "Demo URL",
          file: "src/index.js",
          maskedValue: "FAKE****",
          shownChars: 4,
          totalChars: 12,
          shipsInArtifact: false,
          severity: "low",
        },
      ],
    },
    latestVersion: "1.0.0",
    findings: [],
    verdictReasoning: [{ kind: "gap", text: "Run hackmyagent secure . to see more" }],
    nextSteps: [
      { weight: "primary", label: "Scan locally", command: "hackmyagent check mcp:demo-mcp" },
      { weight: "secondary", label: "Read more", url: "docs/demo-mcp" },
    ],
    reportTool: "ai-trust",
  } as unknown as CheckRichBlockInput;

  it("rewrites the next-step and rotation commands and nothing else", () => {
    const before = JSON.parse(JSON.stringify(input));
    const out = citeRegistryCommands(input);

    expect(out.nextSteps).toEqual([
      { weight: "primary", label: "Scan locally", command: "npx hackmyagent check mcp:demo-mcp" },
      { weight: "secondary", label: "Read more", url: "docs/demo-mcp" },
    ]);
    expect(out.hardcodedSecrets.detected.map((s) => s.rotationCommand)).toEqual([
      "npx secretless-ai scan .",
      undefined,
    ]);
    expect(out.hardcodedSecrets.detected[1]).toBe(input.hardcodedSecrets.detected[1]);
    expect(out.hardcodedSecrets.scanCovered).toBe(true);
    expect(out.verdictReasoning).toBe(input.verdictReasoning);
    expect({ ...out, nextSteps: [], hardcodedSecrets: {} }).toEqual({
      ...before,
      nextSteps: [],
      hardcodedSecrets: {},
    });
    // The input is not changed.
    expect(input).toEqual(before);
  });
});
