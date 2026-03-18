/**
 * Telemetry module -- community contribution of anonymized scan findings.
 */

export {
  generateContributorToken,
  buildContributionPayload,
  submitContribution,
  queueScanResult,
  flushQueue,
  type ContributionFinding,
  type ContributionPayload,
  type ContributionResult,
  type ContributionEvent,
  type ContributionBatch,
} from "./contribute.js";

export {
  isContributeEnabled,
  shouldPromptContribute,
  incrementScanCount,
  saveContributeChoice,
  showContributePrompt,
  recordScanAndMaybeShowTip,
} from "./opt-in.js";
