/**
 * One published fact as text that depends on its content and not on key order.
 *
 * `JSON.stringify` would be shorter and wrong: it preserves insertion order, so
 * two structurally identical nodes built by different code paths -- a strict
 * provider's and a fallback's -- would render differently while describing the
 * same thing.
 *
 * Nothing is remembered here, and that was measured rather than assumed. A
 * generation is sealed by digests computed in several places, all walking the
 * same facts, so keeping each fact's text against the fact looked free: on a
 * small walk it was, and it took the seal from 36 seconds to 31.
 *
 * At the scale that matters it inverts. A C++ project of 52 units holds 1.3
 * million relationships, a few generations pass through one process, and the
 * weak map that remembers them ends up holding millions of entries for objects
 * that are already gone. Looking a fact up in it became fifty-three percent of
 * a whole run -- the lookup, not the serializing, which was one and a half.
 * Writing the text again costs microseconds; asking whether it was already
 * written cost more than writing it.
 */
export function canonicalFactText(value: unknown): string {
  if (value === undefined) return "null";
  if (value === null || typeof value !== "object") {
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) {
    return `[${value.map(canonicalFactText).join(",")}]`;
  }
  const entries = Object.entries(value as Record<string, unknown>)
    .filter(([, entry]) => entry !== undefined)
    .sort(([left], [right]) => (left < right ? -1 : 1));
  return `{${entries
    .map(([key, entry]) => `${JSON.stringify(key)}:${canonicalFactText(entry)}`)
    .join(",")}}`;
}
