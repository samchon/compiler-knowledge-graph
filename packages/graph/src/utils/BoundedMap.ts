/**
 * A memo that cannot become a leak.
 *
 * The provider layer parses each project's compilation database once and keeps
 * the driver list for the life of the process, keyed by that file's path, size,
 * and modification time — the path because two projects are two answers, the
 * rest because a regenerated database is a third. A developer regenerating one
 * in a loop therefore adds a permanently dead entry per regeneration. It is not
 * large enough to matter in an afternoon, and it has no reason to be unbounded
 * in a server that runs for weeks.
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
}
