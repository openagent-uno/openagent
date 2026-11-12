// Product-owned macOS closed-lid service. The privileged side accepts only a
// boolean, holds renewable per-connection leases, and restores its own change.
import Foundation
import ServiceManagement
import Security
import IOKit.ps
import MachO

let serviceName = "ai.openagent.desktop.power-guard"
let plistName = serviceName + ".plist"

@objc protocol PowerGuardProtocol {
    func renew(_ active: Bool, reply: @escaping (Data) -> Void)
}

func json(_ value: [String: Any]) -> Data {
    (try? JSONSerialization.data(withJSONObject: value, options: [.sortedKeys])) ?? Data("{}".utf8)
}

func output(_ value: [String: Any]) {
    FileHandle.standardOutput.write(json(value) + Data([10]))
}

enum GuardFailure: Error { case unavailable, unauthorized, journal }

func command(_ args: [String]) throws -> String {
    let process = Process(), pipe = Pipe()
    process.executableURL = URL(fileURLWithPath: "/usr/bin/pmset")
    process.arguments = args
    process.standardOutput = pipe
    process.standardError = FileHandle.nullDevice
    try process.run()
    let deadline = DispatchWorkItem { if process.isRunning { kill(process.processIdentifier, SIGKILL) } }
    DispatchQueue.global().asyncAfter(deadline: .now() + 4, execute: deadline)
    let data = pipe.fileHandleForReading.readDataToEndOfFile()
    process.waitUntilExit()
    deadline.cancel()
    guard process.terminationStatus == 0 else { throw GuardFailure.unavailable }
    return String(data: data, encoding: .utf8) ?? ""
}

func sleepDisabled() throws -> Bool {
    let text = try command(["-g"])
    for line in text.split(separator: "\n") {
        let fields = line.split(whereSeparator: { $0.isWhitespace })
        if fields.first == "SleepDisabled", fields.count == 2 {
            if fields[1] == "1" { return true }
            if fields[1] == "0" { return false }
        }
    }
    // A missing setting means the standard sleep policy is in effect.
    if !text.contains("SleepDisabled") { return false }
    throw GuardFailure.unavailable
}

func criticalPowerCondition() -> Bool {
    if ProcessInfo.processInfo.thermalState == .critical { return true }
    guard let source = IOPSCopyPowerSourcesInfo()?.takeRetainedValue(),
          let list = IOPSCopyPowerSourcesList(source)?.takeRetainedValue() as? [CFTypeRef] else { return false }
    for item in list {
        guard let description = IOPSGetPowerSourceDescription(source, item)?.takeUnretainedValue() as? [String: Any],
              description[kIOPSPowerSourceStateKey] as? String == kIOPSBatteryPowerValue,
              let current = description[kIOPSCurrentCapacityKey] as? Int,
              let maximum = description[kIOPSMaxCapacityKey] as? Int, maximum > 0 else { continue }
        if current * 100 / maximum <= 5 { return true }
    }
    return false
}

// Kept independent of IPC and OS preference APIs for deterministic lease/crash
// recovery tests. Production callbacks below always use the fixed pmset tool.
final class SleepLeases {
    var leases: [UUID: TimeInterval] = [:]
    var holding = false
    var owned = false
    let read: () throws -> Bool
    let write: (Bool) throws -> Void
    let journal: (Bool) throws -> Void
    let clear: () throws -> Void

    static func recover(previous: Bool, read: () throws -> Bool,
                        write: (Bool) throws -> Void, clear: () throws -> Void) throws {
        guard !previous else { throw GuardFailure.journal }
        if try read() { try write(false) }
        try clear()
    }

    init(read: @escaping () throws -> Bool, write: @escaping (Bool) throws -> Void,
         journal: @escaping (Bool) throws -> Void, clear: @escaping () throws -> Void) {
        self.read = read; self.write = write; self.journal = journal; self.clear = clear
    }

    func reconcile(now: TimeInterval, critical: Bool = false) throws {
        leases = leases.filter { $0.value > now }
        let active = !leases.isEmpty && !critical
        if active && !holding {
            let previous = try read()
            if !previous {
                // Persist recovery BEFORE changing the system setting.
                try journal(previous)
                owned = true
                do { try write(true) }
                catch { try? restore(); throw error }
            }
            holding = true
        } else if !active && (holding || owned) { try restore() }
    }

    func restore() throws {
        if owned {
            if try read() { try write(false) }
            try clear()
            owned = false
        }
        holding = false
    }
}

let queue = DispatchQueue(label: "ai.openagent.power-guard")

final class GuardEndpoint: NSObject, PowerGuardProtocol {
    let id = UUID()
    let leases: SleepLeases
    init(_ leases: SleepLeases) { self.leases = leases }
    func renew(_ active: Bool, reply: @escaping (Data) -> Void) {
        queue.async {
            self.leases.leases[self.id] = active ? ProcessInfo.processInfo.systemUptime + 45 : nil
            do {
                let critical = criticalPowerCondition()
                try self.leases.reconcile(now: ProcessInfo.processInfo.systemUptime, critical: critical)
                reply(json(["ok": true, "active": self.leases.holding, "safetyPaused": critical]))
            } catch { reply(json(["ok": false, "error": "power_setting_unavailable"])) }
        }
    }
    func disconnected() {
        queue.async {
            self.leases.leases[self.id] = nil
            try? self.leases.reconcile(now: ProcessInfo.processInfo.systemUptime, critical: criticalPowerCondition())
        }
    }
}

func executableURL() throws -> URL {
    // launchd ProgramArguments[0] need not be an absolute executable path.
    var size: UInt32 = 0
    _ = _NSGetExecutablePath(nil, &size)
    var buffer = [CChar](repeating: 0, count: Int(size))
    guard _NSGetExecutablePath(&buffer, &size) == 0 else { throw GuardFailure.unavailable }
    return URL(fileURLWithPath: String(cString: buffer)).resolvingSymlinksInPath()
}

func signingInfo(_ code: SecCode) -> [String: Any]? {
    var staticCode: SecStaticCode?
    var info: CFDictionary?
    guard SecCodeCopyStaticCode(code, [], &staticCode) == errSecSuccess, let staticCode,
          SecCodeCopySigningInformation(staticCode, SecCSFlags(rawValue: kSecCSSigningInformation), &info) == errSecSuccess else { return nil }
    return info as? [String: Any]
}

final class GuardListener: NSObject, NSXPCListenerDelegate {
    let leases: SleepLeases
    let requirement: SecRequirement
    let clientPath: String

    init(_ leases: SleepLeases) throws {
        self.leases = leases
        var own: SecCode?
        guard SecCodeCopySelf([], &own) == errSecSuccess, let own,
              let team = signingInfo(own)?[kSecCodeInfoTeamIdentifier as String] as? String,
              team.range(of: "^[A-Z0-9]+$", options: .regularExpression) != nil else { throw GuardFailure.unauthorized }
        var requirement: SecRequirement?
        let rule = "anchor apple generic and certificate leaf[subject.OU] = \"\(team)\""
        guard SecRequirementCreateWithString(rule as CFString, [], &requirement) == errSecSuccess, let requirement else { throw GuardFailure.unauthorized }
        self.requirement = requirement
        let executable = try executableURL()
        // Contents/Library/LaunchServices/guard -> Contents/MacOS/client
        clientPath = executable.deletingLastPathComponent().deletingLastPathComponent()
            .deletingLastPathComponent().appendingPathComponent("MacOS/openagent-power-client").path
    }

    func listener(_ listener: NSXPCListener, shouldAcceptNewConnection connection: NSXPCConnection) -> Bool {
        guard connection.effectiveUserIdentifier != 0 else { return false }
        var guest: SecCode?
        let attributes = [kSecGuestAttributePid as String: connection.processIdentifier] as CFDictionary
        guard SecCodeCopyGuestWithAttributes(nil, attributes, [], &guest) == errSecSuccess, let guest,
              SecCodeCheckValidity(guest, [], requirement) == errSecSuccess,
              let path = signingInfo(guest)?[kSecCodeInfoMainExecutable as String] as? URL,
              path.resolvingSymlinksInPath().path == clientPath else { return false }
        let endpoint = GuardEndpoint(leases)
        connection.exportedInterface = NSXPCInterface(with: PowerGuardProtocol.self)
        connection.exportedObject = endpoint
        connection.invalidationHandler = { endpoint.disconnected() }
        connection.interruptionHandler = { endpoint.disconnected() }
        connection.resume()
        return true
    }
}

func daemon() throws {
    guard geteuid() == 0 else { throw GuardFailure.unauthorized }
    let directory = URL(fileURLWithPath: "/var/db/ai.openagent.desktop.power-guard", isDirectory: true)
    let fm = FileManager.default
    if !fm.fileExists(atPath: directory.path) { try fm.createDirectory(at: directory, withIntermediateDirectories: false, attributes: [.posixPermissions: 0o700]) }
    let attributes = try fm.attributesOfItem(atPath: directory.path)
    guard attributes[.type] as? FileAttributeType == .typeDirectory,
          (attributes[.ownerAccountID] as? NSNumber)?.intValue == 0,
          ((attributes[.posixPermissions] as? NSNumber)?.intValue ?? 0) & 0o077 == 0 else { throw GuardFailure.journal }
    let journal = directory.appendingPathComponent("restore.json")
    if fm.fileExists(atPath: journal.path) {
        let previous = try JSONSerialization.jsonObject(with: Data(contentsOf: journal)) as? [String: Bool]
        guard previous?["sleepDisabled"] == false else { throw GuardFailure.journal }
        try SleepLeases.recover(previous: false, read: sleepDisabled,
            write: { _ = try command(["-a", "disablesleep", $0 ? "1" : "0"]) }, clear: { try fm.removeItem(at: journal) })
    }
    let leases = SleepLeases(read: sleepDisabled,
        write: { _ = try command(["-a", "disablesleep", $0 ? "1" : "0"]) },
        journal: { try json(["sleepDisabled": $0]).write(to: journal, options: .atomic) },
        clear: { if fm.fileExists(atPath: journal.path) { try fm.removeItem(at: journal) } })
    let delegate = try GuardListener(leases)
    let listener = NSXPCListener(machServiceName: serviceName)
    listener.delegate = delegate
    let timer = DispatchSource.makeTimerSource(queue: queue)
    timer.schedule(deadline: .now(), repeating: 2)
    timer.setEventHandler { try? leases.reconcile(now: ProcessInfo.processInfo.systemUptime, critical: criticalPowerCondition()) }
    timer.resume(); listener.resume()
    // Service revocation/shutdown must restore before launchd unloads us too.
    let signals = [SIGTERM, SIGINT].map { number -> DispatchSourceSignal in
        signal(number, SIG_IGN)
        let source = DispatchSource.makeSignalSource(signal: number, queue: queue)
        source.setEventHandler {
            leases.leases.removeAll()
            try? leases.restore()
            exit(0)
        }
        source.resume(); return source
    }
    withExtendedLifetime((delegate, listener, timer, signals)) { RunLoop.current.run() }
}

func client() {
    let connection = NSXPCConnection(machServiceName: serviceName, options: .privileged)
    connection.remoteObjectInterface = NSXPCInterface(with: PowerGuardProtocol.self)
    connection.resume()
    defer { connection.invalidate() }
    while let line = readLine() {
        guard line.utf8.count <= 256, let data = line.data(using: .utf8),
              let value = try? JSONSerialization.jsonObject(with: data) as? [String: Bool],
              let active = value["active"], value.count == 1 else { output(["ok": false]); continue }
        let semaphore = DispatchSemaphore(value: 0)
        let proxy = connection.remoteObjectProxyWithErrorHandler { _ in output(["ok": false, "error": "helper_unavailable"]); semaphore.signal() } as? PowerGuardProtocol
        proxy?.renew(active) { data in FileHandle.standardOutput.write(data + Data([10])); semaphore.signal() }
        if semaphore.wait(timeout: .now() + 8) == .timedOut { output(["ok": false, "error": "helper_timeout"]); return }
    }
}

func selfTest() throws {
    // Never exercises privileges, pmset, launchd or actual power preferences.
    guard geteuid() != 0 else { throw GuardFailure.unauthorized }
    let ownExecutable = try executableURL()
    precondition(FileManager.default.isExecutableFile(atPath: ownExecutable.path))
    var setting = false, journaled = false, writes = [Bool]()
    let leases = SleepLeases(read: { setting }, write: { setting = $0; writes.append($0) },
        journal: { _ in journaled = true }, clear: { journaled = false })
    let a = UUID(), b = UUID()
    leases.leases[a] = 45; try leases.reconcile(now: 0)
    precondition(setting && journaled)
    leases.leases[b] = 60; leases.leases[a] = nil; try leases.reconcile(now: 20)
    precondition(setting && writes == [true])
    try leases.reconcile(now: 61)
    precondition(!setting && !journaled && writes == [true, false])
    setting = true; writes = []
    leases.leases[a] = 120; try leases.reconcile(now: 70)
    leases.leases.removeAll(); try leases.reconcile(now: 80)
    precondition(setting && writes.isEmpty) // preserve pre-existing global policy
    setting = false; leases.leases[a] = 180; try leases.reconcile(now: 100)
    try leases.reconcile(now: 110, critical: true)
    precondition(!setting && !journaled)
    setting = true; journaled = true
    try SleepLeases.recover(previous: false, read: { setting }, write: { setting = $0 }, clear: { journaled = false })
    precondition(!setting && !journaled)
    output(["ok": true, "tests": 5])
}

do {
    switch CommandLine.arguments.dropFirst().first {
    case "--daemon": try daemon()
    case "--client": client()
    case "--self-test": try selfTest()
    case "--status", "--register":
        let service = SMAppService.daemon(plistName: plistName)
        if CommandLine.arguments.last == "--register" {
            guard Bundle.main.bundleIdentifier == "ai.openagent.desktop" else { throw GuardFailure.unauthorized }
            if service.status == .notRegistered { try service.register() }
            if service.status == .requiresApproval { SMAppService.openSystemSettingsLoginItems() }
        }
        let status: String
        switch service.status {
        case .enabled: status = "ready"
        case .requiresApproval: status = "approval-required"
        default: status = "setup-required"
        }
        output(["status": status, "hostApp": Bundle.main.bundleIdentifier ?? "", "criticalPowerCondition": criticalPowerCondition()])
    default: output(["error": "invalid_mode"]); exit(1)
    }
} catch { output(["status": "error", "error": "power_service_unavailable"]); exit(1) }
