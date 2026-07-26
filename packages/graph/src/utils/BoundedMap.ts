/**
 * A memo that cannot become a leak.
 *
 * Two derivations in the provider layer remember an answer for the life of the
 * process: a toolchain's last reported version and a compilation database's
 * parsed compiler list. Both are keyed by something that changes when the thing
 * behind it is replaced, so a developer rebuilding a local toolchain or
 * regenerating a database in a loop adds one permanently dead entry per
 * rebuild. Neither map is large enough to matter in an afternoon and neither
 * has any reason to be unbounded in a server that runs for weeks.
 *
 * The oldest entry goes first because the newest answers are the ones a caller
 * is about to ask for again; a re-set key is re-inserted so that using an entry
 * keeps it.
 */
export class BoundedMap<Value> {
  private readonly entries = new Map<string, Value>();

  public constructor(private readonly maximum: number) {}

  public get(key: string): Value | undefined {
    return this.entries.get(key);
  }

  public set(key: string, value: Value): void {
    if (this.entries.has(key)) this.entries.delete(key);
    else if (this.entries.size >= this.maximum) {
      const oldest = this.entries.keys().next();
      /* c8 ignore next -- a non-empty map at its bound has a first key. */
      if (oldest.done !== true) this.entries.delete(oldest.value);
    }
    this.entries.set(key, value);
  }

  public get size(): number {
    return this.entries.size;
  }
}
