import Foundation

enum StrictJSONFailure: Error {
  case rejected
}

func parseStrictJSON(
  _ data: Data,
  maximumBytes: Int,
  maximumDepth: Int = 64,
  maximumNodes: Int = 10_000
) throws -> Any {
  guard !data.isEmpty,
    data.count <= maximumBytes,
    String(data: data, encoding: .utf8) != nil
  else {
    throw StrictJSONFailure.rejected
  }
  var scanner = StrictJSONScanner(data, maximumDepth: maximumDepth, maximumNodes: maximumNodes)
  try scanner.parseRoot()
  return try JSONSerialization.jsonObject(with: data, options: [])
}

private struct StrictJSONScanner {
  private let bytes: [UInt8]
  private let maximumDepth: Int
  private let maximumNodes: Int
  private var index = 0
  private var nodes = 0

  init(_ data: Data, maximumDepth: Int, maximumNodes: Int) {
    bytes = Array(data)
    self.maximumDepth = maximumDepth
    self.maximumNodes = maximumNodes
  }

  mutating func parseRoot() throws {
    skipWhitespace()
    try parseValue(depth: 1)
    skipWhitespace()
    guard index == bytes.count else { throw StrictJSONFailure.rejected }
  }

  private mutating func parseValue(depth: Int) throws {
    skipWhitespace()
    nodes += 1
    guard depth <= maximumDepth, nodes <= maximumNodes, let byte = peek() else {
      throw StrictJSONFailure.rejected
    }
    switch byte {
    case UInt8(ascii: "{"):
      try parseObject(depth: depth)
    case UInt8(ascii: "["):
      try parseArray(depth: depth)
    case UInt8(ascii: "\""):
      _ = try parseString()
    case UInt8(ascii: "t"):
      try consumeLiteral("true")
    case UInt8(ascii: "f"):
      try consumeLiteral("false")
    case UInt8(ascii: "n"):
      try consumeLiteral("null")
    case UInt8(ascii: "-"), UInt8(ascii: "0")...UInt8(ascii: "9"):
      try parseNumber()
    default:
      throw StrictJSONFailure.rejected
    }
  }

  private mutating func parseObject(depth: Int) throws {
    try consume(UInt8(ascii: "{"))
    skipWhitespace()
    if take(UInt8(ascii: "}")) { return }
    var keys = Set<String>()
    while true {
      skipWhitespace()
      let key = try parseString()
      guard keys.insert(key).inserted else { throw StrictJSONFailure.rejected }
      skipWhitespace()
      try consume(UInt8(ascii: ":"))
      try parseValue(depth: depth + 1)
      skipWhitespace()
      if take(UInt8(ascii: "}")) { return }
      try consume(UInt8(ascii: ","))
    }
  }

  private mutating func parseArray(depth: Int) throws {
    try consume(UInt8(ascii: "["))
    skipWhitespace()
    if take(UInt8(ascii: "]")) { return }
    while true {
      try parseValue(depth: depth + 1)
      skipWhitespace()
      if take(UInt8(ascii: "]")) { return }
      try consume(UInt8(ascii: ","))
    }
  }

  private mutating func parseString() throws -> String {
    let start = index
    try consume(UInt8(ascii: "\""))
    while index < bytes.count {
      let byte = bytes[index]
      index += 1
      if byte == UInt8(ascii: "\"") {
        let token = Data(bytes[start..<index])
        var wrapped = Data([UInt8(ascii: "[")])
        wrapped.append(token)
        wrapped.append(UInt8(ascii: "]"))
        guard
          let values = try JSONSerialization.jsonObject(with: wrapped, options: []) as? [String],
          values.count == 1
        else {
          throw StrictJSONFailure.rejected
        }
        return values[0]
      }
      guard byte >= 0x20 else { throw StrictJSONFailure.rejected }
      if byte == UInt8(ascii: "\\") {
        guard index < bytes.count else { throw StrictJSONFailure.rejected }
        let escaped = bytes[index]
        index += 1
        if escaped == UInt8(ascii: "u") {
          guard index + 4 <= bytes.count else { throw StrictJSONFailure.rejected }
          for value in bytes[index..<(index + 4)] {
            guard
              (UInt8(ascii: "0")...UInt8(ascii: "9")).contains(value)
                || (UInt8(ascii: "a")...UInt8(ascii: "f")).contains(value)
                || (UInt8(ascii: "A")...UInt8(ascii: "F")).contains(value)
            else {
              throw StrictJSONFailure.rejected
            }
          }
          index += 4
        } else {
          guard
            [
              UInt8(ascii: "\""), UInt8(ascii: "\\"), UInt8(ascii: "/"), UInt8(ascii: "b"),
              UInt8(ascii: "f"), UInt8(ascii: "n"), UInt8(ascii: "r"), UInt8(ascii: "t"),
            ].contains(escaped)
          else {
            throw StrictJSONFailure.rejected
          }
        }
      }
    }
    throw StrictJSONFailure.rejected
  }

  private mutating func parseNumber() throws {
    _ = take(UInt8(ascii: "-"))
    guard let first = peek() else { throw StrictJSONFailure.rejected }
    if first == UInt8(ascii: "0") {
      index += 1
      if let next = peek(), (UInt8(ascii: "0")...UInt8(ascii: "9")).contains(next) {
        throw StrictJSONFailure.rejected
      }
    } else {
      guard (UInt8(ascii: "1")...UInt8(ascii: "9")).contains(first) else {
        throw StrictJSONFailure.rejected
      }
      while let next = peek(), (UInt8(ascii: "0")...UInt8(ascii: "9")).contains(next) { index += 1 }
    }
    if take(UInt8(ascii: ".")) {
      guard let digit = peek(), (UInt8(ascii: "0")...UInt8(ascii: "9")).contains(digit) else {
        throw StrictJSONFailure.rejected
      }
      while let next = peek(), (UInt8(ascii: "0")...UInt8(ascii: "9")).contains(next) { index += 1 }
    }
    if take(UInt8(ascii: "e")) || take(UInt8(ascii: "E")) {
      if !take(UInt8(ascii: "+")) { _ = take(UInt8(ascii: "-")) }
      guard let digit = peek(), (UInt8(ascii: "0")...UInt8(ascii: "9")).contains(digit) else {
        throw StrictJSONFailure.rejected
      }
      while let next = peek(), (UInt8(ascii: "0")...UInt8(ascii: "9")).contains(next) { index += 1 }
    }
  }

  private mutating func consumeLiteral(_ literal: String) throws {
    let expected = Array(literal.utf8)
    guard index + expected.count <= bytes.count,
      Array(bytes[index..<(index + expected.count)]) == expected
    else {
      throw StrictJSONFailure.rejected
    }
    index += expected.count
  }

  private mutating func consume(_ expected: UInt8) throws {
    guard take(expected) else { throw StrictJSONFailure.rejected }
  }

  private mutating func take(_ expected: UInt8) -> Bool {
    guard index < bytes.count, bytes[index] == expected else { return false }
    index += 1
    return true
  }

  private func peek() -> UInt8? {
    index < bytes.count ? bytes[index] : nil
  }

  private mutating func skipWhitespace() {
    while let byte = peek(), [0x20, 0x09, 0x0a, 0x0d].contains(byte) { index += 1 }
  }
}
