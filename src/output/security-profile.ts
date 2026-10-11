/**
 * Reader for the registry's `securityProfile` on a trust answer.
 *
 * `@opena2a/registry-client` asks the registry for the profile
 * (`includeProfile=true`) and passes the response body through, but its
 * `TrustAnswer` type does not declare the field. Without this reader the
 * registry's own finding counts never reached the user: a package whose
 * profile recorded a high finding rendered as "No known issues".
 *
 * Only values the registry actually returned are read. A profile without
 * numeric critical and high counts yields `undefined`, so callers omit the
 * line or field instead of showing zeros the registry never reported.
 */

import type { TrustAnswer } from "@opena2a/registry-client";

/** The finding summary the registry records in a package's security profile. */
export interface RegistrySecurityProfile {
  /** Critical findings recorded by the registry's last scan. */
  criticalCount: number;
  /** High findings recorded by the registry's last scan. */
  highCount: number;
  /** Known CVE / advisory identifiers recorded for the package. */
  knownCves: string[];
}

function isCount(value: unknown): value is number {
  return typeof value === "number" && Number.isInteger(value) && value >= 0;
}

function advisoryId(entry: unknown): string | undefined {
  if (typeof entry === "string") return entry.trim() || undefined;
  if (entry && typeof entry === "object") {
    const record = entry as Record<string, unknown>;
    for (const key of ["id", "cveId", "cve"]) {
      const value = record[key];
      if (typeof value === "string" && value.trim()) return value.trim();
    }
  }
  return undefined;
}

/** Read the registry's security profile from a trust answer, if it carries one. */
export function readSecurityProfile(
  answer: TrustAnswer,
): RegistrySecurityProfile | undefined {
  const profile = (answer as TrustAnswer & { securityProfile?: unknown })
    .securityProfile;
  if (!profile || typeof profile !== "object") return undefined;
  const record = profile as Record<string, unknown>;
  if (!isCount(record.criticalCount) || !isCount(record.highCount)) {
    return undefined;
  }
  const knownCves = Array.isArray(record.knownCves)
    ? record.knownCves
        .map(advisoryId)
        .filter((id): id is string => id !== undefined)
    : [];
  return {
    criticalCount: record.criticalCount,
    highCount: record.highCount,
    knownCves,
  };
}

/** True when the profile records any critical or high finding or known CVE. */
export function hasRecordedIssues(profile: RegistrySecurityProfile): boolean {
  return (
    profile.criticalCount > 0 ||
    profile.highCount > 0 ||
    profile.knownCves.length > 0
  );
}
