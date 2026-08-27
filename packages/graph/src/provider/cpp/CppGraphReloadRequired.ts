/**
 * Raised when a delta cannot be adapted without bodies the adapter does not
 * keep.
 *
 * A reload re-adapts every shard, and only a full generation carries them.
 * `CppGraphSnapshotAdapter` remembers a published shard by the seven strings
 * its manifest, universe and handshake are built from, not by its graph -- on a
 * 242 translation-unit project the difference is gigabytes held to answer
 * questions about names. The client answers this by forgetting its generation
 * and asking again; the producer still holds every shard, so a reload costs one
 * round trip on a rare event instead of a resident copy of the corpus on every
 * one.
 */
export class CppGraphReloadRequired extends Error {
  public constructor(reason: string) {
    super(`C/C++ clang graph: a full generation is required: ${reason}`);
    this.name = "CppGraphReloadRequired";
  }
}
