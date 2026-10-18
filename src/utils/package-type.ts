/**
 * The `--type` option of `check` and `batch`.
 *
 * The registry looks a package up by name and type when a type is given, and
 * its packages are of the AI-native types and of the library type. A value
 * such as `banana` matched no package, so a registered package was reported
 * as missing. A value that is not one of these types is refused before any
 * request.
 */

import { AI_NATIVE_PACKAGE_TYPES, LIBRARY_PACKAGE_TYPE } from "@opena2a/ai-classifier";

/** The package types `--type` accepts, as the classifier names them. */
export const PACKAGE_TYPES: readonly string[] = [...AI_NATIVE_PACKAGE_TYPES, LIBRARY_PACKAGE_TYPE];

/** The accepted values, for the help text of `--type`. */
export function packageTypeChoices(): string {
  return `one of ${PACKAGE_TYPES.join(", ")}`;
}

/**
 * The error message for a `--type` value that is not a package type, or
 * undefined when no type was given or the type is one of PACKAGE_TYPES.
 */
export function packageTypeProblem(value: string | undefined): string | undefined {
  if (value === undefined || PACKAGE_TYPES.includes(value)) return undefined;
  return `--type must be ${packageTypeChoices()}; got ${JSON.stringify(value)}`;
}
