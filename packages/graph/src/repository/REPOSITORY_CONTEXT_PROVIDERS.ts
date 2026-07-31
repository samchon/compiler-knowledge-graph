import { cargoRepositoryContextProvider } from "./cargoRepositoryContextProvider";
import { cmakeRepositoryContextProvider } from "./cmakeRepositoryContextProvider";
import { gradleRepositoryContextProvider } from "./gradleRepositoryContextProvider";
import { pnpmRepositoryContextProvider } from "./pnpmRepositoryContextProvider";
import { validateRepositoryContextProviders } from "./validateRepositoryContextProviders";

/** Built-in sibling repository-context provider registry. */
export const REPOSITORY_CONTEXT_PROVIDERS =
  validateRepositoryContextProviders([
    pnpmRepositoryContextProvider,
    cargoRepositoryContextProvider,
    gradleRepositoryContextProvider,
    cmakeRepositoryContextProvider,
  ]);
