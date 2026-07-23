import Foundation

private let rejectedResponse = #"{"ok":false,"error":"GATEWAY_CLIENT_REJECTED"}"#

private func reject() -> Never {
  FileHandle.standardOutput.write(Data(rejectedResponse.utf8))
  exit(2)
}

guard CommandLine.arguments.count == 1 else {
  reject()
}

guard let socketPath = ProcessInfo.processInfo.environment["ASSISTANT_GATEWAY_SOCKET"],
  socketPath.hasPrefix("/"),
  !socketPath.contains("\0")
else {
  reject()
}

do {
  let requestData = try readBoundedStandardInput()
  let request = try parseStrictJSON(requestData)
  let requestId = try validateRunRequest(request)
  let responseData = try exchangeFrame(socketPath: socketPath, request: requestData)
  let response = try parseStrictJSON(responseData)
  try validateRunResponse(response, requestID: requestId)
  FileHandle.standardOutput.write(responseData)
} catch {
  reject()
}

exit(0)
