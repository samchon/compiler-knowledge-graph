# Swift IndexStoreDB sidecar

This SwiftPM package builds `samchon-swift-graph`, the standalone strict Swift
producer shipped as source with `@samchon/graph`. It runs the package's native
incremental
`swift build --enable-index-store --build-tests -Xswiftc -index-include-locals`,
takes only the current build description's source and object paths, opens the
completed store with IndexStoreDB's explicit-output-unit mode, and commits one
atomic graph artifact.

IndexStoreDB is pinned to the Swift 6.1 release commit
`54212fce1aecb199070808bdb265e7f17e396015`. That release retains Swift 6.0 source
compatibility and fixes the 64-bit canonical-role declaration for Clang 19 and
newer. The binary must run with a compatible Swift toolchain and
`libIndexStore`. macOS and Linux are supported; Windows declines the strict
route.

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
