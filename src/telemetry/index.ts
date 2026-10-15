/**
 * Telemetry module -- community contribution of anonymized scan findings.
 */

export {
  generateContributorToken,
  buildContributionPayload,
  submitContribution,
  queueScanResult,
  flushQueue,
  sendScanPing,
  scanPingsSettled,
  type ContributionFinding,
  type ContributionPayload,
  type ContributionEvent,
  type ContributionBatch,
} from "./contribute.js";

export {
  readContributeChoice,
  hasUnmarkedOff,
  incrementScanCount,
  saveContributeChoice,
  recordScanAndMaybeShowTip,
} from "./opt-in.js";

export {
  decideContribution,
  SHARE_QUESTION,
  type ContributionCommand,
  type ContributionDecision,
  type ContributionInputs,
  type ContributionLine,
} from "./decision.js";

export { shareScans, type SharedScan } from "./share.js";
