import Darwin

guard CommandLine.arguments.count == 1 else {
  exit(2)
}

do {
  try verifyControlPeer(descriptor: 3)
  exit(0)
} catch {
  exit(2)
}
