import Foundation

struct ImportFact {
  let module: String
  let evidence: Evidence
}

struct AttributeFact {
  let name: String
  let evidence: Evidence
}

struct SourceEnrichment {
  let relativePath: String
  let data: Data
  private let lines: [String]

  init(url: URL, relativePath: String) throws {
    self.relativePath = relativePath
    data = try Data(contentsOf: url)
    lines = String(decoding: data, as: UTF8.self)
      .split(separator: "\n", omittingEmptySubsequences: false)
      .map(String.init)
  }

  var digest: String { SHA256.hash(data) }

  func evidence(line: Int, utf8Column: Int, name: String) -> Evidence {
    let lineNumber = min(max(line, 1), max(lines.count, 1))
    let text = lines.indices.contains(lineNumber - 1) ? lines[lineNumber - 1] : ""
    let bytes = Array(text.utf8)
    let requested = min(max(utf8Column - 1, 0), bytes.count)
    let needle = Array(name.utf8)
    let found = find(needle, in: bytes, atOrAfter: requested)
      ?? find(needle, in: bytes, atOrAfter: 0)
      ?? requested
    return Evidence(
      file: relativePath,
      startLine: lineNumber,
      startColumn: found + 1,
      endLine: lineNumber,
      endColumn: found + max(needle.count, 1) + 1
    )
  }

  func signature(line: Int) -> String {
    guard lines.indices.contains(line - 1) else { return "" }
    var value = lines[line - 1].trimmingCharacters(in: .whitespaces)
    if let body = value.firstIndex(of: "{") {
      value = String(value[..<body]).trimmingCharacters(in: .whitespaces)
    } else if (value.hasPrefix("let ") || value.hasPrefix("var ")),
              let initializer = value.firstIndex(of: "=") {
      value = String(value[..<initializer]).trimmingCharacters(in: .whitespaces)
    }
    return value
  }

  func modifiers(line: Int, properties: UInt64) -> [String] {
    let head = signature(line: line)
    var values: [String] = []
    if word("public", in: head) || word("open", in: head) { values.append("public") }
    if word("private", in: head) || word("fileprivate", in: head) { values.append("private") }
    if word("internal", in: head) || word("package", in: head) { values.append("internal") }
    if word("static", in: head) { values.append("static") }
    if word("let", in: head) { values.append("readonly") }
    if word("async", in: head) { values.append("async") }
    // INDEXSTOREDB_SYMBOL_PROPERTY_SWIFT_ASYNC is 1 << 9 in the pinned API.
    if properties & (1 << 9) != 0 && !values.contains("async") { values.append("async") }
    return values
  }

  func isExported(line: Int) -> Bool {
    let head = signature(line: line)
    return word("public", in: head) || word("open", in: head) || word("package", in: head)
  }

  func isStaticallyClosed(line: Int) -> Bool {
    let head = signature(line: line)
    return word("final", in: head) || word("static", in: head) || word("private", in: head)
  }

  func imports() -> [ImportFact] {
    let expression = try! NSRegularExpression(
      pattern: #"^\s*(?:@testable\s+)?import\s+(?:(?:struct|class|enum|protocol|typealias|func|var|let)\s+)?([A-Za-z_][A-Za-z0-9_]*)"#
    )
    return lines.enumerated().compactMap { index, line in
      let range = NSRange(line.startIndex..<line.endIndex, in: line)
      guard let match = expression.firstMatch(in: line, range: range),
            let moduleRange = Range(match.range(at: 1), in: line) else { return nil }
      let module = String(line[moduleRange])
      let column = line.utf8.distance(from: line.utf8.startIndex, to: moduleRange.lowerBound.samePosition(in: line.utf8)!) + 1
      return ImportFact(
        module: module,
        evidence: evidence(line: index + 1, utf8Column: column, name: module)
      )
    }
  }

  func attributes(at line: Int) -> [AttributeFact] {
    let expression = try! NSRegularExpression(
      pattern: #"@([A-Za-z_][A-Za-z0-9_.]*)"#
    )
    var rows: [(Int, String)] = []
    var index = min(max(line - 1, 0), max(lines.count - 1, 0))
    while lines.indices.contains(index) {
      let text = lines[index].trimmingCharacters(in: .whitespaces)
      if index != line - 1 && !text.hasPrefix("@") { break }
      rows.append((index, lines[index]))
      if index == 0 { break }
      index -= 1
    }
    return rows.reversed().flatMap { row, text in
      let range = NSRange(text.startIndex..<text.endIndex, in: text)
      return expression.matches(in: text, range: range).compactMap { match in
        guard let nameRange = Range(match.range(at: 1), in: text) else { return nil }
        let name = String(text[nameRange])
        let column = text.utf8.distance(from: text.utf8.startIndex, to: nameRange.lowerBound.samePosition(in: text.utf8)!) + 1
        return AttributeFact(
          name: name,
          evidence: evidence(line: row + 1, utf8Column: column, name: name)
        )
      }
    }
  }

  func unresolvedSyntax() -> [UnresolvedSite] {
    lines.enumerated().flatMap { index, line -> [UnresolvedSite] in
      var sites: [UnresolvedSite] = []
      if let range = line.range(of: "#if") {
        let column = line.utf8.distance(from: line.utf8.startIndex, to: range.lowerBound.samePosition(in: line.utf8)!) + 1
        sites.append(UnresolvedSite(
          family: "references",
          reason: "conditional-build",
          evidence: evidence(line: index + 1, utf8Column: column, name: "#if"),
          candidates: []
        ))
      }
      if let range = line.range(of: "#externalMacro") ?? line.range(of: "#") {
        let token = line[range.lowerBound...].prefix { $0 == "#" || $0.isLetter || $0.isNumber || $0 == "_" }
        let name = String(token)
        if name != "#if" && name != "#else" && name != "#endif" {
          let column = line.utf8.distance(from: line.utf8.startIndex, to: range.lowerBound.samePosition(in: line.utf8)!) + 1
          sites.append(UnresolvedSite(
            family: "references",
            reason: "macro-or-generated",
            evidence: evidence(line: index + 1, utf8Column: column, name: name),
            candidates: []
          ))
        }
      }
      return sites
    }
  }

  private func word(_ value: String, in text: String) -> Bool {
    text.split { !$0.isLetter && !$0.isNumber && $0 != "_" }.contains(Substring(value))
  }

  private func find(_ needle: [UInt8], in haystack: [UInt8], atOrAfter start: Int) -> Int? {
    guard !needle.isEmpty, needle.count <= haystack.count else { return nil }
    let lower = min(max(start, 0), haystack.count - needle.count)
    for index in lower...(haystack.count - needle.count) {
      if Array(haystack[index..<(index + needle.count)]) == needle { return index }
    }
    return nil
  }
}
