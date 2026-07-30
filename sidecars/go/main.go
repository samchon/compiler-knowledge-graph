package main

import (
	"context"
	"encoding/json"
	"errors"
	"flag"
	"fmt"
	"os"
	"os/signal"
	"path/filepath"
	"sort"
	"strings"
	"syscall"
)

func main() {
	if err := run(); err != nil {
		fmt.Fprintln(os.Stderr, "samchon-graph-go:", err)
		os.Exit(1)
	}
}

func run() error {
	output := flag.String("output", "", "write the normalized snapshot to this file")
	project := flag.String("project", "", "absolute project root to index")
	flag.Parse()
	if *output == "" {
		return errors.New("--output is required")
	}
	if *project == "" {
		return errors.New("--project is required")
	}
	if !filepath.IsAbs(*project) {
		return errors.New("--project must be absolute")
	}
	root, err := filepath.Abs(*project)
	if err != nil {
		return fmt.Errorf("resolve project root: %w", err)
	}
	info, err := os.Stat(root)
	if err != nil || !info.IsDir() {
		return fmt.Errorf("--project is not a readable directory: %s", root)
	}
	goCommand, err := resolveGoToolchain(root)
	if err != nil {
		return err
	}
	command, err := resolveScipGo(root)
	if err != nil {
		return err
	}
	ctx, stop := signal.NotifyContext(context.Background(), os.Interrupt, syscall.SIGTERM)
	defer stop()
	environment, err := probeGoEnvironment(ctx, root, goCommand)
	if err != nil {
		return err
	}
	value, err := buildSnapshot(
		ctx,
		root,
		commandScipIndexer{command: command},
		environment,
		goCommand,
	)
	if err != nil {
		return err
	}
	return writeSnapshot(*output, value)
}

func buildSnapshot(
	ctx context.Context,
	root string,
	indexer scipIndexer,
	environment map[string]string,
	goCommands ...string,
) (snapshot, error) {
	goCommand := "go"
	if len(goCommands) != 0 {
		goCommand = goCommands[0]
	}
	if err := validateEffectiveWorkspace(root, environment["GOWORK"]); err != nil {
		return snapshot{}, err
	}
	roots, err := moduleRoots(root, environment["GOWORK"])
	if err != nil {
		return snapshot{}, err
	}
	version, err := indexer.Version(ctx)
	if err != nil {
		return snapshot{}, err
	}
	if !matchesPinnedScipGoVersion(version) {
		return snapshot{}, fmt.Errorf("scip-go compatibility requires %s, got %q", pinnedScipGoVersion, version)
	}
	artifacts := make([]scipArtifact, 0, len(roots))
	documents := 0
	for _, moduleRoot := range roots {
		artifact, indexErr := indexer.Index(ctx, moduleRoot)
		if indexErr != nil {
			return snapshot{}, indexErr
		}
		artifacts = append(artifacts, artifact)
		documents += len(artifact.Documents)
	}
	if documents == 0 {
		return snapshot{}, errors.New("scip-go published no Go documents")
	}
	graph, err := analyzeGo(ctx, root, roots, goToolchainEnvironment(goCommand))
	if err != nil {
		return snapshot{}, err
	}
	sources, nodes, edges := graph.snapshotParts()
	if err := validateScipCoverage(root, sources, nodes, artifacts); err != nil {
		return snapshot{}, err
	}
	inputs, err := buildInputs(root)
	if err != nil {
		return snapshot{}, err
	}
	universeParts := []string{"samchon-graph-go", sidecarVersion, version}
	keys := make([]string, 0, len(environment))
	for key := range environment {
		keys = append(keys, key)
	}
	sort.Strings(keys)
	for _, key := range keys {
		universeParts = append(universeParts, key, normalizedEnvironmentValue(root, key, environment[key]))
	}
	for _, moduleRoot := range roots {
		identity, relativeErr := filepath.Rel(root, moduleRoot)
		if relativeErr != nil {
			return snapshot{}, fmt.Errorf("name Go module root %s: %w", moduleRoot, relativeErr)
		}
		// The SCIP index is derived corroboration, not an input coordinate.
		// Its protobuf bytes can move while the selected Go build universe and
		// the compiler-owned facts remain identical. Keep the module identity
		// in the universe and validate the artifact below, but do not turn a
		// navigation artifact digest into a public coverage target.
		universeParts = append(universeParts, filepath.ToSlash(identity))
	}
	for _, input := range inputs {
		body, readErr := os.ReadFile(input)
		if readErr != nil {
			return snapshot{}, fmt.Errorf("read Go build input %s: %w", input, readErr)
		}
		identity, relativeErr := filepath.Rel(root, input)
		if relativeErr != nil {
			return snapshot{}, fmt.Errorf("name Go build input %s: %w", input, relativeErr)
		}
		universeParts = append(universeParts, filepath.ToSlash(identity), digestBytes(body))
	}
	for _, file := range sources {
		universeParts = append(universeParts, file.File, file.CheckerDigest)
	}
	warnings := []string{}
	if graph.unresolved != 0 {
		warnings = append(
			warnings,
			fmt.Sprintf(
				"samchon-graph-go: %d expression target(s) remained local, dynamic, "+
					"or unresolved and were not assigned fabricated endpoints",
				graph.unresolved,
			),
		)
	}
	compilerVersion := environment["GOVERSION"]
	value := snapshot{
		SchemaVersion: 1,
		ProjectRoot:   root,
		Languages:     []string{"go"},
		Tool: tool{
			Name: "samchon-graph-go", Version: sidecarVersion + "+scip-go." + pinnedScipGoVersion,
			CompilerVersion: compilerVersion, ProtocolVersion: 1,
		},
		Universe: digestStrings(universeParts...),
		Capabilities: []string{
			"universe", "sourceDigests", "diskDigests", "diagnostics",
			"goPackages", "fullRebuild",
		},
		Sources: sources, Nodes: nodes, Edges: edges,
		Diagnostics: []diagnostic{}, Warnings: warnings,
	}
	sortSnapshot(&value)
	return value, nil
}

func validateEffectiveWorkspace(root, workspace string) error {
	if workspace == "" || workspace == "off" {
		return nil
	}
	expected := filepath.Join(root, "go.work")
	if !samePath(workspace, expected) {
		return fmt.Errorf(
			"effective GOWORK %s is not the indexed project's %s; use the generic Go lane or open the workspace root",
			workspace,
			expected,
		)
	}
	return nil
}

func normalizedEnvironmentValue(root, key, value string) string {
	if key == "GOWORK" && value != "" && value != "off" && samePath(value, filepath.Join(root, "go.work")) {
		return "go.work"
	}
	return value
}

func validateScipCoverage(root string, sources []source, nodes []node, artifacts []scipArtifact) error {
	indexed := map[string]bool{}
	definitions := map[string]int{}
	for _, artifact := range artifacts {
		for _, document := range artifact.Documents {
			indexed[pathKey(document)] = true
		}
		for file, count := range artifact.Definitions {
			definitions[file] += count
		}
	}
	requiresDefinition := map[string]bool{}
	for _, declaration := range nodes {
		if declaration.External || declaration.Kind == "file" || declaration.Kind == "package" {
			continue
		}
		requiresDefinition[pathKey(filepath.Join(root, filepath.FromSlash(declaration.File)))] = true
	}
	for _, input := range sources {
		absolute := filepath.Join(root, filepath.FromSlash(input.File))
		key := pathKey(absolute)
		if !indexed[key] {
			return fmt.Errorf(
				"scip-go omitted checker-owned source %s; its navigation artifact cannot corroborate this generation",
				input.File,
			)
		}
		if requiresDefinition[key] && definitions[key] == 0 {
			return fmt.Errorf(
				"scip-go published no definition occurrence for checker-owned source %s; its navigation artifact cannot corroborate this generation",
				input.File,
			)
		}
	}
	return nil
}

func matchesPinnedScipGoVersion(version string) bool {
	for _, field := range strings.Fields(version) {
		candidate := strings.Trim(field, ",;()[]{}")
		if candidate == pinnedScipGoVersion || candidate == "v"+pinnedScipGoVersion {
			return true
		}
	}
	return false
}

func probeGoEnvironment(
	ctx context.Context,
	root string,
	goCommand string,
) (map[string]string, error) {
	stdout, stderr, err := runBounded(
		ctx,
		root,
		goCommand,
		"env",
		"-json",
		"GOVERSION",
		"GOOS",
		"GOARCH",
		"CGO_ENABLED",
		"CGO_CFLAGS",
		"CGO_CPPFLAGS",
		"CGO_CXXFLAGS",
		"CGO_FFLAGS",
		"CGO_LDFLAGS",
		"CC",
		"CXX",
		"FC",
		"GO111MODULE",
		"GOFLAGS",
		"GO386",
		"GOAMD64",
		"GOARM",
		"GOARM64",
		"GODEBUG",
		"GOEXPERIMENT",
		"GOFIPS140",
		"GOMIPS",
		"GOMIPS64",
		"GOPPC64",
		"GORISCV64",
		"GOWASM",
		"GOTOOLCHAIN",
		"GOWORK",
		"GOPROXY",
		"GOPRIVATE",
		"PKG_CONFIG",
	)
	if err != nil {
		return nil, fmt.Errorf("query Go build environment: %w%s", err, stderrSuffix(stderr))
	}
	value := map[string]string{}
	if err := json.Unmarshal([]byte(stdout), &value); err != nil {
		return nil, fmt.Errorf("decode Go build environment: %w", err)
	}
	return value, nil
}

func goToolchainEnvironment(goCommand string) []string {
	if !filepath.IsAbs(goCommand) {
		return os.Environ()
	}
	return append(
		os.Environ(),
		"PATH="+filepath.Dir(goCommand)+string(os.PathListSeparator)+os.Getenv("PATH"),
	)
}

func writeSnapshot(output string, value snapshot) error {
	if err := os.MkdirAll(filepath.Dir(output), 0o755); err != nil {
		return fmt.Errorf("create snapshot directory: %w", err)
	}
	temporary, err := os.CreateTemp(filepath.Dir(output), "snapshot-*.json")
	if err != nil {
		return fmt.Errorf("create snapshot artifact: %w", err)
	}
	temporaryName := temporary.Name()
	defer os.Remove(temporaryName)
	encoder := json.NewEncoder(temporary)
	encoder.SetEscapeHTML(false)
	if err := encoder.Encode(value); err != nil {
		temporary.Close()
		return fmt.Errorf("encode snapshot: %w", err)
	}
	if err := temporary.Close(); err != nil {
		return fmt.Errorf("close snapshot artifact: %w", err)
	}
	if err := os.Rename(temporaryName, output); err != nil {
		return fmt.Errorf("publish snapshot artifact: %w", err)
	}
	return nil
}

const (
	sidecarVersion      = "0.1.0"
	pinnedScipGoVersion = "0.2.7"
)
