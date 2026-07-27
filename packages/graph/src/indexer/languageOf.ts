import path from "node:path";
import { GraphLanguage } from "../typings";
import { LANGUAGE_SPECS } from "./LANGUAGE_SPECS";

export function languageOf(file: string): GraphLanguage {
  const exact = path.extname(file);
  for (const spec of LANGUAGE_SPECS) {
    if (spec.extensions.includes(exact)) return spec.language;
  }
  const folded = exact.toLowerCase();
  if (folded !== exact) {
    for (const spec of LANGUAGE_SPECS) {
      if (spec.extensions.includes(folded)) return spec.language;
    }
  }
  return "unknown";
}
