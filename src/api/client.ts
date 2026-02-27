/**
 * API client for the OpenA2A Registry trust query endpoints.
 */

export interface TrustAnswer {
  name: string;
  type: string;
  found: boolean;
  verdict: string;
  trustLevel: number;
  trustScore: number;
  cveCount: number;
  recommendation: string;
  profile?: SecurityProfile;
  dependencies?: DependencyInfo;
}

export interface SecurityProfile {
  id: string;
  packageId: string;
  version: string;
  trustFactors: Record<string, unknown>;
  riskIndicators: string[];
  createdAt: string;
}

export interface DependencyInfo {
  direct: number;
  transitive: number;
  maxDepth: number;
  riskSummary: {
    blocked: number;
    warning: number;
    safe: number;
  };
}

export interface BatchResponse {
  results: TrustAnswer[];
  meta: {
    total: number;
    found: number;
    notFound: number;
  };
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
        "User-Agent": "oa2a-cli/0.1.0",
      },
    });

    if (!response.ok) {
      const body = await response.text();
      throw new Error(
        `Registry API returned ${response.status}: ${body}`
      );
    }

    return (await response.json()) as TrustAnswer;
  }

  async batchQuery(packages: PackageQuery[]): Promise<BatchResponse> {
    const url = `${this.baseUrl}/api/v1/trust/batch`;
    const response = await fetch(url, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "Accept": "application/json",
        "User-Agent": "oa2a-cli/0.1.0",
      },
      body: JSON.stringify({ packages }),
    });

    if (!response.ok) {
      const body = await response.text();
      throw new Error(
        `Registry API returned ${response.status}: ${body}`
      );
    }

    return (await response.json()) as BatchResponse;
  }
}
