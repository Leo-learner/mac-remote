// MacRemote — menu bar shell for the mac-remote agent.
//
// macOS attributes privacy permissions (Bluetooth, Automation, Accessibility) to the app that
// launched a process. Running the Node agent as our child gives every command it spawns one
// stable identity: this signed bundle. The menu shows the relay link and is the local kill switch.
//
// Build + install: bash launcher/build.sh
import AppKit
import ApplicationServices
import ServiceManagement

let home = FileManager.default.homeDirectoryForCurrentUser
let supportDir = home.appendingPathComponent("Library/Application Support/MacRemote")
let logDir = home.appendingPathComponent("Library/Logs/MacRemote")

func readJSON(_ url: URL) -> [String: Any]? {
    guard let data = try? Data(contentsOf: url) else { return nil }
    return (try? JSONSerialization.jsonObject(with: data)) as? [String: Any]
}

// MARK: - Agent child process

final class Agent {
    var onEvent: ([String: Any]) -> Void = { _ in }
    var onExit: (Int32) -> Void = { _ in }
    private var process: Process?
    private var pending = Data()
    private var log: FileHandle?

    var isRunning: Bool { process?.isRunning ?? false }

    func start(node: String, script: String) throws {
        let process = Process()
        process.executableURL = URL(fileURLWithPath: node)
        process.arguments = [script]
        var environment = ProcessInfo.processInfo.environment
        environment["PATH"] = "/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin"
        process.environment = environment

        let pipe = Pipe()
        process.standardOutput = pipe
        process.standardError = pipe
        log = openLog()
        pipe.fileHandleForReading.readabilityHandler = { [weak self] handle in
            let data = handle.availableData
            guard !data.isEmpty else { return }
            DispatchQueue.main.async { self?.consume(data) }
        }
        process.terminationHandler = { [weak self] finished in
            pipe.fileHandleForReading.readabilityHandler = nil
            DispatchQueue.main.async { self?.onExit(finished.terminationStatus) }
        }
        try process.run()
        self.process = process
    }

    // SIGTERM: the agent closes its relay socket and exits.
    func stop() {
        guard let process, process.isRunning else { return }
        process.terminate()
    }

    private func openLog() -> FileHandle? {
        try? FileManager.default.createDirectory(at: logDir, withIntermediateDirectories: true)
        let url = logDir.appendingPathComponent("agent.log")
        if let size = (try? FileManager.default.attributesOfItem(atPath: url.path))?[.size] as? Int, size > 5_000_000 {
            try? FileManager.default.removeItem(at: url)
        }
        if !FileManager.default.fileExists(atPath: url.path) {
            FileManager.default.createFile(atPath: url.path, contents: nil)
        }
        let handle = try? FileHandle(forWritingTo: url)
        handle?.seekToEndOfFile()
        return handle
    }

    // The agent writes one JSON object per line on stdout.
    private func consume(_ data: Data) {
        log?.write(data)
        pending.append(data)
        while let newline = pending.firstIndex(of: 0x0A) {
            let line = pending.subdata(in: pending.startIndex..<newline)
            pending.removeSubrange(pending.startIndex...newline)
            if let event = (try? JSONSerialization.jsonObject(with: line)) as? [String: Any] {
                onEvent(event)
            }
        }
    }
}

// MARK: - Menu bar

final class AppDelegate: NSObject, NSApplicationDelegate, NSMenuDelegate {
    private let statusItem = NSStatusBar.system.statusItem(withLength: NSStatusItem.squareLength)
    private let statusLine = NSMenuItem(title: "正在启动…", action: nil, keyEquivalent: "")
    private var pauseItem: NSMenuItem!
    private var loginItem: NSMenuItem!
    private let agent = Agent()
    private var paused = false
    private var link = "starting"
    private var restartDelay: TimeInterval = 1
    private var startedAt = Date()

    func applicationDidFinishLaunching(_ notification: Notification) {
        let menu = NSMenu()
        menu.delegate = self
        statusLine.isEnabled = false
        pauseItem = item("暂停远程控制", #selector(togglePause))
        loginItem = item("登录时自动启动", #selector(toggleLoginItem))
        menu.addItem(statusLine)
        menu.addItem(.separator())
        menu.addItem(item("打开控制面板", #selector(openPanel)))
        menu.addItem(pauseItem)
        menu.addItem(.separator())
        menu.addItem(item("授权辅助功能（媒体键）…", #selector(requestAccessibility)))
        menu.addItem(loginItem)
        menu.addItem(item("查看日志", #selector(openLogs)))
        menu.addItem(.separator())
        menu.addItem(item("退出 MacRemote", #selector(quit), key: "q"))
        statusItem.menu = menu

        agent.onEvent = { [weak self] event in self?.handle(event) }
        agent.onExit = { [weak self] _ in self?.agentExited() }
        startAgent()
    }

    func applicationWillTerminate(_ notification: Notification) {
        paused = true
        agent.stop()
    }

    func menuWillOpen(_ menu: NSMenu) {
        render()
    }

    private func item(_ title: String, _ action: Selector, key: String = "") -> NSMenuItem {
        let item = NSMenuItem(title: title, action: action, keyEquivalent: key)
        item.target = self
        return item
    }

    // MARK: agent lifecycle

    private func startAgent() {
        defer { render() }
        guard !paused, !agent.isRunning else { return }
        guard FileManager.default.fileExists(atPath: supportDir.appendingPathComponent("agent.json").path) else {
            link = "unconfigured"
            return
        }
        let node = readJSON(supportDir.appendingPathComponent("launcher.json"))?["node"] as? String ?? "/opt/homebrew/bin/node"
        let script = (Bundle.main.resourcePath ?? "") + "/agent/index.js"
        do {
            startedAt = Date()
            try agent.start(node: node, script: script)
            link = "connecting"
        } catch {
            link = "failed"
            scheduleRestart()
        }
    }

    private func agentExited() {
        guard !paused else {
            link = "paused"
            render()
            return
        }
        if Date().timeIntervalSince(startedAt) > 60 { restartDelay = 1 }
        link = "restarting"
        render()
        scheduleRestart()
    }

    private func scheduleRestart() {
        let delay = restartDelay
        restartDelay = min(restartDelay * 2, 30)
        DispatchQueue.main.asyncAfter(deadline: .now() + delay) { [weak self] in
            self?.startAgent()
        }
    }

    private func handle(_ event: [String: Any]) {
        guard event["event"] as? String == "status", let status = event["status"] as? String else { return }
        link = status
        if status == "connected" { restartDelay = 1 }
        render()
    }

    private func render() {
        let symbol: String
        let text: String
        if paused {
            (symbol, text) = ("pause.circle", "已暂停：手机暂时无法控制这台 Mac")
        } else {
            switch link {
            case "connected": (symbol, text) = ("dot.radiowaves.left.and.right", "已连接，可以用手机控制")
            case "starting", "connecting", "restarting": (symbol, text) = ("ellipsis.circle", "正在连接中转服务器…")
            case "unconfigured": (symbol, text) = ("exclamationmark.triangle", "未配对：先运行 node agent/setup.js")
            case "failed": (symbol, text) = ("exclamationmark.triangle", "无法启动 agent，请检查 node 路径")
            default: (symbol, text) = ("antenna.radiowaves.left.and.right.slash", "未连接，正在重试…")
            }
        }
        let image = NSImage(systemSymbolName: symbol, accessibilityDescription: text)
        image?.isTemplate = true
        statusItem.button?.image = image
        statusItem.button?.toolTip = "MacRemote：\(text)"
        statusLine.title = text
        pauseItem.title = paused ? "恢复远程控制" : "暂停远程控制"
        loginItem.state = SMAppService.mainApp.status == .enabled ? .on : .off
    }

    // MARK: menu actions

    @objc private func openPanel() {
        guard let relay = readJSON(supportDir.appendingPathComponent("agent.json"))?["relayUrl"] as? String,
              var components = URLComponents(string: relay) else { return }
        components.scheme = components.scheme == "wss" ? "https" : "http"
        components.path = "/"
        if let url = components.url { NSWorkspace.shared.open(url) }
    }

    @objc private func togglePause() {
        paused.toggle()
        if paused {
            agent.stop()
            link = "paused"
        } else {
            restartDelay = 1
            startAgent()
        }
        render()
    }

    @objc private func requestAccessibility() {
        let options = ["AXTrustedCheckOptionPrompt": true] as CFDictionary
        if !AXIsProcessTrustedWithOptions(options),
           let url = URL(string: "x-apple.systempreferences:com.apple.preference.security?Privacy_Accessibility") {
            NSWorkspace.shared.open(url)
        }
    }

    @objc private func toggleLoginItem() {
        do {
            if SMAppService.mainApp.status == .enabled {
                try SMAppService.mainApp.unregister()
            } else {
                try SMAppService.mainApp.register()
            }
        } catch {
            NSAlert(error: error).runModal()
        }
        render()
    }

    @objc private func openLogs() {
        try? FileManager.default.createDirectory(at: logDir, withIntermediateDirectories: true)
        NSWorkspace.shared.open(logDir)
    }

    @objc private func quit() {
        paused = true
        agent.stop()
        DispatchQueue.main.asyncAfter(deadline: .now() + 0.5) { NSApp.terminate(nil) }
    }
}

let app = NSApplication.shared
let delegate = AppDelegate()
app.delegate = delegate
app.setActivationPolicy(.accessory)
app.run()
