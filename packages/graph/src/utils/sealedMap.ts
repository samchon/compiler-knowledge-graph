import { freezeDeep } from "./freezeDeep";

/**
 * Publish one map's contents behind a view that has no way to change them.
 *
 * Freezing a `Map` does not seal it. Its entries live in an internal slot that
 * `Object.freeze` never touches, and shadowing `set`/`delete`/`clear` as own
 * properties only blocks the method-call syntax: `Map.prototype.set.call(map, …)`
 * still writes. For a published source manifest that is the whole game, since
 * the entry a caller could add afterwards is exactly the unproven digest the
 * snapshot contract refused. The returned view is a frozen plain object rather
 * than a `Map`, so the prototype methods have no compatible receiver to operate
 * on and the entries are reachable only through the reads below.
 */
export function sealedMap<K, V>(
  source: ReadonlyMap<K, V>,
  subject: string,
): ReadonlyMap<K, V> {
  const entries = new Map(source);
  for (const value of entries.values()) freezeDeep(value, subject);
  const view: ReadonlyMap<K, V> = {
    size: entries.size,
    get: (key) => entries.get(key),
    has: (key) => entries.has(key),
    keys: () => entries.keys(),
    values: () => entries.values(),
    entries: () => entries.entries(),
    // Never `entries.forEach`: that hands the callback the backing map as its
    // third argument, which would publish the one reference this view exists to
    // withhold.
    forEach: (callback, thisArg) => {
      for (const [key, value] of entries) callback.call(thisArg, value, key, view);
    },
    [Symbol.iterator]: () => entries[Symbol.iterator](),
  };
  return Object.freeze(view);
}
