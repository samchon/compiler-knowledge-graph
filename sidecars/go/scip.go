package main

import (
	"bytes"
	"context"
	"errors"
	"fmt"
	"io"
	"net/url"
	"os"
	"os/exec"
	"path/filepath"
	"runtime"
	"sort"
	"strings"

	"github.com/scip-code/scip/bindings/go/scip"
	"google.golang.org/protobuf/proto"
)

type scipArtifact struct {
	Documents   []string
	Definitions map[string]int
}

type scipIndexer interface {
	Version(context.Context) (string, error)
	Index(context.Context, string) (scipArtifact, error)
}

type commandScipIndexer struct {
	command string
}

func resolveGoToolchain(root string) (string, error) {
	if override := os.Getenv("SAMCHON_GRAPH_GO_TOOLCHAIN"); override != "" {
		if !filepath.IsAbs(override) {
			return "", errors.New("SAMCHON_GRAPH_GO_TOOLCHAIN must be an absolute path")
		}
		if !goToolchainName(override) {
			return "", fmt.Errorf("SAMCHON_GRAPH_GO_TOOLCHAIN must name go, go.exe, go.cmd, or go.bat: %s", override)
		}
		if executableFile(override) {
			return override, nil
		}
		return "", fmt.Errorf("SAMCHON_GRAPH_GO_TOOLCHAIN is not executable: %s", override)
	}
	names := []string{"go"}
	if runtime.GOOS == "windows" {
		names = []string{"go.exe", "go.cmd", "go.bat"}
	}
	for _, name := range names {
		candidate := filepath.Join(root, ".samchon-graph", "bin", name)
		if executableFile(candidate) {
			return candidate, nil
		}
	}
	resolved, err := exec.LookPath("go")
	if err != nil {
		return "", errors.New("Go was not found project-locally or on PATH")
	}
	absolute, err := filepath.Abs(resolved)
	if err != nil {
		return "", fmt.Errorf("resolve Go toolchain %s: %w", resolved, err)
	}
	return absolute, nil
}

func goToolchainName(command string) bool {
	switch strings.ToLower(filepath.Base(command)) {
	case "go", "go.exe", "go.cmd", "go.bat":
		return true
	default:
		return false
	}
}

func resolveScipGo(root string) (string, error) {
	if override := os.Getenv("SAMCHON_GRAPH_SCIP_GO"); override != "" {
		if !filepath.IsAbs(override) {
			return "", errors.New("SAMCHON_GRAPH_SCIP_GO must be an absolute path")
		}
		if executableFile(override) {
			return override, nil
		}
		return "", fmt.Errorf("SAMCHON_GRAPH_SCIP_GO is not executable: %s", override)
	}
	names := []string{"scip-go"}
	if runtime.GOOS == "windows" {
		names = []string{"scip-go.exe", "scip-go.cmd", "scip-go.bat"}
	}
	for _, name := range names {
		candidate := filepath.Join(root, ".samchon-graph", "bin", name)
		if executableFile(candidate) {
			return candidate, nil
		}
	}
	resolved, err := exec.LookPath("scip-go")
	if err != nil {
		return "", errors.New("scip-go v0.2.7 was not found project-locally or on PATH")
	}
	return resolved, nil
}

func (runner commandScipIndexer) Version(ctx context.Context) (string, error) {
	stdout, stderr, err := runBounded(ctx, "", runner.command, "--version")
	if err != nil {
		return "", fmt.Errorf("query scip-go version: %w%s", err, stderrSuffix(stderr))
	}
	return strings.TrimSpace(stdout), nil
}

func (runner commandScipIndexer) Index(ctx context.Context, moduleRoot string) (scipArtifact, error) {
	directory, err := os.MkdirTemp("", "samchon-graph-go-scip-")
	if err != nil {
		return scipArtifact{}, fmt.Errorf("create SCIP output directory: %w", err)
	}
	defer os.RemoveAll(directory)
	output := filepath.Join(directory, "index.scip")
	_, stderr, err := runBounded(
		ctx,
		moduleRoot,
		runner.command,
		"index",
		"--quiet",
		"--module-root="+moduleRoot,
		"--output="+output,
		"./...",
	)
	if err != nil {
		return scipArtifact{}, fmt.Errorf("index %s with scip-go: %w%s", moduleRoot, err, stderrSuffix(stderr))
	}
	body, err := os.ReadFile(output)
	if err != nil {
		return scipArtifact{}, fmt.Errorf("read scip-go artifact: %w", err)
	}
	artifact, err := validateScipIndex(moduleRoot, body)
	if err != nil {
		return scipArtifact{}, err
	}
	return artifact, nil
}

func validateScipIndex(moduleRoot string, body []byte) (scipArtifact, error) {
	index := &scip.Index{}
	if err := proto.Unmarshal(body, index); err != nil {
		return scipArtifact{}, fmt.Errorf("decode scip-go artifact: %w", err)
	}
	if index.Metadata == nil {
		return scipArtifact{}, errors.New("scip-go artifact has no metadata")
	}
	declared, err := fileURIPath(index.Metadata.ProjectRoot)
	if err != nil {
		return scipArtifact{}, fmt.Errorf("decode scip-go project root: %w", err)
	}
	if !samePath(declared, moduleRoot) {
		return scipArtifact{}, fmt.Errorf("scip-go artifact belongs to %s, not %s", declared, moduleRoot)
	}
	seen := make(map[string]bool, len(index.Documents))
	documents := make([]string, 0, len(index.Documents))
	definitions := make(map[string]int, len(index.Documents))
	for _, document := range index.Documents {
		relative := filepath.FromSlash(document.RelativePath)
		if document.RelativePath == "" {
			return scipArtifact{}, errors.New("scip-go emitted an empty document path")
		}
		if filepath.IsAbs(relative) || escapesRoot(relative) {
			// scip-go 0.2.7 can include compiler-cache documents outside the
			// declared module root. They are not project facts and their host
			// paths are neither portable nor safe to publish. Exclude them
			// from both corroboration and the canonical artifact digest.
			continue
		}
		cleaned := filepath.Clean(relative)
		key := pathKey(cleaned)
		if seen[key] {
			return scipArtifact{}, fmt.Errorf("scip-go duplicated document path: %s", document.RelativePath)
		}
		seen[key] = true
		if document.Language != "" && document.Language != "go" {
			return scipArtifact{}, fmt.Errorf("scip-go emitted a %s document: %s", document.Language, document.RelativePath)
		}
		absolute := filepath.Join(moduleRoot, cleaned)
		documents = append(documents, absolute)
		for _, occurrence := range document.Occurrences {
			if occurrence.SymbolRoles&int32(scip.SymbolRole_Definition) != 0 {
				definitions[pathKey(absolute)]++
			}
		}
	}
	sort.Strings(documents)
	return scipArtifact{
		Documents: documents, Definitions: definitions,
	}, nil
}

func fileURIPath(value string) (string, error) {
	if runtime.GOOS == "windows" && strings.HasPrefix(strings.ToLower(value), "file://") {
		// scip-go 0.2.7 serializes a Windows drive path as
		// `file://C:%5C...`, placing the drive in URI authority position. That
		// is not a valid file URL, but it is unambiguous and version-pinned at
		// this provider boundary, so normalize only this exact drive form
		// before the general URL parser. Hosts, ports, and non-file schemes
		// still go through the strict path below.
		raw, err := url.PathUnescape(value[len("file://"):])
		if err != nil {
			return "", err
		}
		if len(raw) >= 3 && raw[1] == ':' && (raw[2] == '\\' || raw[2] == '/') {
			return filepath.Clean(raw), nil
		}
	}
	parsed, err := url.Parse(value)
	if err != nil {
		return "", err
	}
	if parsed.Scheme == "" {
		return filepath.Clean(value), nil
	}
	if parsed.Scheme != "file" {
		return "", fmt.Errorf("unsupported URI scheme %q", parsed.Scheme)
	}
	if parsed.User != nil || parsed.Port() != "" {
		return "", errors.New("file URI cannot carry user information or a port")
	}
	path := parsed.Path
	if parsed.Hostname() != "" && !strings.EqualFold(parsed.Hostname(), "localhost") {
		path = "//" + parsed.Hostname() + path
	}
	if runtime.GOOS == "windows" && len(path) >= 3 && path[0] == '/' && path[2] == ':' {
		path = path[1:]
	}
	return filepath.FromSlash(path), nil
}

func runBounded(ctx context.Context, directory, command string, args ...string) (string, string, error) {
	executable, commandArgs, commandLine := commandInvocation(command, args)
	boundedContext, cancel := context.WithCancel(ctx)
	defer cancel()
	if err := boundedContext.Err(); err != nil {
		return "", "", err
	}
	process := exec.Command(executable, commandArgs...)
	configureOwnedProcess(process, commandLine)
	if directory != "" {
		process.Dir = directory
	}
	stdout := &limitedBuffer{limit: maxChildOutputBytes, onExceeded: cancel}
	stderr := &limitedBuffer{limit: maxChildOutputBytes, onExceeded: cancel}
	process.Stdout = stdout
	process.Stderr = stderr
	if err := process.Start(); err != nil {
		return "", "", err
	}
	exited := make(chan error, 1)
	go func() {
		exited <- process.Wait()
	}()
	var err error
	select {
	case err = <-exited:
	case <-boundedContext.Done():
		terminateOwnedProcess(process)
		err = <-exited
		if ctx.Err() != nil {
			err = ctx.Err()
		}
	}
	if stdout.exceeded || stderr.exceeded {
		return stdout.String(), stderr.String(), fmt.Errorf(
			"%s exceeded the %d-byte output limit",
			command,
			maxChildOutputBytes,
		)
	}
	return stdout.String(), stderr.String(), err
}

func commandInvocation(command string, args []string) (string, []string, string) {
	if runtime.GOOS == "windows" {
		extension := strings.ToLower(filepath.Ext(command))
		if extension == ".cmd" || extension == ".bat" {
			systemRoot := os.Getenv("SystemRoot")
			if systemRoot == "" {
				systemRoot = `C:\Windows`
			}
			return filepath.Join(systemRoot, "System32", "cmd.exe"), nil, windowsCommandLine(command, args)
		}
	}
	return command, args, ""
}

func windowsCommandLine(command string, args []string) string {
	doubleEscape := strings.Contains(
		strings.ToLower(filepath.ToSlash(command)),
		"/node_modules/.bin/",
	)
	parts := []string{escapeCmdMeta(filepath.Clean(command))}
	for _, argument := range args {
		escaped := escapeCmdMeta(quoteWindowsArgument(argument))
		if doubleEscape {
			escaped = escapeCmdMeta(escaped)
		}
		parts = append(parts, escaped)
	}
	return `/d /s /v:off /c "` + strings.Join(parts, " ") + `"`
}

func quoteWindowsArgument(value string) string {
	var quoted strings.Builder
	quoted.WriteByte('"')
	backslashes := 0
	for _, character := range value {
		if character == '\\' {
			backslashes++
			continue
		}
		if character == '"' {
			quoted.WriteString(strings.Repeat(`\`, backslashes*2+1))
			quoted.WriteRune(character)
			backslashes = 0
			continue
		}
		quoted.WriteString(strings.Repeat(`\`, backslashes))
		backslashes = 0
		quoted.WriteRune(character)
	}
	quoted.WriteString(strings.Repeat(`\`, backslashes*2))
	quoted.WriteByte('"')
	return quoted.String()
}

func escapeCmdMeta(value string) string {
	const meta = "()[]%!^\"`<>&|;, *?"
	var escaped strings.Builder
	for _, character := range value {
		if strings.ContainsRune(meta, character) {
			escaped.WriteByte('^')
		}
		escaped.WriteRune(character)
	}
	return escaped.String()
}

type limitedBuffer struct {
	buffer     bytes.Buffer
	limit      int
	exceeded   bool
	onExceeded func()
}

func (buffer *limitedBuffer) Write(body []byte) (int, error) {
	available := buffer.limit - buffer.buffer.Len()
	if available > 0 {
		chunk := body
		if len(chunk) > available {
			chunk = chunk[:available]
		}
		_, _ = buffer.buffer.Write(chunk)
	}
	if len(body) > available {
		if !buffer.exceeded && buffer.onExceeded != nil {
			buffer.onExceeded()
		}
		buffer.exceeded = true
	}
	return len(body), nil
}

func (buffer *limitedBuffer) String() string {
	return buffer.buffer.String()
}

func executableFile(file string) bool {
	info, err := os.Stat(file)
	if err != nil || !info.Mode().IsRegular() {
		return false
	}
	if runtime.GOOS == "windows" {
		return true
	}
	return info.Mode().Perm()&0o111 != 0
}

func escapesRoot(relative string) bool {
	cleaned := filepath.Clean(relative)
	return cleaned == ".." || strings.HasPrefix(cleaned, ".."+string(filepath.Separator))
}

func samePath(left, right string) bool {
	left = filepath.Clean(left)
	right = filepath.Clean(right)
	if runtime.GOOS == "windows" {
		return strings.EqualFold(left, right)
	}
	return left == right
}

func pathKey(value string) string {
	cleaned := filepath.Clean(value)
	if runtime.GOOS == "windows" {
		return strings.ToLower(cleaned)
	}
	return cleaned
}

func stderrSuffix(stderr string) string {
	trimmed := strings.TrimSpace(stderr)
	if trimmed == "" {
		return ""
	}
	return ": " + trimmed
}

var _ io.Writer = (*limitedBuffer)(nil)

const maxChildOutputBytes = 16 * 1024 * 1024
