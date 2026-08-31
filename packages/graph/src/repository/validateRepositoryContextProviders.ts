import { IRepositoryContextProvider } from "./IRepositoryContextProvider";

/** Validate unique, non-empty repository-context provider contracts. */
export function validateRepositoryContextProviders(
  providers: readonly IRepositoryContextProvider[],
): readonly IRepositoryContextProvider[] {
  const names = new Set<string>();
  for (const provider of providers) {
    if (provider.name.trim() === "" || names.has(provider.name)) {
      throw new Error(
        `repository context registry has an invalid provider name: ${provider.name}`,
      );
    }
    names.add(provider.name);
    if (provider.ecosystem.trim() === "" || provider.families.length === 0) {
      throw new Error(
        `repository context registry provider ${provider.name} has an empty contract`,
      );
    }
  }
  return Object.freeze([...providers]);
}
