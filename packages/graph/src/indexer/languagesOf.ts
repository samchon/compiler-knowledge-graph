import path from "node:path";

import { GraphLanguage } from "../typings";
import { LANGUAGE_SPECS } from "./LANGUAGE_SPECS";

/** Every exact or case-folded language owner registered for one source. */
export function languagesOf(
  file: string,
): Exclude<GraphLanguage, "unknown">[] {
  const exact = path.extname(file);
  const exactMatches: Exclude<GraphLanguage, "unknown">[] = [];
  for (const spec of LANGUAGE_SPECS) {
    if (spec.language !== "unknown" && spec.extensions.includes(exact)) {
      exactMatches.push(spec.language);
    }
  }
  if (exactMatches.length > 0) return exactMatches;
  const folded = exact.toLowerCase();
  if (folded !== exact) {
    for (const spec of LANGUAGE_SPECS) {
      if (
        spec.language !== "unknown" &&
        spec.extensions.includes(folded)
      ) {
        exactMatches.push(spec.language);
      }
    }
  }
  return exactMatches;
}
