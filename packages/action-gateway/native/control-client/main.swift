import Darwin
import Foundation

private enum ControlClientFailure: Error {
  case rejected
}

private let rejectedResponse = #"{"ok":false,"error":"GATEWAY_CLIENT_REJECTED"}"#
private let maximumFrameBytes = 1024 * 1024
private let exchangeTimeoutNanoseconds: UInt64 = 1_000_000_000

private func reject() -> Never {
  FileHandle.standardOutput.write(Data(rejectedResponse.utf8))
  exit(2)
}

private func readBoundedInput() throws -> Data {
  var input = Data()
  while true {
    let chunk = try FileHandle.standardInput.read(upToCount: 8192) ?? Data()
    if chunk.isEmpty { return input }
    guard input.count <= maximumFrameBytes - chunk.count else {
      throw ControlClientFailure.rejected
    }
    input.append(chunk)
  }
}

private func parseObject(_ data: Data) throws -> [String: Any] {
  guard let object = try parseStrictJSON(data, maximumBytes: maximumFrameBytes) as? [String: Any]
  else {
    throw ControlClientFailure.rejected
  }
  return object
}

private func hasExactKeys(_ object: [String: Any], _ expected: Set<String>) -> Bool {
  Set(object.keys) == expected
}

private func isExactVersionOne(_ value: Any?) -> Bool {
  guard let number = value as? NSNumber,
    CFGetTypeID(number) != CFBooleanGetTypeID()
  else { return false }
  return number.doubleValue == 1 && number.int64Value == 1
}

private func exactBoolean(_ value: Any?) -> Bool? {
  guard let number = value as? NSNumber,
    CFGetTypeID(number) == CFBooleanGetTypeID()
  else { return nil }
  return number.boolValue
}

private func isContractUUID(_ value: String) -> Bool {
  let bytes = Array(value.utf8)
  guard bytes.count == 36 else { return false }
  let hyphens = Set([8, 13, 18, 23])
  for (index, byte) in bytes.enumerated() {
    if hyphens.contains(index) {
      if byte != UInt8(ascii: "-") { return false }
    } else if !((UInt8(ascii: "0")...UInt8(ascii: "9")).contains(byte)
      || (UInt8(ascii: "a")...UInt8(ascii: "f")).contains(byte)
      || (UInt8(ascii: "A")...UInt8(ascii: "F")).contains(byte))
    {
      return false
    }
  }
  guard (UInt8(ascii: "1")...UInt8(ascii: "8")).contains(bytes[14]) else { return false }
  return [
    UInt8(ascii: "8"), UInt8(ascii: "9"), UInt8(ascii: "a"), UInt8(ascii: "b"),
    UInt8(ascii: "A"), UInt8(ascii: "B"),
  ].contains(bytes[19])
}

private func isBoundOperation(_ value: String) -> Bool {
  guard !value.isEmpty, value.utf16.count <= 256 else { return false }
  return value.unicodeScalars.allSatisfy { scalar in
    scalar.value > 0x1f && (scalar.value < 0x7f || scalar.value > 0x9f)
  }
}

private func validateControlRequest(_ object: [String: Any]) throws -> String {
  guard hasExactKeys(object, ["version", "requestId", "operation", "payload"]),
    isExactVersionOne(object["version"]),
    let requestID = object["requestId"] as? String,
    isContractUUID(requestID),
    let operation = object["operation"] as? String,
    isBoundOperation(operation),
    object["payload"] is [String: Any]
  else {
    throw ControlClientFailure.rejected
  }
  return requestID
}

private func validateControlResponse(_ object: [String: Any], requestID: String) throws {
  guard isExactVersionOne(object["version"]),
    object["requestId"] as? String == requestID,
    let ok = exactBoolean(object["ok"])
  else {
    throw ControlClientFailure.rejected
  }
  if ok {
    guard hasExactKeys(object, ["version", "requestId", "ok", "result"]) else {
      throw ControlClientFailure.rejected
    }
    return
  }
  guard hasExactKeys(object, ["version", "requestId", "ok", "error"]),
    let error = object["error"] as? [String: Any],
    hasExactKeys(error, ["code"]),
    let code = error["code"] as? String,
    code == "CAPABILITY_DENIED" || code == "HANDLER_FAILED"
  else {
    throw ControlClientFailure.rejected
  }
}

private func frame(_ body: Data) throws -> Data {
  guard !body.isEmpty, body.count <= maximumFrameBytes else { throw ControlClientFailure.rejected }
  let length = UInt32(body.count)
  var value = Data([
    UInt8((length >> 24) & 0xff), UInt8((length >> 16) & 0xff),
    UInt8((length >> 8) & 0xff), UInt8(length & 0xff),
  ])
  value.append(body)
  return value
}

private func monotonicNanoseconds() throws -> UInt64 {
  var now = timespec()
  guard clock_gettime(CLOCK_MONOTONIC, &now) == 0,
    now.tv_sec >= 0,
    now.tv_nsec >= 0
  else {
    throw ControlClientFailure.rejected
  }
  return UInt64(now.tv_sec) * 1_000_000_000 + UInt64(now.tv_nsec)
}

private func exchangeDeadline() throws -> UInt64 {
  let now = try monotonicNanoseconds()
  let (deadline, overflow) = now.addingReportingOverflow(exchangeTimeoutNanoseconds)
  guard !overflow else { throw ControlClientFailure.rejected }
  return deadline
}

private func remainingPollMilliseconds(_ deadline: UInt64) throws -> Int32 {
  let now = try monotonicNanoseconds()
  guard now < deadline else { throw ControlClientFailure.rejected }
  let remaining = deadline - now
  return Int32((remaining + 999_999) / 1_000_000)
}

private func waitForReady(_ descriptor: Int32, events: Int32, deadline: UInt64) throws {
  let requestedEvents = Int16(events)
  while true {
    var state = pollfd(fd: descriptor, events: requestedEvents, revents: 0)
    let result = Darwin.poll(&state, 1, try remainingPollMilliseconds(deadline))
    if result > 0 {
      guard state.revents & Int16(POLLNVAL) == 0,
        state.revents & (requestedEvents | Int16(POLLERR) | Int16(POLLHUP)) != 0
      else {
        throw ControlClientFailure.rejected
      }
      return
    }
    if result == 0 { throw ControlClientFailure.rejected }
    if errno != EINTR { throw ControlClientFailure.rejected }
  }
}

private func writeAll(_ descriptor: Int32, _ data: Data, deadline: UInt64) throws {
  var offset = 0
  while offset < data.count {
    _ = try remainingPollMilliseconds(deadline)
    let written = data.withUnsafeBytes { bytes in
      Darwin.write(descriptor, bytes.baseAddress!.advanced(by: offset), data.count - offset)
    }
    if written > 0 {
      offset += written
      continue
    }
    if written == 0 { throw ControlClientFailure.rejected }
    if errno == EINTR { continue }
    if errno == EAGAIN || errno == EWOULDBLOCK {
      try waitForReady(descriptor, events: POLLOUT, deadline: deadline)
      continue
    }
    throw ControlClientFailure.rejected
  }
}

private func readExactly(_ descriptor: Int32, _ count: Int, deadline: UInt64) throws -> Data {
  var value = Data()
  while value.count < count {
    _ = try remainingPollMilliseconds(deadline)
    var bytes = [UInt8](repeating: 0, count: min(8192, count - value.count))
    let countRead = Darwin.read(descriptor, &bytes, bytes.count)
    if countRead > 0 {
      value.append(bytes, count: countRead)
      continue
    }
    if countRead == 0 { throw ControlClientFailure.rejected }
    if errno == EINTR { continue }
    if errno == EAGAIN || errno == EWOULDBLOCK {
      try waitForReady(descriptor, events: POLLIN, deadline: deadline)
      continue
    }
    throw ControlClientFailure.rejected
  }
  return value
}

private func requireEOF(_ descriptor: Int32, deadline: UInt64) throws {
  while true {
    _ = try remainingPollMilliseconds(deadline)
    var trailing: UInt8 = 0
    let countRead = Darwin.read(descriptor, &trailing, 1)
    if countRead == 0 { return }
    if countRead > 0 { throw ControlClientFailure.rejected }
    if errno == EINTR { continue }
    if errno == EAGAIN || errno == EWOULDBLOCK {
      try waitForReady(descriptor, events: POLLIN, deadline: deadline)
      continue
    }
    throw ControlClientFailure.rejected
  }
}

private func exchange(_ socketPath: String, request: Data) throws -> Data {
  let deadline = try exchangeDeadline()
  var metadata = stat()
  guard lstat(socketPath, &metadata) == 0,
    (metadata.st_mode & S_IFMT) == S_IFSOCK,
    metadata.st_uid == getuid(),
    (metadata.st_mode & 0o777) == 0o600,
    socketPath.utf8.count < MemoryLayout.size(ofValue: sockaddr_un().sun_path)
  else {
    throw ControlClientFailure.rejected
  }
  let descriptor = Darwin.socket(AF_UNIX, SOCK_STREAM, 0)
  guard descriptor >= 0 else { throw ControlClientFailure.rejected }
  defer { Darwin.close(descriptor) }
  let flags = fcntl(descriptor, F_GETFL)
  var noSignal: Int32 = 1
  guard flags >= 0,
    fcntl(descriptor, F_SETFL, flags | O_NONBLOCK) == 0,
    setsockopt(
      descriptor, SOL_SOCKET, SO_NOSIGPIPE, &noSignal,
      socklen_t(MemoryLayout<Int32>.size)) == 0
  else {
    throw ControlClientFailure.rejected
  }
  var address = sockaddr_un()
  address.sun_family = sa_family_t(AF_UNIX)
  withUnsafeMutableBytes(of: &address.sun_path) { bytes in
    socketPath.withCString { source in
      bytes.baseAddress!.copyMemory(from: source, byteCount: socketPath.utf8.count + 1)
    }
  }
  let connected = withUnsafePointer(to: &address) { pointer in
    pointer.withMemoryRebound(to: sockaddr.self, capacity: 1) {
      Darwin.connect(descriptor, $0, socklen_t(MemoryLayout<sockaddr_un>.size))
    }
  }
  if connected != 0 {
    guard errno == EINPROGRESS else { throw ControlClientFailure.rejected }
    try waitForReady(descriptor, events: POLLOUT, deadline: deadline)
    _ = try remainingPollMilliseconds(deadline)
    var socketError: Int32 = 0
    var socketErrorLength = socklen_t(MemoryLayout<Int32>.size)
    guard
      getsockopt(descriptor, SOL_SOCKET, SO_ERROR, &socketError, &socketErrorLength) == 0,
      socketErrorLength == socklen_t(MemoryLayout<Int32>.size),
      socketError == 0
    else {
      throw ControlClientFailure.rejected
    }
  }
  try writeAll(descriptor, try frame(request), deadline: deadline)
  _ = try remainingPollMilliseconds(deadline)
  guard Darwin.shutdown(descriptor, SHUT_WR) == 0 else { throw ControlClientFailure.rejected }
  let header = try readExactly(descriptor, 4, deadline: deadline)
  let length = header.reduce(UInt32(0)) { ($0 << 8) | UInt32($1) }
  guard length > 0, length <= UInt32(maximumFrameBytes) else { throw ControlClientFailure.rejected }
  let response = try readExactly(descriptor, Int(length), deadline: deadline)
  try requireEOF(descriptor, deadline: deadline)
  return response
}

guard CommandLine.arguments.count == 1 else { reject() }

do {
  let socketPath = try verifyActiveBridgeParent()
  let requestData = try readBoundedInput()
  let request = try parseObject(requestData)
  let requestID = try validateControlRequest(request)
  let responseData = try exchange(socketPath, request: requestData)
  let response = try parseObject(responseData)
  try validateControlResponse(response, requestID: requestID)
  FileHandle.standardOutput.write(responseData)
} catch {
  reject()
}

exit(0)
