/**
 * Telemetry module -- community contribution of anonymized scan findings.
 */

export {
  generateContributorToken,
  buildContributionPayload,
  submitContribution,
  type ContributionFinding,
  type ContributionPayload,
  type ContributionResult,
} from "./contribute.js";

export {
  isContributeEnabled,
  shouldPromptContribute,
  incrementScanCount,
  saveContributeChoice,
  showContributePrompt,
} from "./opt-in.js";
