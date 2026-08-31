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
    let text = "[";
    for (let index = 0; index < value.length; ++index) {
      if (index !== 0) text += ",";
      text += canonicalFactText(value[index]);
    }
    return text + "]";
  }
  // Written by hand rather than through `entries`, `filter`, `sort` and
  // `map`, which is the same text and three intermediate arrays per object.
  // Every node and every edge of a generation passes through here, several
  // times, and on a C++ project of 1.3 million relationships those arrays are
  // most of what the collector spends the run on.
  const keys = Object.keys(value as Record<string, unknown>).sort(
    (left, right) => (left < right ? -1 : 1),
  );
  const record = value as Record<string, unknown>;
  let text = "{";
  let written = false;
  for (const key of keys) {
    const entry = record[key];
    if (entry === undefined) continue;
    if (written) text += ",";
    text += `${JSON.stringify(key)}:${canonicalFactText(entry)}`;
    written = true;
  }
  return text + "}";
}
