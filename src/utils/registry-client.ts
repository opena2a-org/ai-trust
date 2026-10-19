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
 *
 * When the first attempt timed out, a line on stderr says so before the
 * second one starts. When the second attempt also times out, the error
 * names the registry URL, the time both attempts took and the limit of each,
 * instead of the dependency's "timed out after 15000ms", which counts one.
 *
 * The dependency's `checkTrust(name, type)` sends no ecosystem. A client
 * created with an `ecosystem` adds it to each trust query, so a
 * `pip:<name>` target is asked about as a PyPI package (#131).
 */

import chalk from "chalk";
import { RegistryClient } from "@opena2a/registry-client";
import { stripControlCharacters } from "../output/sanitize.js";

/** Explicit per-request timeout, raised from the dependency's 10000 ms default. */
export const REGISTRY_TIMEOUT_MS = 15000;

/** Backoff between the two attempts; keeps the worst case at 30500 ms. */
export const REGISTRY_RETRY_BACKOFF_MS = 500;

/** Idempotent lookup methods that get the single retry. Writes never retry. */
const RETRYABLE_METHODS = ["checkTrust", "batchQuery"] as const;

/** The path `checkTrust` sends its query to. */
const TRUST_QUERY_PATH = "/api/v1/trust/query";

export interface CreateRegistryClientOptions {
  baseUrl: string;
  userAgent: string;
  /**
   * The ecosystem of the package this client looks up, added to each
   * trust query as `ecosystem=<value>`. Batch and publish requests are
   * sent as the dependency builds them (`batchQuery` takes an ecosystem
   * per package). Unset: the trust query carries no ecosystem.
   */
  ecosystem?: "npm" | "pypi";
  /** Injectable transport for tests; defaults to the runtime's global fetch. */
  fetch?: typeof fetch;
  /** Backoff before the single retry (default 500 ms). Tests pass 0 to stay fast. */
  retryBackoffMs?: number;
  /** Per-request timeout (default REGISTRY_TIMEOUT_MS). Tests pass a short one. */
  timeoutMs?: number;
  /**
   * Prints the line said before the second attempt when the first timed out.
   * Defaults to stderr, so `--json` output on stdout stays one document.
   */
  notice?: (line: string) => void;
}

/**
 * True only when the transport itself failed: the client maps an aborted
 * fetch to code "timeout" and any other thrown transport error to code
 * "network". Every response the registry actually produced (404 →
 * PackageNotFoundError, 4xx/5xx → other RegistryApiError codes) is a
 * registry that answered, and is not transient.
 */
export function isTransientRegistryError(err: unknown): boolean {
  return errorCode(err) === "timeout" || errorCode(err) === "network";
}

function errorCode(err: unknown): unknown {
  return err instanceof Error ? (err as Error & { code?: unknown }).code : undefined;
}

/**
 * The text of a registry error to show the user. The client starts the
 * errors it raises before sending a request with its class name
 * ("RegistryClient: package name contains control characters"), which is
 * left out.
 */
export function registryErrorMessage(err: unknown): string {
  const message = err instanceof Error ? err.message : String(err);
  const stripped = message.replace(/^RegistryClient: /, "");
  return stripped === message ? message : stripped.charAt(0).toUpperCase() + stripped.slice(1);
}

/** A lookup whose last attempt timed out; `code` reads as transient. */
export class RegistryTimeoutError extends Error {
  readonly code = "timeout";
  constructor(message: string) {
    super(message);
    this.name = "RegistryTimeoutError";
  }
}

/** Milliseconds as seconds for a message: 30612 -> "30.6 s", 500 -> "0.5 s". */
function seconds(ms: number): string {
  return `${Number((ms / 1000).toFixed(1))} s`;
}

/** The registry URL as printed: without a user name or password in it. */
function shownUrl(baseUrl: string): string {
  try {
    const url = new URL(baseUrl);
    url.username = "";
    url.password = "";
    return url.toString().replace(/\/+$/, "");
  } catch {
    return baseUrl;
  }
}

/**
 * Which registry a failed request went to and what happened, as a clause:
 * `the registry at <url> did not answer` when the transport failed (after
 * the retry), `the registry at <url> answered <status>` when the registry
 * answered with an HTTP error. `check --no-scan`, `batch` and `audit` print
 * it after their `Error:` line, so the three name the registry the same way.
 * Undefined for an error the registry client did not raise. The URL is
 * `--registry-url` or its default, with control characters removed.
 */
export function registryFailure(
  err: unknown,
  registryUrl: string,
): string | undefined {
  const registry = `the registry at ${stripControlCharacters(registryUrl)}`;
  if (isTransientRegistryError(err)) return `${registry} did not answer`;
  if (!(err instanceof Error)) return undefined;
  const { code, statusCode } = err as Error & { code?: unknown; statusCode?: unknown };
  if (typeof statusCode !== "number") return undefined;
  // The client gives "invalid_response" to an answer whose body is not JSON,
  // with that answer's status.
  if (code === "invalid_response") {
    return `${registry} answered ${statusCode} with a body that is not JSON`;
  }
  return `${registry} answered ${statusCode}`;
}

/** `registryFailure` as a sentence of its own: `The registry at <url> ...`. */
export function registryFailureSentence(
  err: unknown,
  registryUrl: string,
): string | undefined {
  const failure = registryFailure(err, registryUrl);
  if (failure === undefined) return undefined;
  return `${failure.charAt(0).toUpperCase()}${failure.slice(1)}.`;
}

/**
 * A transport that adds `ecosystem` to the trust query's URL and passes
 * every other request through unchanged.
 */
function withTrustQueryEcosystem(
  fetchImpl: typeof fetch,
  ecosystem: string,
): typeof fetch {
  return (input, init) => {
    if (typeof input === "string") {
      const url = new URL(input);
      if (url.pathname.endsWith(TRUST_QUERY_PATH)) {
        url.searchParams.set("ecosystem", ecosystem);
        return fetchImpl(url.toString(), init);
      }
    }
    return fetchImpl(input, init);
  };
}

export function createRegistryClient(
  options: CreateRegistryClientOptions,
): RegistryClient {
  const { baseUrl, userAgent, ecosystem } = options;
  const retryBackoffMs = options.retryBackoffMs ?? REGISTRY_RETRY_BACKOFF_MS;
  const timeoutMs = options.timeoutMs ?? REGISTRY_TIMEOUT_MS;
  const notice = options.notice ?? ((line: string) => console.error(chalk.dim(line)));
  const fetchImpl =
    ecosystem !== undefined
      ? withTrustQueryEcosystem(options.fetch ?? globalThis.fetch, ecosystem)
      : options.fetch;

  const client = new RegistryClient({
    baseUrl,
    userAgent,
    timeoutMs,
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
      const startedAt = Date.now();
      try {
        return await attempt(...args);
      } catch (err) {
        if (!isTransientRegistryError(err)) throw err;
        if (errorCode(err) === "timeout") {
          notice(
            `  The registry at ${shownUrl(baseUrl)} did not answer within ${timeoutMs} ms; trying once more.`,
          );
        }
        if (retryBackoffMs > 0) {
          await new Promise((resolve) => setTimeout(resolve, retryBackoffMs));
        }
        // Exactly one extra attempt. A second transport failure propagates;
        // a second timeout says how long both attempts took.
        try {
          return await attempt(...args);
        } catch (retryErr) {
          if (errorCode(retryErr) !== "timeout") throw retryErr;
          throw new RegistryTimeoutError(
            `Registry request timed out: the registry at ${shownUrl(baseUrl)} did not answer in ${seconds(Date.now() - startedAt)} (2 attempts of up to ${timeoutMs} ms each)`,
          );
        }
      }
    };
  }
  return client;
}
