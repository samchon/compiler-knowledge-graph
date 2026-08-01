export interface IRustGraphPhases {
  semanticMillis: number;
  shardMillis: number;
  encodeMillis: number;
  totalMillis: number;
  cacheHit: boolean;
}
