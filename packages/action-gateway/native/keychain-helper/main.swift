import Darwin
import Foundation
import Security

private enum KeychainHelperExit: Int32 {
  case ok = 0
  case usage = 64
  case denied = 77
  case missing = 78
}

private let keychainService = "com.codex-feishu-executive-assistant.bot"
private let maximumRequestBytes = 4096
private let maximumSecretBytes = 4096

private func terminate(_ status: KeychainHelperExit) -> Never {
  exit(status.rawValue)
}

private func readBoundedStandardInput() throws -> Data {
  var input = Data()
  while true {
    var buffer = [UInt8](repeating: 0, count: 1024)
    let countRead = Darwin.read(STDIN_FILENO, &buffer, buffer.count)
    if countRead == 0 { return input }
    if countRead < 0, errno == EINTR { continue }
    guard countRead > 0,
      input.count <= maximumRequestBytes - countRead
    else {
      throw KeychainVerificationFailure.rejected
    }
    input.append(buffer, count: countRead)
  }
}

private func exactVersionOne(_ value: Any?) -> Bool {
  guard let number = value as? NSNumber,
    CFGetTypeID(number) != CFBooleanGetTypeID(),
    number.doubleValue == 1,
    number.int64Value == 1
  else {
    return false
  }
  return true
}

private func validateRequest(
  _ data: Data,
  manifest: VerifiedInstallManifest
) throws -> String {
  let object = try keychainExactKeys(
    parseKeychainStrictJSON(data, maximumBytes: maximumRequestBytes),
    ["protocolVersion", "provider", "ids"]
  )
  guard exactVersionOne(object["protocolVersion"]),
    let provider = object["provider"] as? String,
    provider == manifest.secretRefProvider,
    let ids = object["ids"] as? [Any],
    ids.count == 1,
    let identifier = ids[0] as? String,
    identifier == "app-" + manifest.appID
  else {
    throw KeychainVerificationFailure.rejected
  }
  return identifier
}

private func readSecret(account: String) throws -> String {
  #if ASSISTANT_TESTING
    guard keychainService == "com.codex-feishu-executive-assistant.bot",
      account == "cli_testing_app"
    else {
      throw KeychainVerificationFailure.rejected
    }
    let countPath =
      try keychainRuntimeRoot() + "/control/testing-keychain-lookup-count"
    let countFile = try keychainSecureFile(
      countPath,
      mode: 0o600,
      owner: getuid(),
      maximumBytes: 16
    )
    guard String(data: countFile.data, encoding: .utf8) == "0" else {
      throw KeychainVerificationFailure.rejected
    }
    try Data("1".utf8).write(
      to: URL(fileURLWithPath: countPath),
      options: [.atomic]
    )
    guard chmod(countPath, 0o600) == 0 else {
      throw KeychainVerificationFailure.rejected
    }
    return "ASSISTANT_TEST_KEYCHAIN_SENTINEL"
  #else
    let query: [String: Any] = [
      kSecClass as String: kSecClassGenericPassword,
      kSecAttrService as String: keychainService,
      kSecAttrAccount as String: account,
      kSecReturnData as String: true,
      kSecMatchLimit as String: kSecMatchLimitOne,
      kSecUseAuthenticationUI as String: kSecUseAuthenticationUIFail,
    ]
    var item: CFTypeRef?
    guard SecItemCopyMatching(query as CFDictionary, &item) == errSecSuccess,
      let data = item as? Data,
      !data.isEmpty,
      data.count <= maximumSecretBytes,
      let secret = String(data: data, encoding: .utf8),
      !secret.contains("\0")
    else {
      throw KeychainVerificationFailure.rejected
    }
    return secret
  #endif
}

private func responseData(identifier: String, secret: String) throws -> Data {
  let secretBytes = secret.lengthOfBytes(using: .utf8)
  guard !secret.isEmpty,
    secretBytes <= maximumSecretBytes,
    !secret.contains("\0")
  else {
    throw KeychainVerificationFailure.rejected
  }
  let object: [String: Any] = [
    "protocolVersion": 1,
    "values": [identifier: secret],
    "errors": [String: Any](),
  ]
  let data = try JSONSerialization.data(withJSONObject: object, options: [])
  guard data.count <= maximumRequestBytes * 2 else {
    throw KeychainVerificationFailure.rejected
  }
  return data
}

_ = umask(0o077)
guard CommandLine.arguments.count == 1 else {
  terminate(.usage)
}

let input: Data
do {
  input = try readBoundedStandardInput()
} catch {
  terminate(.usage)
}

let authorization: KeychainAuthorizationContext
do {
  authorization = try keychainEstablishAuthorizationContext()
} catch {
  terminate(.denied)
}

let identifier: String
do {
  identifier = try validateRequest(
    input,
    manifest: authorization.install.manifest
  )
} catch {
  terminate(.usage)
}

#if ASSISTANT_TESTING
  do {
    try keychainApplyTestingAuthorizationMutations(
      authorization,
      stage: .afterInput
    )
  } catch {
    terminate(.denied)
  }
#endif

do {
  try keychainRevalidateAuthorizationContext(authorization)
} catch {
  terminate(.denied)
}

let secret: String
do {
  secret = try readSecret(account: authorization.install.manifest.appID)
} catch {
  terminate(.missing)
}

#if ASSISTANT_TESTING
  do {
    try keychainApplyTestingAuthorizationMutations(
      authorization,
      stage: .afterLookup
    )
  } catch {
    terminate(.denied)
  }
#endif

do {
  try keychainRevalidateAuthorizationContext(authorization)
} catch {
  terminate(.denied)
}

do {
  FileHandle.standardOutput.write(
    try responseData(identifier: identifier, secret: secret)
  )
  terminate(.ok)
} catch {
  terminate(.missing)
}
