import { ISamchonGraphDump } from "./structures";

/** Bounded machine-readable identity for the producer(s) that actually served. */
export function routeSummary(dump: ISamchonGraphDump): string {
  const summary = {
    schemaVersion: 1,
    indexer: dump.indexer,
    provenance: (dump.provenance ?? []).map((row) => ({
      provider: row.provider,
      languages: row.languages,
      authority: row.authority,
      producer: {
        tool: row.producer.tool,
        version: row.producer.version,
        schemaVersion: row.producer.schemaVersion,
        protocolVersion: row.producer.protocolVersion,
      },
    })),
  };
  const encoded = JSON.stringify(summary);
  if (Buffer.byteLength(encoded, "utf8") <= ROUTE_SUMMARY_LIMIT) return encoded;
  return JSON.stringify({
    schemaVersion: 1,
    indexer: dump.indexer,
    provenance: [],
    truncated: true,
  });
}

const ROUTE_SUMMARY_LIMIT = 16 * 1024;
