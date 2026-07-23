import Darwin
import Foundation

@main
private enum KernelProbe {
  static func main() {
    do {
      guard CommandLine.arguments.count == 1 else { throw PeerVerificationFailure.rejected }
      let snapshot = try processSnapshot(pid: getppid())
      let output = try JSONSerialization.data(
        withJSONObject: [
          "pid": Int(snapshot.pid),
          "pidVersion": Int(snapshot.pidVersion),
          "euid": Int(snapshot.euid),
          "parentPID": Int(snapshot.parentPID),
          "executablePath": snapshot.executablePath,
          "argv": snapshot.argv,
        ], options: [.sortedKeys])
      FileHandle.standardOutput.write(output)
      exit(0)
    } catch {
      exit(2)
    }
  }
}
