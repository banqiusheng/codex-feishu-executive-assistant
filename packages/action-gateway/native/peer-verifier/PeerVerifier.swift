import Darwin
import Foundation
import Security

enum PeerVerificationFailure: Error {
  case rejected
}

private let maximumMetadataBytes = 1024 * 1024
private let maximumCodeBytes = Int64(UInt32.max)
private let procPIDUniqueIdentifierInfo: Int32 = 17
private let procPIDShortBSDInfo: Int32 = 13

@_silgen_name("CC_SHA256")
private func commonCryptoSHA256(
  _ data: UnsafeRawPointer?,
  _ length: UInt32,
  _ digest: UnsafeMutablePointer<UInt8>?
) -> UnsafeMutablePointer<UInt8>?

private struct FileIdentity: Equatable {
  let device: UInt64
  let inode: UInt64
  let mode: UInt16
  let owner: uid_t
  let size: Int64
  let modifiedSeconds: Int64
  let modifiedNanoseconds: Int64
}

private struct SecureFile {
  let data: Data
  let identity: FileIdentity
}

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

struct ProcessSnapshot: Equatable {
  let pid: pid_t
  let pidVersion: Int32
  let euid: uid_t
  let parentPID: pid_t
  let executablePath: String
  let argv: [String]
}

private struct SocketSnapshot: Equatable {
  let device: UInt64
  let inode: UInt64
  let peerPID: pid_t
  let peerPIDVersion: Int32
  let peerEUID: uid_t
}

private struct VerifiedReleaseFile {
  let path: String
  let identity: FileIdentity
}

private struct VerifiedCode {
  let file: VerifiedReleaseFile
  let cdHashRequirement: String
}

private func exactKeys(_ value: Any, _ keys: Set<String>) throws -> [String: Any] {
  guard let object = value as? [String: Any], Set(object.keys) == keys else {
    throw PeerVerificationFailure.rejected
  }
  return object
}

private func exactInteger(_ value: Any, minimum: Int64, maximum: Int64) throws -> Int64 {
  guard let number = value as? NSNumber,
    CFGetTypeID(number) != CFBooleanGetTypeID(),
    number.doubleValue.isFinite,
    number.doubleValue.rounded(.towardZero) == number.doubleValue
  else {
    throw PeerVerificationFailure.rejected
  }
  let integer = number.int64Value
  guard integer >= minimum, integer <= maximum else { throw PeerVerificationFailure.rejected }
  return integer
}

private func exactString(_ value: Any, maximumUTF8Bytes: Int = 64 * 1024) throws -> String {
  guard let string = value as? String,
    !string.isEmpty,
    !string.contains("\0"),
    string.utf8.count <= maximumUTF8Bytes
  else {
    throw PeerVerificationFailure.rejected
  }
  return string
}

private func exactSHA256(_ value: Any) throws -> String {
  let string = try exactString(value, maximumUTF8Bytes: 71)
  guard string.range(of: #"^sha256:[0-9a-f]{64}$"#, options: .regularExpression) != nil else {
    throw PeerVerificationFailure.rejected
  }
  return string
}

private func canonicalPath(_ path: String) throws -> String {
  guard path.hasPrefix("/"), !path.contains("\0"), path.utf8.count < Int(PATH_MAX) else {
    throw PeerVerificationFailure.rejected
  }
  var buffer = [CChar](repeating: 0, count: Int(PATH_MAX))
  guard realpath(path, &buffer) != nil else { throw PeerVerificationFailure.rejected }
  return String(cString: buffer)
}

private func identity(_ metadata: stat) -> FileIdentity {
  FileIdentity(
    device: UInt64(bitPattern: Int64(metadata.st_dev)),
    inode: UInt64(metadata.st_ino),
    mode: UInt16(metadata.st_mode & 0o177777),
    owner: metadata.st_uid,
    size: metadata.st_size,
    modifiedSeconds: Int64(metadata.st_mtimespec.tv_sec),
    modifiedNanoseconds: Int64(metadata.st_mtimespec.tv_nsec)
  )
}

private func secureDirectory(_ path: String, owner: uid_t) throws {
  var metadata = stat()
  guard lstat(path, &metadata) == 0,
    (metadata.st_mode & S_IFMT) == S_IFDIR,
    metadata.st_uid == owner,
    (metadata.st_mode & 0o777) == 0o700,
    try canonicalPath(path) == path
  else {
    throw PeerVerificationFailure.rejected
  }
}

private func secureDirectoryChain(from base: String, to parent: String, owner: uid_t) throws {
  guard parent == base || parent.hasPrefix(base + "/") else {
    throw PeerVerificationFailure.rejected
  }
  try secureDirectory(base, owner: owner)
  if parent == base { return }
  let suffix = String(parent.dropFirst(base.count + 1))
  var current = base
  for component in suffix.split(separator: "/", omittingEmptySubsequences: false) {
    guard !component.isEmpty, component != ".", component != ".." else {
      throw PeerVerificationFailure.rejected
    }
    current += "/" + component
    try secureDirectory(current, owner: owner)
  }
}

private func secureFile(
  _ path: String,
  mode: mode_t,
  owner: uid_t,
  maximumBytes: Int64
) throws -> SecureFile {
  var pathMetadata = stat()
  guard lstat(path, &pathMetadata) == 0,
    (pathMetadata.st_mode & S_IFMT) == S_IFREG,
    pathMetadata.st_uid == owner,
    (pathMetadata.st_mode & 0o777) == mode,
    pathMetadata.st_size > 0,
    pathMetadata.st_size <= maximumBytes
  else {
    throw PeerVerificationFailure.rejected
  }
  let descriptor = Darwin.open(path, O_RDONLY | O_NOFOLLOW | O_CLOEXEC)
  guard descriptor >= 0 else { throw PeerVerificationFailure.rejected }
  defer { Darwin.close(descriptor) }
  var openedMetadata = stat()
  guard fstat(descriptor, &openedMetadata) == 0,
    identity(openedMetadata) == identity(pathMetadata)
  else {
    throw PeerVerificationFailure.rejected
  }

  var data = Data()
  data.reserveCapacity(Int(openedMetadata.st_size))
  var buffer = [UInt8](repeating: 0, count: 64 * 1024)
  while true {
    let count = Darwin.read(descriptor, &buffer, buffer.count)
    if count == 0 { break }
    if count < 0, errno == EINTR { continue }
    guard count > 0, data.count <= Int(maximumBytes) - count else {
      throw PeerVerificationFailure.rejected
    }
    data.append(buffer, count: count)
  }
  var finalMetadata = stat()
  guard data.count == Int(openedMetadata.st_size),
    fstat(descriptor, &finalMetadata) == 0,
    identity(finalMetadata) == identity(openedMetadata)
  else {
    throw PeerVerificationFailure.rejected
  }
  return SecureFile(data: data, identity: identity(openedMetadata))
}

private func secureFileIdentity(_ path: String, mode: mode_t, owner: uid_t) throws -> FileIdentity {
  var pathMetadata = stat()
  guard lstat(path, &pathMetadata) == 0,
    (pathMetadata.st_mode & S_IFMT) == S_IFREG,
    pathMetadata.st_uid == owner,
    (pathMetadata.st_mode & 0o777) == mode
  else {
    throw PeerVerificationFailure.rejected
  }
  let descriptor = Darwin.open(path, O_RDONLY | O_NOFOLLOW | O_CLOEXEC)
  guard descriptor >= 0 else { throw PeerVerificationFailure.rejected }
  defer { Darwin.close(descriptor) }
  var openedMetadata = stat()
  guard fstat(descriptor, &openedMetadata) == 0,
    identity(openedMetadata) == identity(pathMetadata)
  else {
    throw PeerVerificationFailure.rejected
  }
  return identity(openedMetadata)
}

private func runtimeRoot() throws -> String {
  #if ASSISTANT_TESTING
    if let root = ProcessInfo.processInfo.environment["ASSISTANT_TEST_RUNTIME_ROOT"],
      root.hasPrefix("/"), !root.contains("\0"), root.utf8.count < Int(PATH_MAX)
    {
      return root
    }
  #endif
  guard let record = getpwuid(getuid()), let home = record.pointee.pw_dir else {
    throw PeerVerificationFailure.rejected
  }
  return String(cString: home) + "/PresidentAssistant/runtime"
}

private func selectedRelease(root: String, owner: uid_t) throws -> String {
  try secureDirectory(root, owner: owner)
  let releases = root + "/releases"
  try secureDirectory(releases, owner: owner)
  let current = root + "/current"
  var currentMetadata = stat()
  guard lstat(current, &currentMetadata) == 0,
    (currentMetadata.st_mode & S_IFMT) == S_IFLNK,
    currentMetadata.st_uid == owner
  else {
    throw PeerVerificationFailure.rejected
  }
  let release = try canonicalPath(current)
  guard URL(fileURLWithPath: release).deletingLastPathComponent().path == releases,
    !URL(fileURLWithPath: release).lastPathComponent.isEmpty
  else {
    throw PeerVerificationFailure.rejected
  }
  try secureDirectory(release, owner: owner)
  return release
}

private func verifiedReleaseFile(
  _ declaredPath: String,
  release: String,
  mode: mode_t,
  owner: uid_t,
  maximumBytes: Int64
) throws -> SecureFile {
  let canonical = try canonicalPath(declaredPath)
  guard canonical == declaredPath,
    canonical.hasPrefix(release + "/"),
    canonical != release
  else {
    throw PeerVerificationFailure.rejected
  }
  let parent = URL(fileURLWithPath: canonical).deletingLastPathComponent().path
  try secureDirectoryChain(from: release, to: parent, owner: owner)
  return try secureFile(canonical, mode: mode, owner: owner, maximumBytes: maximumBytes)
}

private func sha256(_ data: Data) throws -> String {
  guard data.count <= Int(UInt32.max) else { throw PeerVerificationFailure.rejected }
  var digest = [UInt8](repeating: 0, count: 32)
  let result = data.withUnsafeBytes { bytes in
    commonCryptoSHA256(bytes.baseAddress, UInt32(data.count), &digest)
  }
  guard result != nil else { throw PeerVerificationFailure.rejected }
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

private func loadManifest(_ file: SecureFile) throws -> ReleaseManifest {
  let root = try exactKeys(
    parsePeerStrictJSON(file.data, maximumBytes: maximumMetadataBytes),
    ["version", "releaseHash", "node", "bridge", "binaries"]
  )
  guard try exactInteger(root["version"] as Any, minimum: 1, maximum: 1) == 1 else {
    throw PeerVerificationFailure.rejected
  }
  let bridge = try exactKeys(root["bridge"] as Any, ["entryRealPath", "sha256"])
  let binaries = try exactKeys(root["binaries"] as Any, ["controlClient", "peerVerifier"])
  return ReleaseManifest(
    releaseHash: try exactSHA256(root["releaseHash"] as Any),
    node: try parseCodeIdentity(root["node"] as Any),
    bridge: BridgeIdentity(
      entryRealPath: try exactString(bridge["entryRealPath"] as Any),
      sha256: try exactSHA256(bridge["sha256"] as Any)
    ),
    controlClient: try parseCodeIdentity(binaries["controlClient"] as Any),
    peerVerifier: try parseCodeIdentity(binaries["peerVerifier"] as Any)
  )
}

private func loadActiveState(_ file: SecureFile) throws -> ActiveState {
  let root = try exactKeys(
    parsePeerStrictJSON(file.data, maximumBytes: maximumMetadataBytes),
    ["version", "releaseHash", "bridge"]
  )
  guard try exactInteger(root["version"] as Any, minimum: 1, maximum: 1) == 1 else {
    throw PeerVerificationFailure.rejected
  }
  let bridge = try exactKeys(root["bridge"] as Any, ["pid", "pidVersion", "euid", "instanceId"])
  let instanceID = try exactString(bridge["instanceId"] as Any, maximumUTF8Bytes: 36)
  guard UUID(uuidString: instanceID) != nil else { throw PeerVerificationFailure.rejected }
  return ActiveState(
    releaseHash: try exactSHA256(root["releaseHash"] as Any),
    bridge: ActiveBridge(
      pid: pid_t(try exactInteger(bridge["pid"] as Any, minimum: 2, maximum: Int64(Int32.max))),
      pidVersion: Int32(
        try exactInteger(bridge["pidVersion"] as Any, minimum: 1, maximum: Int64(Int32.max))),
      euid: uid_t(try exactInteger(bridge["euid"] as Any, minimum: 0, maximum: Int64(UInt32.max))),
      instanceID: instanceID
    )
  )
}

private func readNativeInt32(_ bytes: [UInt8], offset: Int) throws -> Int32 {
  guard offset >= 0, offset + MemoryLayout<Int32>.size <= bytes.count else {
    throw PeerVerificationFailure.rejected
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
    throw PeerVerificationFailure.rejected
  }
  var bytes = [UInt8](repeating: 0, count: size)
  guard sysctl(&mib, u_int(mib.count), &bytes, &size, nil, 0) == 0,
    size > MemoryLayout<Int32>.size,
    size <= bytes.count
  else {
    throw PeerVerificationFailure.rejected
  }
  bytes.removeSubrange(size..<bytes.count)
  let argc = try readNativeInt32(bytes, offset: 0)
  guard argc > 0, argc <= 4096 else { throw PeerVerificationFailure.rejected }

  func readCString(at start: Int) throws -> (String, Int) {
    guard start < bytes.count, let end = bytes[start...].firstIndex(of: 0), end > start,
      let value = String(bytes: bytes[start..<end], encoding: .utf8),
      !value.isEmpty, !value.contains("\0")
    else {
      throw PeerVerificationFailure.rejected
    }
    return (value, end + 1)
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
  guard argv.count == Int(argc) else { throw PeerVerificationFailure.rejected }
  return (executablePath, argv)
}

func processSnapshot(pid: pid_t) throws -> ProcessSnapshot {
  guard pid > 1 else { throw PeerVerificationFailure.rejected }
  var uniqueBytes = [UInt8](repeating: 0, count: 56)
  guard
    proc_pidinfo(pid, procPIDUniqueIdentifierInfo, 0, &uniqueBytes, Int32(uniqueBytes.count))
      == uniqueBytes.count
  else {
    throw PeerVerificationFailure.rejected
  }
  let pidVersion = try readNativeInt32(uniqueBytes, offset: 32)
  guard pidVersion > 0 else { throw PeerVerificationFailure.rejected }

  var bsd = proc_bsdshortinfo()
  guard
    proc_pidinfo(pid, procPIDShortBSDInfo, 0, &bsd, Int32(MemoryLayout<proc_bsdshortinfo>.size))
      == MemoryLayout<proc_bsdshortinfo>.size,
    bsd.pbsi_pid == UInt32(pid), bsd.pbsi_ppid > 1
  else {
    throw PeerVerificationFailure.rejected
  }
  var path = [CChar](repeating: 0, count: Int(PATH_MAX))
  guard proc_pidpath(pid, &path, UInt32(path.count)) > 0 else {
    throw PeerVerificationFailure.rejected
  }
  let arguments = try processArguments(pid)
  let executablePath = try canonicalPath(String(cString: path))
  guard try canonicalPath(arguments.executablePath) == executablePath else {
    throw PeerVerificationFailure.rejected
  }
  return ProcessSnapshot(
    pid: pid,
    pidVersion: pidVersion,
    euid: bsd.pbsi_uid,
    parentPID: pid_t(bsd.pbsi_ppid),
    executablePath: executablePath,
    argv: arguments.argv
  )
}

private func socketSnapshot(descriptor: Int32, expectedEUID: uid_t) throws -> SocketSnapshot {
  var metadata = stat()
  guard fstat(descriptor, &metadata) == 0, (metadata.st_mode & S_IFMT) == S_IFSOCK else {
    throw PeerVerificationFailure.rejected
  }
  var socketType: Int32 = 0
  var socketTypeLength = socklen_t(MemoryLayout<Int32>.size)
  guard getsockopt(descriptor, SOL_SOCKET, SO_TYPE, &socketType, &socketTypeLength) == 0,
    socketTypeLength == MemoryLayout<Int32>.size,
    socketType == SOCK_STREAM
  else {
    throw PeerVerificationFailure.rejected
  }
  var localAddress = sockaddr_storage()
  var localLength = socklen_t(MemoryLayout<sockaddr_storage>.size)
  var peerAddress = sockaddr_storage()
  var peerLength = socklen_t(MemoryLayout<sockaddr_storage>.size)
  guard
    getsockname(
      descriptor,
      withUnsafeMutablePointer(to: &localAddress) {
        UnsafeMutableRawPointer($0).assumingMemoryBound(to: sockaddr.self)
      }, &localLength) == 0,
    getpeername(
      descriptor,
      withUnsafeMutablePointer(to: &peerAddress) {
        UnsafeMutableRawPointer($0).assumingMemoryBound(to: sockaddr.self)
      }, &peerLength) == 0,
    localAddress.ss_family == sa_family_t(AF_UNIX),
    peerAddress.ss_family == sa_family_t(AF_UNIX)
  else {
    throw PeerVerificationFailure.rejected
  }

  var peerPID: pid_t = 0
  var peerPIDLength = socklen_t(MemoryLayout<pid_t>.size)
  var token = audit_token_t()
  var tokenLength = socklen_t(MemoryLayout<audit_token_t>.size)
  guard getsockopt(descriptor, SOL_LOCAL, LOCAL_PEERPID, &peerPID, &peerPIDLength) == 0,
    peerPIDLength == MemoryLayout<pid_t>.size,
    peerPID > 1,
    getsockopt(descriptor, SOL_LOCAL, LOCAL_PEERTOKEN, &token, &tokenLength) == 0,
    tokenLength == MemoryLayout<audit_token_t>.size,
    audit_token_to_pid(token) == peerPID,
    audit_token_to_pidversion(token) > 0,
    audit_token_to_euid(token) == expectedEUID
  else {
    throw PeerVerificationFailure.rejected
  }
  return SocketSnapshot(
    device: UInt64(bitPattern: Int64(metadata.st_dev)),
    inode: UInt64(metadata.st_ino),
    peerPID: peerPID,
    peerPIDVersion: audit_token_to_pidversion(token),
    peerEUID: audit_token_to_euid(token)
  )
}

private func verifyStaticCode(
  _ identity: CodeIdentity,
  release: String,
  owner: uid_t
) throws -> VerifiedCode {
  let file = try verifiedReleaseFile(
    identity.realPath,
    release: release,
    mode: 0o500,
    owner: owner,
    maximumBytes: maximumCodeBytes
  )
  guard try sha256(file.data) == identity.sha256 else {
    throw PeerVerificationFailure.rejected
  }
  var staticCode: SecStaticCode?
  guard
    SecStaticCodeCreateWithPath(
      URL(fileURLWithPath: identity.realPath) as CFURL, SecCSFlags(), &staticCode)
      == errSecSuccess,
    let staticCode
  else {
    throw PeerVerificationFailure.rejected
  }
  var requirement: SecRequirement?
  guard
    SecRequirementCreateWithString(
      identity.designatedRequirement as CFString, SecCSFlags(), &requirement)
      == errSecSuccess,
    let requirement
  else {
    throw PeerVerificationFailure.rejected
  }
  let flags = SecCSFlags(rawValue: kSecCSStrictValidate | kSecCSCheckAllArchitectures)
  guard SecStaticCodeCheckValidity(staticCode, flags, requirement) == errSecSuccess,
    try secureFileIdentity(identity.realPath, mode: 0o500, owner: owner) == file.identity
  else {
    throw PeerVerificationFailure.rejected
  }
  var information: CFDictionary?
  guard SecCodeCopySigningInformation(staticCode, SecCSFlags(), &information) == errSecSuccess,
    let signingInformation = information as NSDictionary?,
    let cdHash = signingInformation[(kSecCodeInfoUnique as String) as NSString] as? Data,
    !cdHash.isEmpty
  else {
    throw PeerVerificationFailure.rejected
  }
  let hex = cdHash.map { String(format: "%02x", $0) }.joined()
  return VerifiedCode(
    file: VerifiedReleaseFile(path: identity.realPath, identity: file.identity),
    cdHashRequirement: "cdhash H\"\(hex)\""
  )
}

private func verifyRunningCode(
  pid: pid_t,
  designatedRequirementText: String,
  cdHashRequirementText: String
) throws {
  var designatedRequirement: SecRequirement?
  var cdHashRequirement: SecRequirement?
  guard
    SecRequirementCreateWithString(
      designatedRequirementText as CFString,
      SecCSFlags(),
      &designatedRequirement
    ) == errSecSuccess,
    SecRequirementCreateWithString(
      cdHashRequirementText as CFString,
      SecCSFlags(),
      &cdHashRequirement
    ) == errSecSuccess,
    let designatedRequirement,
    let cdHashRequirement
  else {
    throw PeerVerificationFailure.rejected
  }
  let attributes = NSDictionary(
    object: NSNumber(value: pid),
    forKey: (kSecGuestAttributePid as String) as NSString
  )
  var code: SecCode?
  let guestStatus = SecCodeCopyGuestWithAttributes(nil, attributes, SecCSFlags(), &code)
  guard guestStatus == errSecSuccess, let code else {
    throw PeerVerificationFailure.rejected
  }
  let flags = SecCSFlags(rawValue: kSecCSStrictValidate)
  let validityStatus = SecCodeCheckValidity(code, flags, designatedRequirement)
  guard validityStatus == errSecSuccess else {
    throw PeerVerificationFailure.rejected
  }
  guard SecCodeCheckValidity(code, flags, cdHashRequirement) == errSecSuccess else {
    throw PeerVerificationFailure.rejected
  }
}

private func verifyBridgeFile(
  _ identity: BridgeIdentity,
  release: String,
  owner: uid_t
) throws -> VerifiedReleaseFile {
  let file = try verifiedReleaseFile(
    identity.entryRealPath,
    release: release,
    mode: 0o600,
    owner: owner,
    maximumBytes: maximumCodeBytes
  )
  guard try sha256(file.data) == identity.sha256 else {
    throw PeerVerificationFailure.rejected
  }
  return VerifiedReleaseFile(path: identity.entryRealPath, identity: file.identity)
}

private func revalidate(
  _ file: VerifiedReleaseFile,
  release: String,
  mode: mode_t,
  owner: uid_t
) throws {
  let canonical = try canonicalPath(file.path)
  guard canonical == file.path, canonical.hasPrefix(release + "/") else {
    throw PeerVerificationFailure.rejected
  }
  try secureDirectoryChain(
    from: release,
    to: URL(fileURLWithPath: canonical).deletingLastPathComponent().path,
    owner: owner
  )
  guard try secureFileIdentity(file.path, mode: mode, owner: owner) == file.identity else {
    throw PeerVerificationFailure.rejected
  }
}

#if ASSISTANT_TESTING
  private func applyTestingActiveStateHook(root: String, activePath: String, owner: uid_t) throws {
    let hookPath = root + "/control/testing-active-after.json"
    var metadata = stat()
    guard lstat(hookPath, &metadata) == 0 else {
      if errno == ENOENT { return }
      throw PeerVerificationFailure.rejected
    }
    let hook = try secureFile(
      hookPath, mode: 0o600, owner: owner, maximumBytes: Int64(maximumMetadataBytes))
    try hook.data.write(to: URL(fileURLWithPath: activePath), options: [.atomic])
    guard chmod(activePath, 0o600) == 0 else { throw PeerVerificationFailure.rejected }
  }
#endif

func verifyControlPeer(descriptor: Int32) throws {
  let owner = getuid()
  let socketBefore = try socketSnapshot(descriptor: descriptor, expectedEUID: owner)
  let root = try runtimeRoot()
  guard try canonicalPath(root) == root else { throw PeerVerificationFailure.rejected }
  let release = try selectedRelease(root: root, owner: owner)
  let controlDirectory = root + "/control"
  try secureDirectory(controlDirectory, owner: owner)

  let manifestPath = release + "/release-manifest.json"
  let activePath = controlDirectory + "/active-instances.json"
  let manifestFile = try secureFile(
    manifestPath,
    mode: 0o600,
    owner: owner,
    maximumBytes: Int64(maximumMetadataBytes)
  )
  let activeFile = try secureFile(
    activePath,
    mode: 0o600,
    owner: owner,
    maximumBytes: Int64(maximumMetadataBytes)
  )
  let manifest = try loadManifest(manifestFile)
  let activeBefore = try loadActiveState(activeFile)
  guard manifest.releaseHash == activeBefore.releaseHash else {
    throw PeerVerificationFailure.rejected
  }

  let peerBefore = try processSnapshot(pid: socketBefore.peerPID)
  guard peerBefore.pidVersion == socketBefore.peerPIDVersion,
    peerBefore.euid == socketBefore.peerEUID,
    peerBefore.executablePath == manifest.controlClient.realPath,
    peerBefore.argv.count == 1,
    try canonicalPath(peerBefore.argv[0]) == manifest.controlClient.realPath,
    peerBefore.parentPID == activeBefore.bridge.pid
  else {
    throw PeerVerificationFailure.rejected
  }
  let parentBefore = try processSnapshot(pid: peerBefore.parentPID)
  guard parentBefore.pid == activeBefore.bridge.pid,
    parentBefore.pidVersion == activeBefore.bridge.pidVersion,
    parentBefore.euid == activeBefore.bridge.euid,
    parentBefore.euid == owner,
    parentBefore.executablePath == manifest.node.realPath,
    parentBefore.argv.count >= 2,
    try canonicalPath(parentBefore.argv[0]) == manifest.node.realPath,
    try canonicalPath(parentBefore.argv[1]) == manifest.bridge.entryRealPath
  else {
    throw PeerVerificationFailure.rejected
  }

  let nodeFile = try verifyStaticCode(manifest.node, release: release, owner: owner)
  let bridgeFile = try verifyBridgeFile(manifest.bridge, release: release, owner: owner)
  let controlFile = try verifyStaticCode(manifest.controlClient, release: release, owner: owner)
  let helperFile = try verifyStaticCode(manifest.peerVerifier, release: release, owner: owner)
  guard try canonicalPath(CommandLine.arguments[0]) == helperFile.file.path else {
    throw PeerVerificationFailure.rejected
  }
  try verifyRunningCode(
    pid: peerBefore.pid,
    designatedRequirementText: manifest.controlClient.designatedRequirement,
    cdHashRequirementText: controlFile.cdHashRequirement
  )
  try verifyRunningCode(
    pid: parentBefore.pid,
    designatedRequirementText: manifest.node.designatedRequirement,
    cdHashRequirementText: nodeFile.cdHashRequirement
  )

  #if ASSISTANT_TESTING
    try applyTestingActiveStateHook(root: root, activePath: activePath, owner: owner)
  #endif

  let socketAfter = try socketSnapshot(descriptor: descriptor, expectedEUID: owner)
  let peerAfter = try processSnapshot(pid: socketAfter.peerPID)
  let parentAfter = try processSnapshot(pid: peerAfter.parentPID)
  let manifestAfterFile = try secureFile(
    manifestPath,
    mode: 0o600,
    owner: owner,
    maximumBytes: Int64(maximumMetadataBytes)
  )
  let activeAfterFile = try secureFile(
    activePath,
    mode: 0o600,
    owner: owner,
    maximumBytes: Int64(maximumMetadataBytes)
  )
  let manifestAfter = try loadManifest(manifestAfterFile)
  let activeAfter = try loadActiveState(activeAfterFile)
  let releaseAfter = try selectedRelease(root: root, owner: owner)

  guard socketAfter == socketBefore,
    peerAfter == peerBefore,
    parentAfter == parentBefore,
    manifestAfter == manifest,
    manifestAfterFile.identity == manifestFile.identity,
    activeAfter == activeBefore,
    activeAfterFile.identity == activeFile.identity,
    releaseAfter == release,
    peerAfter.pidVersion == socketAfter.peerPIDVersion,
    peerAfter.euid == socketAfter.peerEUID,
    parentAfter.pid == activeAfter.bridge.pid,
    parentAfter.pidVersion == activeAfter.bridge.pidVersion,
    parentAfter.euid == activeAfter.bridge.euid
  else {
    throw PeerVerificationFailure.rejected
  }

  try revalidate(nodeFile.file, release: release, mode: 0o500, owner: owner)
  try revalidate(bridgeFile, release: release, mode: 0o600, owner: owner)
  try revalidate(controlFile.file, release: release, mode: 0o500, owner: owner)
  try revalidate(helperFile.file, release: release, mode: 0o500, owner: owner)
}
