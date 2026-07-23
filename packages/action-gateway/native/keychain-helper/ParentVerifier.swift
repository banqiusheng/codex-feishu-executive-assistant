import Darwin
import Foundation
import Security

private let keychainProcPIDUniqueIdentifierInfo: Int32 = 17
private let keychainProcPIDShortBSDInfo: Int32 = 13

struct KeychainActiveBridge: Equatable {
  let pid: pid_t
  let pidVersion: Int32
  let euid: uid_t
  let instanceID: String
}

struct KeychainActiveState: Equatable {
  let releaseHash: String
  let bridge: KeychainActiveBridge
}

struct KeychainActiveSnapshot {
  let file: KeychainSecureFile
  let state: KeychainActiveState
}

struct KeychainParentSnapshot: Equatable {
  let pid: pid_t
  let pidVersion: Int32
  let euid: uid_t
  let parentPID: pid_t
  let executablePath: String
  let argv: [String]
}

struct KeychainAuthorizationContext {
  let install: KeychainInstallSnapshot
  let activePath: String
  let active: KeychainActiveSnapshot
  let parent: KeychainParentSnapshot
}

private func keychainLoadActiveState(_ file: KeychainSecureFile) throws
  -> KeychainActiveState
{
  let object = try keychainExactKeys(
    parseKeychainStrictJSON(
      file.data,
      maximumBytes: keychainMaximumMetadataBytes
    ),
    ["version", "releaseHash", "bridge"]
  )
  guard
    try keychainExactInteger(object["version"] as Any, minimum: 1, maximum: 1) == 1
  else {
    throw KeychainVerificationFailure.rejected
  }
  let bridge = try keychainExactKeys(
    object["bridge"] as Any,
    ["pid", "pidVersion", "euid", "instanceId"]
  )
  let instanceID = try keychainExactString(
    bridge["instanceId"] as Any,
    maximumUTF8Bytes: 36
  )
  guard UUID(uuidString: instanceID) != nil else {
    throw KeychainVerificationFailure.rejected
  }
  return KeychainActiveState(
    releaseHash: try keychainExactSHA256(object["releaseHash"] as Any),
    bridge: KeychainActiveBridge(
      pid: pid_t(
        try keychainExactInteger(
          bridge["pid"] as Any,
          minimum: 1,
          maximum: Int64(Int32.max)
        )
      ),
      pidVersion: Int32(
        try keychainExactInteger(
          bridge["pidVersion"] as Any,
          minimum: 1,
          maximum: Int64(Int32.max)
        )
      ),
      euid: uid_t(
        try keychainExactInteger(
          bridge["euid"] as Any,
          minimum: 0,
          maximum: Int64(UInt32.max)
        )
      ),
      instanceID: instanceID
    )
  )
}

private func keychainActiveSnapshot(
  path: String,
  owner: uid_t
) throws -> KeychainActiveSnapshot {
  let file = try keychainSecureFile(
    path,
    mode: 0o600,
    owner: owner,
    maximumBytes: Int64(keychainMaximumMetadataBytes)
  )
  return KeychainActiveSnapshot(file: file, state: try keychainLoadActiveState(file))
}

private func keychainReadNativeInt32(_ bytes: [UInt8], offset: Int) throws -> Int32 {
  guard offset >= 0, offset + MemoryLayout<Int32>.size <= bytes.count else {
    throw KeychainVerificationFailure.rejected
  }
  var value: Int32 = 0
  withUnsafeMutableBytes(of: &value) { target in
    bytes.withUnsafeBytes { source in
      target.copyBytes(
        from: source[offset..<(offset + MemoryLayout<Int32>.size)]
      )
    }
  }
  return value
}

private func keychainProcessArguments(
  _ pid: pid_t
) throws -> (executablePath: String, argv: [String]) {
  var mib = [CTL_KERN, KERN_PROCARGS2, pid]
  var size = 0
  guard sysctl(&mib, u_int(mib.count), nil, &size, nil, 0) == 0,
    size > MemoryLayout<Int32>.size,
    size <= keychainMaximumMetadataBytes
  else {
    throw KeychainVerificationFailure.rejected
  }
  var bytes = [UInt8](repeating: 0, count: size)
  let result = bytes.withUnsafeMutableBytes { buffer in
    sysctl(&mib, u_int(mib.count), buffer.baseAddress, &size, nil, 0)
  }
  guard result == 0,
    size > MemoryLayout<Int32>.size,
    size <= bytes.count
  else {
    throw KeychainVerificationFailure.rejected
  }
  bytes.removeSubrange(size..<bytes.count)
  let argc = try keychainReadNativeInt32(bytes, offset: 0)
  guard argc > 0, argc <= 4096 else {
    throw KeychainVerificationFailure.rejected
  }

  func readCString(at start: Int) throws -> (String, Int) {
    guard start < bytes.count,
      let end = bytes[start...].firstIndex(of: 0),
      end > start,
      let string = String(bytes: bytes[start..<end], encoding: .utf8),
      !string.isEmpty
    else {
      throw KeychainVerificationFailure.rejected
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
  guard argv.count == Int(argc) else {
    throw KeychainVerificationFailure.rejected
  }
  return (executablePath, argv)
}

func keychainProcessSnapshot(pid: pid_t) throws -> KeychainParentSnapshot {
  guard pid > 1 else { throw KeychainVerificationFailure.rejected }
  var uniqueBytes = [UInt8](repeating: 0, count: 56)
  guard
    proc_pidinfo(
      pid,
      keychainProcPIDUniqueIdentifierInfo,
      0,
      &uniqueBytes,
      Int32(uniqueBytes.count)
    ) == uniqueBytes.count
  else {
    throw KeychainVerificationFailure.rejected
  }
  let pidVersion = try keychainReadNativeInt32(uniqueBytes, offset: 32)
  guard pidVersion > 0 else { throw KeychainVerificationFailure.rejected }

  var bsd = proc_bsdshortinfo()
  guard
    proc_pidinfo(
      pid,
      keychainProcPIDShortBSDInfo,
      0,
      &bsd,
      Int32(MemoryLayout<proc_bsdshortinfo>.size)
    ) == MemoryLayout<proc_bsdshortinfo>.size,
    bsd.pbsi_pid == UInt32(pid),
    bsd.pbsi_ppid > 1
  else {
    throw KeychainVerificationFailure.rejected
  }
  var path = [CChar](repeating: 0, count: Int(PATH_MAX))
  guard proc_pidpath(pid, &path, UInt32(path.count)) > 0 else {
    throw KeychainVerificationFailure.rejected
  }
  let arguments = try keychainProcessArguments(pid)
  let executablePath = try keychainCanonicalPath(String(cString: path))
  guard try keychainCanonicalPath(arguments.executablePath) == executablePath else {
    throw KeychainVerificationFailure.rejected
  }
  return KeychainParentSnapshot(
    pid: pid,
    pidVersion: pidVersion,
    euid: bsd.pbsi_uid,
    parentPID: pid_t(bsd.pbsi_ppid),
    executablePath: executablePath,
    argv: arguments.argv
  )
}

private func keychainProductionParentSnapshot() throws -> KeychainParentSnapshot {
  let parentPID = getppid()
  guard parentPID > 1 else { throw KeychainVerificationFailure.rejected }
  let snapshot = try keychainProcessSnapshot(pid: parentPID)
  guard getppid() == parentPID else {
    throw KeychainVerificationFailure.rejected
  }
  return snapshot
}

private func keychainVerifyRunningCode(
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
    throw KeychainVerificationFailure.rejected
  }
  let attributes = NSDictionary(
    object: NSNumber(value: pid),
    forKey: (kSecGuestAttributePid as String) as NSString
  )
  var code: SecCode?
  guard
    SecCodeCopyGuestWithAttributes(
      nil,
      attributes,
      SecCSFlags(),
      &code
    ) == errSecSuccess,
    let code
  else {
    throw KeychainVerificationFailure.rejected
  }
  let flags = SecCSFlags(rawValue: kSecCSStrictValidate)
  guard
    SecCodeCheckValidity(code, flags, designatedRequirement) == errSecSuccess,
    SecCodeCheckValidity(code, flags, cdHashRequirement) == errSecSuccess
  else {
    throw KeychainVerificationFailure.rejected
  }
}

#if ASSISTANT_TESTING
  func testingKeychainProductionParentSnapshotJSON() throws -> Data {
    let snapshot = try keychainProductionParentSnapshot()
    return try JSONSerialization.data(
      withJSONObject: [
        "pid": Int(snapshot.pid),
        "pidVersion": Int(snapshot.pidVersion),
        "euid": Int(snapshot.euid),
        "executablePath": snapshot.executablePath,
        "argv": snapshot.argv,
      ],
      options: [.sortedKeys]
    )
  }

  enum KeychainTestingAuthorizationStage: String {
    case afterInput = "after-input"
    case afterLookup = "after-lookup"
  }

  private func keychainTestingMarkerExists(
    _ marker: String,
    owner: uid_t
  ) throws -> Bool {
    let markerPath = try keychainRuntimeRoot() + "/control/" + marker
    var markerMetadata = stat()
    guard lstat(markerPath, &markerMetadata) == 0 else {
      if errno == ENOENT { return false }
      throw KeychainVerificationFailure.rejected
    }
    _ = try keychainSecureFile(
      markerPath,
      mode: 0o600,
      owner: owner,
      maximumBytes: 16
    )
    return true
  }

  private func keychainApplyTestingFileMutation(
    marker: String,
    target: String,
    mode: mode_t,
    owner: uid_t,
    maximumBytes: Int64
  ) throws {
    guard try keychainTestingMarkerExists(marker, owner: owner) else { return }
    let original = try keychainSecureFile(
      target,
      mode: mode,
      owner: owner,
      maximumBytes: maximumBytes
    )
    try original.data.write(to: URL(fileURLWithPath: target), options: [.atomic])
    guard chmod(target, mode) == 0 else {
      throw KeychainVerificationFailure.rejected
    }
  }

  private func keychainApplyTestingContentMutation(
    marker: String,
    target: String,
    mode: mode_t,
    owner: uid_t,
    maximumBytes: Int64
  ) throws {
    guard try keychainTestingMarkerExists(marker, owner: owner) else { return }
    let original = try keychainSecureFile(
      target,
      mode: mode,
      owner: owner,
      maximumBytes: maximumBytes
    )
    var changed = original.data
    guard Int64(changed.count) < maximumBytes else {
      throw KeychainVerificationFailure.rejected
    }
    changed.append(0x20)
    try changed.write(to: URL(fileURLWithPath: target), options: [.atomic])
    guard chmod(target, mode) == 0 else {
      throw KeychainVerificationFailure.rejected
    }
  }

  private func keychainApplyTestingCurrentMutation(
    marker: String,
    context: KeychainAuthorizationContext,
    owner: uid_t
  ) throws {
    guard try keychainTestingMarkerExists(marker, owner: owner) else { return }
    let current = context.install.root + "/current"
    let replacement = context.install.root + "/testing-current-replacement"
    if unlink(replacement) != 0, errno != ENOENT {
      throw KeychainVerificationFailure.rejected
    }
    let relativeTarget =
      "releases/"
      + URL(fileURLWithPath: context.install.selection.path).lastPathComponent
    guard symlink(relativeTarget, replacement) == 0 else {
      throw KeychainVerificationFailure.rejected
    }
    guard rename(replacement, current) == 0 else {
      _ = unlink(replacement)
      throw KeychainVerificationFailure.rejected
    }
  }

  func keychainApplyTestingAuthorizationMutations(
    _ context: KeychainAuthorizationContext,
    stage: KeychainTestingAuthorizationStage
  ) throws {
    let owner = getuid()
    let suffix = stage.rawValue
    try keychainApplyTestingFileMutation(
      marker: "testing-keychain-active-" + suffix,
      target: context.activePath,
      mode: 0o600,
      owner: owner,
      maximumBytes: Int64(keychainMaximumMetadataBytes)
    )
    try keychainApplyTestingFileMutation(
      marker: "testing-keychain-helper-manifest-" + suffix,
      target: context.install.manifestPath,
      mode: 0o600,
      owner: owner,
      maximumBytes: Int64(keychainMaximumMetadataBytes)
    )
    try keychainApplyTestingFileMutation(
      marker: "testing-keychain-release-manifest-" + suffix,
      target: context.install.releaseManifestPath,
      mode: 0o600,
      owner: owner,
      maximumBytes: Int64(keychainMaximumMetadataBytes)
    )
    try keychainApplyTestingContentMutation(
      marker: "testing-keychain-release-manifest-content-" + suffix,
      target: context.install.releaseManifestPath,
      mode: 0o600,
      owner: owner,
      maximumBytes: Int64(keychainMaximumMetadataBytes)
    )
    try keychainApplyTestingCurrentMutation(
      marker: "testing-keychain-current-" + suffix,
      context: context,
      owner: owner
    )
    try keychainApplyTestingFileMutation(
      marker: "testing-keychain-node-" + suffix,
      target: context.install.node.file.path,
      mode: 0o500,
      owner: owner,
      maximumBytes: keychainMaximumCodeBytes
    )
    try keychainApplyTestingFileMutation(
      marker: "testing-keychain-bridge-" + suffix,
      target: context.install.bridge.path,
      mode: 0o600,
      owner: owner,
      maximumBytes: keychainMaximumCodeBytes
    )
  }
#endif

func keychainEstablishAuthorizationContext() throws -> KeychainAuthorizationContext {
  let owner = getuid()
  let install = try keychainLoadInstallSnapshot()
  let activePath = install.root + "/control/active-instances.json"
  let active = try keychainActiveSnapshot(path: activePath, owner: owner)
  guard
    active.state.releaseHash == install.manifest.releaseHash,
    active.state.releaseHash == install.releaseManifest.releaseHash
  else {
    throw KeychainVerificationFailure.rejected
  }

  let parent = try keychainProductionParentSnapshot()
  guard parent.pid == active.state.bridge.pid,
    parent.pidVersion == active.state.bridge.pidVersion,
    parent.euid == active.state.bridge.euid,
    parent.euid == owner,
    parent.executablePath == install.manifest.node.realPath,
    parent.argv.count == 2,
    try keychainCanonicalPath(parent.argv[0]) == install.manifest.node.realPath,
    try keychainCanonicalPath(parent.argv[1])
      == install.manifest.bridge.entryRealPath
  else {
    throw KeychainVerificationFailure.rejected
  }
  try keychainVerifyRunningCode(
    pid: parent.pid,
    designatedRequirementText: install.manifest.node.designatedRequirement,
    cdHashRequirementText: install.node.cdHashRequirement
  )

  let context = KeychainAuthorizationContext(
    install: install,
    activePath: activePath,
    active: active,
    parent: parent
  )
  try keychainRevalidateAuthorizationContext(context)
  return context
}

func keychainRevalidateAuthorizationContext(
  _ context: KeychainAuthorizationContext
) throws {
  let install = context.install
  let parentAfter = try keychainProductionParentSnapshot()
  let activeAfter = try keychainActiveSnapshot(
    path: context.activePath,
    owner: getuid()
  )
  try keychainRevalidateInstallSnapshot(install)
  guard parentAfter == context.parent,
    activeAfter.state == context.active.state,
    activeAfter.file.identity == context.active.file.identity,
    activeAfter.file.data == context.active.file.data,
    parentAfter.pid == activeAfter.state.bridge.pid,
    parentAfter.pidVersion == activeAfter.state.bridge.pidVersion,
    parentAfter.euid == activeAfter.state.bridge.euid,
    activeAfter.state.releaseHash == install.manifest.releaseHash,
    activeAfter.state.releaseHash == install.releaseManifest.releaseHash
  else {
    throw KeychainVerificationFailure.rejected
  }
  try keychainVerifyRunningCode(
    pid: parentAfter.pid,
    designatedRequirementText: install.manifest.node.designatedRequirement,
    cdHashRequirementText: install.node.cdHashRequirement
  )
}
