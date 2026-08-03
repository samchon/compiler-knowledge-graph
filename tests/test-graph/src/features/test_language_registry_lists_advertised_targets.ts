import { TestValidator } from "@nestia/e2e";
import {
  LANGUAGE_SPECS,
  allExtensions,
  languageOf,
  languagesOf,
} from "@samchon/graph";

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
    "uppercase .C remains a case-sensitive C++ identity",
    languageOf("src/implementation.C"),
    "cpp",
  );
  TestValidator.equals(
    "uppercase .H remains a case-sensitive C++ identity",
    languageOf("include/interface.H"),
    "cpp",
  );
  TestValidator.equals(
    "ordinary C++ suffixes remain case-insensitive",
    languageOf("src/implementation.CPP"),
    "cpp",
  );
  TestValidator.equals(
    "lowercase .c remains a C identity",
    languageOf("src/implementation.c"),
    "c",
  );
  TestValidator.equals(
    "lowercase .h remains a C identity",
    languageOf("include/interface.h"),
    "c",
  );
  TestValidator.equals(
    "lowercase .h reaches both contextual owners",
    languagesOf("include/interface.h"),
    ["cpp", "c"],
  );
  TestValidator.predicate(
    "C++-only discovery includes shared .h inputs",
    allExtensions(["cpp"]).has(".h"),
  );
  TestValidator.equals(
    "an unregistered uppercase suffix remains unknown after folded lookup",
    languageOf("README.MD"),
    "unknown",
  );
  TestValidator.equals(
    "typescript default server",
    LANGUAGE_SPECS.find((spec) => spec.language === "typescript")?.lsp,
    { command: "ttscserver", args: ["--stdio"] },
  );
};
