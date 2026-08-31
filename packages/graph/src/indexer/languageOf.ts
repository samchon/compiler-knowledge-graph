import { GraphLanguage } from "../typings";
import { languagesOf } from "./languagesOf";

export function languageOf(file: string): GraphLanguage {
  const candidates = languagesOf(file);
  // Compatibility surfaces with one language retain C as the default for a
  // shared .h. Indexing uses languagesOf() and therefore never partitions the
  // header away from C++ before semantic ownership can be resolved.
  if (candidates.includes("c")) return "c";
  return candidates[0] ?? "unknown";
}
