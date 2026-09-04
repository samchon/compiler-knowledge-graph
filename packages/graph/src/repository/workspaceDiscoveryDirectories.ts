import path from "node:path";

import { isSubPath } from "../utils/isSubPath";

/** Directory identities whose immediate entries can reveal a new member. */
export function workspaceDiscoveryDirectories(
  workspaceRoot: string,
  members: readonly string[],
): string[] {
  const root = path.resolve(workspaceRoot);
  const found = new Set<string>([root]);
  for (const member of members) {
    let directory = path.dirname(path.resolve(member));
    while (isSubPath(root, directory)) {
      found.add(directory);
      if (isSubPath(directory, root)) break;
      directory = path.dirname(directory);
    }
  }
  return [...found].sort(compareText);
}

function compareText(left: string, right: string): number {
  return left < right ? -1 : 1;
}
