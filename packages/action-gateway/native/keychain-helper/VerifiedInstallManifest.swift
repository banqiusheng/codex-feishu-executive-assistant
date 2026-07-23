import Darwin
import Foundation
import Security

enum KeychainVerificationFailure: Error {
  case rejected
}

let keychainMaximumMetadataBytes = 1024 * 1024
let keychainMaximumCodeBytes = Int64(UInt32.max)

@_silgen_name("CC_SHA256")
private func keychainCommonCryptoSHA256(
  _ data: UnsafeRawPointer?,
  _ length: UInt32,
  _ digest: UnsafeMutablePointer<UInt8>?
) -> UnsafeMutablePointer<UInt8>?

struct KeychainFileIdentity: Equatable {
  let device: UInt64
  let inode: UInt64
  let mode: UInt16
  let owner: uid_t
  let size: Int64
  let modifiedSeconds: Int64
  let modifiedNanoseconds: Int64
}

struct KeychainSecureFile {
  let data: Data
  let identity: KeychainFileIdentity
}

struct KeychainCodeIdentity: Equatable {
  let realPath: String
  let sha256: String
  let designatedRequirement: String
}

struct KeychainBridgeIdentity: Equatable {
  let entryRealPath: String
  let sha256: String
}

struct KeychainReleaseManifestReference: Equatable {
  let realPath: String
  let sha256: String
}

private struct KeychainHelperManifest: Equatable {
  let releaseHash: String
  let appID: String
  let secretRefProvider: String
  let releaseManifest: KeychainReleaseManifestReference
  let keychainHelper: KeychainCodeIdentity
}

struct KeychainReleaseManifest: Equatable {
  let releaseHash: String
  let node: KeychainCodeIdentity
  let bridge: KeychainBridgeIdentity
  let controlClient: KeychainCodeIdentity
  let peerVerifier: KeychainCodeIdentity
}

struct VerifiedInstallManifest: Equatable {
  let releaseHash: String
  let appID: String
  let secretRefProvider: String
  let releaseManifest: KeychainReleaseManifestReference
  let node: KeychainCodeIdentity
  let bridge: KeychainBridgeIdentity
  let keychainHelper: KeychainCodeIdentity
}

struct KeychainVerifiedReleaseFile {
  let path: String
  let identity: KeychainFileIdentity
}

struct KeychainVerifiedCode {
  let file: KeychainVerifiedReleaseFile
  let cdHashRequirement: String
}

struct KeychainReleaseSelection: Equatable {
  let path: String
  let currentIdentity: KeychainFileIdentity
  let releaseIdentity: KeychainFileIdentity
}

struct KeychainInstallSnapshot {
  let root: String
  let selection: KeychainReleaseSelection
  let manifestPath: String
  let manifestFile: KeychainSecureFile
  fileprivate let helperManifest: KeychainHelperManifest
  let releaseManifestPath: String
  let releaseManifestFile: KeychainSecureFile
  let releaseManifest: KeychainReleaseManifest
  let manifest: VerifiedInstallManifest
  let node: KeychainVerifiedCode
  let bridge: KeychainVerifiedReleaseFile
  let helper: KeychainVerifiedCode
}

func keychainExactKeys(_ value: Any, _ keys: Set<String>) throws -> [String: Any] {
  guard let object = value as? [String: Any], Set(object.keys) == keys else {
    throw KeychainVerificationFailure.rejected
  }
  return object
}

func keychainExactInteger(
  _ value: Any,
  minimum: Int64,
  maximum: Int64
) throws -> Int64 {
  guard let number = value as? NSNumber,
    CFGetTypeID(number) != CFBooleanGetTypeID(),
    number.doubleValue.isFinite,
    number.doubleValue.rounded(.towardZero) == number.doubleValue
  else {
    throw KeychainVerificationFailure.rejected
  }
  let integer = number.int64Value
  guard integer >= minimum, integer <= maximum else {
    throw KeychainVerificationFailure.rejected
  }
  return integer
}

func keychainExactString(
  _ value: Any,
  maximumUTF8Bytes: Int = 64 * 1024
) throws -> String {
  guard let string = value as? String,
    !string.isEmpty,
    !string.contains("\0"),
    string.utf8.count <= maximumUTF8Bytes
  else {
    throw KeychainVerificationFailure.rejected
  }
  return string
}

func keychainExactSHA256(_ value: Any) throws -> String {
  let string = try keychainExactString(value, maximumUTF8Bytes: 71)
  guard string.range(of: #"^sha256:[0-9a-f]{64}$"#, options: .regularExpression) != nil
  else {
    throw KeychainVerificationFailure.rejected
  }
  return string
}

func keychainCanonicalPath(_ path: String) throws -> String {
  guard path.hasPrefix("/"), !path.contains("\0"), path.utf8.count < Int(PATH_MAX) else {
    throw KeychainVerificationFailure.rejected
  }
  var buffer = [CChar](repeating: 0, count: Int(PATH_MAX))
  guard realpath(path, &buffer) != nil else {
    throw KeychainVerificationFailure.rejected
  }
  return String(cString: buffer)
}

private func keychainIdentity(_ metadata: stat) -> KeychainFileIdentity {
  KeychainFileIdentity(
    device: UInt64(bitPattern: Int64(metadata.st_dev)),
    inode: UInt64(metadata.st_ino),
    mode: UInt16(metadata.st_mode & 0o177777),
    owner: metadata.st_uid,
    size: metadata.st_size,
    modifiedSeconds: Int64(metadata.st_mtimespec.tv_sec),
    modifiedNanoseconds: Int64(metadata.st_mtimespec.tv_nsec)
  )
}

func keychainSecureDirectoryIdentity(
  _ path: String,
  owner: uid_t
) throws -> KeychainFileIdentity {
  var metadata = stat()
  guard lstat(path, &metadata) == 0,
    (metadata.st_mode & S_IFMT) == S_IFDIR,
    metadata.st_uid == owner,
    (metadata.st_mode & 0o777) == 0o700,
    try keychainCanonicalPath(path) == path
  else {
    throw KeychainVerificationFailure.rejected
  }
  return keychainIdentity(metadata)
}

func keychainSecureDirectoryChain(
  from base: String,
  to parent: String,
  owner: uid_t
) throws {
  guard parent == base || parent.hasPrefix(base + "/") else {
    throw KeychainVerificationFailure.rejected
  }
  _ = try keychainSecureDirectoryIdentity(base, owner: owner)
  if parent == base { return }
  let suffix = String(parent.dropFirst(base.count + 1))
  var current = base
  for component in suffix.split(separator: "/", omittingEmptySubsequences: false) {
    guard !component.isEmpty, component != ".", component != ".." else {
      throw KeychainVerificationFailure.rejected
    }
    current += "/" + component
    _ = try keychainSecureDirectoryIdentity(current, owner: owner)
  }
}

func keychainSecureFile(
  _ path: String,
  mode: mode_t,
  owner: uid_t,
  maximumBytes: Int64
) throws -> KeychainSecureFile {
  var pathMetadata = stat()
  guard lstat(path, &pathMetadata) == 0,
    (pathMetadata.st_mode & S_IFMT) == S_IFREG,
    pathMetadata.st_uid == owner,
    (pathMetadata.st_mode & 0o777) == mode,
    pathMetadata.st_size > 0,
    pathMetadata.st_size <= maximumBytes
  else {
    throw KeychainVerificationFailure.rejected
  }
  let descriptor = Darwin.open(path, O_RDONLY | O_NOFOLLOW | O_CLOEXEC)
  guard descriptor >= 0 else { throw KeychainVerificationFailure.rejected }
  defer { Darwin.close(descriptor) }

  var openedMetadata = stat()
  guard fstat(descriptor, &openedMetadata) == 0,
    keychainIdentity(openedMetadata) == keychainIdentity(pathMetadata)
  else {
    throw KeychainVerificationFailure.rejected
  }

  var data = Data()
  data.reserveCapacity(Int(openedMetadata.st_size))
  var buffer = [UInt8](repeating: 0, count: 64 * 1024)
  while true {
    let countRead = Darwin.read(descriptor, &buffer, buffer.count)
    if countRead == 0 { break }
    if countRead < 0, errno == EINTR { continue }
    guard countRead > 0, data.count <= Int(maximumBytes) - countRead else {
      throw KeychainVerificationFailure.rejected
    }
    data.append(buffer, count: countRead)
  }

  var finalMetadata = stat()
  guard data.count == Int(openedMetadata.st_size),
    fstat(descriptor, &finalMetadata) == 0,
    keychainIdentity(finalMetadata) == keychainIdentity(openedMetadata)
  else {
    throw KeychainVerificationFailure.rejected
  }
  return KeychainSecureFile(data: data, identity: keychainIdentity(openedMetadata))
}

func keychainSecureFileIdentity(
  _ path: String,
  mode: mode_t,
  owner: uid_t
) throws -> KeychainFileIdentity {
  var pathMetadata = stat()
  guard lstat(path, &pathMetadata) == 0,
    (pathMetadata.st_mode & S_IFMT) == S_IFREG,
    pathMetadata.st_uid == owner,
    (pathMetadata.st_mode & 0o777) == mode
  else {
    throw KeychainVerificationFailure.rejected
  }
  let descriptor = Darwin.open(path, O_RDONLY | O_NOFOLLOW | O_CLOEXEC)
  guard descriptor >= 0 else { throw KeychainVerificationFailure.rejected }
  defer { Darwin.close(descriptor) }
  var openedMetadata = stat()
  guard fstat(descriptor, &openedMetadata) == 0,
    keychainIdentity(openedMetadata) == keychainIdentity(pathMetadata)
  else {
    throw KeychainVerificationFailure.rejected
  }
  return keychainIdentity(openedMetadata)
}

func keychainRuntimeRoot() throws -> String {
  #if ASSISTANT_TESTING
    if let root = ProcessInfo.processInfo.environment["ASSISTANT_TEST_RUNTIME_ROOT"],
      root.hasPrefix("/"),
      !root.contains("\0"),
      root.utf8.count < Int(PATH_MAX)
    {
      return root
    }
  #endif
  guard let record = getpwuid(getuid()), let home = record.pointee.pw_dir else {
    throw KeychainVerificationFailure.rejected
  }
  return String(cString: home) + "/PresidentAssistant/runtime"
}

private func keychainSymlinkIdentity(
  _ path: String,
  owner: uid_t
) throws -> KeychainFileIdentity {
  var metadata = stat()
  guard lstat(path, &metadata) == 0,
    (metadata.st_mode & S_IFMT) == S_IFLNK,
    metadata.st_uid == owner
  else {
    throw KeychainVerificationFailure.rejected
  }
  return keychainIdentity(metadata)
}

func keychainSelectedRelease(
  root: String,
  owner: uid_t
) throws -> KeychainReleaseSelection {
  _ = try keychainSecureDirectoryIdentity(root, owner: owner)
  let releases = root + "/releases"
  _ = try keychainSecureDirectoryIdentity(releases, owner: owner)
  let current = root + "/current"
  let currentIdentity = try keychainSymlinkIdentity(current, owner: owner)
  let release = try keychainCanonicalPath(current)
  guard URL(fileURLWithPath: release).deletingLastPathComponent().path == releases,
    !URL(fileURLWithPath: release).lastPathComponent.isEmpty
  else {
    throw KeychainVerificationFailure.rejected
  }
  let releaseIdentity = try keychainSecureDirectoryIdentity(release, owner: owner)
  return KeychainReleaseSelection(
    path: release,
    currentIdentity: currentIdentity,
    releaseIdentity: releaseIdentity
  )
}

private func keychainSHA256(_ data: Data) throws -> String {
  guard data.count <= Int(UInt32.max) else {
    throw KeychainVerificationFailure.rejected
  }
  var digest = [UInt8](repeating: 0, count: 32)
  let result = data.withUnsafeBytes { bytes in
    keychainCommonCryptoSHA256(bytes.baseAddress, UInt32(data.count), &digest)
  }
  guard result != nil else { throw KeychainVerificationFailure.rejected }
  return "sha256:" + digest.map { String(format: "%02x", $0) }.joined()
}

private func keychainParseCodeIdentity(_ value: Any) throws -> KeychainCodeIdentity {
  let object = try keychainExactKeys(
    value,
    ["realPath", "sha256", "designatedRequirement"]
  )
  return KeychainCodeIdentity(
    realPath: try keychainExactString(object["realPath"] as Any),
    sha256: try keychainExactSHA256(object["sha256"] as Any),
    designatedRequirement: try keychainExactString(
      object["designatedRequirement"] as Any,
      maximumUTF8Bytes: 4096
    )
  )
}

private func keychainParseBridgeIdentity(_ value: Any) throws
  -> KeychainBridgeIdentity
{
  let object = try keychainExactKeys(value, ["entryRealPath", "sha256"])
  return KeychainBridgeIdentity(
    entryRealPath: try keychainExactString(object["entryRealPath"] as Any),
    sha256: try keychainExactSHA256(object["sha256"] as Any)
  )
}

private func keychainLoadHelperManifest(_ file: KeychainSecureFile) throws
  -> KeychainHelperManifest
{
  let object = try keychainExactKeys(
    parseKeychainStrictJSON(
      file.data,
      maximumBytes: keychainMaximumMetadataBytes
    ),
    [
      "version",
      "releaseHash",
      "appId",
      "secretRefProvider",
      "releaseManifest",
      "keychainHelper",
    ]
  )
  guard
    try keychainExactInteger(object["version"] as Any, minimum: 1, maximum: 1) == 1
  else {
    throw KeychainVerificationFailure.rejected
  }
  let appID = try keychainExactString(object["appId"] as Any, maximumUTF8Bytes: 256)
  let provider = try keychainExactString(
    object["secretRefProvider"] as Any,
    maximumUTF8Bytes: 256
  )
  guard
    appID.unicodeScalars.allSatisfy({
      $0.value > 0x20 && $0.value < 0x7f
    }),
    provider.unicodeScalars.allSatisfy({
      $0.value > 0x20 && $0.value < 0x7f
    })
  else {
    throw KeychainVerificationFailure.rejected
  }
  let releaseManifest = try keychainExactKeys(
    object["releaseManifest"] as Any,
    ["realPath", "sha256"]
  )
  return KeychainHelperManifest(
    releaseHash: try keychainExactSHA256(object["releaseHash"] as Any),
    appID: appID,
    secretRefProvider: provider,
    releaseManifest: KeychainReleaseManifestReference(
      realPath: try keychainExactString(releaseManifest["realPath"] as Any),
      sha256: try keychainExactSHA256(releaseManifest["sha256"] as Any)
    ),
    keychainHelper: try keychainParseCodeIdentity(object["keychainHelper"] as Any)
  )
}

private func keychainLoadReleaseManifest(_ file: KeychainSecureFile) throws
  -> KeychainReleaseManifest
{
  let object = try keychainExactKeys(
    parseKeychainStrictJSON(
      file.data,
      maximumBytes: keychainMaximumMetadataBytes
    ),
    ["version", "releaseHash", "node", "bridge", "binaries"]
  )
  guard
    try keychainExactInteger(object["version"] as Any, minimum: 1, maximum: 1) == 1
  else {
    throw KeychainVerificationFailure.rejected
  }
  let binaries = try keychainExactKeys(
    object["binaries"] as Any,
    ["controlClient", "peerVerifier"]
  )
  return KeychainReleaseManifest(
    releaseHash: try keychainExactSHA256(object["releaseHash"] as Any),
    node: try keychainParseCodeIdentity(object["node"] as Any),
    bridge: try keychainParseBridgeIdentity(object["bridge"] as Any),
    controlClient: try keychainParseCodeIdentity(binaries["controlClient"] as Any),
    peerVerifier: try keychainParseCodeIdentity(binaries["peerVerifier"] as Any)
  )
}

private func keychainVerifiedReleaseFile(
  _ declaredPath: String,
  release: String,
  mode: mode_t,
  owner: uid_t,
  maximumBytes: Int64
) throws -> KeychainSecureFile {
  let canonical = try keychainCanonicalPath(declaredPath)
  guard canonical == declaredPath,
    canonical.hasPrefix(release + "/"),
    canonical != release
  else {
    throw KeychainVerificationFailure.rejected
  }
  let parent = URL(fileURLWithPath: canonical).deletingLastPathComponent().path
  try keychainSecureDirectoryChain(from: release, to: parent, owner: owner)
  return try keychainSecureFile(
    canonical,
    mode: mode,
    owner: owner,
    maximumBytes: maximumBytes
  )
}

private func keychainVerifyStaticCode(
  _ identity: KeychainCodeIdentity,
  release: String,
  owner: uid_t
) throws -> KeychainVerifiedCode {
  let file = try keychainVerifiedReleaseFile(
    identity.realPath,
    release: release,
    mode: 0o500,
    owner: owner,
    maximumBytes: keychainMaximumCodeBytes
  )
  guard try keychainSHA256(file.data) == identity.sha256 else {
    throw KeychainVerificationFailure.rejected
  }
  var staticCode: SecStaticCode?
  guard
    SecStaticCodeCreateWithPath(
      URL(fileURLWithPath: identity.realPath) as CFURL,
      SecCSFlags(),
      &staticCode
    ) == errSecSuccess,
    let staticCode
  else {
    throw KeychainVerificationFailure.rejected
  }
  var requirement: SecRequirement?
  guard
    SecRequirementCreateWithString(
      identity.designatedRequirement as CFString,
      SecCSFlags(),
      &requirement
    ) == errSecSuccess,
    let requirement
  else {
    throw KeychainVerificationFailure.rejected
  }
  let flags = SecCSFlags(rawValue: kSecCSStrictValidate | kSecCSCheckAllArchitectures)
  guard
    SecStaticCodeCheckValidity(staticCode, flags, requirement) == errSecSuccess,
    try keychainSecureFileIdentity(identity.realPath, mode: 0o500, owner: owner)
      == file.identity
  else {
    throw KeychainVerificationFailure.rejected
  }
  var information: CFDictionary?
  guard
    SecCodeCopySigningInformation(staticCode, SecCSFlags(), &information) == errSecSuccess,
    let signingInformation = information as NSDictionary?,
    let cdHash = signingInformation[(kSecCodeInfoUnique as String) as NSString] as? Data,
    !cdHash.isEmpty
  else {
    throw KeychainVerificationFailure.rejected
  }
  let hex = cdHash.map { String(format: "%02x", $0) }.joined()
  return KeychainVerifiedCode(
    file: KeychainVerifiedReleaseFile(
      path: identity.realPath,
      identity: file.identity
    ),
    cdHashRequirement: "cdhash H\"\(hex)\""
  )
}

private func keychainVerifyBridgeFile(
  _ identity: KeychainBridgeIdentity,
  release: String,
  owner: uid_t
) throws -> KeychainVerifiedReleaseFile {
  let file = try keychainVerifiedReleaseFile(
    identity.entryRealPath,
    release: release,
    mode: 0o600,
    owner: owner,
    maximumBytes: keychainMaximumCodeBytes
  )
  guard try keychainSHA256(file.data) == identity.sha256 else {
    throw KeychainVerificationFailure.rejected
  }
  return KeychainVerifiedReleaseFile(
    path: identity.entryRealPath,
    identity: file.identity
  )
}

func keychainLoadInstallSnapshot() throws -> KeychainInstallSnapshot {
  let owner = getuid()
  let root = try keychainRuntimeRoot()
  guard try keychainCanonicalPath(root) == root else {
    throw KeychainVerificationFailure.rejected
  }
  _ = try keychainSecureDirectoryIdentity(root + "/control", owner: owner)
  let selection = try keychainSelectedRelease(root: root, owner: owner)
  let manifestPath = selection.path + "/keychain-helper-manifest.json"
  let manifestFile = try keychainSecureFile(
    manifestPath,
    mode: 0o600,
    owner: owner,
    maximumBytes: Int64(keychainMaximumMetadataBytes)
  )
  let helperManifest = try keychainLoadHelperManifest(manifestFile)
  let releaseManifestPath = selection.path + "/release-manifest.json"
  guard
    helperManifest.releaseManifest.realPath == releaseManifestPath,
    try keychainCanonicalPath(helperManifest.releaseManifest.realPath) == releaseManifestPath
  else {
    throw KeychainVerificationFailure.rejected
  }
  let releaseManifestFile = try keychainVerifiedReleaseFile(
    helperManifest.releaseManifest.realPath,
    release: selection.path,
    mode: 0o600,
    owner: owner,
    maximumBytes: Int64(keychainMaximumMetadataBytes)
  )
  guard try keychainSHA256(releaseManifestFile.data) == helperManifest.releaseManifest.sha256
  else {
    throw KeychainVerificationFailure.rejected
  }
  let releaseManifest = try keychainLoadReleaseManifest(releaseManifestFile)
  guard helperManifest.releaseHash == releaseManifest.releaseHash else {
    throw KeychainVerificationFailure.rejected
  }
  let manifest = VerifiedInstallManifest(
    releaseHash: helperManifest.releaseHash,
    appID: helperManifest.appID,
    secretRefProvider: helperManifest.secretRefProvider,
    releaseManifest: helperManifest.releaseManifest,
    node: releaseManifest.node,
    bridge: releaseManifest.bridge,
    keychainHelper: helperManifest.keychainHelper
  )
  let node = try keychainVerifyStaticCode(
    manifest.node,
    release: selection.path,
    owner: owner
  )
  let bridge = try keychainVerifyBridgeFile(
    manifest.bridge,
    release: selection.path,
    owner: owner
  )
  let helper = try keychainVerifyStaticCode(
    manifest.keychainHelper,
    release: selection.path,
    owner: owner
  )
  guard try keychainCanonicalPath(CommandLine.arguments[0]) == helper.file.path else {
    throw KeychainVerificationFailure.rejected
  }
  return KeychainInstallSnapshot(
    root: root,
    selection: selection,
    manifestPath: manifestPath,
    manifestFile: manifestFile,
    helperManifest: helperManifest,
    releaseManifestPath: releaseManifestPath,
    releaseManifestFile: releaseManifestFile,
    releaseManifest: releaseManifest,
    manifest: manifest,
    node: node,
    bridge: bridge,
    helper: helper
  )
}

private func keychainRevalidateFile(
  _ file: KeychainVerifiedReleaseFile,
  release: String,
  mode: mode_t,
  owner: uid_t
) throws {
  let canonical = try keychainCanonicalPath(file.path)
  guard canonical == file.path, canonical.hasPrefix(release + "/") else {
    throw KeychainVerificationFailure.rejected
  }
  try keychainSecureDirectoryChain(
    from: release,
    to: URL(fileURLWithPath: canonical).deletingLastPathComponent().path,
    owner: owner
  )
  guard
    try keychainSecureFileIdentity(file.path, mode: mode, owner: owner) == file.identity
  else {
    throw KeychainVerificationFailure.rejected
  }
}

func keychainRevalidateInstallSnapshot(_ snapshot: KeychainInstallSnapshot) throws {
  let owner = getuid()
  guard try keychainCanonicalPath(snapshot.root) == snapshot.root else {
    throw KeychainVerificationFailure.rejected
  }
  _ = try keychainSecureDirectoryIdentity(snapshot.root + "/control", owner: owner)
  let selectionAfter = try keychainSelectedRelease(root: snapshot.root, owner: owner)
  guard selectionAfter == snapshot.selection else {
    throw KeychainVerificationFailure.rejected
  }
  let manifestAfterFile = try keychainSecureFile(
    snapshot.manifestPath,
    mode: 0o600,
    owner: owner,
    maximumBytes: Int64(keychainMaximumMetadataBytes)
  )
  let helperManifestAfter = try keychainLoadHelperManifest(manifestAfterFile)
  guard manifestAfterFile.identity == snapshot.manifestFile.identity,
    manifestAfterFile.data == snapshot.manifestFile.data,
    helperManifestAfter == snapshot.helperManifest,
    helperManifestAfter.releaseManifest.realPath == snapshot.releaseManifestPath,
    try keychainCanonicalPath(helperManifestAfter.releaseManifest.realPath)
      == snapshot.releaseManifestPath
  else {
    throw KeychainVerificationFailure.rejected
  }
  let releaseManifestAfterFile = try keychainVerifiedReleaseFile(
    helperManifestAfter.releaseManifest.realPath,
    release: snapshot.selection.path,
    mode: 0o600,
    owner: owner,
    maximumBytes: Int64(keychainMaximumMetadataBytes)
  )
  let releaseManifestAfter = try keychainLoadReleaseManifest(releaseManifestAfterFile)
  guard
    releaseManifestAfterFile.identity == snapshot.releaseManifestFile.identity,
    releaseManifestAfterFile.data == snapshot.releaseManifestFile.data,
    try keychainSHA256(releaseManifestAfterFile.data)
      == helperManifestAfter.releaseManifest.sha256,
    releaseManifestAfter == snapshot.releaseManifest,
    helperManifestAfter.releaseHash == releaseManifestAfter.releaseHash
  else {
    throw KeychainVerificationFailure.rejected
  }
  let manifestAfter = VerifiedInstallManifest(
    releaseHash: helperManifestAfter.releaseHash,
    appID: helperManifestAfter.appID,
    secretRefProvider: helperManifestAfter.secretRefProvider,
    releaseManifest: helperManifestAfter.releaseManifest,
    node: releaseManifestAfter.node,
    bridge: releaseManifestAfter.bridge,
    keychainHelper: helperManifestAfter.keychainHelper
  )
  guard manifestAfter == snapshot.manifest else {
    throw KeychainVerificationFailure.rejected
  }
  try keychainRevalidateFile(
    snapshot.node.file,
    release: snapshot.selection.path,
    mode: 0o500,
    owner: owner
  )
  try keychainRevalidateFile(
    snapshot.bridge,
    release: snapshot.selection.path,
    mode: 0o600,
    owner: owner
  )
  try keychainRevalidateFile(
    snapshot.helper.file,
    release: snapshot.selection.path,
    mode: 0o500,
    owner: owner
  )
  let nodeAfter = try keychainVerifyStaticCode(
    snapshot.manifest.node,
    release: snapshot.selection.path,
    owner: owner
  )
  let bridgeAfter = try keychainVerifyBridgeFile(
    snapshot.manifest.bridge,
    release: snapshot.selection.path,
    owner: owner
  )
  let helperAfter = try keychainVerifyStaticCode(
    snapshot.manifest.keychainHelper,
    release: snapshot.selection.path,
    owner: owner
  )
  guard nodeAfter.file.identity == snapshot.node.file.identity,
    nodeAfter.cdHashRequirement == snapshot.node.cdHashRequirement,
    bridgeAfter.identity == snapshot.bridge.identity,
    helperAfter.file.identity == snapshot.helper.file.identity,
    helperAfter.cdHashRequirement == snapshot.helper.cdHashRequirement,
    try keychainCanonicalPath(CommandLine.arguments[0]) == snapshot.helper.file.path
  else {
    throw KeychainVerificationFailure.rejected
  }
}
