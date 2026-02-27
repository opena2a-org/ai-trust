/**
 * API client for the OpenA2A Registry trust query endpoints.
 */

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
        "User-Agent": "ai-trust/0.1.0",
      },
    });

    if (!response.ok) {
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
        "User-Agent": "ai-trust/0.1.0",
      },
      body: JSON.stringify({ packages }),
    });

    if (!response.ok) {
      const body = await response.text();
      throw new Error(
        `Registry API returned ${response.status}: ${body}`
      );
    }

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
}
