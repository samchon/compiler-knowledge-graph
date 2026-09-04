# Swift IndexStoreDB sidecar

This SwiftPM package builds `samchon-swift-graph`, the standalone strict Swift
producer shipped as source with `@samchon/graph`. It runs the package's native
incremental
`swift build --enable-index-store --build-tests -Xswiftc -index-include-locals`,
takes only the current build description's source and object paths, opens the
completed store with IndexStoreDB's explicit-output-unit mode, and commits one
atomic graph artifact.

IndexStoreDB is pinned to commit
`f4d7f08f6a078050d86aed10a06bf1fc871a8ded`, the Swift 6.0 release commit. The
binary must run with a matching Swift toolchain and `libIndexStore`. macOS and
Linux are supported; Windows declines the strict route.

Build and expose the executable on `PATH`, or set
`SAMCHON_GRAPH_SWIFT_GRAPH` to its absolute path:

```bash
swift build --package-path sidecars/swift -c release
```

On Linux, IndexStoreDB's C++ targets also need the Swift toolchain's dispatch
headers, as documented upstream:

```bash
SWIFT_ROOT="$(dirname "$(dirname "$(command -v swift)")")"
swift build --package-path sidecars/swift -c release \
  -Xcxx "-I${SWIFT_ROOT}/lib/swift" \
  -Xcxx "-I${SWIFT_ROOT}/lib/swift/Block"
```

The sidecar keeps its process resident, but it does not claim ownership of
SourceKit-LSP's scheduler or caches. Each changed generation is a completed
SwiftPM build followed by a frozen IndexStoreDB query. The ordinary
SourceKit-LSP/static route remains the fallback when the sidecar or matching
toolchain is unavailable.
