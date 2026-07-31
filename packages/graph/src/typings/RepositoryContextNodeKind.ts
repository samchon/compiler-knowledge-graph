/** Version-one repository-context ontology. */
export type RepositoryContextNodeKind =
  | "workspace"
  | "project"
  | "package"
  | "source-set"
  | "source-root"
  | "generated-root"
  | "build-target"
  | "task"
  | "entrypoint";
