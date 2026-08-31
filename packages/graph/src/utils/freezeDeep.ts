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
 *
 * What joins it is the tree that was handed in and the values hanging directly
 * off it, not every object underneath. A later walk arrives at sealed work
 * through a reference somebody kept, and the references anybody keeps are the
 * slice and its lanes: a republished generation is a fresh envelope around the
 * same `nodes` and `edges`, so recording those two arrays skips both in full.
 * Recording every object underneath skips the same walks and costs the process
 * a weak record of millions of entries per generation, which the collector
 * then carries for the rest of the run — on a C++ project of 1.3 million
 * relationships that showed up as seals of nineteen seconds among seals of
 * four hundred milliseconds, growing with each generation. Root and lanes is
 * flat, and the republish it exists for still costs nothing.
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
  if (typeof value === "object" && value !== null) {
    SEALED.add(value);
    // Read rather than described: the walk above already refused every own
    // property that was not a plain value, so there is no getter here to run.
    for (const key of Reflect.ownKeys(value)) {
      const lane = (value as Record<PropertyKey, unknown>)[key];
      if (typeof lane === "object" && lane !== null) SEALED.add(lane);
    }
  }
  return value;
}

function enqueue(pending: object[], value: unknown): void {
  if (typeof value === "object" && value !== null) pending.push(value);
}

const SEALED = new WeakSet<object>();
