import { TestValidator } from "@nestia/e2e";
import { csharpGraphProvider } from "@samchon/graph";
import childProcess from "node:child_process";
import fs from "node:fs";
import path from "node:path";

import { GraphPaths } from "../internal/GraphPaths.js";

/** The shipped Roslyn producer proves one real multi-project, multi-target compilation. */
export const test_csharp_roslyn_producer_covers_solution_semantics = async () => {
  const root = GraphPaths.createTempDirectory("samchon-graph-csharp-producer-");
  const dotnet = resolveDotnet();
  writeFixture(root);
  runDotnet(dotnet, root, [
    "build",
    "Fixture.slnx",
    "--configuration",
    "Release",
    "--verbosity",
    "quiet",
  ]);

  const command = csharpGraphProvider.resolve(root, {
    SystemRoot: process.env.SystemRoot,
    SAMCHON_GRAPH_DOTNET_TOOLCHAIN: dotnet,
  });
  if (command === undefined) {
    throw new Error("the shipped Roslyn source fallback did not resolve");
  }
  const buildInputs =
    typeof csharpGraphProvider.buildInputs === "function"
      ? csharpGraphProvider.buildInputs(root)
      : (csharpGraphProvider.buildInputs ?? []);
  TestValidator.predicate(
    "the coordinator fences the solution entry point the Roslyn workspace loaded",
    buildInputs.includes("Fixture.slnx"),
  );
  TestValidator.predicate(
    "the source fallback tells MSBuildLocator which SDK host launched it",
    command.args.includes("--dotnet-host") && command.args.includes(dotnet),
  );

  const session = csharpGraphProvider.open({
    root,
    command,
    languages: ["csharp"],
    options: { cwd: root, lspTimeoutMs: 180_000 },
  });
  try {
    const started = Date.now();
    const initial = await session.refresh();
    const coldMs = Date.now() - started;
    const snapshot = initial.snapshot;
    const targets = snapshot.protocol?.targets ?? [];
    const families = new Set(snapshot.coverage?.map((row) => row.family));
    const generated = snapshot.nodes.filter(
      (node) => node.name === "GeneratedMarker",
    );
    const buildGenerated = snapshot.nodes.filter(
      (node) => node.name === "LegacyGenerated",
    );
    const workMethods = snapshot.nodes.filter(
      (node) =>
        node.qualifiedName === "Company.One.Shared.Worker.Work(string)",
    );
    const workIds = new Set(workMethods.map((node) => node.id));
    const runIds = new Set(
      snapshot.nodes
        .filter(
          (node) => node.qualifiedName === "Company.Two.Shared.Runner.Run()",
        )
        .map((node) => node.id),
    );
    const extraIds = new Set(
      snapshot.nodes
        .filter((node) => node.qualifiedName === "Company.One.Shared.Extra")
        .map((node) => node.id),
    );

    TestValidator.predicate(
      "Roslyn opens the whole solution and expands both library target frameworks",
      initial.mode === "initial" &&
        initial.changed &&
        targets.length >= 4 &&
        snapshot.nodes.some((node) =>
          node.qualifiedName?.startsWith("Library,"),
        ) &&
        snapshot.nodes.some((node) =>
          node.qualifiedName?.startsWith("Consumer,"),
        ),
    );
    TestValidator.predicate(
      "source-generated documents, records, generic arity, and partial methods keep semantic identities",
      generated.length >= 2 &&
        buildGenerated.length >= 2 &&
        buildGenerated.every((node) =>
          node.file.startsWith("bundled:///csharp/generated/"),
        ) &&
        snapshot.nodes.some((node) => node.name === "Deconstruct") &&
        new Set(
          snapshot.nodes
            .filter((node) => node.name === "Foo")
            .map((node) => node.qualifiedName),
        ).size >= 2 &&
        snapshot.nodes.filter((node) => node.name === "Hook").length === 2 &&
        workIds.size === 2,
    );
    TestValidator.predicate(
      "the producer publishes the complete per-target fact-coverage matrix",
      families.size === 15 &&
        snapshot.coverage?.length === targets.length * 15 &&
        snapshot.coverage.every((row) =>
          row.family === "renders"
            ? row.state === "unsupported"
            : row.state === "partial",
        ) === true,
    );
    TestValidator.predicate(
      "compiler semantics cover inheritance, calls, access, construction, attributes, tests, and dispatch candidates",
      [
        "accesses",
        "calls",
        "decorates",
        "extends",
        "implements",
        "instantiates",
        "overrides",
        "references",
        "tests",
        "type_ref",
      ].every((kind) => snapshot.edges.some((edge) => edge.kind === kind)) &&
        snapshot.unresolved?.some(
          (site) =>
            site.family === "dispatches" &&
            site.reason === "dynamic" &&
            site.candidates.length !== 0,
        ) === true,
    );
    TestValidator.predicate(
      "every compiler input has checker and disk identity in the initial generation",
      snapshot.sources.size !== 0 &&
        [...snapshot.sources.values()].every(
          (source) =>
            source.checkerDigest.length === 64 &&
            (source.diskDigest === "" || source.diskDigest.length === 64),
        ) &&
        [...snapshot.sources.keys()].some((file) =>
          file.replaceAll("\\", "/").endsWith("/Generator.dll"),
        ),
    );

    const noOpStarted = Date.now();
    const noOp = await session.refresh();
    const noOpMs = Date.now() - noOpStarted;
    // V8 coverage instruments the JavaScript transport around the native
    // producer. The ordinary test enforces no-op latency and the experiment
    // enforces both no-op and edit latency; the coverage replay verifies
    // behavior without treating instrumentation overhead as Roslyn latency.
    const timingReliable = process.env.NODE_V8_COVERAGE === undefined;
    TestValidator.predicate(
      "an unchanged resident solution returns the identical generation under 250 ms",
      noOp.mode === "unchanged" &&
        !noOp.changed &&
        noOp.snapshot === snapshot &&
        noOp.generation === initial.generation &&
        (!timingReliable || noOpMs < 250),
    );

    const runner = path.join(root, "Consumer", "Runner.cs");
    const beforeInvalidBody = session.current;
    fs.writeFileSync(
      runner,
      consumerSource(true).replace(
        "return worker.Work(value.ToString() + extra.Value + suffix);",
        "return missingSymbol;",
      ),
    );
    await rejectedRefresh(session, "compiler errors");
    TestValidator.predicate(
      "a document-local compiler error is rejected without running a full analyzer pass",
      session.current === beforeInvalidBody,
    );
    fs.writeFileSync(runner, consumerSource(true));
    const edited = await session.refresh();
    const bodyRunIds = new Set(
      edited.snapshot.nodes
        .filter(
          (node) =>
            node.qualifiedName === "Company.Two.Shared.Runner.Run()",
        )
        .map((node) => node.id),
    );
    TestValidator.predicate(
      "a body edit reuses the resident solution and preserves declaration identities",
      edited.mode === "incremental" &&
        runIds.size === bodyRunIds.size &&
        [...runIds].every((id) => bodyRunIds.has(id)) &&
        edited.snapshot.diagnostics.some((diagnostic) =>
          diagnostic.message.includes("CSHARP_ACCEPTANCE_WARNING"),
        ),
    );

    const api = path.join(root, "Library", "Api.cs");
    fs.writeFileSync(api, librarySource(false, true));
    const libraryEdited = await waitForChanged(session);
    TestValidator.predicate(
      "an unrelated body edit retains diagnostics from unchanged project shards",
      libraryEdited.mode === "incremental" &&
        libraryEdited.snapshot.diagnostics.some((diagnostic) =>
          diagnostic.message.includes("CSHARP_ACCEPTANCE_WARNING"),
        ),
    );

    fs.writeFileSync(api, librarySource(true, true));
    const overloaded = await waitForChanged(session);
    const survivingWorkIds = new Set(
      overloaded.snapshot.nodes
        .filter(
          (node) =>
            node.qualifiedName === "Company.One.Shared.Worker.Work(string)",
        )
        .map((node) => node.id),
    );
    TestValidator.predicate(
      "inserting an overload rechecks dependents without renumbering an existing symbol",
      overloaded.mode === "incremental" &&
        workIds.size === survivingWorkIds.size &&
        [...workIds].every((id) => survivingWorkIds.has(id)) &&
        overloaded.snapshot.nodes.filter(
          (node) =>
            node.qualifiedName === "Company.One.Shared.Worker.Work(int)",
        ).length === 2,
    );

    const extra = path.join(root, "Library", "Extra.cs");
    const moved = path.join(root, "Library", "Moved.cs");
    fs.renameSync(extra, moved);
    const renamed = await waitForChanged(session);
    const renamedExtraIds = new Set(
      renamed.snapshot.nodes
        .filter((node) => node.qualifiedName === "Company.One.Shared.Extra")
        .map((node) => node.id),
    );
    const oldSourcePresent = [...renamed.snapshot.sources.keys()].some((file) =>
      file.replaceAll("\\", "/").endsWith("/Extra.cs"),
    );
    const movedSourcePresent = [...renamed.snapshot.sources.keys()].some((file) =>
      file.replaceAll("\\", "/").endsWith("/Moved.cs"),
    );
    TestValidator.predicate(
      "a file rename updates the manifest without renumbering its semantic declarations",
      renamed.mode === "incremental" &&
        extraIds.size === renamedExtraIds.size &&
        [...extraIds].every((id) => renamedExtraIds.has(id)) &&
        !oldSourcePresent &&
        movedSourcePresent,
    );

    const movedSource = fs.readFileSync(moved, "utf8");
    const acceptedRename = session.current;
    fs.unlinkSync(moved);
    await rejectedRefresh(session, "compiler errors");
    TestValidator.predicate(
      "deleting a referenced declaration rechecks dependents and retains the accepted generation",
      session.current === acceptedRename,
    );
    fs.writeFileSync(moved, movedSource);
    const restored = await waitForSuccess(session);
    TestValidator.predicate(
      "restoring a rejected deletion returns the still-current semantic generation",
      restored.mode === "unchanged" &&
        restored.snapshot === acceptedRename &&
        [...extraIds].every((id) =>
          restored.snapshot.nodes.some((node) => node.id === id),
        ),
    );

    const project = path.join(root, "Consumer", "Consumer.csproj");
    const validProject = fs.readFileSync(project, "utf8");
    const accepted = session.current;
    fs.writeFileSync(project, "<Project>");
    await rejectedRefresh(session);
    TestValidator.predicate(
      "an invalid project reload rejects atomically and retains the accepted generation",
      session.current === accepted,
    );
    fs.writeFileSync(project, validProject);
    const repairedProject = await waitForSuccess(session);
    TestValidator.predicate(
      "repairing a compiler input reproduces and reuses the exact accepted generation",
      repairedProject.mode === "unchanged" &&
        !repairedProject.changed &&
        repairedProject.snapshot === accepted,
    );

    const configuredProject = validProject.replace(
      "<Nullable>enable</Nullable>",
      "<Nullable>enable</Nullable>\n    <DefineConstants>SAMCHON_ACCEPTANCE</DefineConstants>",
    );
    fs.writeFileSync(project, configuredProject);
    const reloaded = await waitForChanged(session);
    TestValidator.predicate(
      "a valid project configuration change reloads the whole solution",
      reloaded.mode === "reload" &&
        reloaded.snapshot !== repairedProject.snapshot,
    );
    fs.writeFileSync(project, validProject);
    const configurationRestored = await waitForChanged(session);
    TestValidator.predicate(
      "restoring project configuration returns the accepted generation through a reload",
      configurationRestored.mode === "reload" &&
        configurationRestored.snapshot !== reloaded.snapshot,
    );

    TestValidator.predicate(
      "the cold acceptance run completed with a measured compiler load",
      coldMs > 0,
    );
  } finally {
    await session.close();
  }
};

function resolveDotnet(): string {
  const configured = process.env.SAMCHON_GRAPH_DOTNET_TOOLCHAIN;
  if (configured !== undefined && path.isAbsolute(configured)) {
    return configured;
  }
  const probe = childProcess.spawnSync(
    process.platform === "win32" ? "where.exe" : "/bin/sh",
    process.platform === "win32"
      ? ["dotnet"]
      : ["-c", 'command -v "$1"', "csharp-acceptance", "dotnet"],
    { encoding: "utf8", windowsHide: true },
  );
  const executable = probe.stdout
    .split(/\r?\n/)
    .map((line) => line.trim())
    .find((line) => line !== "");
  if (probe.status !== 0 || executable === undefined) {
    throw new Error("the C# producer acceptance test requires a .NET SDK");
  }
  return path.resolve(executable);
}

function runDotnet(dotnet: string, root: string, args: string[]): void {
  const result = childProcess.spawnSync(dotnet, args, {
    cwd: root,
    encoding: "utf8",
    env: {
      ...process.env,
      DOTNET_CLI_TELEMETRY_OPTOUT: "1",
      DOTNET_NOLOGO: "1",
      NUGET_XMLDOC_MODE: "skip",
    },
    timeout: 180_000,
    windowsHide: true,
  });
  if (result.status !== 0) {
    const detail = [
      result.error?.message,
      result.signal === null ? undefined : `signal=${result.signal}`,
      result.stdout,
      result.stderr,
    ]
      .filter((value): value is string => value !== undefined && value !== "")
      .join("\n");
    throw new Error(
      `dotnet ${args[0]} failed (${String(result.status)}):\n${detail}`,
    );
  }
}

async function waitForChanged(
  session: ReturnType<typeof csharpGraphProvider.open>,
) {
  for (let attempt = 0; attempt !== 40; ++attempt) {
    const result = await session.refresh();
    if (result.changed) return result;
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  throw new Error("the resident Roslyn producer did not observe the file change");
}

async function rejectedRefresh(
  session: ReturnType<typeof csharpGraphProvider.open>,
  expected?: string,
): Promise<void> {
  for (let attempt = 0; attempt !== 40; ++attempt) {
    try {
      const result = await session.refresh();
      if (result.changed) {
        throw new Error("an invalid project was published");
      }
    } catch (error) {
      if (
        error instanceof Error &&
        !error.message.includes("an invalid project was published") &&
        (expected === undefined || error.message.includes(expected))
      ) {
        return;
      }
      throw error;
    }
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  throw new Error("the resident Roslyn producer did not reject the invalid project");
}

async function waitForSuccess(
  session: ReturnType<typeof csharpGraphProvider.open>,
) {
  for (let attempt = 0; attempt !== 40; ++attempt) {
    try {
      return await session.refresh();
    } catch {
      await new Promise((resolve) => setTimeout(resolve, 25));
    }
  }
  throw new Error("the resident Roslyn producer did not recover after repair");
}

function writeFixture(root: string): void {
  write(
    root,
    "Fixture.slnx",
    `<Solution>
  <Project Path="Generator/Generator.csproj" />
  <Project Path="Library/Library.csproj" />
  <Project Path="Consumer/Consumer.csproj" />
</Solution>
`,
  );
  write(
    root,
    "Generator/Generator.csproj",
    `<Project Sdk="Microsoft.NET.Sdk">
  <PropertyGroup>
    <TargetFramework>netstandard2.0</TargetFramework>
    <LangVersion>latest</LangVersion>
    <Nullable>enable</Nullable>
    <EnforceExtendedAnalyzerRules>true</EnforceExtendedAnalyzerRules>
  </PropertyGroup>
  <ItemGroup>
    <PackageReference Include="Microsoft.CodeAnalysis.CSharp" Version="5.9.0" PrivateAssets="all" />
  </ItemGroup>
</Project>
`,
  );
  write(
    root,
    "Library/IsExternalInit.cs",
    `#if NETSTANDARD2_1
namespace System.Runtime.CompilerServices;

internal static class IsExternalInit { }
#endif
`,
  );
  write(
    root,
    "Generator/MarkerGenerator.cs",
    `using Microsoft.CodeAnalysis;

namespace Fixture.Generator;

[Generator]
public sealed class MarkerGenerator : IIncrementalGenerator
{
    public void Initialize(IncrementalGeneratorInitializationContext context)
    {
        context.RegisterPostInitializationOutput(output => output.AddSource(
            "GeneratedMarker.g.cs",
            "namespace Company.One.Shared; public static class GeneratedMarker { public static string Value => \\\"generated\\\"; }"));
    }
}
`,
  );
  write(
    root,
    "Library/Library.csproj",
    `<Project Sdk="Microsoft.NET.Sdk">
  <PropertyGroup>
    <TargetFrameworks>net10.0;netstandard2.1</TargetFrameworks>
    <LangVersion>latest</LangVersion>
    <Nullable>enable</Nullable>
    <ImplicitUsings>enable</ImplicitUsings>
  </PropertyGroup>
  <ItemGroup>
    <ProjectReference Include="../Generator/Generator.csproj" ReferenceOutputAssembly="false" />
    <Analyzer Include="../Generator/bin/Release/netstandard2.0/Generator.dll" />
    <Compile Include="obj/Generated/LegacyGenerated.g.cs" />
  </ItemGroup>
</Project>
`,
  );
  write(root, "Library/Api.cs", librarySource(false));
  write(
    root,
    "Library/obj/Generated/LegacyGenerated.g.cs",
    `namespace Company.One.Shared;

public static class LegacyGenerated
{
    public static string Value => "legacy-generated";
}
`,
  );
  write(
    root,
    "Library/Extra.cs",
    `namespace Company.One.Shared;

public sealed class Extra
{
    public string Value => "extra";
}
`,
  );
  write(
    root,
    "Library/Partial.cs",
    `namespace Company.One.Shared;

public partial record Worker
{
    partial void Hook() => state = state.Trim();
}
`,
  );
  write(
    root,
    "Consumer/Consumer.csproj",
    `<Project Sdk="Microsoft.NET.Sdk">
  <PropertyGroup>
    <TargetFramework>net10.0</TargetFramework>
    <Nullable>enable</Nullable>
    <ImplicitUsings>enable</ImplicitUsings>
  </PropertyGroup>
  <ItemGroup>
    <ProjectReference Include="../Library/Library.csproj" />
  </ItemGroup>
</Project>
`,
  );
  write(
    root,
    "Consumer/Runner.cs",
    consumerSource(false),
  );
}

function consumerSource(changedBody: boolean): string {
  return `#warning CSHARP_ACCEPTANCE_WARNING

using Company.One.Shared;

namespace Company.Two.Shared;

public sealed class Runner
{
    private readonly IWorker worker = new Worker(">");
    private readonly Extra extra = new();

    public string Run()
    {
        var value = new Foo<string>();
        var suffix = "${changedBody ? "changed" : "initial"}";
        return worker.Work(value.ToString() + extra.Value + suffix);
    }
}

public sealed class RunnerTests
{
    [Xunit.Fact]
    public void CallsRun() => _ = new Runner().Run();
}
`;
}

function librarySource(
  withOverload: boolean,
  changedBody: boolean = false,
): string {
  return `using System;

namespace Xunit
{
    [AttributeUsage(AttributeTargets.Method)]
    public sealed class FactAttribute : Attribute { }
}

namespace Company.One.Shared
{
    public interface IWorker
    {
        string Work(string input);
    }

    public abstract record BaseWorker
    {
        public abstract string Work(string input);
    }

    [Marker("🤷‍")]
    [NumericMarker(1e-7)]
    [NumericMarker(1e-6)]
    [NumericMarker(1e20)]
    [NumericMarker(1e21)]
    [NumericMarker(1.2345678901234567)]
    [NumericMarker(0.0000012345678901234567)]
    public partial record Worker(string Prefix) : BaseWorker, IWorker
    {
        private string state = "${changedBody ? "!!" : "!"}";

        partial void Hook();
${withOverload ? "\n        public string Work(int input) => input.ToString();\n" : ""}
        public override string Work(string input)
        {
            Func<string, string> normalize = value => value.Trim();
            Hook();
            return normalize(Prefix + input + GeneratedMarker.Value) + state;
        }
    }

    public sealed class Foo { }

    public sealed class Foo<T> { }

    [AttributeUsage(AttributeTargets.Class)]
    public sealed class MarkerAttribute(string name) : Attribute
    {
        public string Name { get; } = name;
    }

    [AttributeUsage(AttributeTargets.Class, AllowMultiple = true)]
    public sealed class NumericMarkerAttribute(double value) : Attribute
    {
        public double Value { get; } = value;
    }
}
`;
}

function write(root: string, relative: string, contents: string): void {
  const file = path.join(root, ...relative.split("/"));
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, contents);
}
