/**
 * API client for the OpenA2A Registry trust query endpoints.
 */

import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const pkg = require("../../package.json");
const USER_AGENT = `ai-trust/${pkg.version}`;

export interface TrustAnswer {
  packageId?: string;
  name: string;
  type?: string;
  packageType?: string;
  trustLevel: number;
  trustScore: number;
  verdict: string;
  scanStatus?: string;
  communityScans?: number;
  cveCount?: number;
  recommendation?: string;
  dependencies?: DependencyInfo;
  /** Confidence in the trust score (0.0-1.0), returned by registry */
  confidence?: number;
  /** ISO timestamp of last security scan */
  lastScannedAt?: string;
  // Computed by CLI
  found: boolean;
}

export interface DependencyRiskSummary {
  blocked: number;
  warning: number;
  safe: number;
}

export interface DependencyInfo {
  direct?: number;
  transitive?: number;
  totalDeps: number;
  vulnerableDeps: number;
  minTrustLevel: number;
  minTrustScore: number;
  maxDepth: number;
  riskSummary?: DependencyRiskSummary;
}

export interface BatchResponse {
  results: TrustAnswer[];
  meta: {
    total: number;
    found: number;
    notFound: number;
  };
}

interface RawBatchResponse {
  results: TrustAnswer[];
  total: number;
  queriedAt: string;
}

export interface PackageQuery {
  name: string;
  type?: string;
}

export interface ScanSubmission {
  name: string;
  type?: string;
  score: number;
  maxScore: number;
  findings: ScanFinding[];
  projectType?: string;
  scanTimestamp: string;
  /** Ed25519 signature (hex) if user has an opena2a identity */
  signature?: string;
  /** Public key (hex) of the signer */
  publicKey?: string;
}

export interface ScanFinding {
  checkId: string;
  name: string;
  severity: string;
  passed: boolean;
  message: string;
  category?: string;
  /** Attack taxonomy class this finding maps to (from HMA taxonomy) */
  attackClass?: string;
}

export interface PublishResponse {
  accepted: boolean;
  packageId?: string;
  message?: string;
}

export class PackageNotFoundError extends Error {
  public readonly packageName: string;

  constructor(name: string) {
    super(`Package "${name}" not found in the OpenA2A Registry.`);
    this.name = "PackageNotFoundError";
    this.packageName = name;
  }
}

export class RegistryClient {
  private baseUrl: string;

  constructor(registryUrl: string) {
    this.baseUrl = registryUrl.replace(/\/+$/, "");
  }

  async checkTrust(
    name: string,
    type?: string
  ): Promise<TrustAnswer> {
    const params = new URLSearchParams({
      name,
      includeProfile: "true",
      includeDeps: "true",
    });

    if (type) {
      params.set("type", type);
    }

    const url = `${this.baseUrl}/api/v1/trust/query?${params.toString()}`;
    const response = await fetch(url, {
      method: "GET",
      headers: {
        "Accept": "application/json",
        "User-Agent": USER_AGENT,
      },
    });

    if (!response.ok) {
      if (response.status === 404) {
        throw new PackageNotFoundError(name);
      }
      const body = await response.text();
      throw new Error(
        `Registry API returned ${response.status}: ${body}`
      );
    }

    const data = (await response.json()) as TrustAnswer;
    data.found = !!data.packageId;
    return data;
  }

  async batchQuery(packages: PackageQuery[]): Promise<BatchResponse> {
    const url = `${this.baseUrl}/api/v1/trust/batch`;
    const response = await fetch(url, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "Accept": "application/json",
        "User-Agent": USER_AGENT,
      },
      body: JSON.stringify({ packages }),
    });

    if (!response.ok) {
      const body = await response.text();
      throw new Error(
        `Registry API returned ${response.status}: ${body}`
      );
    }

    // Known issue: The batch endpoint may return different trust scores and
    // package classifications (e.g., express classified as "ai_tool") compared
    // to the single-query endpoint. This is a server-side inconsistency in the
    // registry API, not a client-side bug.
    const raw = (await response.json()) as RawBatchResponse;
    const NULL_UUID = "00000000-0000-0000-0000-000000000000";
    for (const r of raw.results) {
      r.found = !!r.packageId && r.packageId !== NULL_UUID;
    }
    const found = raw.results.filter((r) => r.found).length;
    return {
      results: raw.results,
      meta: {
        total: raw.total,
        found,
        notFound: raw.total - found,
      },
    };
  }

  /**
   * Publish scan results to the community registry.
   */
  async publishScan(
    submission: ScanSubmission
  ): Promise<PublishResponse> {
    const url = `${this.baseUrl}/api/v1/trust/publish`;
    const response = await fetch(url, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "Accept": "application/json",
        "User-Agent": USER_AGENT,
      },
      body: JSON.stringify(submission),
      signal: AbortSignal.timeout(10000),
    });

    if (!response.ok) {
      const body = await response.text();
      throw new Error(
        `Registry publish failed (${response.status}): ${body}`
      );
    }

    return (await response.json()) as PublishResponse;
  }
}
