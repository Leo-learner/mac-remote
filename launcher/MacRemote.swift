// MacRemote — menu bar app for both phone services on this Mac.
//
// Phone control (Orbit, this repo's agent) and the phone terminal (the remote-term agent) share
// this one icon but not their privacy permissions. macOS attributes a permission to the app that
// is responsible for a process:
//   - The Orbit agent is an ordinary child, so macctl, osascript and blueutil run under this signed
//     bundle and its Accessibility, Bluetooth and Automation grants.
//   - The terminal agent runs under the RemoteTerm.app helper, spawned with that responsibility
//     disclaimed: the helper, its node and every shell count as RemoteTerm, which holds Full Disk
//     Access, and never inherit this app's grants. When macOS does not confirm that, the terminal
//     is not started at all. The helper is installed next to the agent config, not inside this
//     bundle: TCC treats code anywhere inside an app's bundle as that app, whoever is responsible.
// The menu shows both links, carries the local controls for the external display and the
// terminal's pairing, and is the local kill switch for each service. Opening the app (or opening
// it again) shows a status window.
//
// Build + install: bash launcher/build.sh
import AppKit
import ApplicationServices
import CoreBluetooth
import CoreImage
import ServiceManagement
import SwiftUI

let home = FileManager.default.homeDirectoryForCurrentUser
let supportDir = home.appendingPathComponent("Library/Application Support/MacRemote")
let orbitConfig = supportDir.appendingPathComponent("agent.json")
let terminalConfig = home.appendingPathComponent("Library/Application Support/RemoteTerm/agent.json")
// Installed by launcher/build.sh. Outside MacRemote.app on purpose, see TerminalProcess.
let terminalHelper = supportDir.appendingPathComponent("RemoteTerm.app")
let logDir = home.appendingPathComponent("Library/Logs/MacRemote")
let showWindowNotification = Notification.Name("dev.mac-remote.launcher.show-window")
// Enough for the agents themselves; login shells rebuild PATH from /etc/zprofile and dotfiles.
let agentPath = "/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin"

func readJSON(_ url: URL) -> [String: Any]? {
    guard let data = try? Data(contentsOf: url) else { return nil }
    return (try? JSONSerialization.jsonObject(with: data)) as? [String: Any]
}

// Both agents run on the node the build recorded.
func nodePath() -> String {
    readJSON(supportDir.appendingPathComponent("launcher.json"))?["node"] as? String ?? "/opt/homebrew/bin/node"
}

func relayHost(_ config: URL) -> String? {
    guard let relay = readJSON(config)?["relayUrl"] as? String else { return nil }
    return URLComponents(string: relay)?.host
}

func qrImage(_ text: String, points: CGFloat) -> NSImage? {
    guard let filter = CIFilter(name: "CIQRCodeGenerator") else { return nil }
    filter.setValue(Data(text.utf8), forKey: "inputMessage")
    filter.setValue("M", forKey: "inputCorrectionLevel")
    guard let output = filter.outputImage else { return nil }
    let scale = (points * 2) / output.extent.width // drawn at 2x, shown at `points`
    let representation = NSCIImageRep(ciImage: output.transformed(by: CGAffineTransform(scaleX: scale, y: scale)))
    let image = NSImage(size: NSSize(width: points, height: points))
    image.addRepresentation(representation)
    return image
}

// MARK: - Logs

// One log per agent in ~/Library/Logs/MacRemote, readable by the owner only. The rules keep it
// small and free of secrets: replies (status polls, pairing links), pairing events and the chatty
// count updates stay out, and a relay outage leaves its first line plus, on the next `connected`,
// the number of attempts that failed, instead of three lines per retry for hours.
final class AgentLog {
    private static let unlogged: Set<String> = ["reply", "pairing", "sessions", "links", "watch-input"]
    private static let rotateAt: off_t = 2 << 20

    private let path: String
    private var file: Int32 = -1
    private var offline = false // an offline-family line is in the log; the rest wait for `connected`
    private var attemptOpen = false // a `connecting` that has not been answered yet
    private var failedAttempts = 0

    init(_ name: String) {
        path = logDir.appendingPathComponent(name).path
    }

    // A new agent process starts with a clean slate, and an existing file gets its mode fixed now.
    func agentStarting() {
        offline = false
        attemptOpen = false
        failedAttempts = 0
        openFile()
    }

    func record(_ line: Data, _ event: [String: Any]?) {
        guard let event else { return append(line) } // warnings and stack traces, verbatim
        let kind = event["event"] as? String ?? ""
        if AgentLog.unlogged.contains(kind) { return }
        if kind == "started" { offline = false }
        guard kind == "status", let status = event["status"] as? String else { return append(line) }
        switch status {
        case "connected":
            let failed = failedAttempts
            offline = false
            attemptOpen = false
            failedAttempts = 0
            append(failed > 0 ? adding(failedAttempts: failed, to: line) : line)
        case "connecting":
            // An attempt is one `connecting`; it failed if the next word about it is not `connected`.
            if attemptOpen { failedAttempts += 1 }
            attemptOpen = true
            appendFirstOffline(line)
        case "error", "disconnected":
            if attemptOpen { failedAttempts += 1 }
            attemptOpen = false
            appendFirstOffline(line)
        default:
            append(line)
        }
    }

    // The app's own word in the log, in the agents' line format.
    func launcherError(_ message: String) {
        let event: [String: Any] = ["event": "error", "source": "launcher", "message": message,
                                    "ts": Int(Date().timeIntervalSince1970 * 1000)]
        if let line = try? JSONSerialization.data(withJSONObject: event, options: .sortedKeys) { append(line) }
    }

    private func appendFirstOffline(_ line: Data) {
        guard !offline else { return }
        offline = true
        append(line)
    }

    private func adding(failedAttempts count: Int, to line: Data) -> Data {
        var line = line
        while let last = line.last, last == 0x20 || last == 0x0D { line.removeLast() }
        guard line.last == UInt8(ascii: "}") else { return line }
        line.removeLast()
        line.append(Data(",\"failedAttempts\":\(count)}".utf8))
        return line
    }

    private func append(_ line: Data) {
        guard prepare() else { return }
        var bytes = line
        bytes.append(0x0A)
        _ = bytes.withUnsafeBytes { Darwin.write(file, $0.baseAddress, $0.count) }
    }

    // Opens the file on first use, starts a new one if it was deleted, and rolls it over to
    // <name>.1 once it is past 2 MB, before the write that would grow it further.
    private func prepare() -> Bool {
        if file >= 0 {
            var info = stat()
            if fstat(file, &info) != 0 || info.st_nlink == 0 {
                Darwin.close(file)
                file = -1
            } else if info.st_size > AgentLog.rotateAt {
                Darwin.close(file)
                file = -1
                rename(path, path + ".1")
            }
        }
        openFile()
        return file >= 0
    }

    private func openFile() {
        guard file < 0 else { return }
        try? FileManager.default.createDirectory(at: logDir, withIntermediateDirectories: true)
        file = Darwin.open(path, O_WRONLY | O_APPEND | O_CREAT | O_CLOEXEC, 0o600)
        if file >= 0 { fchmod(file, 0o600) } // logs from older builds were world-readable
    }
}

// MARK: - Agent processes

// An agent writes one JSON object per line on stdout; stderr (warnings, stack traces) shares the
// pipe. Lines are handed on in order, on the main queue.
final class LineReader {
    private var pending = Data()
    private let onLine: (Data) -> Void

    init(_ onLine: @escaping (Data) -> Void) {
        self.onLine = onLine
    }

    // The handler keeps this reader and the handle alive until end of file and then lets go of
    // both; left in place, it would be called again and again with nothing to read.
    func read(_ handle: FileHandle) {
        handle.readabilityHandler = { [self, handle] _ in
            let data = handle.availableData
            if data.isEmpty { handle.readabilityHandler = nil }
            DispatchQueue.main.async {
                if data.isEmpty {
                    self.finish()
                } else {
                    self.feed(data)
                }
            }
        }
    }

    private func feed(_ data: Data) {
        pending.append(data)
        while let newline = pending.firstIndex(of: 0x0A) {
            let line = pending.subdata(in: pending.startIndex..<newline)
            pending.removeSubrange(pending.startIndex...newline)
            onLine(line)
        }
        if pending.count > 1 << 20 { finish() } // no agent line comes near this; pass a runaway one on as is
    }

    // A last line without a newline (a crash message, say) still counts.
    private func finish() {
        guard !pending.isEmpty else { return }
        let line = pending
        pending = Data()
        onLine(line)
    }
}

protocol AgentProcess: AnyObject {
    var isRunning: Bool { get }
    // Lines and the exit code (128 + n for signal n) arrive on the main queue.
    func start(onLine: @escaping (Data) -> Void, onExit: @escaping (Int32) -> Void) throws
    func send(_ request: [String: Any])
    func stop()
}

enum LaunchError: Error, CustomStringConvertible {
    case failed(String) // could not spawn; retried with backoff
    case unsafe(String) // could not be spawned as its own responsible process; never retried on its own

    var description: String {
        switch self {
        case .failed(let reason), .unsafe(let reason): return reason
        }
    }
}

// Requests are one line of JSON each. The pipe is non-blocking: if an agent stops reading, a
// request is dropped instead of freezing the menu.
func writeLine(_ fd: Int32, _ request: [String: Any]) {
    guard fd >= 0, var line = try? JSONSerialization.data(withJSONObject: request) else { return }
    line.append(0x0A)
    line.withUnsafeBytes { buffer in
        var offset = 0
        while offset < buffer.count {
            let written = Darwin.write(fd, buffer.baseAddress! + offset, buffer.count - offset)
            if written > 0 {
                offset += written
            } else if written < 0, errno == EINTR {
                continue
            } else {
                return
            }
        }
    }
}

func setNonBlocking(_ fd: Int32) {
    _ = fcntl(fd, F_SETFL, fcntl(fd, F_GETFL) | O_NONBLOCK)
}

@discardableResult
func reap(_ pid: pid_t) -> Int32 {
    var status: Int32 = 0
    while waitpid(pid, &status, 0) == -1 {
        if errno != EINTR { return -1 }
    }
    let signal = status & 0x7f
    return signal == 0 ? (status >> 8) & 0xff : 128 + signal
}

func cStrings(_ strings: [String]) -> [UnsafeMutablePointer<CChar>?] {
    strings.map { strdup($0) } + [nil]
}

// The Orbit agent is an ordinary child: whatever it runs (macctl, osascript, blueutil) is
// attributed to this app and its grants.
final class OrbitProcess: AgentProcess {
    private var process: Process?
    private var lifeline: FileHandle?

    var isRunning: Bool { process?.isRunning ?? false }

    func start(onLine: @escaping (Data) -> Void, onExit: @escaping (Int32) -> Void) throws {
        let process = Process()
        process.executableURL = URL(fileURLWithPath: nodePath())
        process.arguments = [(Bundle.main.resourcePath ?? "") + "/agent/index.js"]
        var environment = ProcessInfo.processInfo.environment.filter { !$0.key.hasPrefix("REMOTE_TERM_") }
        environment["PATH"] = agentPath
        environment["MAC_REMOTE_PARENT_PIPE"] = "1"
        process.environment = environment

        // We hold the write end of the child's stdin for as long as we live. When this app exits,
        // even by SIGKILL, the child reads EOF and stops instead of lingering as an orphan.
        let lifeline = Pipe()
        process.standardInput = lifeline
        let output = Pipe()
        process.standardOutput = output
        process.standardError = output
        process.terminationHandler = { finished in
            let code = finished.terminationStatus + (finished.terminationReason == .uncaughtSignal ? 128 : 0)
            DispatchQueue.main.async { onExit(code) }
        }
        try process.run()
        self.process = process
        self.lifeline = lifeline.fileHandleForWriting
        setNonBlocking(lifeline.fileHandleForWriting.fileDescriptor)
        LineReader(onLine).read(output.fileHandleForReading)
    }

    // The menu bar's own controls travel down the same pipe that keeps the agent alive. The agent
    // runs them through its allow-list, exactly like a request from the phone.
    func send(_ request: [String: Any]) {
        guard isRunning, let lifeline else { return }
        writeLine(lifeline.fileDescriptor, request)
    }

    // SIGTERM: the agent closes its relay socket and exits.
    func stop() {
        guard let process, process.isRunning else { return }
        process.terminate()
    }
}

// Two private libSystem calls with no SDK header, looked up at run time. Without either one the
// terminal cannot be started safely, so it is not started.
enum Responsibility {
    typealias SetDisclaim = @convention(c) (UnsafeMutablePointer<posix_spawnattr_t?>?, Int32) -> Int32
    typealias ResponsiblePID = @convention(c) (pid_t) -> pid_t

    private static let anywhere = UnsafeMutableRawPointer(bitPattern: -2) // RTLD_DEFAULT
    static let setDisclaim = dlsym(anywhere, "responsibility_spawnattrs_setdisclaim")
        .map { unsafeBitCast($0, to: SetDisclaim.self) }
    static let responsiblePID = dlsym(anywhere, "responsibility_get_pid_responsible_for_pid")
        .map { unsafeBitCast($0, to: ResponsiblePID.self) }
}

// The terminal agent runs as the RemoteTerm.app helper, which is its own app as far as privacy
// grants go. Spawned with TCC responsibility disclaimed, the helper, the node it starts and every
// shell count as dev.remote-term.launcher (the holder of Full Disk Access) and never get this
// app's Accessibility, Input Monitoring, Bluetooth or Automation. That only holds while the helper
// lives outside any other app's bundle: TCC attributes code inside MacRemote.app to MacRemote even
// when the helper is its own responsible process (checked on macOS 27: nested, its Full Disk
// Access check was made for dev.mac-remote.launcher and denied). Foundation's Process cannot set
// spawn attributes, hence posix_spawn. It fails closed: no disclaim, no terminal.
final class TerminalProcess: AgentProcess {
    private var pid: pid_t = 0
    private var input: Int32 = -1 // the lifeline and the request channel, as on the Orbit side
    private var exitWatch: DispatchSourceProcess?

    var isRunning: Bool { pid > 0 }

    func start(onLine: @escaping (Data) -> Void, onExit: @escaping (Int32) -> Void) throws {
        guard let disclaim = Responsibility.setDisclaim, let responsiblePID = Responsibility.responsiblePID else {
            throw LaunchError.unsafe("responsibility_spawnattrs_setdisclaim or responsibility_get_pid_responsible_for_pid is missing")
        }
        guard !terminalHelper.deletingLastPathComponent().pathComponents.contains(where: { $0.hasSuffix(".app") }) else {
            throw LaunchError.unsafe("\(terminalHelper.path) is inside another app, which macOS would hold responsible")
        }
        let helper = terminalHelper.appendingPathComponent("Contents/MacOS/RemoteTerm").path
        let script = terminalHelper.appendingPathComponent("Contents/Resources/agent/index.js").path
        guard FileManager.default.isExecutableFile(atPath: helper) else {
            throw LaunchError.failed("\(helper) is missing: run launcher/build.sh")
        }

        var inputPipe: [Int32] = [-1, -1]
        var outputPipe: [Int32] = [-1, -1]
        guard pipe(&inputPipe) == 0 else { throw LaunchError.failed("pipe: \(String(cString: strerror(errno)))") }
        guard pipe(&outputPipe) == 0 else {
            let reason = String(cString: strerror(errno))
            inputPipe.forEach { Darwin.close($0) }
            throw LaunchError.failed("pipe: \(reason)")
        }
        // Foundation spawns the Orbit agent without our help: none of these may leak into it.
        for fd in inputPipe + outputPipe { _ = fcntl(fd, F_SETFD, FD_CLOEXEC) }

        var actions: posix_spawn_file_actions_t?
        posix_spawn_file_actions_init(&actions)
        defer { posix_spawn_file_actions_destroy(&actions) }
        posix_spawn_file_actions_adddup2(&actions, inputPipe[0], 0)
        posix_spawn_file_actions_adddup2(&actions, outputPipe[1], 1)
        posix_spawn_file_actions_adddup2(&actions, outputPipe[1], 2)
        if #available(macOS 26.0, *) {
            posix_spawn_file_actions_addchdir(&actions, home.path)
        } else {
            posix_spawn_file_actions_addchdir_np(&actions, home.path)
        }

        // Only the three descriptors above reach the helper, with default signal actions (this app
        // ignores SIGPIPE) and nothing blocked. It starts suspended, so not one instruction of it
        // runs before the kernel confirms that it is its own responsible process.
        var attributes: posix_spawnattr_t?
        posix_spawnattr_init(&attributes)
        defer { posix_spawnattr_destroy(&attributes) }
        posix_spawnattr_setflags(&attributes, Int16(POSIX_SPAWN_CLOEXEC_DEFAULT | POSIX_SPAWN_SETSIGDEF
            | POSIX_SPAWN_SETSIGMASK | POSIX_SPAWN_START_SUSPENDED))
        var allSignals = sigset_t()
        sigfillset(&allSignals)
        posix_spawnattr_setsigdefault(&attributes, &allSignals)
        var noSignals = sigset_t()
        sigemptyset(&noSignals)
        posix_spawnattr_setsigmask(&attributes, &noSignals)
        let disclaimed = disclaim(&attributes, 1)
        guard disclaimed == 0 else {
            (inputPipe + outputPipe).forEach { Darwin.close($0) }
            throw LaunchError.unsafe("responsibility_spawnattrs_setdisclaim failed: \(disclaimed)")
        }

        let argv = cStrings([helper, nodePath(), script])
        let envp = cStrings(terminalEnvironment())
        defer { (argv + envp).forEach { free($0) } }
        var pid: pid_t = 0
        let spawned = posix_spawn(&pid, helper, &actions, &attributes, argv, envp)
        Darwin.close(inputPipe[0])
        Darwin.close(outputPipe[1])
        guard spawned == 0 else {
            Darwin.close(inputPipe[1])
            Darwin.close(outputPipe[0])
            throw LaunchError.failed("posix_spawn \(helper): \(String(cString: strerror(spawned)))")
        }
        let owner = responsiblePID(pid)
        guard owner == pid else {
            kill(pid, SIGKILL)
            reap(pid)
            Darwin.close(inputPipe[1])
            Darwin.close(outputPipe[0])
            throw LaunchError.unsafe("the helper (pid \(pid)) is attributed to pid \(owner), not to itself")
        }

        self.pid = pid
        input = inputPipe[1]
        setNonBlocking(input)
        LineReader(onLine).read(FileHandle(fileDescriptor: outputPipe[0], closeOnDealloc: true))
        let watch = DispatchSource.makeProcessSource(identifier: pid, eventMask: .exit, queue: .main)
        watch.setEventHandler { [weak self] in
            watch.cancel()
            let code = reap(pid)
            self?.exited(pid)
            onExit(code)
        }
        exitWatch = watch
        watch.resume()
        kill(pid, SIGCONT)
    }

    func send(_ request: [String: Any]) {
        if isRunning { writeLine(input, request) }
    }

    // SIGTERM reaches node through the helper: the agent hangs up its sessions, flushes its state,
    // closes the relay socket and exits, and the helper exits after it.
    func stop() {
        if pid > 0 { kill(pid, SIGTERM) }
    }

    // A node the helper left behind reads EOF on its stdin and stops.
    private func exited(_ pid: pid_t) {
        guard self.pid == pid else { return }
        self.pid = 0
        Darwin.close(input)
        input = -1
        exitWatch = nil
    }

    // This app's environment minus both projects' control variables (MAC_REMOTE_PARENT_PIPE must
    // never reach a phone's shell), plus the agent's PATH and its parent-pipe switch.
    private func terminalEnvironment() -> [String] {
        var environment = ProcessInfo.processInfo.environment.filter {
            !$0.key.hasPrefix("MAC_REMOTE_") && !$0.key.hasPrefix("REMOTE_TERM_")
        }
        environment["PATH"] = agentPath
        environment["REMOTE_TERM_PARENT_PIPE"] = "1"
        return environment.map { "\($0.key)=\($0.value)" }
    }
}

// MARK: - Supervision

// One agent under the menu bar app, with its own link state, pause switch, restart backoff and
// log. The two never share any of it, so one agent's crash loop or reconnect cannot reset or
// delay the other.
final class Service {
    let log: AgentLog
    var onEvent: ([String: Any]) -> Void = { _ in }
    var onExit: () -> Void = {}
    var onChange: () -> Void = {}
    private(set) var link = "starting"
    private(set) var paused = false
    private let process: AgentProcess
    private let launchFailures: Set<Int32>
    private let isConfigured: () -> Bool
    private var quitting = false
    private var restartDelay: TimeInterval = 1
    private var restartWork: DispatchWorkItem?
    private var restartRequested = false
    private var startedAt = Date()
    private var generation = 0
    private var requestCounter = 0
    private var lastLaunchError: String?

    init(log: String, process: AgentProcess, launchFailures: Set<Int32> = [], isConfigured: @escaping () -> Bool) {
        self.log = AgentLog(log)
        self.process = process
        self.launchFailures = launchFailures
        self.isConfigured = isConfigured
    }

    var isRunning: Bool { process.isRunning }

    func nextRequestID() -> Int {
        requestCounter += 1
        return requestCounter
    }

    func send(_ request: [String: Any]) {
        process.send(request)
    }

    func start() {
        restartWork?.cancel()
        restartWork = nil
        guard !paused, !quitting, !process.isRunning else { return }
        defer { onChange() }
        guard isConfigured() else {
            link = "unconfigured"
            return
        }
        generation += 1
        let generation = generation
        log.agentStarting()
        do {
            startedAt = Date()
            try process.start(
                onLine: { [weak self] line in self?.received(line, from: generation) },
                onExit: { [weak self] code in self?.exited(code, from: generation) })
            link = "connecting"
            lastLaunchError = nil
        } catch LaunchError.unsafe(let reason) {
            // Never retried by itself: the only other way to start it would hand shells this app's grants.
            note(reason)
            link = "unsafe"
        } catch {
            note((error as? LaunchError)?.description ?? error.localizedDescription)
            link = "failed"
            scheduleRestart()
        }
    }

    func setPaused(_ paused: Bool) {
        self.paused = paused
        if paused {
            restartWork?.cancel()
            restartWork = nil
            restartRequested = false
            process.stop()
            link = "paused"
        } else {
            restartDelay = 1
            link = "starting"
            start()
        }
        onChange()
    }

    // Stops the agent and starts it again at once, for example so a new Full Disk Access grant applies.
    func restart() {
        guard !paused, !quitting else { return }
        if process.isRunning {
            restartRequested = true
            process.stop()
        } else {
            restartDelay = 1
            start()
        }
    }

    func quit() {
        guard !quitting else { return }
        quitting = true
        restartWork?.cancel()
        restartWork = nil
        process.stop()
    }

    private func received(_ line: Data, from generation: Int) {
        let event = (try? JSONSerialization.jsonObject(with: line)) as? [String: Any]
        log.record(line, event)
        // A late line from an agent that has been replaced only goes to the log.
        guard generation == self.generation, let event else { return }
        if event["event"] as? String == "status", let status = event["status"] as? String {
            link = status
            if status == "connected" { restartDelay = 1 }
        }
        onEvent(event)
    }

    private func exited(_ code: Int32, from generation: Int) {
        guard generation == self.generation else { return }
        onExit()
        if paused || quitting {
            restartRequested = false
            if paused { link = "paused" }
            onChange()
            return
        }
        if restartRequested {
            restartRequested = false
            restartDelay = 1
            start()
            return
        }
        if Date().timeIntervalSince(startedAt) > 60 { restartDelay = 1 }
        link = launchFailures.contains(code) ? "failed" : "restarting"
        onChange()
        scheduleRestart()
    }

    private func scheduleRestart() {
        let delay = restartDelay
        restartDelay = min(restartDelay * 2, 30)
        let work = DispatchWorkItem { [weak self] in self?.start() }
        restartWork = work
        DispatchQueue.main.asyncAfter(deadline: .now() + delay, execute: work)
    }

    // A spawn that keeps failing the same way is logged once, not every 30 s.
    private func note(_ reason: String) {
        if reason != lastLaunchError { log.launcherError(reason) }
        lastLaunchError = reason
    }
}

// Creating a manager is what shows the Bluetooth prompt. Once the prompt is answered, the probe
// lets go of its connection to bluetoothd instead of holding it for the life of the app.
final class BluetoothPrompt: NSObject, CBCentralManagerDelegate {
    private var manager: CBCentralManager?
    private let answered: () -> Void

    init(answered: @escaping () -> Void) {
        self.answered = answered
        super.init()
        manager = CBCentralManager(delegate: self, queue: nil)
    }

    func centralManagerDidUpdateState(_ central: CBCentralManager) {
        guard CBManager.authorization != .notDetermined else { return }
        DispatchQueue.main.async { self.answered() }
    }
}

// MARK: - Status window

struct ServiceState: Equatable {
    var symbol = "ellipsis.circle"
    var text = "正在启动…"
    var detail = ""
    var paused = false
}

// Everything the window shows. It is replaced only when a value differs, so SwiftUI re-renders
// only when something visible changed.
struct WindowState: Equatable {
    var symbol = "ellipsis.circle"
    var orbit = ServiceState()
    var terminal = ServiceState()
    var orbitConfigured = false
    var accessibility = false
    var bluetooth = "未询问"
    var automation = "未检查"
    var loginItem = false
    var sessions = 0
    var phones = 0
    var devices = 0
    var fullDiskAccess: Bool?
    var canPair = false
    var canRestartTerminal = false
    var pairingImage: NSImage?
    var pairingExpires: Date?
}

final class StatusModel: ObservableObject {
    @Published var state = WindowState()

    var openPanel: () -> Void = {}
    var toggleOrbit: () -> Void = {}
    var toggleTerminal: () -> Void = {}
    var restartTerminal: () -> Void = {}
    var pair: () -> Void = {}
    var setLoginItem: (Bool) -> Void = { _ in }
    var requestAccessibility: () -> Void = {}
    var requestBluetooth: () -> Void = {}
    var requestAutomation: () -> Void = {}
    var openFullDiskAccess: () -> Void = {}
    var openLogs: () -> Void = {}
}

struct PermissionRow: View {
    let title: String
    let status: String
    let granted: Bool
    var actionTitle = "授权…"
    let action: () -> Void

    var body: some View {
        HStack(spacing: 8) {
            Image(systemName: granted ? "checkmark.circle.fill" : "circle.dashed")
                .foregroundStyle(granted ? Color.green : Color.secondary)
            Text(title)
            Spacer()
            Text(status).foregroundStyle(.secondary)
            if !granted {
                Button(actionTitle, action: action).controlSize(.small)
            }
        }
    }
}

// A service's state line, with its relay host or what to do next underneath.
struct ServiceSummary: View {
    let state: ServiceState

    var body: some View {
        VStack(alignment: .leading, spacing: 4) {
            Label(state.text, systemImage: state.symbol)
            if !state.detail.isEmpty {
                Text(state.detail)
                    .font(.callout)
                    .foregroundStyle(.secondary)
                    .fixedSize(horizontal: false, vertical: true)
                    .textSelection(.enabled)
            }
        }
    }
}

struct PairingView: View {
    let image: NSImage
    let expires: Date

    var body: some View {
        HStack(spacing: 14) {
            Image(nsImage: image)
                .interpolation(.none)
                .frame(width: 200, height: 200)
                .padding(10)
                .background(Color.white)
                .clipShape(RoundedRectangle(cornerRadius: 10))
            VStack(alignment: .leading, spacing: 8) {
                Text("用手机相机扫描，按提示创建通行密钥")
                    .fixedSize(horizontal: false, vertical: true)
                Text("\(expires.formatted(date: .omitted, time: .shortened)) 前有效，只能用一次")
                    .font(.footnote)
                    .foregroundStyle(.secondary)
                    .fixedSize(horizontal: false, vertical: true)
            }
        }
    }
}

struct StatusView: View {
    @ObservedObject var model: StatusModel

    var body: some View {
        let state = model.state
        VStack(alignment: .leading, spacing: 14) {
            HStack(spacing: 12) {
                Image(systemName: state.symbol)
                    .font(.system(size: 26, weight: .medium))
                    .foregroundStyle(Color.orange)
                    .frame(width: 36)
                VStack(alignment: .leading, spacing: 2) {
                    Text("MacRemote").font(.headline)
                    Text("用手机控制这台 Mac，也在手机上用它的终端").foregroundStyle(.secondary)
                }
            }
            if let image = state.pairingImage, let expires = state.pairingExpires {
                GroupBox("配对新设备") { PairingView(image: image, expires: expires).padding(8) }
            }
            GroupBox("手机控制") {
                VStack(alignment: .leading, spacing: 8) {
                    ServiceSummary(state: state.orbit)
                    PermissionRow(title: "辅助功能（媒体键）", status: state.accessibility ? "已授权" : "未授权",
                                  granted: state.accessibility, action: model.requestAccessibility)
                    PermissionRow(title: "蓝牙（开关蓝牙）", status: state.bluetooth,
                                  granted: state.bluetooth == "已授权", action: model.requestBluetooth)
                    PermissionRow(title: "自动化（深色模式）", status: state.automation,
                                  granted: state.automation == "已授权", action: model.requestAutomation)
                    HStack {
                        Button(state.orbit.paused ? "恢复远程控制" : "暂停远程控制", action: model.toggleOrbit)
                        Spacer()
                        Button("打开控制面板", action: model.openPanel)
                            .disabled(!state.orbitConfigured)
                    }
                }
                .padding(6)
            }
            GroupBox("手机终端") {
                VStack(alignment: .leading, spacing: 8) {
                    ServiceSummary(state: state.terminal)
                    Text("\(state.sessions) 个会话 · \(state.phones) 个手机连接 · \(state.devices) 个已配对的通行密钥")
                    PermissionRow(title: "完全磁盘访问",
                                  status: state.fullDiskAccess == nil ? "未检查" : state.fullDiskAccess == true ? "已授权" : "未授权",
                                  granted: state.fullDiskAccess == true, actionTitle: "去授权…",
                                  action: model.openFullDiskAccess)
                    HStack {
                        Button(state.terminal.paused ? "恢复终端" : "暂停终端", action: model.toggleTerminal)
                        Button("重启终端", action: model.restartTerminal)
                            .disabled(!state.canRestartTerminal)
                        Spacer()
                        Button("配对新设备…", action: model.pair)
                            .disabled(!state.canPair)
                            .keyboardShortcut(.defaultAction)
                    }
                }
                .padding(6)
            }
            HStack {
                Toggle("登录时自动启动", isOn: Binding(get: { model.state.loginItem }, set: { model.setLoginItem($0) }))
                Spacer()
                Button("查看日志", action: model.openLogs)
            }
            Text("菜单栏图标里有外接屏的亮度滑块；关掉这个窗口后 MacRemote 仍在菜单栏运行，再次打开 App 会重新显示这里。")
                .font(.footnote)
                .foregroundStyle(.secondary)
                .fixedSize(horizontal: false, vertical: true)
            Text("没有完全磁盘访问时，远程 shell 读桌面、文稿、下载等文件夹会被系统拦下。这项权限在系统设置里记在 RemoteTerm 名下，授权后点「重启终端」才生效。")
                .font(.footnote)
                .foregroundStyle(.secondary)
                .fixedSize(horizontal: false, vertical: true)
        }
        .padding(20)
        .frame(width: 440)
    }
}

// MARK: - App

final class AppDelegate: NSObject, NSApplicationDelegate, NSMenuDelegate, NSWindowDelegate {
    private var statusItem: NSStatusItem!
    private let orbitLine = NSMenuItem(title: "远程控制：正在启动…", action: nil, keyEquivalent: "")
    private let terminalLine = NSMenuItem(title: "终端：正在启动…", action: nil, keyEquivalent: "")
    private let countsLine = NSMenuItem(title: "", action: nil, keyEquivalent: "")
    private let displaySeparator = NSMenuItem.separator()
    private var brightnessItem: NSMenuItem!
    private var displayPowerItem: NSMenuItem!
    private var pairItem: NSMenuItem!
    private var orbitPauseItem: NSMenuItem!
    private var terminalPauseItem: NSMenuItem!
    private var loginItem: NSMenuItem!
    private let brightnessSlider = NSSlider(value: 50, minValue: 0, maxValue: 100, target: nil, action: nil)
    private let brightnessReadout = NSTextField(labelWithString: "—")
    private let orbit = Service(log: "agent.log", process: OrbitProcess()) {
        FileManager.default.fileExists(atPath: orbitConfig.path)
    }
    // The helper exits 64 on bad arguments and 70 when it cannot start node.
    private let terminal = Service(log: "terminal.log", process: TerminalProcess(), launchFailures: [64, 70]) {
        FileManager.default.fileExists(atPath: terminalConfig.path)
    }
    private var model: StatusModel?
    private var window: NSWindow?
    private var pollTimer: Timer?
    private var bluetoothPrompt: BluetoothPrompt?
    private var quitting = false
    private var shownIcon = ""
    private var shownSummary = ""

    // Read at the refresh points only: menu open, window open, the window's tick, after a change.
    private var loginEnabled = false
    private var orbitRelay: String?
    private var terminalRelay: String?
    private var accessibility = false
    private var bluetooth = "未询问"
    private var automation = "未检查"

    // What the terminal agent last reported.
    private var sessions = 0
    private var phones = 0
    private var devices = 0
    private var fullDiskAccess: Bool?
    private var pairingURL: String?
    private var pairingImage: NSImage?
    private var pairingExpires: Date?
    private var pairingExpiry: DispatchWorkItem?

    // The external display, through the Orbit agent.
    private var screenId: String?
    private var displayAsleep = false
    private var displayRequest: (id: Int, wasAsleep: Bool)?
    private var pendingBrightness: Int?
    private var brightnessTimer: Timer?
    private var lastBrightnessSend = Date.distantPast
    private var wakeTimer: Timer?
    private var sawQuiet = false

    func applicationDidFinishLaunching(_ notification: Notification) {
        // One MacRemote at a time: a second launch (another copy, or a double click while it is
        // running) asks the running one to show its window and quits.
        let me = ProcessInfo.processInfo.processIdentifier
        let others = NSRunningApplication.runningApplications(withBundleIdentifier: Bundle.main.bundleIdentifier ?? "")
            .filter { $0.processIdentifier != me }
        if !others.isEmpty {
            DistributedNotificationCenter.default().postNotificationName(
                showWindowNotification, object: nil, userInfo: nil, deliverImmediately: true)
            NSApp.terminate(nil)
            return
        }
        _ = DistributedNotificationCenter.default().addObserver(
            forName: showWindowNotification, object: nil, queue: .main) { [weak self] _ in self?.showWindow() }

        // Writing to an agent's pipe after it died must not take this app down with it.
        signal(SIGPIPE, SIG_IGN)

        let manualLaunch = !launchedAsLoginItem()
        buildMenu()
        orbit.onEvent = { [weak self] event in self?.handleOrbit(event) }
        orbit.onExit = { [weak self] in self?.orbitExited() }
        orbit.onChange = { [weak self] in self?.render() }
        terminal.onEvent = { [weak self] event in self?.handleTerminal(event) }
        terminal.onExit = { [weak self] in self?.terminalExited() }
        terminal.onChange = { [weak self] in self?.render() }
        refreshCaches(permissions: false)
        orbit.start()
        terminal.start()
        if manualLaunch { showWindow() }
    }

    func applicationShouldHandleReopen(_ sender: NSApplication, hasVisibleWindows flag: Bool) -> Bool {
        showWindow()
        return true
    }

    func applicationWillTerminate(_ notification: Notification) {
        orbit.quit()
        terminal.quit()
    }

    func menuWillOpen(_ menu: NSMenu) {
        refreshCaches(permissions: false)
        askScreens()
        askTerminal("status")
        render()
    }

    // Nothing of the window stays behind once it is closed; the next showWindow builds it again.
    func windowWillClose(_ notification: Notification) {
        stopPolling()
        window?.delegate = nil
        window = nil
        model = nil
    }

    // Polling runs only while the window can actually be seen.
    func windowDidChangeOcclusionState(_ notification: Notification) {
        guard let window else { return }
        if !window.occlusionState.contains(.visible) {
            stopPolling()
        } else if pollTimer == nil {
            tick()
            startPolling()
        }
    }

    // MARK: setup

    private func wire(_ model: StatusModel) {
        model.openPanel = { [weak self] in self?.openPanel() }
        model.toggleOrbit = { [weak self] in self?.toggleOrbitPause() }
        model.toggleTerminal = { [weak self] in self?.toggleTerminalPause() }
        model.restartTerminal = { [weak self] in self?.restartTerminal() }
        model.pair = { [weak self] in self?.pair() }
        model.setLoginItem = { [weak self] enabled in self?.setLoginItem(enabled) }
        model.requestAccessibility = { [weak self] in self?.requestAccessibility() }
        model.requestBluetooth = { [weak self] in self?.requestBluetooth() }
        model.requestAutomation = { [weak self] in self?.requestAutomation() }
        model.openFullDiskAccess = { [weak self] in self?.openPrivacyPane("Privacy_AllFiles") }
        model.openLogs = { [weak self] in self?.openLogs() }
    }

    private func buildMenu() {
        statusItem = NSStatusBar.system.statusItem(withLength: NSStatusItem.squareLength)
        let menu = NSMenu()
        menu.delegate = self
        // Enabled states are set by render(): 配对新设备… only works while the terminal is connected.
        menu.autoenablesItems = false
        for line in [orbitLine, terminalLine, countsLine] { line.isEnabled = false }
        brightnessItem = makeBrightnessItem()
        displayPowerItem = item("关闭显示器", #selector(toggleDisplayPower))
        pairItem = item("配对新设备…", #selector(pair))
        orbitPauseItem = item("暂停远程控制", #selector(toggleOrbitPause))
        terminalPauseItem = item("暂停终端", #selector(toggleTerminalPause))
        loginItem = item("登录时自动启动", #selector(toggleLoginItem))
        menu.addItem(orbitLine)
        menu.addItem(terminalLine)
        menu.addItem(countsLine)
        menu.addItem(displaySeparator)
        menu.addItem(brightnessItem)
        menu.addItem(displayPowerItem)
        menu.addItem(.separator())
        menu.addItem(item("显示状态窗口…", #selector(showWindow)))
        menu.addItem(item("打开控制面板", #selector(openPanel)))
        menu.addItem(pairItem)
        menu.addItem(orbitPauseItem)
        menu.addItem(terminalPauseItem)
        menu.addItem(.separator())
        menu.addItem(item("授权辅助功能（媒体键）…", #selector(requestAccessibility)))
        menu.addItem(loginItem)
        menu.addItem(item("查看日志", #selector(openLogs)))
        menu.addItem(.separator())
        menu.addItem(item("退出 MacRemote", #selector(quit), key: "q"))
        statusItem.menu = menu
        showDisplayControls(false)
    }

    private func item(_ title: String, _ action: Selector, key: String = "") -> NSMenuItem {
        let item = NSMenuItem(title: title, action: action, keyEquivalent: key)
        item.target = self
        return item
    }

    // A slider lives in the menu as a custom view, so dragging it keeps the menu open.
    private func makeBrightnessItem() -> NSMenuItem {
        let label = NSTextField(labelWithString: "亮度")
        label.font = .menuFont(ofSize: 13)
        brightnessReadout.font = .monospacedDigitSystemFont(ofSize: 12, weight: .regular)
        brightnessReadout.textColor = .secondaryLabelColor
        brightnessReadout.alignment = .right
        brightnessSlider.isContinuous = true
        brightnessSlider.controlSize = .small
        brightnessSlider.target = self
        brightnessSlider.action = #selector(brightnessChanged(_:))

        let stack = NSStackView(views: [label, brightnessSlider, brightnessReadout])
        stack.orientation = .horizontal
        stack.spacing = 10
        stack.translatesAutoresizingMaskIntoConstraints = false

        let container = NSView(frame: NSRect(x: 0, y: 0, width: 260, height: 32))
        container.addSubview(stack)
        NSLayoutConstraint.activate([
            stack.leadingAnchor.constraint(equalTo: container.leadingAnchor, constant: 14),
            stack.trailingAnchor.constraint(equalTo: container.trailingAnchor, constant: -14),
            stack.centerYAnchor.constraint(equalTo: container.centerYAnchor),
            brightnessReadout.widthAnchor.constraint(equalToConstant: 40),
            brightnessSlider.widthAnchor.constraint(greaterThanOrEqualToConstant: 120),
        ])
        let item = NSMenuItem()
        item.view = container
        return item
    }

    private func launchedAsLoginItem() -> Bool {
        guard let event = NSAppleEventManager.shared().currentAppleEvent,
              event.eventID == AEEventID(kAEOpenApplication) else { return false }
        return event.paramDescriptor(forKeyword: AEKeyword(keyAEPropData))?.enumCodeValue == OSType(keyAELaunchedAsLogInItem)
    }

    // MARK: external display

    private func showDisplayControls(_ visible: Bool) {
        displaySeparator.isHidden = !visible
        brightnessItem.isHidden = !visible
        displayPowerItem.isHidden = !visible
    }

    @discardableResult
    private func askOrbit(_ request: [String: Any]) -> Int {
        let id = orbit.nextRequestID()
        var payload = request
        payload["id"] = id
        orbit.send(payload)
        return id
    }

    private func askScreens() {
        guard orbit.isRunning else { return }
        askOrbit(["cmd": "screens"])
    }

    // The agent answers with the same screen list the phone sees.
    private func applyScreens(_ screens: [[String: Any]]) {
        let screen = screens.first { ($0["kind"] as? String) == "ddc" }
        screenId = screen?["id"] as? String
        showDisplayControls(screenId != nil)
        // While the slider is being dragged, its own value is the newer one.
        guard let brightness = screen?["brightness"] as? Int,
              Date().timeIntervalSince(lastBrightnessSend) > 2, pendingBrightness == nil else { return }
        brightnessSlider.doubleValue = Double(brightness)
        brightnessReadout.stringValue = "\(brightness)%"
    }

    @objc private func brightnessChanged(_ sender: NSSlider) {
        let value = Int(sender.doubleValue.rounded())
        brightnessReadout.stringValue = "\(value)%"
        pendingBrightness = value
        let since = Date().timeIntervalSince(lastBrightnessSend)
        // A DDC write takes 60-160 ms to reach the monitor, and the agent keeps at most one waiting
        // and moves it to the newest value: every 0.1 s keeps the screen about a step behind the drag.
        if since >= 0.1 {
            flushBrightness()
        } else if brightnessTimer == nil {
            brightnessTimer = Timer.scheduledTimer(withTimeInterval: 0.1 - since, repeats: false) { [weak self] _ in
                self?.flushBrightness()
            }
        }
    }

    private func flushBrightness() {
        brightnessTimer?.invalidate()
        brightnessTimer = nil
        guard let screenId, let value = pendingBrightness else { return }
        pendingBrightness = nil
        lastBrightnessSend = Date()
        askOrbit(["action": "display.brightness.set", "params": ["display": screenId, "value": value]])
    }

    // DDC standby: the Mac keeps sending a picture, so the display stays dark until it is woken
    // here, from the phone, or by someone at the Mac. The agent reports each change (watch-input,
    // display); until it does, the item shows what was asked for.
    @objc private func toggleDisplayPower() {
        let wasAsleep = displayAsleep
        displayRequest = (askOrbit(["action": "display.awake.set", "params": ["on": wasAsleep]]), wasAsleep)
        setDisplayAsleep(!wasAsleep)
    }

    private func setDisplayAsleep(_ asleep: Bool) {
        displayAsleep = asleep
        displayPowerItem.title = asleep ? "唤醒显示器" : "关闭显示器"
    }

    // While the monitor is in standby the agent asks this app to watch for someone at the Mac. A
    // key press, a click or a scroll counts; moving the mouse does not, since a twitchy wireless
    // mouse lighting the display back up is what standby is meant to stop. The click that asked
    // for standby counts as input too, so a quiet moment comes first. Same rule as macctl's
    // `display wait-for-input`, which stays the agent's fallback when it runs without this app.
    private func watchForInput(_ on: Bool) {
        wakeTimer?.invalidate()
        wakeTimer = nil
        guard on else { return }
        sawQuiet = false
        let timer = Timer(timeInterval: 0.5, repeats: true) { [weak self] _ in self?.checkForInput() }
        timer.tolerance = 0.1
        // Common modes: the watch keeps running while a menu or an alert is open.
        RunLoop.main.add(timer, forMode: .common)
        wakeTimer = timer
    }

    private func checkForInput() {
        let idle = [CGEventType.keyDown, .leftMouseDown, .rightMouseDown, .scrollWheel]
            .map { CGEventSource.secondsSinceLastEventType(.combinedSessionState, eventType: $0) }
            .min() ?? .greatestFiniteMagnitude
        if idle > 2 { sawQuiet = true }
        guard sawQuiet, idle < 1 else { return }
        watchForInput(false)
        orbit.send(["cmd": "input"])
    }

    // MARK: agents

    // Each agent's events only ever lead to requests to that same agent: nothing Orbit says reaches
    // the terminal's stdin, and the other way round.
    private func handleOrbit(_ event: [String: Any]) {
        switch event["event"] as? String {
        case "status":
            if event["status"] as? String == "connected" { askScreens() }
        case "reply":
            if let screens = event["screens"] as? [[String: Any]] { applyScreens(screens) }
            if let request = displayRequest, event["id"] as? Int == request.id {
                displayRequest = nil
                if event["ok"] as? Bool != true { setDisplayAsleep(request.wasAsleep) } // the DDC write did not go through
            }
        case "watch-input":
            // The agent watches exactly while the monitor is in standby, whoever put it there.
            let on = event["on"] as? Bool == true
            setDisplayAsleep(on)
            watchForInput(on)
        case "display":
            if event["awake"] as? Bool == true { setDisplayAsleep(false) }
        default:
            break
        }
    }

    private func orbitExited() {
        showDisplayControls(false)
        watchForInput(false) // a restarted agent asks again if the monitor is still in standby
        displayRequest = nil
        quitIfStopped()
    }

    // The terminal agent's requests carry string ids, "<cmd>-<n>".
    private func askTerminal(_ command: String) {
        guard terminal.isRunning else { return }
        terminal.send(["id": "\(command)-\(terminal.nextRequestID())", "cmd": command])
    }

    private func handleTerminal(_ event: [String: Any]) {
        switch event["event"] as? String {
        case "status":
            if event["status"] as? String == "connected" { askTerminal("status") }
        case "sessions":
            sessions = event["count"] as? Int ?? sessions
        case "links":
            phones = event["count"] as? Int ?? phones
        case "pairing":
            showPairing(event)
        case "auth":
            // A finished pairing uses up the QR code.
            guard event["method"] as? String == "pair-finish", event["ok"] as? Bool == true else { return }
            clearPairing()
            askTerminal("status")
        case "reply":
            if let url = event["url"] as? String, !url.isEmpty {
                showPairing(event)
            } else if let count = event["sessions"] as? Int {
                sessions = count
                phones = event["links"] as? Int ?? 0
                devices = event["devices"] as? Int ?? 0
                // Only the agent can tell: the grant belongs to RemoteTerm, whose identity it runs under.
                if let granted = event["fullDiskAccess"] as? Bool { fullDiskAccess = granted }
                if event["pairing"] is NSNull { clearPairing() }
            }
        default:
            return
        }
        render()
    }

    private func terminalExited() {
        sessions = 0
        phones = 0
        clearPairing()
        quitIfStopped()
    }

    // The link carries a one-time secret: it lives in memory and in the QR code only, never in a log.
    private func showPairing(_ event: [String: Any]) {
        guard let url = event["url"] as? String, let expiresAt = event["expiresAt"] as? Double else { return }
        let fresh = url != pairingURL
        pairingURL = url
        pairingExpires = Date(timeIntervalSince1970: expiresAt / 1000)
        if fresh { pairingImage = qrImage(url, points: 200) }
        pairingExpiry?.cancel()
        let expiry = DispatchWorkItem { [weak self] in
            self?.clearPairing()
            self?.render()
        }
        pairingExpiry = expiry
        DispatchQueue.main.asyncAfter(deadline: .now() + max(1, expiresAt / 1000 - Date().timeIntervalSince1970), execute: expiry)
        if fresh { showWindow() }
    }

    private func clearPairing() {
        pairingExpiry?.cancel()
        pairingExpiry = nil
        pairingURL = nil
        pairingImage = nil
        pairingExpires = nil
    }

    // MARK: rendering

    private func describeOrbit() -> (symbol: String, text: String) {
        if orbit.paused { return ("pause.circle", "已暂停，手机暂时无法控制这台 Mac") }
        switch orbit.link {
        case "connected": return ("dot.radiowaves.left.and.right", "已连接，可以用手机控制")
        case "starting", "connecting", "restarting": return ("ellipsis.circle", "正在连接中转服务器…")
        case "unconfigured": return ("exclamationmark.triangle", "还没有配对")
        case "failed": return ("exclamationmark.triangle", "无法启动 agent，请检查 node 路径")
        default: return ("antenna.radiowaves.left.and.right.slash", "未连接，正在重试…")
        }
    }

    private func describeTerminal() -> (symbol: String, text: String) {
        if terminal.paused { return ("pause.circle", "已暂停，手机暂时连不上终端") }
        switch terminal.link {
        case "connected": return ("terminal", "已连接，可以在手机上使用")
        case "starting", "connecting", "restarting": return ("ellipsis.circle", "正在连接中转服务器…")
        case "unconfigured": return ("exclamationmark.triangle", "还没有连接中转服务器")
        case "failed": return ("exclamationmark.triangle", "无法启动，请检查 node 路径")
        case "unsafe": return ("exclamationmark.triangle", "为安全起见没有启动（权限隔离失败）")
        default: return ("wifi.exclamationmark", "未连接，正在重试…")
        }
    }

    // The icon shows the worse of the two services that are not paused: a problem, then a link
    // being set up, then connected. With both paused it shows the pause sign.
    private func overallIcon() -> String {
        let links = [orbit, terminal].filter { !$0.paused }.map(\.link)
        let settingUp: Set<String> = ["starting", "connecting", "restarting"]
        if links.isEmpty { return "pause.circle" }
        if links.contains(where: { $0 != "connected" && !settingUp.contains($0) }) { return "exclamationmark.triangle" }
        if links.contains(where: { settingUp.contains($0) }) { return "ellipsis.circle" }
        return "dot.radiowaves.left.and.right"
    }

    private func render() {
        let orbitStatus = describeOrbit()
        let terminalStatus = describeTerminal()
        let icon = overallIcon()
        let summary = "远程控制：\(orbitStatus.text)\n终端：\(terminalStatus.text)"
        if icon != shownIcon || summary != shownSummary {
            let image = NSImage(systemSymbolName: icon, accessibilityDescription: summary)
            image?.isTemplate = true
            statusItem.button?.image = image
            statusItem.button?.toolTip = summary
            shownIcon = icon
            shownSummary = summary
        }
        let terminalUp = terminal.link == "connected" && !terminal.paused
        retitle(orbitLine, "远程控制：\(orbitStatus.text)")
        retitle(terminalLine, "终端：\(terminalStatus.text)")
        retitle(countsLine, "\(sessions) 个会话 · \(phones) 个手机连接")
        countsLine.isHidden = !terminalUp
        pairItem.isEnabled = terminalUp
        retitle(orbitPauseItem, orbit.paused ? "恢复远程控制" : "暂停远程控制")
        retitle(terminalPauseItem, terminal.paused ? "恢复终端" : "暂停终端")
        loginItem.state = loginEnabled ? .on : .off

        guard let model else { return }
        let orbitDetail = orbit.link == "unconfigured"
            ? "在 mac-remote 项目目录运行 node agent/setup.js wss://<中转域名>/agent 完成配对，然后重新打开 MacRemote。"
            : "中转服务器：\(orbitRelay ?? "?")"
        let terminalDetail: String
        switch terminal.link {
        case "unconfigured":
            terminalDetail = "在 remote-term 项目目录运行 node agent/setup.js wss://<中转域名>/agent，把打印的哈希填进服务器的 .env，然后重新打开 MacRemote。"
        case "unsafe":
            terminalDetail = "终端要以独立的 RemoteTerm 身份运行，远程 shell 才拿不到 MacRemote 的辅助功能、蓝牙和自动化权限。系统这次没有确认这一点，所以终端没有启动；点「重启终端」可以再试。"
        case "failed":
            terminalDetail = "检查 ~/Library/Application Support/MacRemote/launcher.json 里的 node 路径，或重新运行 launcher/build.sh。"
        default:
            terminalDetail = "中转服务器：\(terminalRelay ?? "?")。暂停终端或退出 MacRemote 会结束所有会话。"
        }
        let state = WindowState(
            symbol: icon,
            orbit: ServiceState(symbol: orbitStatus.symbol, text: orbitStatus.text, detail: orbitDetail, paused: orbit.paused),
            terminal: ServiceState(symbol: terminalStatus.symbol, text: terminalStatus.text, detail: terminalDetail,
                                   paused: terminal.paused),
            orbitConfigured: orbit.link != "unconfigured",
            accessibility: accessibility,
            bluetooth: bluetooth,
            automation: automation,
            loginItem: loginEnabled,
            sessions: sessions,
            phones: phones,
            devices: devices,
            fullDiskAccess: fullDiskAccess,
            canPair: terminalUp,
            canRestartTerminal: !terminal.paused && terminal.link != "unconfigured",
            pairingImage: pairingImage,
            pairingExpires: pairingExpires)
        if model.state != state { model.state = state }
    }

    private func retitle(_ item: NSMenuItem, _ title: String) {
        if item.title != title { item.title = title }
    }

    // MARK: cached state and permissions

    // Login-item state, permissions and both agent.json files are read here and cached, never on
    // every render.
    private func refreshCaches(permissions: Bool) {
        loginEnabled = SMAppService.mainApp.status == .enabled
        orbitRelay = relayHost(orbitConfig)
        terminalRelay = relayHost(terminalConfig)
        if permissions {
            accessibility = AXIsProcessTrusted()
            bluetooth = bluetoothStatus()
            automation = automationStatus()
        }
        // A service set up while the app was already running starts now, e.g. when the app is
        // opened again after setup.js.
        for service in [orbit, terminal] where service.link == "unconfigured" { service.start() }
    }

    private func bluetoothStatus() -> String {
        switch CBManager.authorization {
        case .allowedAlways: return "已授权"
        case .denied: return "已拒绝"
        case .restricted: return "受限制"
        case .notDetermined: return "未询问"
        @unknown default: return "未知"
        }
    }

    // Reports the current Automation grant for System Events without prompting.
    private func automationStatus() -> String {
        let target = NSAppleEventDescriptor(bundleIdentifier: "com.apple.systemevents")
        let status = Int(AEDeterminePermissionToAutomateTarget(
            target.aeDesc, AEEventClass(typeWildCard), AEEventID(typeWildCard), false))
        if status == Int(noErr) { return "已授权" }
        if status == Int(errAEEventNotPermitted) { return "已拒绝" }
        if status == Int(errAEEventWouldRequireUserConsent) { return "未询问" }
        return "未检查" // System Events is not running yet
    }

    private func refreshPermissions() {
        refreshCaches(permissions: true)
        render()
    }

    private func openPrivacyPane(_ anchor: String) {
        if let url = URL(string: "x-apple.systempreferences:com.apple.preference.security?\(anchor)") {
            NSWorkspace.shared.open(url)
        }
    }

    @objc private func requestAccessibility() {
        let options = ["AXTrustedCheckOptionPrompt": true] as CFDictionary
        if !AXIsProcessTrustedWithOptions(options) { openPrivacyPane("Privacy_Accessibility") }
        refreshPermissions()
    }

    private func requestBluetooth() {
        if CBManager.authorization == .notDetermined {
            bluetoothPrompt = BluetoothPrompt { [weak self] in
                self?.bluetoothPrompt = nil
                self?.refreshPermissions()
            }
        } else {
            openPrivacyPane("Privacy_Bluetooth")
        }
    }

    // Asking System Events once from our own child process shows the Automation prompt; the grant
    // then covers the Orbit agent's osascript calls too, since both run under this app.
    private func requestAutomation() {
        let probe = Process()
        probe.executableURL = URL(fileURLWithPath: "/usr/bin/osascript")
        probe.arguments = ["-e", "tell application \"System Events\" to get dark mode of appearance preferences"]
        probe.standardOutput = FileHandle.nullDevice
        probe.standardError = FileHandle.nullDevice
        probe.terminationHandler = { [weak self] finished in
            DispatchQueue.main.async {
                if finished.terminationStatus != 0 { self?.openPrivacyPane("Privacy_Automation") }
                self?.refreshPermissions()
            }
        }
        try? probe.run()
    }

    // MARK: window

    @objc private func showWindow() {
        let fresh = window == nil
        if fresh {
            let model = StatusModel()
            wire(model)
            self.model = model
        }
        refreshCaches(permissions: true)
        render() // a new window is sized from this state
        if fresh, let model {
            let window = NSWindow(contentViewController: NSHostingController(rootView: StatusView(model: model)))
            window.title = "MacRemote"
            window.styleMask = [.titled, .closable]
            window.isReleasedWhenClosed = false
            window.delegate = self
            window.center()
            self.window = window
        }
        askTerminal("status")
        startPolling()
        activate()
        window?.makeKeyAndOrderFront(nil)
    }

    // While the window is up: the terminal's counts and Full Disk Access, the permission checklist
    // and the login item, every 3 s.
    private func startPolling() {
        pollTimer?.invalidate()
        pollTimer = Timer.scheduledTimer(withTimeInterval: 3, repeats: true) { [weak self] _ in self?.tick() }
        pollTimer?.tolerance = 0.5
    }

    private func stopPolling() {
        pollTimer?.invalidate()
        pollTimer = nil
    }

    private func tick() {
        refreshCaches(permissions: true)
        askTerminal("status")
        render()
    }

    private func activate() {
        if #available(macOS 14.0, *) {
            NSApp.activate()
        } else {
            NSApp.activate(ignoringOtherApps: true)
        }
    }

    // MARK: actions

    @objc private func openPanel() {
        guard let relay = readJSON(orbitConfig)?["relayUrl"] as? String,
              var components = URLComponents(string: relay) else { return }
        components.scheme = components.scheme == "wss" ? "https" : "http"
        components.path = "/"
        if let url = components.url { NSWorkspace.shared.open(url) }
    }

    @objc private func pair() {
        guard terminal.link == "connected", !terminal.paused else { return }
        askTerminal("pair")
    }

    @objc private func toggleOrbitPause() {
        orbit.setPaused(!orbit.paused)
    }

    @objc private func toggleTerminalPause() {
        if !terminal.paused {
            if !confirmEndingSessions("暂停") { return }
            clearPairing()
        }
        terminal.setPaused(!terminal.paused)
    }

    private func restartTerminal() {
        if !confirmEndingSessions("重启") { return }
        terminal.restart()
    }

    // Sessions live in the terminal agent: stopping it ends them. Ask first when any are running.
    private func confirmEndingSessions(_ action: String) -> Bool {
        guard sessions > 0 else { return true }
        let alert = NSAlert()
        alert.messageText = "\(action)会结束 \(sessions) 个会话"
        alert.informativeText = "会话里正在运行的程序会收到挂断信号并退出。"
        alert.addButton(withTitle: action)
        alert.addButton(withTitle: "取消")
        alert.alertStyle = .warning
        activate()
        return alert.runModal() == .alertFirstButtonReturn
    }

    @objc private func toggleLoginItem() {
        setLoginItem(!loginEnabled)
    }

    private func setLoginItem(_ enabled: Bool) {
        do {
            if enabled {
                try SMAppService.mainApp.register()
            } else {
                try SMAppService.mainApp.unregister()
            }
        } catch {
            NSAlert(error: error).runModal()
        }
        loginEnabled = SMAppService.mainApp.status == .enabled
        render()
    }

    @objc private func openLogs() {
        try? FileManager.default.createDirectory(at: logDir, withIntermediateDirectories: true)
        NSWorkspace.shared.open(logDir)
    }

    @objc private func quit() {
        if !confirmEndingSessions("退出") { return }
        quitting = true
        watchForInput(false)
        orbit.quit()
        terminal.quit()
        // Both agents flush and exit on SIGTERM. Quit once they are gone, or after 0.8 s at most;
        // an agent still busy then reads EOF on its stdin and finishes on its own.
        DispatchQueue.main.asyncAfter(deadline: .now() + 0.8) { NSApp.terminate(nil) }
        quitIfStopped()
    }

    private func quitIfStopped() {
        if quitting, !orbit.isRunning, !terminal.isRunning { NSApp.terminate(nil) }
    }
}

let app = NSApplication.shared
let delegate = AppDelegate()
app.delegate = delegate
app.setActivationPolicy(.accessory)
app.run()
