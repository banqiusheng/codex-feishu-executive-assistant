#if ASSISTANT_TESTING
  import Darwin
  import Foundation

  @main
  struct KernelProbe {
    static func main() {
      do {
        FileHandle.standardOutput.write(try testingProductionParentSnapshotJSON())
        exit(0)
      } catch {
        exit(2)
      }
    }
  }
#endif
