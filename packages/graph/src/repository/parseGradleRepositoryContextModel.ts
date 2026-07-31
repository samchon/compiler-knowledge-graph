/** Parse the line-framed output produced by the packaged Gradle Tooling helper. */
export function parseGradleRepositoryContextModel(
  output: string,
): parseGradleRepositoryContextModel.IModel {
  let version = "";
  const modules = new Map<string, parseGradleRepositoryContextModel.IModule>();
  for (const raw of output.split(/\r?\n/)) {
    if (raw.trim() === "") continue;
    const [kind, ...encoded] = raw.split("\t");
    const fields = encoded.map((value) =>
      Buffer.from(value, "base64url").toString("utf8"),
    );
    if (kind === "V" && fields.length === 1) {
      version = fields[0]!;
    } else if (kind === "M" && fields.length === 3) {
      modules.set(fields[0]!, {
        path: fields[0]!,
        name: fields[1]!,
        directory: fields[2]!,
        dependencies: [],
        sources: [],
        tasks: [],
      });
    } else if (kind === "D" && fields.length === 2) {
      requiredModule(modules, fields[0]!).dependencies.push(fields[1]!);
    } else if (kind === "S" && fields.length === 4) {
      requiredModule(modules, fields[0]!).sources.push({
        kind: fields[1]!,
        directory: fields[2]!,
        generated: fields[3] === "true",
      });
    } else if (kind === "T" && fields.length === 3) {
      requiredModule(modules, fields[0]!).tasks.push({
        path: fields[1]!,
        name: fields[2]!,
      });
    } else {
      throw new Error("Gradle Tooling API helper returned a malformed model");
    }
  }
  if (version === "" || modules.size === 0) {
    throw new Error("Gradle Tooling API helper returned an empty model");
  }
  return { version, modules: [...modules.values()] };
}

export namespace parseGradleRepositoryContextModel {
  export interface IModel {
    version: string;
    modules: IModule[];
  }

  export interface IModule {
    path: string;
    name: string;
    directory: string;
    dependencies: string[];
    sources: Array<{
      kind: string;
      directory: string;
      generated: boolean;
    }>;
    tasks: Array<{ path: string; name: string }>;
  }
}

function requiredModule(
  modules: ReadonlyMap<string, parseGradleRepositoryContextModel.IModule>,
  project: string,
): parseGradleRepositoryContextModel.IModule {
  const found = modules.get(project);
  if (found === undefined) {
    throw new Error(
      `Gradle Tooling API helper referenced unknown project ${project}`,
    );
  }
  return found;
}
