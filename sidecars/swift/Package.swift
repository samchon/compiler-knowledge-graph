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
      revision: "f4d7f08f6a078050d86aed10a06bf1fc871a8ded"
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
