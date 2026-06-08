/**
 * CLI self-citation prefix.
 *
 * ai-trust is bundled by opena2a-cli, which exposes `ai-trust check <pkg>` as
 * the top-level `opena2a registry <pkg>` command (the `registry` adapter
 * delegates to `ai-trust check`, forwarding args — there is NO `check`
 * subcommand on the opena2a side). When opena2a-cli runs us it sets
 * `AI_TRUST_CLI_PREFIX=opena2a registry`, and every user-facing citation of
 * `ai-trust check <pkg>` must render as `opena2a registry <pkg>` instead — the
 * prefix REPLACES the whole `ai-trust check` token pair (the `check` verb is
 * absorbed because `opena2a registry` IS the check command).
 *
 * When the env var is unset, behavior is identical to today: `ai-trust check`.
 *
 * This only governs the `check` surface (the command `opena2a registry`
 * exposes). The `audit`/`batch`/`telemetry` subcommands stay native and are
 * intentionally not routed through this helper.
 */

/** Default citation token for the check command when no prefix is configured. */
const DEFAULT_CHECK_PREFIX = "ai-trust check";

/**
 * The token a self-citation should use in place of `ai-trust check`.
 * Read at call time (not module load) so tests can set/unset the env var
 * between cases without re-importing.
 */
export function checkCitation(): string {
  const prefix = process.env.AI_TRUST_CLI_PREFIX;
  if (prefix && prefix.trim().length > 0) return prefix.trim();
  return DEFAULT_CHECK_PREFIX;
}
