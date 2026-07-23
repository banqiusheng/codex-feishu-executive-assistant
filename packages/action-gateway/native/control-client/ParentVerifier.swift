import Darwin
import Foundation
import Security

enum ParentVerificationFailure: Error {
  case rejected
}

private let maximumMetadataBytes = 1024 * 1024
private let procPIDUniqueIdentifierInfo: Int32 = 17
private let procPIDShortBSDInfo: Int32 = 13

@_silgen_name("CC_SHA256")
private func commonCryptoSHA256(
  _ data: UnsafeRawPointer?,
  _ length: UInt32,
  _ digest: UnsafeMutablePointer<UInt8>?
) -> UnsafeMutablePointer<UInt8>?

private struct CodeIdentity: Equatable {
  let realPath: String
  let sha256: String
  let designatedRequirement: String
}

private struct BridgeIdentity: Equatable {
  let entryRealPath: String
  let sha256: String
}

private struct ReleaseManifest: Equatable {
  let releaseHash: String
  let node: CodeIdentity
  let bridge: BridgeIdentity
  let controlClient: CodeIdentity
  let peerVerifier: CodeIdentity
}

private struct ActiveBridge: Equatable {
  let pid: pid_t
  let pidVersion: Int32
  let euid: uid_t
  let instanceID: String
}

private struct ActiveState: Equatable {
  let releaseHash: String
  let bridge: ActiveBridge
}

private struct ParentSnapshot: Equatable {
  let pid: pid_t
  let pidVersion: Int32
  let euid: uid_t
  let executablePath: String
  let argv: [String]
}

private func exactKeys(_ value: Any, _ keys: Set<String>) throws -> [String: Any] {
  guard let object = value as? [String: Any], Set(object.keys) == keys else {
    throw ParentVerificationFailure.rejected
  }
  return object
}

private func exactInteger(_ value: Any, minimum: Int64, maximum: Int64) throws -> Int64 {
  guard let number = value as? NSNumber,
    CFGetTypeID(number) != CFBooleanGetTypeID(),
    number.doubleValue.isFinite,
    number.doubleValue.rounded(.towardZero) == number.doubleValue
  else {
    throw ParentVerificationFailure.rejected
  }
  let integer = number.int64Value
  guard integer >= minimum, integer <= maximum else { throw ParentVerificationFailure.rejected }
  return integer
}

private func exactString(_ value: Any) throws -> String {
  guard let string = value as? String, !string.isEmpty, !string.contains("\0") else {
    throw ParentVerificationFailure.rejected
  }
  return string
}

private func exactSHA256(_ value: Any) throws -> String {
  let string = try exactString(value)
  guard string.range(of: #"^sha256:[0-9a-f]{64}$"#, options: .regularExpression) != nil else {
    throw ParentVerificationFailure.rejected
  }
  return string
}

private func parseJSONFile(_ path: String) throws -> Any {
  var before = stat()
  guard lstat(path, &before) == 0,
    (before.st_mode & S_IFMT) == S_IFREG,
    before.st_uid == getuid(),
    (before.st_mode & 0o777) == 0o600,
    before.st_size > 0,
    before.st_size <= off_t(maximumMetadataBytes)
  else {
    throw ParentVerificationFailure.rejected
  }

  let descriptor = Darwin.open(path, O_RDONLY | O_CLOEXEC | O_NOFOLLOW)
  guard descriptor >= 0 else { throw ParentVerificationFailure.rejected }
  defer { Darwin.close(descriptor) }

  var opened = stat()
  guard fstat(descriptor, &opened) == 0,
    (opened.st_mode & S_IFMT) == S_IFREG,
    opened.st_uid == getuid(),
    (opened.st_mode & 0o777) == 0o600,
    opened.st_dev == before.st_dev,
    opened.st_ino == before.st_ino,
    opened.st_size == before.st_size
  else {
    throw ParentVerificationFailure.rejected
  }

  let expectedSize = Int(opened.st_size)
  var data = Data()
  data.reserveCapacity(expectedSize)
  while data.count < expectedSize {
    var buffer = [UInt8](repeating: 0, count: min(8192, expectedSize - data.count))
    let countRead = Darwin.read(descriptor, &buffer, buffer.count)
    if countRead > 0 {
      data.append(buffer, count: countRead)
      continue
    }
    if countRead < 0, errno == EINTR { continue }
    throw ParentVerificationFailure.rejected
  }

  while true {
    var trailing: UInt8 = 0
    let countRead = Darwin.read(descriptor, &trailing, 1)
    if countRead == 0 { break }
    if countRead < 0, errno == EINTR { continue }
    throw ParentVerificationFailure.rejected
  }

  var after = stat()
  guard fstat(descriptor, &after) == 0,
    after.st_dev == opened.st_dev,
    after.st_ino == opened.st_ino,
    after.st_uid == opened.st_uid,
    after.st_mode == opened.st_mode,
    after.st_size == opened.st_size
  else {
    throw ParentVerificationFailure.rejected
  }
  return try parseStrictJSON(data, maximumBytes: maximumMetadataBytes)
}

private func secureRegularFile(_ path: String, mode: mode_t?, owner: uid_t) throws {
  var value = stat()
  guard lstat(path, &value) == 0,
    (value.st_mode & S_IFMT) == S_IFREG,
    value.st_uid == owner,
    mode == nil || (value.st_mode & 0o777) == mode!
  else {
    throw ParentVerificationFailure.rejected
  }
}

private func secureDirectory(_ path: String, owner: uid_t) throws {
  var value = stat()
  guard lstat(path, &value) == 0,
    (value.st_mode & S_IFMT) == S_IFDIR,
    value.st_uid == owner,
    (value.st_mode & 0o777) == 0o700
  else {
    throw ParentVerificationFailure.rejected
  }
}

private func canonicalPath(_ path: String) throws -> String {
  guard path.hasPrefix("/"), !path.contains("\0") else { throw ParentVerificationFailure.rejected }
  var buffer = [CChar](repeating: 0, count: Int(PATH_MAX))
  guard realpath(path, &buffer) != nil else { throw ParentVerificationFailure.rejected }
  return String(cString: buffer)
}

private func runtimeRoot() throws -> String {
  #if ASSISTANT_TESTING
    if let root = ProcessInfo.processInfo.environment["ASSISTANT_TEST_RUNTIME_ROOT"],
      root.hasPrefix("/"), !root.contains("\0")
    {
      return root
    }
  #endif
  guard let record = getpwuid(getuid()), let home = record.pointee.pw_dir else {
    throw ParentVerificationFailure.rejected
  }
  return String(cString: home) + "/PresidentAssistant/runtime"
}

private func sha256(_ path: String) throws -> String {
  let data = try Data(contentsOf: URL(fileURLWithPath: path), options: [.mappedIfSafe])
  guard data.count <= Int(UInt32.max) else { throw ParentVerificationFailure.rejected }
  var digest = [UInt8](repeating: 0, count: 32)
  let result = data.withUnsafeBytes { bytes in
    commonCryptoSHA256(bytes.baseAddress, UInt32(data.count), &digest)
  }
  guard result != nil else { throw ParentVerificationFailure.rejected }
  return "sha256:" + digest.map { String(format: "%02x", $0) }.joined()
}

private func parseCodeIdentity(_ value: Any) throws -> CodeIdentity {
  let object = try exactKeys(value, ["realPath", "sha256", "designatedRequirement"])
  return CodeIdentity(
    realPath: try exactString(object["realPath"] as Any),
    sha256: try exactSHA256(object["sha256"] as Any),
    designatedRequirement: try exactString(object["designatedRequirement"] as Any)
  )
}

private func loadManifest(_ path: String) throws -> ReleaseManifest {
  let object = try exactKeys(
    parseJSONFile(path), ["version", "releaseHash", "node", "bridge", "binaries"])
  guard try exactInteger(object["version"] as Any, minimum: 1, maximum: 1) == 1 else {
    throw ParentVerificationFailure.rejected
  }
  let bridge = try exactKeys(object["bridge"] as Any, ["entryRealPath", "sha256"])
  let binaries = try exactKeys(object["binaries"] as Any, ["controlClient", "peerVerifier"])
  return ReleaseManifest(
    releaseHash: try exactSHA256(object["releaseHash"] as Any),
    node: try parseCodeIdentity(object["node"] as Any),
    bridge: BridgeIdentity(
      entryRealPath: try exactString(bridge["entryRealPath"] as Any),
      sha256: try exactSHA256(bridge["sha256"] as Any)
    ),
    controlClient: try parseCodeIdentity(binaries["controlClient"] as Any),
    peerVerifier: try parseCodeIdentity(binaries["peerVerifier"] as Any)
  )
}

private func loadActiveState(_ path: String) throws -> ActiveState {
  let object = try exactKeys(parseJSONFile(path), ["version", "releaseHash", "bridge"])
  guard try exactInteger(object["version"] as Any, minimum: 1, maximum: 1) == 1 else {
    throw ParentVerificationFailure.rejected
  }
  let bridge = try exactKeys(object["bridge"] as Any, ["pid", "pidVersion", "euid", "instanceId"])
  let instanceID = try exactString(bridge["instanceId"] as Any)
  guard UUID(uuidString: instanceID) != nil else { throw ParentVerificationFailure.rejected }
  return ActiveState(
    releaseHash: try exactSHA256(object["releaseHash"] as Any),
    bridge: ActiveBridge(
      pid: pid_t(try exactInteger(bridge["pid"] as Any, minimum: 1, maximum: Int64(Int32.max))),
      pidVersion: Int32(
        try exactInteger(bridge["pidVersion"] as Any, minimum: 1, maximum: Int64(Int32.max))),
      euid: uid_t(try exactInteger(bridge["euid"] as Any, minimum: 0, maximum: Int64(UInt32.max))),
      instanceID: instanceID
    )
  )
}

private func readNativeInt32(_ bytes: [UInt8], offset: Int) throws -> Int32 {
  guard offset >= 0, offset + MemoryLayout<Int32>.size <= bytes.count else {
    throw ParentVerificationFailure.rejected
  }
  var value: Int32 = 0
  withUnsafeMutableBytes(of: &value) { target in
    bytes.withUnsafeBytes { source in
      target.copyBytes(from: source[offset..<(offset + MemoryLayout<Int32>.size)])
    }
  }
  return value
}

private func processArguments(_ pid: pid_t) throws -> (executablePath: String, argv: [String]) {
  var mib = [CTL_KERN, KERN_PROCARGS2, pid]
  var size = 0
  guard sysctl(&mib, u_int(mib.count), nil, &size, nil, 0) == 0,
    size > MemoryLayout<Int32>.size,
    size <= maximumMetadataBytes
  else {
    throw ParentVerificationFailure.rejected
  }
  var bytes = [UInt8](repeating: 0, count: size)
  let readResult = bytes.withUnsafeMutableBytes { buffer in
    sysctl(&mib, u_int(mib.count), buffer.baseAddress, &size, nil, 0)
  }
  guard readResult == 0,
    size > MemoryLayout<Int32>.size,
    size <= bytes.count
  else {
    throw ParentVerificationFailure.rejected
  }
  bytes.removeSubrange(size..<bytes.count)
  let argc = try readNativeInt32(bytes, offset: 0)
  guard argc > 0, argc <= 4096 else { throw ParentVerificationFailure.rejected }

  func readCString(at start: Int) throws -> (String, Int) {
    guard start < bytes.count, let end = bytes[start...].firstIndex(of: 0), end > start else {
      throw ParentVerificationFailure.rejected
    }
    guard let string = String(bytes: bytes[start..<end], encoding: .utf8), !string.isEmpty else {
      throw ParentVerificationFailure.rejected
    }
    return (string, end + 1)
  }

  var offset = MemoryLayout<Int32>.size
  let (executablePath, executableEnd) = try readCString(at: offset)
  offset = executableEnd
  while offset < bytes.count, bytes[offset] == 0 { offset += 1 }
  var argv: [String] = []
  for _ in 0..<argc {
    let (argument, next) = try readCString(at: offset)
    argv.append(argument)
    offset = next
  }
  guard argv.count == Int(argc) else { throw ParentVerificationFailure.rejected }
  return (executablePath, argv)
}

private func productionParentSnapshot() throws -> ParentSnapshot {
  let pid = getppid()
  guard pid > 1 else { throw ParentVerificationFailure.rejected }

  var uniqueBytes = [UInt8](repeating: 0, count: 56)
  guard
    proc_pidinfo(pid, procPIDUniqueIdentifierInfo, 0, &uniqueBytes, Int32(uniqueBytes.count))
      == uniqueBytes.count
  else {
    throw ParentVerificationFailure.rejected
  }
  let pidVersion = try readNativeInt32(uniqueBytes, offset: 32)
  guard pidVersion > 0 else { throw ParentVerificationFailure.rejected }

  var bsd = proc_bsdshortinfo()
  guard
    proc_pidinfo(pid, procPIDShortBSDInfo, 0, &bsd, Int32(MemoryLayout<proc_bsdshortinfo>.size))
      == MemoryLayout<proc_bsdshortinfo>.size,
    bsd.pbsi_pid == UInt32(pid)
  else {
    throw ParentVerificationFailure.rejected
  }
  var path = [CChar](repeating: 0, count: Int(PATH_MAX) * 4)
  guard proc_pidpath(pid, &path, UInt32(path.count)) > 0 else {
    throw ParentVerificationFailure.rejected
  }
  let arguments = try processArguments(pid)
  let processPath = try canonicalPath(String(cString: path))
  guard try canonicalPath(arguments.executablePath) == processPath else {
    throw ParentVerificationFailure.rejected
  }
  guard getppid() == pid else { throw ParentVerificationFailure.rejected }
  return ParentSnapshot(
    pid: pid,
    pidVersion: pidVersion,
    euid: bsd.pbsi_uid,
    executablePath: processPath,
    argv: arguments.argv
  )
}

#if ASSISTANT_TESTING
  func testingProductionParentSnapshotJSON() throws -> Data {
    let snapshot = try productionParentSnapshot()
    return try JSONSerialization.data(
      withJSONObject: [
        "pid": Int(snapshot.pid),
        "pidVersion": Int(snapshot.pidVersion),
        "euid": Int(snapshot.euid),
        "executablePath": snapshot.executablePath,
        "argv": snapshot.argv,
      ], options: [.sortedKeys])
  }

#endif

private func selectedRelease(_ root: String, owner: uid_t) throws -> String {
  let current = root + "/current"
  var currentMetadata = stat()
  guard lstat(current, &currentMetadata) == 0,
    (currentMetadata.st_mode & S_IFMT) == S_IFLNK,
    currentMetadata.st_uid == owner
  else {
    throw ParentVerificationFailure.rejected
  }
  let releases = try canonicalPath(root + "/releases")
  let release = try canonicalPath(current)
  guard URL(fileURLWithPath: release).deletingLastPathComponent().path == releases,
    URL(fileURLWithPath: release).lastPathComponent.isEmpty == false
  else {
    throw ParentVerificationFailure.rejected
  }
  try secureDirectory(release, owner: owner)
  return release
}

private func verifiedReleaseFile(
  _ path: String,
  release: String,
  mode: mode_t,
  owner: uid_t
) throws -> String {
  let canonical = try canonicalPath(path)
  guard path == canonical,
    canonical.hasPrefix(release + "/"),
    canonical != release
  else {
    throw ParentVerificationFailure.rejected
  }
  try secureRegularFile(canonical, mode: mode, owner: owner)
  return canonical
}

private func verifyCodeIdentity(_ identity: CodeIdentity, release: String, owner: uid_t) throws {
  let path = try verifiedReleaseFile(
    identity.realPath,
    release: release,
    mode: 0o500,
    owner: owner
  )
  guard try sha256(path) == identity.sha256 else { throw ParentVerificationFailure.rejected }
  var staticCode: SecStaticCode?
  guard
    SecStaticCodeCreateWithPath(URL(fileURLWithPath: path) as CFURL, SecCSFlags(), &staticCode)
      == errSecSuccess,
    let code = staticCode
  else {
    throw ParentVerificationFailure.rejected
  }
  var requirement: SecRequirement?
  guard
    SecRequirementCreateWithString(
      identity.designatedRequirement as CFString, SecCSFlags(), &requirement) == errSecSuccess,
    let requirement
  else {
    throw ParentVerificationFailure.rejected
  }
  let flags = SecCSFlags(rawValue: kSecCSStrictValidate | kSecCSCheckAllArchitectures)
  guard SecStaticCodeCheckValidity(code, flags, requirement) == errSecSuccess else {
    throw ParentVerificationFailure.rejected
  }
}

#if ASSISTANT_TESTING
  private func testingParentSnapshots(_ root: String) throws -> [ParentSnapshot] {
    let path = root + "/control/testing-parent-snapshots.json"
    try secureRegularFile(path, mode: 0o600, owner: getuid())
    let object = try exactKeys(parseJSONFile(path), ["version", "reads"])
    guard try exactInteger(object["version"] as Any, minimum: 1, maximum: 1) == 1,
      let reads = object["reads"] as? [Any], reads.count == 2
    else {
      throw ParentVerificationFailure.rejected
    }
    return try reads.map { value in
      let item = try exactKeys(value, ["pid", "pidVersion", "euid", "executablePath", "argv"])
      guard let argvValues = item["argv"] as? [Any], !argvValues.isEmpty else {
        throw ParentVerificationFailure.rejected
      }
      return ParentSnapshot(
        pid: pid_t(try exactInteger(item["pid"] as Any, minimum: 1, maximum: Int64(Int32.max))),
        pidVersion: Int32(
          try exactInteger(item["pidVersion"] as Any, minimum: 1, maximum: Int64(Int32.max))),
        euid: uid_t(try exactInteger(item["euid"] as Any, minimum: 0, maximum: Int64(UInt32.max))),
        executablePath: try exactString(item["executablePath"] as Any),
        argv: try argvValues.map(exactString)
      )
    }
  }
#endif

func verifyActiveBridgeParent() throws -> String {
  let uid = getuid()
  let root = try runtimeRoot()
  guard try canonicalPath(root) == root else {
    throw ParentVerificationFailure.rejected
  }
  try secureDirectory(root, owner: uid)
  try secureDirectory(root + "/releases", owner: uid)
  try secureDirectory(root + "/control", owner: uid)
  let release = try selectedRelease(root, owner: uid)
  let manifestPath = root + "/current/release-manifest.json"
  let activePath = root + "/control/active-instances.json"
  try secureRegularFile(manifestPath, mode: 0o600, owner: uid)
  try secureRegularFile(activePath, mode: 0o600, owner: uid)
  guard try canonicalPath(manifestPath) == release + "/release-manifest.json" else {
    throw ParentVerificationFailure.rejected
  }
  let manifest = try loadManifest(manifestPath)
  let activeBefore = try loadActiveState(activePath)
  guard manifest.releaseHash == activeBefore.releaseHash else {
    throw ParentVerificationFailure.rejected
  }

  let nodePath = try verifiedReleaseFile(
    manifest.node.realPath,
    release: release,
    mode: 0o500,
    owner: uid
  )
  let bridgePath = try verifiedReleaseFile(
    manifest.bridge.entryRealPath,
    release: release,
    mode: 0o600,
    owner: uid
  )
  let controlPath = try verifiedReleaseFile(
    manifest.controlClient.realPath,
    release: release,
    mode: 0o500,
    owner: uid
  )
  _ = try verifiedReleaseFile(
    manifest.peerVerifier.realPath,
    release: release,
    mode: 0o500,
    owner: uid
  )
  guard try canonicalPath(CommandLine.arguments[0]) == controlPath else {
    throw ParentVerificationFailure.rejected
  }

  #if ASSISTANT_TESTING
    let snapshots = try testingParentSnapshots(root)
    let first = snapshots[0]
  #else
    let first = try productionParentSnapshot()
  #endif
  let actualNodeHash = try sha256(nodePath)
  let actualBridgeHash = try sha256(bridgePath)
  guard first.pid == activeBefore.bridge.pid,
    first.pidVersion == activeBefore.bridge.pidVersion,
    first.euid == activeBefore.bridge.euid,
    first.executablePath == nodePath,
    first.argv.count >= 2,
    first.argv[0] == nodePath,
    first.argv[1] == bridgePath,
    manifest.node.sha256 == actualNodeHash,
    manifest.bridge.sha256 == actualBridgeHash
  else {
    throw ParentVerificationFailure.rejected
  }

  try verifyCodeIdentity(manifest.node, release: release, owner: uid)
  try verifyCodeIdentity(manifest.controlClient, release: release, owner: uid)
  try verifyCodeIdentity(manifest.peerVerifier, release: release, owner: uid)

  #if ASSISTANT_TESTING
    let second = snapshots[1]
  #else
    let second = try productionParentSnapshot()
  #endif
  let activeAfter = try loadActiveState(activePath)
  guard second == first,
    activeAfter == activeBefore,
    second.pid == activeAfter.bridge.pid,
    second.pidVersion == activeAfter.bridge.pidVersion,
    second.euid == activeAfter.bridge.euid
  else {
    throw ParentVerificationFailure.rejected
  }
  guard try selectedRelease(root, owner: uid) == release,
    try canonicalPath(manifestPath) == release + "/release-manifest.json",
    try loadManifest(manifestPath) == manifest
  else {
    throw ParentVerificationFailure.rejected
  }
  try secureRegularFile(manifestPath, mode: 0o600, owner: uid)
  try secureRegularFile(activePath, mode: 0o600, owner: uid)
  return root + "/control/action-gateway.sock"
}
