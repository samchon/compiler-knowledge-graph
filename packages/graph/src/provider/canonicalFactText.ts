/**
 * One published fact as text that depends on its content and not on key order.
 *
 * `JSON.stringify` would be shorter and wrong: it preserves insertion order, so
 * two structurally identical nodes built by different code paths -- a strict
 * provider's and a fallback's -- would render differently while describing the
 * same thing.
 *
 * The answer is remembered against the fact itself. A generation is sealed by
 * two digests computed in two places, and both walk every node and every edge:
 * serializing each fact once for the process rather than once per digest is
 * most of what sealing a large generation costs. The memory is keyed by
 * identity, so a fact that is genuinely rebuilt gets its own text, and held
 * weakly, so remembering it keeps nothing alive that the generation released.
 */
export function canonicalFactText(value: unknown): string {
  if (value === null || typeof value !== "object") return derive(value);
  const known = remembered.get(value);
  if (known !== undefined) return known;
  const text = derive(value);
  remembered.set(value, text);
  return text;
}

const remembered = new WeakMap<object, string>();

function derive(value: unknown): string {
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
