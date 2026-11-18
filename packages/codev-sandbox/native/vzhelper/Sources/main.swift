// codev-vmm: boots one NIC-less Linux VM via Virtualization.framework and
// bridges its vsock ports to host unix sockets.
//
// Protocol (matches src/vz/protocol.ts):
//   argv[1]   path to a VmConfig JSON file
//   stdout    one JSON event per line: {"event":"state","state":...} | {"event":"error","message":...}
//   stderr    guest serial console + diagnostics
//   stdin     {"cmd":"stop"} requests a stop; EOF (parent died) also stops
//
// The VM deliberately gets no network device: its only egress is vsock, which
// this helper exposes as unix sockets so the TS side can gate every byte.

import Foundation
import Virtualization

struct ShareConfig: Codable {
  let tag: String
  let path: String
  let readOnly: Bool
}

struct ForwardConfig: Codable {
  let direction: String // "host-to-guest" | "guest-to-host"
  let vsockPort: UInt32
  let socketPath: String
}

struct VmConfig: Codable {
  let kernel: String
  let initrd: String
  let disk: String
  let cmdline: String
  let cpus: Int
  let memoryMiB: UInt64
  let shares: [ShareConfig]
  let forwards: [ForwardConfig]
}

let stdoutLock = NSLock()

func emit(_ payload: [String: String]) {
  guard let data = try? JSONSerialization.data(withJSONObject: payload) else { return }
  stdoutLock.lock()
  FileHandle.standardOutput.write(data)
  FileHandle.standardOutput.write(Data([0x0A]))
  stdoutLock.unlock()
}

func fail(_ message: String) -> Never {
  emit(["event": "error", "message": message])
  exit(1)
}

// MARK: - Byte relay between two file descriptors

final class Relay {
  private let a: Int32
  private let b: Int32
  // Retains the VZVirtioSocketConnection whose fd we are copying, so the
  // framework does not invalidate it mid-stream.
  private let retained: AnyObject?
  private var remaining = 2
  private let lock = NSLock()

  init(_ a: Int32, _ b: Int32, retaining: AnyObject? = nil) {
    self.a = a
    self.b = b
    self.retained = retaining
    stream(a, b)
    stream(b, a)
  }

  private func stream(_ source: Int32, _ sink: Int32) {
    DispatchQueue.global().async { [self] in
      var buffer = [UInt8](repeating: 0, count: 65536)
      loop: while true {
        let count = read(source, &buffer, buffer.count)
        if count <= 0 { break }
        var offset = 0
        while offset < count {
          let written = buffer.withUnsafeBytes { raw in
            write(sink, raw.baseAddress!.advanced(by: offset), count - offset)
          }
          if written <= 0 { break loop }
          offset += written
        }
      }
      shutdown(sink, SHUT_WR)
      lock.lock()
      remaining -= 1
      let done = remaining == 0
      lock.unlock()
      if done {
        close(a)
        close(b)
      }
    }
  }
}

// MARK: - Unix sockets

func withUnixAddress<T>(_ path: String, _ body: (UnsafePointer<sockaddr>, socklen_t) -> T) -> T? {
  var address = sockaddr_un()
  address.sun_family = sa_family_t(AF_UNIX)
  let bytes = path.utf8CString
  guard bytes.count <= MemoryLayout.size(ofValue: address.sun_path) else { return nil }
  withUnsafeMutableBytes(of: &address.sun_path) { destination in
    bytes.withUnsafeBytes { source in destination.copyBytes(from: source) }
  }
  return withUnsafePointer(to: &address) { pointer in
    pointer.withMemoryRebound(to: sockaddr.self, capacity: 1) { rebound in
      body(rebound, socklen_t(MemoryLayout<sockaddr_un>.size))
    }
  }
}

func makeUnixListener(_ path: String) -> Int32 {
  unlink(path)
  let fd = socket(AF_UNIX, SOCK_STREAM, 0)
  guard fd >= 0 else { fail("socket() failed for \(path): \(String(cString: strerror(errno)))") }
  let bound = withUnixAddress(path) { address, size in bind(fd, address, size) }
  guard bound == 0 else { fail("bind() failed for \(path): \(String(cString: strerror(errno)))") }
  guard listen(fd, 16) == 0 else { fail("listen() failed for \(path): \(String(cString: strerror(errno)))") }
  return fd
}

func connectUnix(_ path: String) -> Int32? {
  let fd = socket(AF_UNIX, SOCK_STREAM, 0)
  guard fd >= 0 else { return nil }
  let connected = withUnixAddress(path) { address, size in connect(fd, address, size) }
  guard connected == 0 else {
    close(fd)
    return nil
  }
  return fd
}

// MARK: - vsock forwarding

// host-to-guest: accept on a host unix socket, dial the guest vsock port.
func forwardHostToGuest(_ socketDevice: VZVirtioSocketDevice, listenerFd: Int32, vsockPort: UInt32) {
  DispatchQueue.global().async {
    while true {
      let client = accept(listenerFd, nil, nil)
      if client < 0 { break }
      DispatchQueue.main.async {
        socketDevice.connect(toPort: vsockPort) { result in
          switch result {
          case .success(let connection):
            _ = Relay(client, dup(connection.fileDescriptor), retaining: connection)
          case .failure(let error):
            FileHandle.standardError.write(Data("vsock connect \(vsockPort) failed: \(error)\n".utf8))
            close(client)
          }
        }
      }
    }
  }
}

// guest-to-host: the guest dials a vsock port, we dial the host unix socket.
final class GuestDialDelegate: NSObject, VZVirtioSocketListenerDelegate {
  private let socketPath: String

  init(socketPath: String) {
    self.socketPath = socketPath
  }

  func listener(
    _ listener: VZVirtioSocketListener,
    shouldAcceptNewConnection connection: VZVirtioSocketConnection,
    from socketDevice: VZVirtioSocketDevice
  ) -> Bool {
    guard let fd = connectUnix(socketPath) else {
      FileHandle.standardError.write(Data("dial \(socketPath) failed: \(String(cString: strerror(errno)))\n".utf8))
      return false
    }
    _ = Relay(dup(connection.fileDescriptor), fd, retaining: connection)
    return true
  }
}

// MARK: - VM configuration

func buildConfiguration(_ config: VmConfig) throws -> VZVirtualMachineConfiguration {
  let machine = VZVirtualMachineConfiguration()
  let boot = VZLinuxBootLoader(kernelURL: URL(fileURLWithPath: config.kernel))
  // Empty initrd means the kernel boots without one (virtio compiled in).
  if !config.initrd.isEmpty {
    boot.initialRamdiskURL = URL(fileURLWithPath: config.initrd)
  }
  boot.commandLine = config.cmdline
  machine.bootLoader = boot
  machine.cpuCount = min(
    max(config.cpus, VZVirtualMachineConfiguration.minimumAllowedCPUCount),
    VZVirtualMachineConfiguration.maximumAllowedCPUCount
  )
  machine.memorySize = min(
    max(config.memoryMiB * 1024 * 1024, VZVirtualMachineConfiguration.minimumAllowedMemorySize),
    VZVirtualMachineConfiguration.maximumAllowedMemorySize
  )
  let disk = try VZDiskImageStorageDeviceAttachment(url: URL(fileURLWithPath: config.disk), readOnly: false)
  machine.storageDevices = [VZVirtioBlockDeviceConfiguration(attachment: disk)]
  machine.entropyDevices = [VZVirtioEntropyDeviceConfiguration()]
  machine.memoryBalloonDevices = [VZVirtioTraditionalMemoryBalloonDeviceConfiguration()]
  // Deliberately no network device: the guest's only egress is vsock.
  machine.socketDevices = [VZVirtioSocketDeviceConfiguration()]
  machine.directorySharingDevices = config.shares.map { share in
    let device = VZVirtioFileSystemDeviceConfiguration(tag: share.tag)
    device.share = VZSingleDirectoryShare(
      directory: VZSharedDirectory(url: URL(fileURLWithPath: share.path), readOnly: share.readOnly)
    )
    return device
  }
  // Guest serial console goes to stderr so boot problems are diagnosable from
  // the provider's captured stderr tail.
  let serial = VZVirtioConsoleDeviceSerialPortConfiguration()
  serial.attachment = VZFileHandleSerialPortAttachment(
    fileHandleForReading: nil,
    fileHandleForWriting: FileHandle.standardError
  )
  machine.serialPorts = [serial]
  try machine.validate()
  return machine
}

final class MachineDelegate: NSObject, VZVirtualMachineDelegate {
  func guestDidStop(_ virtualMachine: VZVirtualMachine) {
    emit(["event": "state", "state": "stopped"])
    exit(0)
  }

  func virtualMachine(_ virtualMachine: VZVirtualMachine, didStopWithError error: Error) {
    fail("virtual machine stopped: \(error.localizedDescription)")
  }
}

// MARK: - Main

var retained: [AnyObject] = []

let arguments = CommandLine.arguments
guard arguments.count == 2 else { fail("usage: codev-vmm <config.json>") }
guard let configData = FileManager.default.contents(atPath: arguments[1]) else {
  fail("cannot read config: \(arguments[1])")
}
guard let config = try? JSONDecoder().decode(VmConfig.self, from: configData) else {
  fail("invalid config: \(arguments[1])")
}

emit(["event": "state", "state": "starting"])

let machineConfiguration: VZVirtualMachineConfiguration
do {
  machineConfiguration = try buildConfiguration(config)
} catch {
  fail("invalid virtual machine configuration: \(error.localizedDescription)")
}

let vm = VZVirtualMachine(configuration: machineConfiguration, queue: .main)
let machineDelegate = MachineDelegate()
retained.append(machineDelegate)
vm.delegate = machineDelegate

func requestStop() {
  DispatchQueue.main.async {
    vm.stop { _ in
      emit(["event": "state", "state": "stopped"])
      exit(0)
    }
  }
}

// Stop on stdin command or EOF (parent process died), and on SIGTERM.
DispatchQueue.global().async {
  while let line = readLine() {
    if line.contains("stop") { requestStop() }
  }
  requestStop()
}
signal(SIGTERM, SIG_IGN)
let sigterm = DispatchSource.makeSignalSource(signal: SIGTERM, queue: .main)
sigterm.setEventHandler { requestStop() }
sigterm.resume()
retained.append(sigterm)

DispatchQueue.main.async {
  vm.start { result in
    switch result {
    case .success:
      guard let socketDevice = vm.socketDevices.first as? VZVirtioSocketDevice else {
        fail("virtual machine has no vsock device")
      }
      for forward in config.forwards {
        if forward.direction == "host-to-guest" {
          forwardHostToGuest(socketDevice, listenerFd: makeUnixListener(forward.socketPath), vsockPort: forward.vsockPort)
          continue
        }
        let delegate = GuestDialDelegate(socketPath: forward.socketPath)
        let listener = VZVirtioSocketListener()
        listener.delegate = delegate
        retained.append(delegate)
        retained.append(listener)
        socketDevice.setSocketListener(listener, forPort: forward.vsockPort)
      }
      emit(["event": "state", "state": "running"])
    case .failure(let error):
      fail("virtual machine failed to start: \(error.localizedDescription)")
    }
  }
}

RunLoop.main.run()
