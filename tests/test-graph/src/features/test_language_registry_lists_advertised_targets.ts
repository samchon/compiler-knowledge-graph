import { TestValidator } from "@nestia/e2e";
import { LANGUAGE_SPECS, languageOf } from "@samchon/graph";

import { GraphFixtures } from "../internal/GraphFixtures";

export const test_language_registry_lists_advertised_targets = () => {
  TestValidator.equals(
    "advertised language order",
    LANGUAGE_SPECS.map((spec) => spec.language),
    GraphFixtures.languageFixtures.map((fixture) => fixture.language),
  );
  for (const fixture of GraphFixtures.languageFixtures) {
    TestValidator.equals(
      `${fixture.language} extension maps to language`,
      languageOf(fixture.file),
      fixture.language,
    );
  }
  for (const extension of [".ipp", ".tpp", ".tcc", ".inl"]) {
    TestValidator.equals(
      `${extension} implementation header maps to C++`,
      languageOf(`include/implementation${extension}`),
      "cpp",
    );
  }
  TestValidator.equals(
    "typescript default server",
    LANGUAGE_SPECS.find((spec) => spec.language === "typescript")?.lsp,
    { command: "ttscserver", args: ["--stdio"] },
  );
};
