// swift-tools-version: 5.10

import PackageDescription

let package = Package(
  name: "SamchonSwiftGraph",
  platforms: [.macOS(.v13)],
  products: [
    .executable(name: "samchon-swift-graph", targets: ["SamchonSwiftGraph"]),
  ],
  dependencies: [
    .package(
      url: "https://github.com/swiftlang/indexstore-db.git",
      revision: "54212fce1aecb199070808bdb265e7f17e396015"
    ),
  ],
  targets: [
    .executableTarget(
      name: "SamchonSwiftGraph",
      dependencies: [
        .product(name: "IndexStoreDB", package: "indexstore-db"),
      ]
    ),
  ],
  cxxLanguageStandard: .cxx17
)
