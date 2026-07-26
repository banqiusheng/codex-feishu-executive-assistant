import Darwin
import Foundation

enum ClientFailure: Error {
  case rejected
}

let maxFrameBytes = 1024 * 1024
private let maxJSONDepth = 64
private let maxJSONNodes = 10_000

indirect enum StrictJSONValue {
  case object([String: StrictJSONValue])
  case array([StrictJSONValue])
  case string(String)
  case number(Double)
  case boolean(Bool)
  case null
}

private final class StrictJSONParser {
  private let bytes: [UInt8]
  private var offset = 0
  private var nodes = 0

  init(data: Data) throws {
    guard !data.isEmpty, String(data: data, encoding: .utf8) != nil else {
      throw ClientFailure.rejected
    }
    bytes = Array(data)
  }

  func parse() throws -> StrictJSONValue {
    skipWhitespace()
    let value = try parseValue(depth: 1)
    skipWhitespace()
    guard offset == bytes.count else { throw ClientFailure.rejected }
    return value
  }

  private func parseValue(depth: Int) throws -> StrictJSONValue {
    guard depth <= maxJSONDepth else { throw ClientFailure.rejected }
    nodes += 1
    guard nodes <= maxJSONNodes, offset < bytes.count else {
      throw ClientFailure.rejected
    }
    switch bytes[offset] {
    case 0x7b:
      return try parseObject(depth: depth)
    case 0x5b:
      return try parseArray(depth: depth)
    case 0x22:
      return .string(try parseString())
    case 0x74:
      try consumeLiteral([0x74, 0x72, 0x75, 0x65])
      return .boolean(true)
    case 0x66:
      try consumeLiteral([0x66, 0x61, 0x6c, 0x73, 0x65])
      return .boolean(false)
    case 0x6e:
      try consumeLiteral([0x6e, 0x75, 0x6c, 0x6c])
      return .null
    default:
      return try parseNumber()
    }
  }

  private func parseObject(depth: Int) throws -> StrictJSONValue {
    offset += 1
    skipWhitespace()
    var object: [String: StrictJSONValue] = [:]
    var keys = Set<String>()
    if consume(0x7d) { return .object(object) }
    while true {
      guard currentByte == 0x22 else { throw ClientFailure.rejected }
      let key = try parseString()
      guard keys.insert(key).inserted else { throw ClientFailure.rejected }
      skipWhitespace()
      guard consume(0x3a) else { throw ClientFailure.rejected }
      skipWhitespace()
      object[key] = try parseValue(depth: depth + 1)
      skipWhitespace()
      if consume(0x7d) { return .object(object) }
      guard consume(0x2c) else { throw ClientFailure.rejected }
      skipWhitespace()
    }
  }

  private func parseArray(depth: Int) throws -> StrictJSONValue {
    offset += 1
    skipWhitespace()
    var array: [StrictJSONValue] = []
    if consume(0x5d) { return .array(array) }
    while true {
      array.append(try parseValue(depth: depth + 1))
      skipWhitespace()
      if consume(0x5d) { return .array(array) }
      guard consume(0x2c) else { throw ClientFailure.rejected }
      skipWhitespace()
    }
  }

  private func parseString() throws -> String {
    guard consume(0x22) else { throw ClientFailure.rejected }
    var result = ""
    var rawStart = offset
    while offset < bytes.count {
      let byte = bytes[offset]
      if byte == 0x22 {
        try appendRawString(from: rawStart, to: offset, into: &result)
        offset += 1
        return result
      }
      if byte == 0x5c {
        try appendRawString(from: rawStart, to: offset, into: &result)
        offset += 1
        guard offset < bytes.count else { throw ClientFailure.rejected }
        let escape = bytes[offset]
        offset += 1
        switch escape {
        case 0x22:
          result.append("\"")
        case 0x5c:
          result.append("\\")
        case 0x2f:
          result.append("/")
        case 0x62:
          result.unicodeScalars.append(Unicode.Scalar(0x08)!)
        case 0x66:
          result.unicodeScalars.append(Unicode.Scalar(0x0c)!)
        case 0x6e:
          result.append("\n")
        case 0x72:
          result.append("\r")
        case 0x74:
          result.append("\t")
        case 0x75:
          let first = try parseHexQuad()
          let scalar: UInt32
          if first >= 0xd800 && first <= 0xdbff {
            guard offset + 2 <= bytes.count,
              bytes[offset] == 0x5c,
              bytes[offset + 1] == 0x75
            else {
              throw ClientFailure.rejected
            }
            offset += 2
            let second = try parseHexQuad()
            guard second >= 0xdc00 && second <= 0xdfff else {
              throw ClientFailure.rejected
            }
            scalar = 0x10000 + ((first - 0xd800) << 10) + (second - 0xdc00)
          } else {
            guard first < 0xdc00 || first > 0xdfff else {
              throw ClientFailure.rejected
            }
            scalar = first
          }
          guard let unicode = Unicode.Scalar(scalar) else {
            throw ClientFailure.rejected
          }
          result.unicodeScalars.append(unicode)
        default:
          throw ClientFailure.rejected
        }
        rawStart = offset
        continue
      }
      guard byte > 0x1f else { throw ClientFailure.rejected }
      offset += 1
    }
    throw ClientFailure.rejected
  }

  private func appendRawString(
    from start: Int,
    to end: Int,
    into result: inout String
  ) throws {
    guard start <= end else { throw ClientFailure.rejected }
    if start == end { return }
    guard let decoded = String(bytes: bytes[start..<end], encoding: .utf8) else {
      throw ClientFailure.rejected
    }
    result.append(decoded)
  }

  private func parseHexQuad() throws -> UInt32 {
    guard offset + 4 <= bytes.count else { throw ClientFailure.rejected }
    var value: UInt32 = 0
    for byte in bytes[offset..<(offset + 4)] {
      let digit: UInt32
      switch byte {
      case 0x30...0x39:
        digit = UInt32(byte - 0x30)
      case 0x41...0x46:
        digit = UInt32(byte - 0x41 + 10)
      case 0x61...0x66:
        digit = UInt32(byte - 0x61 + 10)
      default:
        throw ClientFailure.rejected
      }
      value = (value << 4) | digit
    }
    offset += 4
    return value
  }

  private func parseNumber() throws -> StrictJSONValue {
    let start = offset
    _ = consume(0x2d)
    guard offset < bytes.count else { throw ClientFailure.rejected }
    if consume(0x30) {
      if let current = currentByte, current >= 0x30 && current <= 0x39 {
        throw ClientFailure.rejected
      }
    } else {
      guard let current = currentByte, current >= 0x31 && current <= 0x39 else {
        throw ClientFailure.rejected
      }
      offset += 1
      while let current = currentByte, current >= 0x30 && current <= 0x39 {
        offset += 1
      }
    }
    if consume(0x2e) {
      guard let current = currentByte, current >= 0x30 && current <= 0x39 else {
        throw ClientFailure.rejected
      }
      repeat { offset += 1 } while currentByte.map { $0 >= 0x30 && $0 <= 0x39 } == true
    }
    if currentByte == 0x65 || currentByte == 0x45 {
      offset += 1
      if currentByte == 0x2b || currentByte == 0x2d { offset += 1 }
      guard let current = currentByte, current >= 0x30 && current <= 0x39 else {
        throw ClientFailure.rejected
      }
      repeat { offset += 1 } while currentByte.map { $0 >= 0x30 && $0 <= 0x39 } == true
    }
    guard let text = String(bytes: bytes[start..<offset], encoding: .utf8),
      let value = Double(text), value.isFinite
    else {
      throw ClientFailure.rejected
    }
    return .number(value)
  }

  private func consumeLiteral(_ literal: [UInt8]) throws {
    guard offset + literal.count <= bytes.count,
      Array(bytes[offset..<(offset + literal.count)]) == literal
    else {
      throw ClientFailure.rejected
    }
    offset += literal.count
  }

  private var currentByte: UInt8? {
    offset < bytes.count ? bytes[offset] : nil
  }

  private func consume(_ expected: UInt8) -> Bool {
    guard currentByte == expected else { return false }
    offset += 1
    return true
  }

  private func skipWhitespace() {
    while let current = currentByte,
      current == 0x20 || current == 0x09 || current == 0x0a || current == 0x0d
    {
      offset += 1
    }
  }
}

func readBoundedStandardInput() throws -> Data {
  var input = Data()
  while true {
    let chunk = try FileHandle.standardInput.read(upToCount: 8192) ?? Data()
    if chunk.isEmpty { return input }
    guard input.count <= maxFrameBytes - chunk.count else {
      throw ClientFailure.rejected
    }
    input.append(chunk)
  }
}

func parseStrictJSON(_ data: Data) throws -> StrictJSONValue {
  try StrictJSONParser(data: data).parse()
}

private func exactObject(
  _ value: StrictJSONValue,
  keys: Set<String>
) throws -> [String: StrictJSONValue] {
  guard case .object(let object) = value,
    object.count == keys.count,
    Set(object.keys) == keys
  else {
    throw ClientFailure.rejected
  }
  return object
}

private func stringValue(_ value: StrictJSONValue?) throws -> String {
  guard case .string(let string)? = value else { throw ClientFailure.rejected }
  return string
}

private func isVersionOne(_ value: StrictJSONValue?) -> Bool {
  guard case .number(let number)? = value else { return false }
  return number == 1
}

private func isValidRequestID(_ value: String) -> Bool {
  let bytes = Array(value.utf8)
  guard bytes.count == 36 else { return false }
  let hyphens = Set([8, 13, 18, 23])
  for (index, byte) in bytes.enumerated() {
    if hyphens.contains(index) {
      if byte != 0x2d { return false }
      continue
    }
    let isHex =
      (byte >= 0x30 && byte <= 0x39) || (byte >= 0x41 && byte <= 0x46)
      || (byte >= 0x61 && byte <= 0x66)
    if !isHex { return false }
  }
  let version = bytes[14] | 0x20
  let variant = bytes[19] | 0x20
  return version >= 0x31 && version <= 0x38 && [UInt8(0x38), 0x39, 0x61, 0x62].contains(variant)
}

private func isBoundIdentifier(_ value: String) -> Bool {
  let scalars = value.unicodeScalars
  guard !scalars.isEmpty, scalars.count <= 256 else { return false }
  return scalars.allSatisfy { scalar in
    scalar.value > 0x1f && (scalar.value < 0x7f || scalar.value > 0x9f)
  }
}

func validateRunRequest(_ value: StrictJSONValue) throws -> String {
  let request = try exactObject(
    value,
    keys: ["version", "requestId", "kind", "capability", "payload"]
  )
  guard isVersionOne(request["version"]) else { throw ClientFailure.rejected }
  let requestID = try stringValue(request["requestId"])
  guard isValidRequestID(requestID) else { throw ClientFailure.rejected }
  let kind = try stringValue(request["kind"])
  guard ["read", "prepare", "system_reply"].contains(kind) else {
    throw ClientFailure.rejected
  }
  let capability = try stringValue(request["capability"])
  guard isBoundIdentifier(capability) else { throw ClientFailure.rejected }
  guard case .object? = request["payload"] else { throw ClientFailure.rejected }
  return requestID
}

func validateRunResponse(
  _ value: StrictJSONValue,
  requestID: String
) throws {
  guard case .object(let response) = value,
    isVersionOne(response["version"]),
    try stringValue(response["requestId"]) == requestID,
    case .boolean(let ok)? = response["ok"]
  else {
    throw ClientFailure.rejected
  }
  if ok {
    _ = try exactObject(
      value,
      keys: ["version", "requestId", "ok", "result"]
    )
    return
  }
  let exact = try exactObject(
    value,
    keys: ["version", "requestId", "ok", "error"]
  )
  let error = try exactObject(exact["error"]!, keys: ["code"])
  let code = try stringValue(error["code"])
  guard code == "CAPABILITY_DENIED" || code == "HANDLER_FAILED" else {
    throw ClientFailure.rejected
  }
}

func encodeFrame(_ body: Data) throws -> Data {
  guard !body.isEmpty, body.count <= maxFrameBytes else {
    throw ClientFailure.rejected
  }
  let length = UInt32(body.count)
  var frame = Data(
    bytes: [
      UInt8((length >> 24) & 0xff),
      UInt8((length >> 16) & 0xff),
      UInt8((length >> 8) & 0xff),
      UInt8(length & 0xff),
    ], count: 4)
  frame.append(body)
  return frame
}

private func monotonicNanoseconds() throws -> UInt64 {
  var time = timespec()
  guard clock_gettime(CLOCK_MONOTONIC, &time) == 0,
    time.tv_sec >= 0,
    time.tv_nsec >= 0
  else {
    throw ClientFailure.rejected
  }
  return UInt64(time.tv_sec) * 1_000_000_000 + UInt64(time.tv_nsec)
}

private struct SocketDeadline {
  let expiresAt: UInt64

  init(milliseconds: UInt64) throws {
    let startedAt = try monotonicNanoseconds()
    let duration = milliseconds.multipliedReportingOverflow(by: 1_000_000)
    guard !duration.overflow else { throw ClientFailure.rejected }
    let expiration = startedAt.addingReportingOverflow(duration.partialValue)
    guard !expiration.overflow else { throw ClientFailure.rejected }
    expiresAt = expiration.partialValue
  }

  func remainingMilliseconds() throws -> Int32 {
    let now = try monotonicNanoseconds()
    guard now < expiresAt else { throw ClientFailure.rejected }
    let remaining = expiresAt - now
    let milliseconds = max(UInt64(1), (remaining + 999_999) / 1_000_000)
    return Int32(min(milliseconds, UInt64(Int32.max)))
  }
}

private func waitForSocket(
  _ descriptor: Int32,
  events: Int16,
  allowHangup: Bool,
  allowError: Bool = false,
  deadline: SocketDeadline
) throws {
  while true {
    var state = pollfd(fd: descriptor, events: events, revents: 0)
    let result = Darwin.poll(
      &state,
      1,
      try deadline.remainingMilliseconds()
    )
    if result < 0 && errno == EINTR { continue }
    guard result > 0, state.revents & Int16(POLLNVAL) == 0 else {
      throw ClientFailure.rejected
    }
    if !allowError && state.revents & Int16(POLLERR) != 0 {
      throw ClientFailure.rejected
    }
    let acceptedEvents =
      events | (allowHangup ? Int16(POLLHUP) : 0)
      | (allowError ? Int16(POLLERR) : 0)
    guard state.revents & acceptedEvents != 0 else {
      throw ClientFailure.rejected
    }
    return
  }
}

func confirmNonblockingConnection(
  connectResult: Int32,
  connectError: Int32,
  waitUntilWritable: () throws -> Void,
  readSocketError: () throws -> Int32
) throws {
  if connectResult == 0 { return }
  guard connectResult == -1,
    connectError == EINPROGRESS || connectError == EALREADY
      || connectError == EAGAIN || connectError == EINTR
  else {
    throw ClientFailure.rejected
  }
  try waitUntilWritable()
  guard try readSocketError() == 0 else { throw ClientFailure.rejected }
}

private func writeAll(
  _ descriptor: Int32,
  _ data: Data,
  deadline: SocketDeadline
) throws {
  var offset = 0
  while offset < data.count {
    try waitForSocket(
      descriptor,
      events: Int16(POLLOUT),
      allowHangup: false,
      deadline: deadline
    )
    let written = data.withUnsafeBytes { bytes in
      Darwin.write(
        descriptor,
        bytes.baseAddress!.advanced(by: offset),
        data.count - offset
      )
    }
    if written < 0 && errno == EINTR { continue }
    if written < 0 && (errno == EAGAIN || errno == EWOULDBLOCK) { continue }
    guard written > 0 else { throw ClientFailure.rejected }
    offset += written
  }
}

private func readExactly(
  _ descriptor: Int32,
  _ count: Int,
  deadline: SocketDeadline
) throws -> Data {
  var value = Data()
  while value.count < count {
    try waitForSocket(
      descriptor,
      events: Int16(POLLIN),
      allowHangup: true,
      deadline: deadline
    )
    var buffer = [UInt8](repeating: 0, count: count - value.count)
    let readCount = Darwin.read(descriptor, &buffer, buffer.count)
    if readCount < 0 && errno == EINTR { continue }
    if readCount < 0 && (errno == EAGAIN || errno == EWOULDBLOCK) { continue }
    guard readCount > 0 else { throw ClientFailure.rejected }
    value.append(buffer, count: readCount)
  }
  return value
}

func exchangeFrame(
  socketPath: String,
  request: Data,
  deadlineMilliseconds: UInt64
) throws -> Data {
  guard socketPath.utf8.count < MemoryLayout.size(ofValue: sockaddr_un().sun_path) else {
    throw ClientFailure.rejected
  }
  guard deadlineMilliseconds > 0 else { throw ClientFailure.rejected }
  let descriptor = Darwin.socket(AF_UNIX, SOCK_STREAM, 0)
  guard descriptor >= 0 else { throw ClientFailure.rejected }
  defer { Darwin.close(descriptor) }
  let currentFlags = Darwin.fcntl(descriptor, F_GETFL)
  guard currentFlags >= 0,
    Darwin.fcntl(descriptor, F_SETFL, currentFlags | O_NONBLOCK) == 0
  else {
    throw ClientFailure.rejected
  }
  let deadline = try SocketDeadline(milliseconds: deadlineMilliseconds)
  var noSignal: Int32 = 1
  guard
    setsockopt(
      descriptor,
      SOL_SOCKET,
      SO_NOSIGPIPE,
      &noSignal,
      socklen_t(MemoryLayout<Int32>.size)
    ) == 0
  else {
    throw ClientFailure.rejected
  }

  var address = sockaddr_un()
  address.sun_family = sa_family_t(AF_UNIX)
  withUnsafeMutableBytes(of: &address.sun_path) { bytes in
    socketPath.withCString { source in
      bytes.baseAddress!.copyMemory(
        from: source,
        byteCount: socketPath.utf8.count + 1
      )
    }
  }
  let connected = withUnsafePointer(to: &address) {
    $0.withMemoryRebound(to: sockaddr.self, capacity: 1) {
      Darwin.connect(
        descriptor,
        $0,
        socklen_t(MemoryLayout<sockaddr_un>.size)
      )
    }
  }
  let connectionError = errno
  try confirmNonblockingConnection(
    connectResult: connected,
    connectError: connectionError,
    waitUntilWritable: {
      try waitForSocket(
        descriptor,
        events: Int16(POLLOUT),
        allowHangup: true,
        allowError: true,
        deadline: deadline
      )
    },
    readSocketError: {
      var pendingError: Int32 = 0
      var pendingErrorLength = socklen_t(MemoryLayout<Int32>.size)
      guard
        getsockopt(
          descriptor,
          SOL_SOCKET,
          SO_ERROR,
          &pendingError,
          &pendingErrorLength
        ) == 0,
        pendingErrorLength == socklen_t(MemoryLayout<Int32>.size)
      else {
        throw ClientFailure.rejected
      }
      return pendingError
    }
  )
  try writeAll(descriptor, encodeFrame(request), deadline: deadline)
  guard Darwin.shutdown(descriptor, SHUT_WR) == 0 else {
    throw ClientFailure.rejected
  }

  let header = try readExactly(descriptor, 4, deadline: deadline)
  let length = header.reduce(UInt32(0)) { ($0 << 8) | UInt32($1) }
  guard length > 0, length <= UInt32(maxFrameBytes) else {
    throw ClientFailure.rejected
  }
  let response = try readExactly(
    descriptor,
    Int(length),
    deadline: deadline
  )
  var trailing: UInt8 = 0
  var trailingCount: Int
  repeat {
    try waitForSocket(
      descriptor,
      events: Int16(POLLIN),
      allowHangup: true,
      deadline: deadline
    )
    trailingCount = Darwin.read(descriptor, &trailing, 1)
  } while trailingCount < 0 && (errno == EINTR || errno == EAGAIN || errno == EWOULDBLOCK)
  guard trailingCount == 0 else { throw ClientFailure.rejected }
  return response
}
