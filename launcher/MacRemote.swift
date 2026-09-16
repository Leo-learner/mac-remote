// MacRemote — menu bar shell for the mac-remote agent.
//
// macOS attributes privacy permissions (Bluetooth, Automation, Accessibility) to the app that
// launched a process. Running the Node agent as our child gives every command it spawns one
// stable identity: this signed bundle. The menu shows the relay link, carries the local controls
// for the external display, and is the local kill switch.
// Opening the app (or opening it again) shows a status window with the permission checklist.
//
// Build + install: bash launcher/build.sh
import AppKit
import ApplicationServices
import CoreBluetooth
import ServiceManagement
import SwiftUI

let home = FileManager.default.homeDirectoryForCurrentUser
let supportDir = home.appendingPathComponent("Library/Application Support/MacRemote")
let logDir = home.appendingPathComponent("Library/Logs/MacRemote")
let showWindowNotification = Notification.Name("dev.mac-remote.launcher.show-window")

func readJSON(_ url: URL) -> [String: Any]? {
    guard let data = try? Data(contentsOf: url) else { return nil }
    return (try? JSONSerialization.jsonObject(with: data)) as? [String: Any]
}

// MARK: - Agent child process

final class Agent {
    var onEvent: ([String: Any]) -> Void = { _ in }
    var onExit: (Int32) -> Void = { _ in }
    private var process: Process?
    private var lifeline: Pipe?
    private var pending = Data()
    private var log: FileHandle?

    var isRunning: Bool { process?.isRunning ?? false }

    func start(node: String, script: String) throws {
        let process = Process()
        process.executableURL = URL(fileURLWithPath: node)
        process.arguments = [script]
        var environment = ProcessInfo.processInfo.environment
        environment["PATH"] = "/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin"
        environment["MAC_REMOTE_PARENT_PIPE"] = "1"
        process.environment = environment

        // We hold the write end of the child's stdin for as long as we live. When this app exits,
        // even by SIGKILL, the child reads EOF and stops instead of lingering as an orphan.
        let lifeline = Pipe()
        process.standardInput = lifeline
        self.lifeline = lifeline

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

    // The menu bar's own controls travel down the same pipe that keeps the agent alive. The agent
    // runs them through its allow-list, exactly like a request from the phone.
    func send(_ request: [String: Any]) {
        guard isRunning, let lifeline, let data = try? JSONSerialization.data(withJSONObject: request) else { return }
        try? lifeline.fileHandleForWriting.write(contentsOf: data + Data("\n".utf8))
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

// MARK: - Status window

final class StatusModel: ObservableObject {
    @Published var symbol = "ellipsis.circle"
    @Published var headline = "正在启动…"
    @Published var detail = ""
    @Published var paused = false
    @Published var configured = false
    @Published var loginItem = false
    @Published var accessibility = false
    @Published var bluetooth = "未询问"
    @Published var automation = "未检查"

    var openPanel: () -> Void = {}
    var togglePause: () -> Void = {}
    var setLoginItem: (Bool) -> Void = { _ in }
    var requestAccessibility: () -> Void = {}
    var requestBluetooth: () -> Void = {}
    var requestAutomation: () -> Void = {}
    var openLogs: () -> Void = {}
}

struct PermissionRow: View {
    let title: String
    let status: String
    let granted: Bool
    let action: () -> Void

    var body: some View {
        HStack(spacing: 8) {
            Image(systemName: granted ? "checkmark.circle.fill" : "circle.dashed")
                .foregroundStyle(granted ? Color.green : Color.secondary)
            Text(title)
            Spacer()
            Text(status).foregroundStyle(.secondary)
            if !granted {
                Button("授权…", action: action).controlSize(.small)
            }
        }
    }
}

struct StatusView: View {
    @ObservedObject var model: StatusModel

    var body: some View {
        VStack(alignment: .leading, spacing: 14) {
            HStack(spacing: 12) {
                Image(systemName: model.symbol)
                    .font(.system(size: 26, weight: .medium))
                    .foregroundStyle(Color.orange)
                    .frame(width: 36)
                VStack(alignment: .leading, spacing: 2) {
                    Text("MacRemote").font(.headline)
                    Text(model.headline).foregroundStyle(.secondary)
                }
            }
            if !model.detail.isEmpty {
                Text(model.detail)
                    .font(.callout)
                    .foregroundStyle(.secondary)
                    .fixedSize(horizontal: false, vertical: true)
                    .textSelection(.enabled)
            }
            GroupBox("系统权限") {
                VStack(alignment: .leading, spacing: 8) {
                    PermissionRow(title: "辅助功能（媒体键）", status: model.accessibility ? "已授权" : "未授权",
                                  granted: model.accessibility, action: model.requestAccessibility)
                    PermissionRow(title: "蓝牙（开关蓝牙）", status: model.bluetooth,
                                  granted: model.bluetooth == "已授权", action: model.requestBluetooth)
                    PermissionRow(title: "自动化（深色模式）", status: model.automation,
                                  granted: model.automation == "已授权", action: model.requestAutomation)
                }
                .padding(6)
            }
            Toggle("登录时自动启动", isOn: Binding(get: { model.loginItem }, set: { model.setLoginItem($0) }))
            HStack {
                Button(model.paused ? "恢复远程控制" : "暂停远程控制", action: model.togglePause)
                Spacer()
                Button("查看日志", action: model.openLogs)
                Button("打开控制面板", action: model.openPanel)
                    .disabled(!model.configured)
                    .keyboardShortcut(.defaultAction)
            }
            Text("菜单栏图标里有外接屏的亮度滑块；关掉这个窗口后 MacRemote 仍在菜单栏运行，再次打开 App 会重新显示这里。")
                .font(.footnote)
                .foregroundStyle(.secondary)
        }
        .padding(20)
        .frame(width: 440)
    }
}

// MARK: - App

final class AppDelegate: NSObject, NSApplicationDelegate, NSMenuDelegate, NSWindowDelegate {
    private var statusItem: NSStatusItem!
    private let statusLine = NSMenuItem(title: "正在启动…", action: nil, keyEquivalent: "")
    private var pauseItem: NSMenuItem!
    private var loginItem: NSMenuItem!
    private var displayPowerItem: NSMenuItem!
    private var brightnessItem: NSMenuItem!
    private let brightnessSlider = NSSlider(value: 50, minValue: 0, maxValue: 100, target: nil, action: nil)
    private let brightnessReadout = NSTextField(labelWithString: "—")
    private let agent = Agent()
    private let model = StatusModel()
    private var window: NSWindow?
    private var permissionTimer: Timer?
    private var bluetoothProbe: CBCentralManager?
    private var paused = false
    private var link = "starting"
    private var restartDelay: TimeInterval = 1
    private var startedAt = Date()
    private var requestCounter = 0
    private var screenId: String?
    private var screenName = ""
    private var displayAsleep = false
    private var pendingBrightness: Int?
    private var brightnessTimer: Timer?
    private var lastBrightnessSend = Date.distantPast

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

        // Writing to the agent's pipe after it died must not take this app down with it.
        signal(SIGPIPE, SIG_IGN)

        wireModel()
        buildMenu()
        agent.onEvent = { [weak self] event in self?.handle(event) }
        agent.onExit = { [weak self] _ in self?.agentExited() }
        startAgent()
        if !launchedAsLoginItem() { showWindow() }
    }

    func applicationShouldHandleReopen(_ sender: NSApplication, hasVisibleWindows flag: Bool) -> Bool {
        showWindow()
        return true
    }

    func applicationWillTerminate(_ notification: Notification) {
        paused = true
        agent.stop()
    }

    func menuWillOpen(_ menu: NSMenu) {
        render()
        askScreens()
    }

    func windowWillClose(_ notification: Notification) {
        permissionTimer?.invalidate()
        permissionTimer = nil
    }

    // MARK: setup

    private func wireModel() {
        model.openPanel = { [weak self] in self?.openPanel() }
        model.togglePause = { [weak self] in self?.togglePause() }
        model.setLoginItem = { [weak self] enabled in self?.setLoginItem(enabled) }
        model.requestAccessibility = { [weak self] in self?.requestAccessibility() }
        model.requestBluetooth = { [weak self] in self?.requestBluetooth() }
        model.requestAutomation = { [weak self] in self?.requestAutomation() }
        model.openLogs = { [weak self] in self?.openLogs() }
    }

    private func buildMenu() {
        statusItem = NSStatusBar.system.statusItem(withLength: NSStatusItem.squareLength)
        let menu = NSMenu()
        menu.delegate = self
        statusLine.isEnabled = false
        pauseItem = item("暂停远程控制", #selector(togglePause))
        loginItem = item("登录时自动启动", #selector(toggleLoginItem))
        displayPowerItem = item("关闭显示器", #selector(toggleDisplayPower))
        brightnessItem = makeBrightnessItem()
        menu.addItem(statusLine)
        menu.addItem(.separator())
        menu.addItem(brightnessItem)
        menu.addItem(displayPowerItem)
        menu.addItem(.separator())
        menu.addItem(item("显示状态窗口…", #selector(showWindow)))
        menu.addItem(item("打开控制面板", #selector(openPanel)))
        menu.addItem(pauseItem)
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
        brightnessItem.isHidden = !visible
        displayPowerItem.isHidden = !visible
    }

    private func ask(_ request: [String: Any]) {
        requestCounter += 1
        var payload = request
        payload["id"] = requestCounter
        agent.send(payload)
    }

    private func askScreens() {
        guard agent.isRunning else { return }
        ask(["cmd": "screens"])
    }

    // The agent answers with the same screen list the phone sees.
    private func applyScreens(_ screens: [[String: Any]]) {
        let screen = screens.first { ($0["kind"] as? String) == "ddc" }
        screenId = screen?["id"] as? String
        screenName = screen?["name"] as? String ?? ""
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
        // DDC writes are queued 400 ms apart in the agent; sending faster than that only piles up.
        if since >= 0.2 {
            flushBrightness()
        } else if brightnessTimer == nil {
            brightnessTimer = Timer.scheduledTimer(withTimeInterval: 0.2 - since, repeats: false) { [weak self] _ in
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
        ask(["action": "display.brightness.set", "params": ["display": screenId, "value": value]])
    }

    // DDC standby: the Mac keeps sending a picture, so the display stays dark until it is woken
    // here again. Nothing reports that state back, so the item remembers what it last sent.
    @objc private func toggleDisplayPower() {
        ask(["action": "display.awake.set", "params": ["on": displayAsleep]])
        displayAsleep.toggle()
        displayPowerItem.title = displayAsleep ? "唤醒显示器" : "关闭显示器"
    }

    // MARK: agent lifecycle

    private var configured: Bool {
        FileManager.default.fileExists(atPath: supportDir.appendingPathComponent("agent.json").path)
    }

    private func startAgent() {
        defer { render() }
        guard !paused, !agent.isRunning else { return }
        guard configured else {
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
        showDisplayControls(false)
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
        switch event["event"] as? String {
        case "status":
            guard let status = event["status"] as? String else { return }
            link = status
            if status == "connected" {
                restartDelay = 1
                askScreens()
            }
            render()
        case "reply":
            if let screens = event["screens"] as? [[String: Any]] { applyScreens(screens) }
        default:
            break
        }
    }

    private var relayHost: String? {
        guard let relay = readJSON(supportDir.appendingPathComponent("agent.json"))?["relayUrl"] as? String else { return nil }
        return URLComponents(string: relay)?.host
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
            case "unconfigured": (symbol, text) = ("exclamationmark.triangle", "还没有配对")
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
        let loginEnabled = SMAppService.mainApp.status == .enabled
        loginItem.state = loginEnabled ? .on : .off

        model.symbol = symbol
        model.headline = text
        model.paused = paused
        model.configured = configured
        model.loginItem = loginEnabled
        model.detail = configured
            ? "中转服务器：\(relayHost ?? "?")。菜单栏右上角的图标就是 MacRemote。"
            : "在项目目录运行 node agent/setup.js wss://<中转域名>/agent 完成配对，然后重新打开 MacRemote。"
    }

    // MARK: permissions

    private func refreshPermissions() {
        model.accessibility = AXIsProcessTrusted()
        switch CBManager.authorization {
        case .allowedAlways: model.bluetooth = "已授权"
        case .denied: model.bluetooth = "已拒绝"
        case .restricted: model.bluetooth = "受限制"
        case .notDetermined: model.bluetooth = "未询问"
        @unknown default: model.bluetooth = "未知"
        }
        model.automation = automationStatus()
        model.loginItem = SMAppService.mainApp.status == .enabled
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

    private func openPrivacyPane(_ anchor: String) {
        if let url = URL(string: "x-apple.systempreferences:com.apple.preference.security?\(anchor)") {
            NSWorkspace.shared.open(url)
        }
    }

    @objc private func requestAccessibility() {
        let options = ["AXTrustedCheckOptionPrompt": true] as CFDictionary
        if !AXIsProcessTrustedWithOptions(options) { openPrivacyPane("Privacy_Accessibility") }
    }

    private func requestBluetooth() {
        if CBManager.authorization == .notDetermined {
            bluetoothProbe = CBCentralManager(delegate: nil, queue: nil) // creating a manager shows the prompt
        } else {
            openPrivacyPane("Privacy_Bluetooth")
        }
    }

    // Asking System Events once from our own child process shows the Automation prompt; the grant
    // then covers the agent's osascript calls too, since both run under this app.
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

    // MARK: window and menu actions

    @objc private func showWindow() {
        if window == nil {
            let window = NSWindow(contentViewController: NSHostingController(rootView: StatusView(model: model)))
            window.title = "MacRemote"
            window.styleMask = [.titled, .closable]
            window.isReleasedWhenClosed = false
            window.delegate = self
            self.window = window
        }
        render()
        refreshPermissions()
        permissionTimer?.invalidate()
        permissionTimer = Timer.scheduledTimer(withTimeInterval: 2, repeats: true) { [weak self] _ in
            self?.refreshPermissions()
        }
        window?.center()
        if #available(macOS 14.0, *) {
            NSApp.activate()
        } else {
            NSApp.activate(ignoringOtherApps: true)
        }
        window?.makeKeyAndOrderFront(nil)
    }

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

    @objc private func toggleLoginItem() {
        setLoginItem(SMAppService.mainApp.status != .enabled)
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
