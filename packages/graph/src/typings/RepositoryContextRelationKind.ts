/** Version-one repository-context relationship vocabulary. */
export type RepositoryContextRelationKind =
  | "contains"
  | "depends-on"
  | "source-of"
  | "test-of"
  | "produces"
  | "invokes"
  | "entrypoint-of"
  | "joins-file";
