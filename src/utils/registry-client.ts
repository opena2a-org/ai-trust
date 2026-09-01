/**
 * Shared RegistryClient factory — the single construction site for the
 * registry client in ai-trust (AIT-01).
 *
 * Why a factory: `@opena2a/registry-client` 0.2.0 defaults `timeoutMs` to
 * 10000 and offers no retry. Six independent construction sites each
 * silently inherited that default, so one cold-start timeout on the
 * registry degraded `check` output to an error block. Every caller now
 * goes through `createRegistryClient`, which:
 *
 * - passes an explicit `timeoutMs` of 15000, and
 * - retries ONCE (two attempts total, 500 ms backoff between them) when
 *   the transport itself died — `RegistryApiError` code `"timeout"` or
 *   `"network"` — bounding the worst case at 30500 ms per lookup.
 *
 * A registry that ANSWERS is never retried: 404 propagates as
 * `PackageNotFoundError`, and 4xx/5xx propagate as `RegistryApiError`
 * (`bad_request`, `unauthorized`, `forbidden`, `rate_limited`,
 * `server_error`) on the first attempt. Retrying an answering registry
 * would double load on a service that is not cold-starting.
 *
 * Only idempotent lookups (`checkTrust`, `batchQuery`) retry.
 * `publishScan` is a write — retrying it after a timeout could publish
 * the same scan twice, so it keeps single-attempt semantics.
 */

import { RegistryClient } from "@opena2a/registry-client";

/** Explicit per-request timeout, raised from the dependency's 10000 ms default. */
export const REGISTRY_TIMEOUT_MS = 15000;

/** Backoff between the two attempts; keeps the worst case at 30500 ms. */
export const REGISTRY_RETRY_BACKOFF_MS = 500;

/** Idempotent lookup methods that get the single retry. Writes never retry. */
const RETRYABLE_METHODS = ["checkTrust", "batchQuery"] as const;

export interface CreateRegistryClientOptions {
  baseUrl: string;
  userAgent: string;
  /** Injectable transport for tests; defaults to the runtime's global fetch. */
  fetch?: typeof fetch;
  /** Backoff before the single retry (default 500 ms). Tests pass 0 to stay fast. */
  retryBackoffMs?: number;
}

/**
 * True only when the transport itself failed: the client maps an aborted
 * fetch to code "timeout" and any other thrown transport error to code
 * "network". Every response the registry actually produced (404 →
 * PackageNotFoundError, 4xx/5xx → other RegistryApiError codes) is a
 * registry that answered, and is not transient.
 */
function isTransientRegistryError(err: unknown): boolean {
  if (!(err instanceof Error)) return false;
  const code = (err as Error & { code?: unknown }).code;
  return code === "timeout" || code === "network";
}

export function createRegistryClient(
  options: CreateRegistryClientOptions,
): RegistryClient {
  const { baseUrl, userAgent, fetch: fetchImpl } = options;
  const retryBackoffMs = options.retryBackoffMs ?? REGISTRY_RETRY_BACKOFF_MS;

  const client = new RegistryClient({
    baseUrl,
    userAgent,
    timeoutMs: REGISTRY_TIMEOUT_MS,
    ...(fetchImpl !== undefined ? { fetch: fetchImpl } : {}),
  });

  const mutable = client as unknown as Record<string, unknown>;
  for (const method of RETRYABLE_METHODS) {
    const original = mutable[method];
    if (typeof original !== "function") continue;
    const attempt = (original as (...args: unknown[]) => Promise<unknown>).bind(
      client,
    );
    mutable[method] = async (...args: unknown[]) => {
      try {
        return await attempt(...args);
      } catch (err) {
        if (!isTransientRegistryError(err)) throw err;
        if (retryBackoffMs > 0) {
          await new Promise((resolve) => setTimeout(resolve, retryBackoffMs));
        }
        // Exactly one extra attempt. A second transport failure propagates.
        return attempt(...args);
      }
    };
  }
  return client;
}
