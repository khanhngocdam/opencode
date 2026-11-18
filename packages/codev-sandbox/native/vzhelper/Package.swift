// swift-tools-version:5.9
import PackageDescription

let package = Package(
  name: "codev-vmm",
  platforms: [.macOS(.v12)],
  targets: [
    .executableTarget(name: "codev-vmm", path: "Sources")
  ]
)
