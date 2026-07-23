#if ASSISTANT_TESTING
  import Darwin
  import Foundation

  @main
  struct KeychainKernelProbe {
    static func main() {
      do {
        FileHandle.standardOutput.write(
          try testingKeychainProductionParentSnapshotJSON()
        )
        exit(0)
      } catch {
        exit(2)
      }
    }
  }
#endif
