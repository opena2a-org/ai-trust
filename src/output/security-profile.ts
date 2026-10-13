/**
 * Reader for the registry's `securityProfile` on a trust answer.
 *
 * `@opena2a/registry-client` asks the registry for the profile
 * (`includeProfile=true`) and passes the response body through, but its
 * `TrustAnswer` type does not declare the field. Without this reader the
 * registry's own finding counts never reached the user: a package whose
 * profile recorded a high finding rendered as "No known issues".
 *
 * Each field is read on its own. A count the registry did not return, or
 * returned in a form that is not a count, is left out, so callers say "not
 * reported" instead of showing a zero the registry never reported, and one
 * unreadable field does not hide the others. A profile with no readable count
 * and no advisory identifier yields `undefined`.
 */

import type { TrustAnswer } from "@opena2a/registry-client";

/** The finding summary the registry records in a package's security profile. */
export interface RegistrySecurityProfile {
  /** Critical findings recorded by the registry's last scan, when reported. */
  criticalCount?: number;
  /** High findings recorded by the registry's last scan, when reported. */
  highCount?: number;
  /** Known CVE / advisory identifiers recorded for the package. */
  knownCves: string[];
}

function isCount(value: unknown): value is number {
  return typeof value === "number" && Number.isInteger(value) && value >= 0;
}

/**
 * A count as a number: a non-negative integer, or a string of decimal digits
 * naming one (a 64-bit count serialized as a string). Anything else, such as
 * null, a negative number or a fraction, is not a count.
 */
function readCount(value: unknown): number | undefined {
  if (isCount(value)) return value;
  if (typeof value === "string" && /^\d+$/.test(value.trim())) {
    const parsed = Number(value.trim());
    if (isCount(parsed)) return parsed;
  }
  return undefined;
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

/** Advisory identifiers from a list, or from a single identifier sent bare. */
function readAdvisoryIds(value: unknown): string[] {
  const entries = Array.isArray(value) ? value : [value];
  return entries.map(advisoryId).filter((id): id is string => id !== undefined);
}

/** Read the registry's security profile from a trust answer, if it carries one. */
export function readSecurityProfile(
  answer: TrustAnswer,
): RegistrySecurityProfile | undefined {
  const profile = (answer as TrustAnswer & { securityProfile?: unknown })
    .securityProfile;
  if (!profile || typeof profile !== "object") return undefined;
  const record = profile as Record<string, unknown>;
  const criticalCount = readCount(record.criticalCount);
  const highCount = readCount(record.highCount);
  const knownCves = readAdvisoryIds(record.knownCves);
  if (criticalCount === undefined && highCount === undefined && knownCves.length === 0) {
    return undefined;
  }
  return {
    ...(criticalCount !== undefined ? { criticalCount } : {}),
    ...(highCount !== undefined ? { highCount } : {}),
    knownCves,
  };
}

/** True when the profile records any critical or high finding or known CVE. */
export function hasRecordedIssues(profile: RegistrySecurityProfile): boolean {
  return (
    (profile.criticalCount ?? 0) > 0 ||
    (profile.highCount ?? 0) > 0 ||
    profile.knownCves.length > 0
  );
}
