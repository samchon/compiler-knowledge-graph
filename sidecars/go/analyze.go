package main

import (
	"context"
	"fmt"
	"go/ast"
	"go/doc"
	"go/parser"
	"go/token"
	"go/types"
	"os"
	"path/filepath"
	"reflect"
	"sort"
	"strconv"
	"strings"
	"sync"
	"unicode"
	"unicode/utf8"

	"golang.org/x/tools/go/packages"
)

type collector struct {
	root              string
	nodes             map[string]node
	edges             map[string]edge
	sources           map[string]source
	objectIDs         map[types.Object]string
	objectKeyIDs      map[string]string
	packageIDs        map[string]string
	workspacePackages map[string]bool
	checkerDigests    map[string]string
	checkerConflicts  map[string]bool
	checkerMu         sync.Mutex
	unresolved        int
	conflict          error
}

type unit struct {
	pkg       *packages.Package
	file      *ast.File
	fileName  string
	fileID    string
	packageID string
}

type namedType struct {
	typeValue *types.Named
	id        string
}

func analyzeGo(
	ctx context.Context,
	projectRoot string,
	roots []string,
	environment []string,
) (*collector, error) {
	result := &collector{
		root:              projectRoot,
		nodes:             map[string]node{},
		edges:             map[string]edge{},
		sources:           map[string]source{},
		objectIDs:         map[types.Object]string{},
		objectKeyIDs:      map[string]string{},
		packageIDs:        map[string]string{},
		workspacePackages: map[string]bool{},
		checkerDigests:    map[string]string{},
		checkerConflicts:  map[string]bool{},
	}

	var loaded []*packages.Package
	var groups [][]*packages.Package
	for _, root := range roots {
		packagesAtRoot, err := packages.Load(&packages.Config{
			Context:   ctx,
			Dir:       root,
			Env:       environment,
			Tests:     true,
			ParseFile: result.parseFile,
			Mode: packages.NeedName |
				packages.NeedFiles |
				packages.NeedCompiledGoFiles |
				packages.NeedImports |
				packages.NeedDeps |
				packages.NeedExportFile |
				packages.NeedTypes |
				packages.NeedSyntax |
				packages.NeedTypesInfo |
				packages.NeedModule |
				packages.NeedEmbedFiles,
		}, "./...")
		if err != nil {
			return nil, fmt.Errorf("load Go packages at %s: %w", root, err)
		}
		group := packageClosure(projectRoot, packagesAtRoot)
		groups = append(groups, group)
		loaded = append(loaded, group...)
	}
	sort.Slice(loaded, func(i, j int) bool { return loaded[i].ID < loaded[j].ID })
	if err := rejectPackageErrors(loaded); err != nil {
		return nil, err
	}

	unitGroups := make([][]unit, 0, len(groups))
	var units []unit
	for _, group := range groups {
		current, unitErr := result.units(group)
		if unitErr != nil {
			return nil, unitErr
		}
		unitGroups = append(unitGroups, current)
		units = append(units, current...)
	}
	result.addContainers(units)
	result.addDeclarations(units)
	result.addImports(units)
	result.addRelationships(units)
	for _, group := range unitGroups {
		result.addImplementations(namedTypes(group))
	}
	if result.conflict != nil {
		return nil, result.conflict
	}
	return result, nil
}

func packageClosure(projectRoot string, roots []*packages.Package) []*packages.Package {
	seen := map[*packages.Package]bool{}
	var output []*packages.Package
	var visit func(*packages.Package)
	visit = func(pkg *packages.Package) {
		if pkg == nil || seen[pkg] {
			return
		}
		seen[pkg] = true
		if packageWithin(projectRoot, pkg) {
			output = append(output, pkg)
		}
		paths := make([]string, 0, len(pkg.Imports))
		for imported := range pkg.Imports {
			paths = append(paths, imported)
		}
		sort.Strings(paths)
		for _, imported := range paths {
			visit(pkg.Imports[imported])
		}
	}
	for _, root := range roots {
		visit(root)
	}
	sort.Slice(output, func(i, j int) bool { return output[i].ID < output[j].ID })
	return output
}

func packageWithin(root string, pkg *packages.Package) bool {
	for _, file := range pkg.GoFiles {
		if within(root, file) {
			return true
		}
	}
	for _, file := range pkg.CompiledGoFiles {
		if within(root, file) {
			return true
		}
	}
	return false
}

func (c *collector) parseFile(
	fset *token.FileSet,
	filename string,
	src []byte,
) (*ast.File, error) {
	absolute := filepath.Clean(filename)
	digest := digestBytes(src)
	c.checkerMu.Lock()
	if previous := c.checkerDigests[absolute]; previous != "" && previous != digest {
		c.checkerConflicts[absolute] = true
	}
	c.checkerDigests[absolute] = digest
	c.checkerMu.Unlock()
	return parser.ParseFile(
		fset,
		filename,
		src,
		parser.AllErrors|parser.ParseComments,
	)
}

func rejectPackageErrors(loaded []*packages.Package) error {
	var messages []string
	for _, pkg := range loaded {
		for _, problem := range pkg.Errors {
			messages = append(messages, problem.Error())
		}
	}
	if len(messages) == 0 {
		return nil
	}
	sort.Strings(messages)
	if len(messages) > 8 {
		messages = append(messages[:8], fmt.Sprintf("... and %d more", len(messages)-8))
	}
	return fmt.Errorf("go/packages reported an incomplete program: %s", strings.Join(messages, "; "))
}

// Whether a source lies inside a directory the go tool ignores.
//
// Directory segments only: the final element is the file itself, and a Go
// source is named `*.go`, so a file could never be the `testdata` in question.
func underTestdata(root, filename string) bool {
	relative, err := filepath.Rel(root, filepath.Clean(filename))
	if err != nil {
		return false
	}
	segments := strings.Split(filepath.ToSlash(relative), "/")
	if len(segments) < 2 {
		return false
	}
	for _, segment := range segments[:len(segments)-1] {
		if segment == "testdata" {
			return true
		}
	}
	return false
}

func (c *collector) units(loaded []*packages.Package) ([]unit, error) {
	var units []unit
	seenUnit := map[string]bool{}
	for _, pkg := range loaded {
		if pkg.Types == nil || pkg.TypesInfo == nil || pkg.Fset == nil {
			continue
		}
		for _, file := range pkg.Syntax {
			position := pkg.Fset.PositionFor(file.Pos(), true)
			if position.Filename == "" || !within(c.root, position.Filename) {
				continue
			}
			// `go help packages`: "The go tool will ignore a directory named
			// testdata". scip-go enumerates by pattern and so never indexes one,
			// while the checker reaches it through an ordinary import — a
			// package may explicitly import a sibling under `testdata`, which is
			// legal because
			// testdata is skipped by pattern matching and not by the importer.
			//
			// The two therefore disagreed about what the project is, and the
			// corroboration rule refused every build containing the idiom. This
			// settles the disagreement at the boundary instead of weakening the
			// rule: nothing here is owned, nothing is emitted, and nothing is
			// owed. What a package pattern does not cover is not what this index
			// describes, and a package reached only by import is a dependency
			// like any other.
			if underTestdata(c.root, position.Filename) {
				continue
			}
			absolute := filepath.Clean(position.Filename)
			key := pkg.ID + "\x00" + absolute
			if seenUnit[key] {
				continue
			}
			seenUnit[key] = true
			fileName := c.fileIdentity(absolute)
			checkerDigest := c.checkerDigests[absolute]
			if checkerDigest == "" {
				return nil, fmt.Errorf("Go checker published syntax without source bytes: %s", absolute)
			}
			if c.checkerConflicts[absolute] {
				return nil, fmt.Errorf("Go source changed between checker loads: %s", absolute)
			}
			body, err := os.ReadFile(absolute)
			if err != nil {
				return nil, fmt.Errorf("read checker input %s: %w", absolute, err)
			}
			diskDigest := digestBytes(body)
			if checkerDigest != diskDigest {
				return nil, fmt.Errorf("Go source changed after the checker parsed it: %s", absolute)
			}
			c.sources[fileName] = source{
				File: fileName, CheckerDigest: checkerDigest, DiskDigest: diskDigest,
			}
			c.workspacePackages[pkg.PkgPath] = true
			units = append(units, unit{pkg: pkg, file: file, fileName: fileName})
		}
	}
	sort.Slice(units, func(i, j int) bool {
		if units[i].pkg.PkgPath != units[j].pkg.PkgPath {
			return units[i].pkg.PkgPath < units[j].pkg.PkgPath
		}
		if units[i].fileName != units[j].fileName {
			return units[i].fileName < units[j].fileName
		}
		return units[i].pkg.ID < units[j].pkg.ID
	})
	return units, nil
}

func (c *collector) addContainers(units []unit) {
	firstFile := map[string]string{}
	packageNames := map[string]string{}
	for _, current := range units {
		if firstFile[current.pkg.PkgPath] == "" {
			firstFile[current.pkg.PkgPath] = current.fileName
			packageNames[current.pkg.PkgPath] = current.pkg.Name
		}
	}
	paths := make([]string, 0, len(firstFile))
	for pkgPath := range firstFile {
		paths = append(paths, pkgPath)
	}
	sort.Strings(paths)
	for _, pkgPath := range paths {
		id := semanticID("package", "package:"+pkgPath, pkgPath, "")
		c.packageIDs[pkgPath] = id
		c.addNode(node{
			ID: id, Kind: "package", Language: "go", Name: packageNames[pkgPath],
			QualifiedName: pkgPath, File: firstFile[pkgPath], External: false,
		})
	}
	for index := range units {
		current := &units[index]
		current.packageID = c.packageIDs[current.pkg.PkgPath]
		current.fileID = semanticID(
			"file",
			"file:"+current.fileName,
			filepath.Base(current.fileName),
			"",
		)
		c.addNode(node{
			ID: current.fileID, Kind: "file", Language: "go", Name: filepath.Base(current.fileName),
			File: current.fileName, External: false,
		})
		c.addEdge(edge{From: current.packageID, To: current.fileID, Kind: "contains"})
	}
}

func (c *collector) addDeclarations(units []unit) {
	for _, current := range units {
		for _, declaration := range current.file.Decls {
			generic, ok := declaration.(*ast.GenDecl)
			if !ok {
				continue
			}
			for _, specification := range generic.Specs {
				switch spec := specification.(type) {
				case *ast.TypeSpec:
					c.addType(&current, spec)
				case *ast.ValueSpec:
					c.addValues(&current, generic.Tok, spec)
				}
			}
		}
	}
	for _, current := range units {
		for _, declaration := range current.file.Decls {
			if function, ok := declaration.(*ast.FuncDecl); ok {
				c.addFunction(&current, function)
			}
		}
	}
}

func (c *collector) addType(current *unit, spec *ast.TypeSpec) {
	object, ok := current.pkg.TypesInfo.Defs[spec.Name].(*types.TypeName)
	if !ok {
		return
	}
	kind := "type"
	switch object.Type().Underlying().(type) {
	case *types.Struct:
		kind = "class"
	case *types.Interface:
		kind = "interface"
	}
	qualified := current.pkg.PkgPath + "." + spec.Name.Name
	id := c.addObjectNode(current, object, kind, spec.Name.Name, qualified, spec, nil)
	c.addTypeParameters(current, id, qualified, spec.TypeParams)
	switch body := spec.Type.(type) {
	case *ast.StructType:
		for _, field := range body.Fields.List {
			for _, name := range field.Names {
				if object := current.pkg.TypesInfo.Defs[name]; object != nil {
					c.addObjectNode(current, object, "field", name.Name,
						qualified+"."+name.Name, field, &id)
				}
			}
		}
	case *ast.InterfaceType:
		for _, field := range body.Methods.List {
			for _, name := range field.Names {
				if object := current.pkg.TypesInfo.Defs[name]; object != nil {
					c.addObjectNode(current, object, "method", name.Name,
						qualified+"."+name.Name, field, &id)
				}
			}
		}
	}
}

func (c *collector) addValues(current *unit, tokenKind token.Token, spec *ast.ValueSpec) {
	for _, name := range spec.Names {
		// The blank identifier declares nothing. `var _ Iface = T{}` exists
		// precisely so the assertion binds no name, and go/types still records
		// it in Defs — so it arrives here with an object like any other.
		//
		// Emitting it as a node is wrong twice over: nothing can ever reference
		// a symbol with no name, and every blank at package scope derives the
		// same qualified identity, so the second one is a conflict that fails
		// the build rather than a graph missing an edge.
		if name.Name == "_" {
			continue
		}
		object := current.pkg.TypesInfo.Defs[name]
		if object == nil {
			continue
		}
		qualified := current.pkg.PkgPath + "." + name.Name
		extra := []string{}
		if tokenKind == token.CONST {
			extra = append(extra, "const")
		}
		c.addObjectNode(current, object, "variable", name.Name, qualified, spec, nil, extra...)
	}
}

func (c *collector) addFunction(current *unit, declaration *ast.FuncDecl) {
	object, ok := current.pkg.TypesInfo.Defs[declaration.Name].(*types.Func)
	if !ok {
		return
	}
	kind := "function"
	qualified := current.pkg.PkgPath + "." + declaration.Name.Name
	var owner *string
	if declaration.Recv != nil && len(declaration.Recv.List) != 0 {
		kind = "method"
		if named := namedFromType(current.pkg.TypesInfo.TypeOf(declaration.Recv.List[0].Type)); named != nil {
			if ownerID := c.targetForObject(named.Obj()); ownerID != "" {
				owner = &ownerID
				qualified = current.pkg.PkgPath + "." + named.Obj().Name() + "." + declaration.Name.Name
			}
		}
	}
	id := c.addObjectNode(current, object, kind, declaration.Name.Name, qualified, declaration, owner)
	c.addTypeParameters(current, id, qualified, declaration.Type.TypeParams)
	c.addParameters(current, id, qualified, declaration.Recv)
	c.addParameters(current, id, qualified, declaration.Type.Params)
	c.addParameters(current, id, qualified, declaration.Type.Results)
}

func (c *collector) addTypeParameters(current *unit, ownerID, qualified string, fields *ast.FieldList) {
	if fields == nil {
		return
	}
	for _, field := range fields.List {
		for _, name := range field.Names {
			if object := current.pkg.TypesInfo.Defs[name]; object != nil {
				c.addObjectNode(current, object, "type", name.Name,
					qualified+"."+name.Name, field, &ownerID)
			}
		}
	}
}

func (c *collector) addParameters(current *unit, ownerID, qualified string, fields *ast.FieldList) {
	if fields == nil {
		return
	}
	for _, field := range fields.List {
		for _, name := range field.Names {
			if object := current.pkg.TypesInfo.Defs[name]; object != nil {
				c.addObjectNode(current, object, "parameter", name.Name,
					qualified+"."+name.Name, field, &ownerID)
			}
		}
	}
}

func (c *collector) addObjectNode(
	current *unit,
	object types.Object,
	kind, name, qualified string,
	positioned ast.Node,
	owner *string,
	extraModifiers ...string,
) string {
	symbol := objectSymbol(object, qualified)
	// Go allows many `func init()` in one package and forbids referring to any
	// of them, so every one shares a FullName and they all derive one identity.
	// A real package can have several; the second used to collide.
	//
	// Unlike the blank identifier this cannot be skipped: an init body runs and
	// what it calls are edges worth having. So it is disambiguated by where it
	// is written, the same way a closure is — position is the only thing that
	// distinguishes two declarations the language deliberately left
	// indistinguishable by name.
	if isPackageInit(object, kind) {
		position := current.pkg.Fset.PositionFor(positioned.Pos(), true)
		symbol += "::" + current.fileName + "::" + strconv.Itoa(position.Offset)
	}
	id := semanticID(kind, symbol, qualified, "")
	exported := object.Exported() && kind != "parameter" && !(kind == "type" && owner != nil)
	modifiers := []string{}
	if kind != "parameter" {
		modifiers = visibilityModifiers(exported)
	}
	modifiers = append(modifiers, extraModifiers...)
	c.addNode(node{
		ID: id, Kind: kind, Language: "go", Name: name, QualifiedName: qualified,
		File: current.fileName, External: false, Exported: exported,
		Modifiers: modifiers, Evidence: c.evidence(current.pkg, positioned),
	})
	c.objectIDs[object] = id
	key := declarationObjectKey(object, qualified)
	if existing, ok := c.objectKeyIDs[key]; !ok {
		c.objectKeyIDs[key] = id
	} else if existing != id {
		c.objectKeyIDs[key] = ambiguousObjectID
	}
	container := current.fileID
	if owner != nil {
		container = *owner
	}
	c.addEdge(edge{From: container, To: id, Kind: "contains"})
	if owner == nil && exported {
		c.addEdge(edge{From: current.packageID, To: id, Kind: "exports"})
	}
	return id
}

func (c *collector) addImports(units []unit) {
	for _, current := range units {
		for _, imported := range current.file.Imports {
			pathValue, err := strconv.Unquote(imported.Path.Value)
			if err != nil {
				continue
			}
			target := c.packageIDs[pathValue]
			if target == "" {
				target = c.externalPackage(pathValue)
			}
			c.addEdge(edge{
				From: current.fileID, To: target, Kind: "imports",
				Evidence: c.evidence(current.pkg, imported),
			})
		}
	}
}

func (c *collector) addRelationships(units []unit) {
	for _, current := range units {
		for _, declaration := range current.file.Decls {
			switch value := declaration.(type) {
			case *ast.FuncDecl:
				object := current.pkg.TypesInfo.Defs[value.Name]
				sourceID := c.targetForObject(object)
				if sourceID != "" {
					visitor := &semanticVisitor{
						collector: c, unit: &current, sourceID: sourceID,
						test:   isTestFunction(current.pkg, current.fileName, current.file, value),
						called: map[ast.Node]bool{},
					}
					ast.Walk(visitor, value.Type)
					if value.Body != nil {
						ast.Walk(visitor, value.Body)
					}
				}
			case *ast.GenDecl:
				for _, raw := range value.Specs {
					switch spec := raw.(type) {
					case *ast.TypeSpec:
						sourceID := c.targetForObject(current.pkg.TypesInfo.Defs[spec.Name])
						if sourceID != "" {
							ast.Walk(&semanticVisitor{
								collector: c, unit: &current, sourceID: sourceID,
								called: map[ast.Node]bool{},
							}, spec.Type)
						}
					case *ast.ValueSpec:
						for _, expression := range spec.Values {
							ast.Walk(&semanticVisitor{
								collector: c, unit: &current, sourceID: current.packageID,
								called: map[ast.Node]bool{},
							}, expression)
						}
					}
				}
			}
		}
	}
}

func namedTypes(units []unit) []namedType {
	var values []namedType
	for _, current := range units {
		for _, declaration := range current.file.Decls {
			generic, ok := declaration.(*ast.GenDecl)
			if !ok {
				continue
			}
			for _, raw := range generic.Specs {
				spec, ok := raw.(*ast.TypeSpec)
				if !ok {
					continue
				}
				object, ok := current.pkg.TypesInfo.Defs[spec.Name].(*types.TypeName)
				if !ok {
					continue
				}
				named, ok := object.Type().(*types.Named)
				if !ok {
					continue
				}
				values = append(values, namedType{typeValue: named})
			}
		}
	}
	return values
}

func (c *collector) addImplementations(values []namedType) {
	kept := values[:0]
	for index := range values {
		values[index].id = c.targetForObject(values[index].typeValue.Obj())
		if values[index].id != "" {
			kept = append(kept, values[index])
		}
	}
	values = kept
	sort.Slice(values, func(i, j int) bool { return values[i].id < values[j].id })
	for _, candidate := range values {
		if _, isInterface := candidate.typeValue.Underlying().(*types.Interface); isInterface {
			continue
		}
		for _, contract := range values {
			iface, ok := contract.typeValue.Underlying().(*types.Interface)
			if !ok || iface.NumMethods() == 0 {
				continue
			}
			iface.Complete()
			implementation := types.Type(candidate.typeValue)
			if !types.Implements(implementation, iface) {
				pointer := types.NewPointer(candidate.typeValue)
				if !types.Implements(pointer, iface) {
					continue
				}
				implementation = pointer
			}
			c.addEdge(edge{From: candidate.id, To: contract.id, Kind: "implements"})
			for index := 0; index < iface.NumMethods(); index++ {
				abstract := iface.Method(index)
				abstractID := c.targetForObject(abstract)
				concrete, _, _ := types.LookupFieldOrMethod(
					implementation, true, abstract.Pkg(), abstract.Name(),
				)
				concreteID := c.targetForObject(concrete)
				if abstractID != "" && concreteID != "" && abstractID != concreteID {
					c.addEdge(edge{From: abstractID, To: concreteID, Kind: "dispatches"})
				}
			}
		}
	}
}

type semanticVisitor struct {
	collector *collector
	unit      *unit
	sourceID  string
	test      bool
	called    map[ast.Node]bool
}

func (visitor *semanticVisitor) Visit(raw ast.Node) ast.Visitor {
	if raw == nil {
		return nil
	}
	switch value := raw.(type) {
	case *ast.FuncLit:
		closureID := visitor.collector.addClosure(visitor.unit, visitor.sourceID, value)
		return &semanticVisitor{
			collector: visitor.collector, unit: visitor.unit, sourceID: closureID,
			test: visitor.test, called: visitor.called,
		}
	case *ast.CallExpr:
		visitor.markCalled(value.Fun)
		visitor.addCall(value)
	case *ast.CompositeLit:
		visitor.addInstantiation(value.Type, value)
	case *ast.SelectorExpr:
		if !visitor.called[value] && !visitor.called[value.Sel] {
			visitor.addSelectorUse(value)
			visitor.called[value.Sel] = true
		}
	case *ast.Ident:
		if !visitor.called[value] {
			visitor.addUse(value, value)
		}
	}
	return visitor
}

func (visitor *semanticVisitor) addSelectorUse(selector *ast.SelectorExpr) {
	info := visitor.unit.pkg.TypesInfo
	selection := info.Selections[selector]
	if selection == nil {
		visitor.addUse(selector.Sel, selector)
		return
	}
	object := selection.Obj()
	switch typed := object.(type) {
	case *types.TypeName:
		visitor.addTypeReference(namedFromType(typed.Type()), selector)
	case *types.Var, *types.Const:
		visitor.addObjectEdgeTo(
			visitor.collector.targetForSelection(selection),
			"accesses",
			selector,
		)
	case *types.Func:
		visitor.addObjectEdgeTo(
			visitor.collector.targetForSelection(selection),
			"references",
			selector,
		)
	}
}

func (visitor *semanticVisitor) markCalled(expression ast.Expr) {
	for {
		switch value := expression.(type) {
		case *ast.ParenExpr:
			expression = value.X
		case *ast.IndexExpr:
			expression = value.X
		case *ast.IndexListExpr:
			expression = value.X
		default:
			visitor.called[expression] = true
			if selector, ok := expression.(*ast.SelectorExpr); ok {
				visitor.called[selector.Sel] = true
			}
			return
		}
	}
}

func (visitor *semanticVisitor) addCall(call *ast.CallExpr) {
	info := visitor.unit.pkg.TypesInfo
	if typed, ok := info.Types[call.Fun]; ok && typed.IsType() {
		visitor.addTypeReference(namedFromType(typed.Type), call.Fun)
		return
	}
	base := unwrappedExpression(call.Fun)
	if identifier, ok := base.(*ast.Ident); ok && identifier.Name == "new" && len(call.Args) == 1 {
		visitor.addInstantiation(call.Args[0], call)
		return
	}
	object := objectOfExpression(info, base)
	target := visitor.collector.targetForObject(object)
	if target == "" {
		visitor.collector.unresolved++
		return
	}
	proof := visitor.collector.evidence(visitor.unit.pkg, call)
	visitor.collector.addEdge(edge{From: visitor.sourceID, To: target, Kind: "calls", Evidence: proof})
	if visitor.test {
		if targetNode, ok := visitor.collector.nodes[target]; ok && !targetNode.External {
			visitor.collector.addEdge(edge{From: visitor.sourceID, To: target, Kind: "tests", Evidence: proof})
		}
	}
}

func (visitor *semanticVisitor) addInstantiation(expression ast.Expr, positioned ast.Node) {
	named := namedFromType(visitor.unit.pkg.TypesInfo.TypeOf(expression))
	if named == nil {
		return
	}
	target := visitor.collector.targetForObject(named.Obj())
	if target != "" {
		visitor.collector.addEdge(edge{
			From: visitor.sourceID, To: target, Kind: "instantiates",
			Evidence: visitor.collector.evidence(visitor.unit.pkg, positioned),
		})
	}
}

func (visitor *semanticVisitor) addTypeReference(named *types.Named, positioned ast.Node) {
	if named == nil {
		return
	}
	target := visitor.collector.targetForObject(named.Obj())
	if target != "" && target != visitor.sourceID {
		visitor.collector.addEdge(edge{
			From: visitor.sourceID, To: target, Kind: "type_ref",
			Evidence: visitor.collector.evidence(visitor.unit.pkg, positioned),
		})
	}
}

func (visitor *semanticVisitor) addUse(identifier *ast.Ident, positioned ast.Node) {
	info := visitor.unit.pkg.TypesInfo
	if info.Defs[identifier] != nil {
		return
	}
	object := info.Uses[identifier]
	if object == nil {
		return
	}
	switch value := object.(type) {
	case *types.TypeName:
		visitor.addTypeReference(namedFromType(value.Type()), positioned)
	case *types.Var, *types.Const:
		visitor.addObjectEdge(object, "accesses", positioned)
	case *types.Func:
		visitor.addObjectEdge(object, "references", positioned)
	}
}

func (visitor *semanticVisitor) addObjectEdge(object types.Object, kind string, positioned ast.Node) {
	visitor.addObjectEdgeTo(visitor.collector.targetForObject(object), kind, positioned)
}

func (visitor *semanticVisitor) addObjectEdgeTo(target, kind string, positioned ast.Node) {
	if target == "" || target == visitor.sourceID {
		return
	}
	visitor.collector.addEdge(edge{
		From: visitor.sourceID, To: target, Kind: kind,
		Evidence: visitor.collector.evidence(visitor.unit.pkg, positioned),
	})
}

func (c *collector) addClosure(current *unit, owner string, literal *ast.FuncLit) string {
	position := current.pkg.Fset.PositionFor(literal.Type.Func, true)
	name := fmt.Sprintf("func@%d:%d", position.Line, position.Column)
	qualified := c.nodes[owner].QualifiedName
	if qualified == "" {
		qualified = c.nodes[owner].Name
	}
	qualified += "." + name
	symbol := owner + "::" + current.fileName + "::" + strconv.Itoa(position.Offset)
	symbol += "::" + c.sources[current.fileName].CheckerDigest
	id := semanticID(
		"function",
		symbol,
		qualified,
		c.sources[current.fileName].CheckerDigest,
	)
	c.addNode(node{
		ID: id, Kind: "function", Language: "go", Name: name, QualifiedName: qualified,
		File: current.fileName, External: false, Closure: true,
		Modifiers: []string{"private"}, Evidence: c.evidence(current.pkg, literal),
	})
	c.addEdge(edge{From: owner, To: id, Kind: "contains"})
	return id
}

func (c *collector) addNode(value node) {
	if existing, exists := c.nodes[value.ID]; exists {
		if !reflect.DeepEqual(existing, value) && c.conflict == nil {
			c.conflict = fmt.Errorf(
				"conflicting Go facts derive the same semantic node id %s",
				value.ID,
			)
		}
		return
	}
	c.nodes[value.ID] = value
}

func (c *collector) addEdge(value edge) {
	if value.From == "" || value.To == "" {
		return
	}
	key := value.Kind + "\x00" + value.From + "\x00" + value.To
	// One semantic relation may be observed at several source sites and through
	// several go/packages variants. The relation is unique by kind/endpoints,
	// but retaining whichever evidence arrived first makes the published fact
	// depend on package traversal order. Keep the canonical proof instead:
	// evidence beats no evidence, then the earliest complete source span wins.
	if existing, exists := c.edges[key]; !exists ||
		evidenceLess(value.Evidence, existing.Evidence) {
		c.edges[key] = value
	}
}

func (c *collector) targetForObject(object types.Object) string {
	if object == nil {
		return ""
	}
	if id := c.knownObjectID(object); id != "" {
		return id
	}
	if object.Pkg() != nil && c.workspacePackages[object.Pkg().Path()] {
		return ""
	}
	return c.externalObject(object, "external:"+objectKey(object))
}

func (c *collector) targetForSelection(selection *types.Selection) string {
	object := selection.Obj()
	if id := c.objectIDs[object]; id != "" {
		return id
	}
	key := selectionObjectKey(selection)
	if id := c.objectKeyIDs[key]; id != "" && id != ambiguousObjectID {
		return id
	}
	if object.Pkg() != nil && c.workspacePackages[object.Pkg().Path()] {
		return ""
	}
	return c.externalObject(object, "external:"+key)
}

func (c *collector) knownObjectID(object types.Object) string {
	if id := c.objectIDs[object]; id != "" {
		return id
	}
	if id := c.objectKeyIDs[objectKey(object)]; id != "" && id != ambiguousObjectID {
		return id
	}
	return ""
}

func (c *collector) externalObject(object types.Object, symbol string) string {
	packagePath := "builtin"
	if object.Pkg() != nil {
		packagePath = object.Pkg().Path()
	}
	qualified := packagePath + "." + object.Name()
	id := semanticID("external_symbol", symbol, qualified, "")
	c.addNode(node{
		ID: id, Kind: "external_symbol", Language: "go", Name: object.Name(),
		QualifiedName: qualified, File: "bundled:///go/" + packagePath,
		External: true,
	})
	return id
}

func (c *collector) externalPackage(packagePath string) string {
	id := semanticID(
		"external_symbol",
		"external-package:"+packagePath,
		packagePath,
		"",
	)
	name := packagePath
	if slash := strings.LastIndex(packagePath, "/"); slash >= 0 {
		name = packagePath[slash+1:]
	}
	c.addNode(node{
		ID: id, Kind: "external_symbol", Language: "go", Name: name,
		QualifiedName: packagePath, File: "bundled:///go/" + packagePath,
		External: true,
	})
	return id
}

func (c *collector) evidence(pkg *packages.Package, positioned ast.Node) *evidence {
	start := pkg.Fset.PositionFor(positioned.Pos(), true)
	end := pkg.Fset.PositionFor(positioned.End(), true)
	if start.Filename == "" || start.Line < 1 {
		return nil
	}
	result := &evidence{
		File: c.fileIdentity(start.Filename), StartLine: start.Line, StartCol: start.Column,
	}
	if end.Column > 0 {
		// The common span wire requires the end line whenever an end column is
		// present, including a same-line declaration.
		result.EndLine = end.Line
		result.EndCol = end.Column
	} else if end.Line != start.Line {
		result.EndLine = end.Line
	}
	return result
}

func (c *collector) fileIdentity(file string) string {
	if within(c.root, file) {
		relative, _ := filepath.Rel(c.root, file)
		return filepath.ToSlash(relative)
	}
	return filepath.ToSlash(filepath.Clean(file))
}

func (c *collector) snapshotParts() ([]source, []node, []edge) {
	sources := make([]source, 0, len(c.sources))
	for _, value := range c.sources {
		sources = append(sources, value)
	}
	sort.Slice(sources, func(i, j int) bool { return sources[i].File < sources[j].File })
	nodes := make([]node, 0, len(c.nodes))
	for _, value := range c.nodes {
		nodes = append(nodes, value)
	}
	edges := make([]edge, 0, len(c.edges))
	for _, value := range c.edges {
		edges = append(edges, value)
	}
	return sources, nodes, edges
}

// Whether this is a package initializer, which the language lets a package
// declare more than once and lets nothing refer to.
//
// The kind check already excludes methods, and a method named `init` is an
// ordinary referenceable method that must keep its name-based identity; the
// receiver check says so directly rather than leaving it to that coincidence.
func isPackageInit(object types.Object, kind string) bool {
	if kind != "function" {
		return false
	}
	function, ok := object.(*types.Func)
	if !ok || function.Name() != "init" {
		return false
	}
	signature, ok := function.Type().(*types.Signature)
	return ok && signature.Recv() == nil
}

func objectSymbol(object types.Object, qualified string) string {
	return objectKey(object) + "::" + qualified
}

func objectKey(object types.Object) string {
	if object == nil {
		return ""
	}
	if function, ok := object.(*types.Func); ok {
		return function.FullName()
	}
	packagePath := "builtin"
	if object.Pkg() != nil {
		packagePath = object.Pkg().Path()
	}
	return packagePath + "::" + fmt.Sprintf("%T", object) + "::" + object.Name()
}

func declarationObjectKey(object types.Object, qualified string) string {
	if variable, ok := object.(*types.Var); ok && variable.IsField() {
		return "field::" + qualified
	}
	return objectKey(object)
}

func selectionObjectKey(selection *types.Selection) string {
	object := selection.Obj()
	variable, isField := object.(*types.Var)
	if !isField || !variable.IsField() {
		return objectKey(object)
	}
	owner := selectionOwner(selection)
	if owner != nil && owner.Obj() != nil && owner.Obj().Pkg() != nil {
		return "field::" + owner.Obj().Pkg().Path() + "." + owner.Obj().Name() + "." + object.Name()
	}
	return "field::" + types.TypeString(selection.Recv(), packageQualifier) + "." + object.Name()
}

func selectionOwner(selection *types.Selection) *types.Named {
	current := selection.Recv()
	indices := selection.Index()
	for index := range indices {
		if index == len(indices)-1 {
			return namedFromType(current)
		}
		value := current
		if named := namedFromType(value); named != nil {
			value = named.Underlying()
		} else if pointer, ok := value.(*types.Pointer); ok {
			value = pointer.Elem()
		}
		structure, ok := value.Underlying().(*types.Struct)
		if !ok || indices[index] >= structure.NumFields() {
			return nil
		}
		current = structure.Field(indices[index]).Type()
	}
	return nil
}

func packageQualifier(pkg *types.Package) string {
	if pkg == nil {
		return ""
	}
	return pkg.Path()
}

func visibilityModifiers(exported bool) []string {
	if exported {
		return []string{"export", "public"}
	}
	return []string{"private"}
}

func objectOfExpression(info *types.Info, expression ast.Expr) types.Object {
	switch value := expression.(type) {
	case *ast.Ident:
		return info.Uses[value]
	case *ast.SelectorExpr:
		if selection := info.Selections[value]; selection != nil {
			return selection.Obj()
		}
		return info.Uses[value.Sel]
	default:
		return nil
	}
}

func unwrappedExpression(expression ast.Expr) ast.Expr {
	for {
		switch value := expression.(type) {
		case *ast.ParenExpr:
			expression = value.X
		case *ast.IndexExpr:
			expression = value.X
		case *ast.IndexListExpr:
			expression = value.X
		default:
			return expression
		}
	}
}

func namedFromType(value types.Type) *types.Named {
	for value != nil {
		switch typed := value.(type) {
		case *types.Named:
			return typed
		case *types.Pointer:
			value = typed.Elem()
		case *types.Alias:
			value = types.Unalias(typed)
		default:
			return nil
		}
	}
	return nil
}

func isTestFunction(
	pkg *packages.Package,
	file string,
	syntax *ast.File,
	declaration *ast.FuncDecl,
) bool {
	if !strings.HasSuffix(file, "_test.go") {
		return false
	}
	object, ok := pkg.TypesInfo.Defs[declaration.Name].(*types.Func)
	if !ok {
		return false
	}
	signature, ok := object.Type().(*types.Signature)
	if !ok || signature.Recv() != nil || signature.Results().Len() != 0 {
		return false
	}
	if parameters := signature.TypeParams(); parameters != nil && parameters.Len() != 0 {
		return false
	}
	name := declaration.Name.Name
	if validTestName(name, "Example") {
		if signature.Params().Len() != 0 {
			return false
		}
		exampleName := strings.TrimPrefix(name, "Example")
		for _, example := range doc.Examples(syntax) {
			if example.Name == exampleName && (example.Output != "" || example.EmptyOutput) {
				return true
			}
		}
		return false
	}
	expected := ""
	switch {
	case name == "TestMain":
		expected = "M"
	case validTestName(name, "Test"):
		expected = "T"
	case validTestName(name, "Benchmark"):
		expected = "B"
	case validTestName(name, "Fuzz"):
		expected = "F"
	default:
		return false
	}
	if signature.Params().Len() != 1 {
		return false
	}
	parameter := namedFromType(signature.Params().At(0).Type())
	return parameter != nil && parameter.Obj() != nil && parameter.Obj().Pkg() != nil &&
		parameter.Obj().Pkg().Path() == "testing" && parameter.Obj().Name() == expected
}

func validTestName(name, prefix string) bool {
	if !strings.HasPrefix(name, prefix) {
		return false
	}
	if len(name) == len(prefix) {
		return true
	}
	first, _ := utf8.DecodeRuneInString(name[len(prefix):])
	return !unicode.IsLower(first)
}

func within(root, file string) bool {
	relative, err := filepath.Rel(root, file)
	return err == nil && !filepath.IsAbs(relative) && !escapesRoot(relative)
}

const ambiguousObjectID = "<ambiguous>"
