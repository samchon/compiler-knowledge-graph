import Foundation

private let capability =
  "Serve explicit-output-unit SwiftPM IndexStoreDB generations over NDJSON."
private let arguments = Array(CommandLine.arguments.dropFirst())

do {
  if arguments.contains("--version") {
    print("samchon-swift-graph 0.1.0 indexstore-db f4d7f08f6a078050d86aed10a06bf1fc871a8ded")
  } else if arguments.first == "supports" {
    let root = try cwd(arguments)
    guard SwiftGraphProducer.supports(root: root) else { exit(1) }
  } else if arguments.first == "snapshot" {
    let root = try cwd(arguments)
    let output = try value("--output", in: arguments)
    try SwiftGraphProducer(root: root).write(to: absolute(output, relativeTo: root))
  } else if arguments.first == "graph-server" && arguments.contains("--help") {
    print(capability)
  } else if arguments.first == "graph-server" {
    try serve(root: cwd(arguments))
  } else {
    throw MainError.message(
      "usage: samchon-swift-graph --version | supports --cwd ROOT | snapshot --cwd ROOT --output FILE | graph-server --cwd ROOT"
    )
  }
} catch {
  FileHandle.standardError.write(Data("\(error)\n".utf8))
  exit(2)
}

private struct Request: Decodable {
  let id: Int
  let protocolVersion: Int
  let output: String
}

private struct Response: Encodable {
  let id: Int
  let protocolVersion: Int
  let ok: Bool
  let error: String?
}

private enum MainError: Error, CustomStringConvertible {
  case message(String)
  var description: String {
    switch self { case .message(let text): return text }
  }
}

private func serve(root: URL) throws {
  let decoder = JSONDecoder()
  let encoder = JSONEncoder()
  while let line = readLine() {
    guard !line.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty else { continue }
    var identifier = 0
    do {
      let request = try decoder.decode(Request.self, from: Data(line.utf8))
      identifier = request.id
      guard request.protocolVersion == 1 else {
        throw MainError.message("request protocolVersion must be 1")
      }
      try SwiftGraphProducer(root: root).write(
        to: absolute(request.output, relativeTo: root)
      )
      try answer(Response(id: identifier, protocolVersion: 1, ok: true, error: nil), encoder: encoder)
    } catch {
      try answer(Response(id: identifier, protocolVersion: 1, ok: false, error: String(describing: error)), encoder: encoder)
    }
  }
}

private func answer(_ response: Response, encoder: JSONEncoder) throws {
  let data = try encoder.encode(response)
  FileHandle.standardOutput.write(data)
  FileHandle.standardOutput.write(Data([0x0a]))
}

private func cwd(_ arguments: [String]) throws -> URL {
  if let index = arguments.firstIndex(of: "--cwd"), arguments.indices.contains(index + 1) {
    return URL(fileURLWithPath: arguments[index + 1]).standardizedFileURL
  }
  return URL(fileURLWithPath: FileManager.default.currentDirectoryPath).standardizedFileURL
}

private func value(_ name: String, in arguments: [String]) throws -> String {
  guard let index = arguments.firstIndex(of: name), arguments.indices.contains(index + 1) else {
    throw MainError.message("\(name) requires a value")
  }
  return arguments[index + 1]
}

private func absolute(_ path: String, relativeTo root: URL) -> URL {
  path.hasPrefix("/")
    ? URL(fileURLWithPath: path).standardizedFileURL
    : root.appendingPathComponent(path).standardizedFileURL
}
