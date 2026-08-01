export interface IRustGraphUniverse {
  digest: string;
  target: string;
  workspaceRoots: string[];
  toolchains: string[];
  configurations: string[];
}
