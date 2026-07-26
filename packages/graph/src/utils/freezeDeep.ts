/**
 * Seal one already-validated tree in place so no retained reference can edit it.
 *
 * A trust boundary that validates a value and then hands the same object back
 * has not fenced anything: whoever kept the reference can change it afterwards,
 * and the check that passed no longer describes what the graph publishes. This
 * closes that by freezing the tree rather than copying it. A copy would fence
 * the same reference just as well, but a whole-workspace snapshot is exactly the
 * value that must not be duplicated once per publication.
 *
 * Published evidence must be plain data, and any other object is refused rather
 * than waved through. `Object.freeze` only fixes an object's own properties: on
 * a `Map`, `Set`, or `Date` it leaves every mutator working, and on a typed
 * array it throws something that names neither the value nor the field. A
 * function value is left alone rather than refused — it is not data, so nothing
 * in a published tree should hold one, and freezing one would seal a shape this
 * boundary does not own. An accessor is refused for the same reason as the
 * exotic objects: freezing fixes which getter runs and never what it returns, so
 * a value that recomputes itself on every read is precisely the channel this
 * seal exists to close. A caller that needs one of those shapes converts it at
 * the boundary; `sealedMap` is how the source manifest does it.
 *
 * The walk is iterative and remembers what it sealed, so a cycle terminates, a
 * shared subtree is walked once, and a tree already sealed upstream — the common
 * SCIP slice, which is sealed for the enrichment contract and then published —
 * costs one lookup instead of a second full traversal. Objects join that record
 * only after the whole walk succeeds, so a refused tree never leaves a partial
 * seal behind that a later call would trust.
 */
export function freezeDeep<T>(value: T, subject: string): T {
  const walked = new Set<object>();
  const pending: object[] = [];
  enqueue(pending, value);
  while (pending.length > 0) {
    const target = pending.pop()!;
    if (SEALED.has(target) || walked.has(target)) continue;
    const prototype = Object.getPrototypeOf(target) as object | null;
    if (
      prototype !== Object.prototype &&
      prototype !== Array.prototype &&
      prototype !== null
    ) {
      throw new TypeError(
        `@samchon/graph: ${subject} must be plain data, but carries ${Object.prototype.toString.call(target)}`,
      );
    }
    walked.add(target);
    for (const key of Reflect.ownKeys(target)) {
      const descriptor = Object.getOwnPropertyDescriptor(target, key)!;
      if (!("value" in descriptor)) {
        throw new TypeError(
          `@samchon/graph: ${subject} cannot expose an accessor property`,
        );
      }
      enqueue(pending, descriptor.value);
    }
    Object.freeze(target);
  }
  for (const target of walked) SEALED.add(target);
  return value;
}

function enqueue(pending: object[], value: unknown): void {
  if (typeof value === "object" && value !== null) pending.push(value);
}

const SEALED = new WeakSet<object>();
