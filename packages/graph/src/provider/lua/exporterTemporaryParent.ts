import os from "node:os";
import path from "node:path";

type IPathOperations = Pick<
  typeof path,
  "dirname" | "isAbsolute" | "relative" | "resolve"
>;

/**
 * Choose an outside-project generation parent reachable from a LuaLS subpath.
 *
 * POSIX has one path namespace even across mounted filesystems. Windows does
 * not: `path.relative` returns a volume-qualified absolute path when the two
 * operands are on different drives or shares. LuaLS concatenates its configured
 * doc script path onto the project root, so that absolute result cannot work;
 * a sibling of the project is the nearest outside-project parent in the same
 * namespace. A project that is itself the namespace root has no such location
 * and is declined rather than receiving generated index inputs.
 */
export function exporterTemporaryParent(
  root: string,
  temporary: string = os.tmpdir(),
  paths: IPathOperations = path,
): string {
  const project = paths.resolve(root);
  const resolvedTemporary = paths.resolve(temporary);
  const relative = paths.relative(project, resolvedTemporary);
  if (!paths.isAbsolute(relative)) return resolvedTemporary;
  const sibling = paths.dirname(project);
  if (sibling === project) {
    throw new Error(
      "samchon-graph-lua: a filesystem-root project has no outside sibling for its exporter",
    );
  }
  return sibling;
}
