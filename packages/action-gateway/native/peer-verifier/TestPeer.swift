import Darwin
import Foundation

private func fail() -> Never {
  exit(2)
}

guard CommandLine.arguments.count == 1,
  let socketPath = ProcessInfo.processInfo.environment["ASSISTANT_TEST_PEER_SOCKET"],
  socketPath.hasPrefix("/"),
  !socketPath.contains("\0"),
  socketPath.utf8.count < MemoryLayout.size(ofValue: sockaddr_un().sun_path)
else {
  fail()
}

let descriptor = Darwin.socket(AF_UNIX, SOCK_STREAM, 0)
guard descriptor >= 0 else { fail() }
defer { Darwin.close(descriptor) }

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
guard connected == 0 else { fail() }

let marker = Array("PEER_VERIFIER_MUST_NOT_READ_FD3".utf8)
let wrote = marker.withUnsafeBytes { bytes in
  Darwin.write(descriptor, bytes.baseAddress, bytes.count)
}
guard wrote == marker.count, Darwin.shutdown(descriptor, SHUT_WR) == 0 else { fail() }

var byte: UInt8 = 0
while true {
  let count = Darwin.read(descriptor, &byte, 1)
  if count == 0 { break }
  guard count > 0 else { fail() }
}
exit(0)
