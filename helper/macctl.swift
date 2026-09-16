// macctl — native helper for mac-remote.
//
// Every subcommand prints exactly one JSON value on stdout. On failure it prints
// {"ok":false,"error":"..."} and exits non-zero. The agent only calls it with
// arguments it has already validated, but each command re-checks its inputs.
//
// Build: helper/build.sh  ->  bin/macctl

import AppKit
import ApplicationServices
import CoreAudio
import Darwin

// MARK: - Output

func write(_ object: Any) {
    let data = (try? JSONSerialization.data(withJSONObject: object))
        ?? Data("{\"ok\":false,\"error\":\"encode-failed\"}".utf8)
    FileHandle.standardOutput.write(data)
    FileHandle.standardOutput.write(Data("\n".utf8))
}

func emit(_ object: Any) -> Never {
    write(object)
    exit(0)
}

func fail(_ message: String) -> Never {
    write(["ok": false, "error": message])
    exit(1)
}

// MARK: - Apps

func runningApps() -> [[String: Any]] {
    let frontPid = NSWorkspace.shared.frontmostApplication?.processIdentifier
    return NSWorkspace.shared.runningApplications
        .filter { $0.activationPolicy == .regular }
        .map { app -> [String: Any] in
            [
                "name": app.localizedName ?? app.bundleIdentifier ?? "?",
                "bundleId": app.bundleIdentifier ?? "",
                "pid": Int(app.processIdentifier),
                "path": app.bundleURL?.path ?? "",
                "active": app.processIdentifier == frontPid,
                "hidden": app.isHidden,
            ]
        }
}

func installedApps() -> [[String: Any]] {
    let fm = FileManager.default
    var seen = Set<String>()
    var result: [[String: Any]] = []

    func add(_ path: String) {
        guard let id = Bundle(path: path)?.bundleIdentifier, !seen.contains(id) else { return }
        seen.insert(id)
        var name = fm.displayName(atPath: path)
        if name.hasSuffix(".app") { name.removeLast(4) }
        result.append(["name": name, "bundleId": id, "path": path])
    }

    // Depth 1 covers Utilities folders and vendor folders like "/Applications/Microsoft Office".
    func scan(_ dir: String, depth: Int) {
        guard let items = try? fm.contentsOfDirectory(atPath: dir) else { return }
        for item in items where !item.hasPrefix(".") {
            let path = (dir as NSString).appendingPathComponent(item)
            if item.hasSuffix(".app") {
                add(path)
            } else if depth > 0 {
                var isDir: ObjCBool = false
                if fm.fileExists(atPath: path, isDirectory: &isDir), isDir.boolValue {
                    scan(path, depth: depth - 1)
                }
            }
        }
    }

    for root in ["/Applications", "/System/Applications", NSHomeDirectory() + "/Applications"] {
        scan(root, depth: 1)
    }
    add("/System/Library/CoreServices/Finder.app")
    return result.sorted {
        ($0["name"] as? String ?? "").localizedStandardCompare($1["name"] as? String ?? "") == .orderedAscending
    }
}

func iconPNG(path: String, size: Int) -> String? {
    var isDir: ObjCBool = false
    guard path.hasSuffix(".app"), (16...512).contains(size),
          FileManager.default.fileExists(atPath: path, isDirectory: &isDir), isDir.boolValue,
          let rep = NSBitmapImageRep(bitmapDataPlanes: nil, pixelsWide: size, pixelsHigh: size,
                                     bitsPerSample: 8, samplesPerPixel: 4, hasAlpha: true, isPlanar: false,
                                     colorSpaceName: .deviceRGB, bytesPerRow: 0, bitsPerPixel: 0)
    else { return nil }
    let icon = NSWorkspace.shared.icon(forFile: path)
    rep.size = NSSize(width: size, height: size)
    NSGraphicsContext.saveGraphicsState()
    NSGraphicsContext.current = NSGraphicsContext(bitmapImageRep: rep)
    icon.draw(in: NSRect(x: 0, y: 0, width: size, height: size), from: .zero, operation: .copy, fraction: 1)
    NSGraphicsContext.restoreGraphicsState()
    return rep.representation(using: .png, properties: [:])?.base64EncodedString()
}

func regularApp(_ pidArg: String) -> NSRunningApplication {
    guard let pid = Int32(pidArg), let app = NSRunningApplication(processIdentifier: pid) else {
        fail("no-such-app")
    }
    guard app.activationPolicy == .regular else { fail("not-a-regular-app") }
    return app
}

// MARK: - Audio (CoreAudio, public API)

func audioAddress(_ selector: AudioObjectPropertySelector,
                  _ scope: AudioObjectPropertyScope = kAudioObjectPropertyScopeGlobal) -> AudioObjectPropertyAddress {
    AudioObjectPropertyAddress(mSelector: selector, mScope: scope, mElement: kAudioObjectPropertyElementMain)
}

func audioUInt32(_ id: AudioObjectID, _ selector: AudioObjectPropertySelector) -> UInt32? {
    var address = audioAddress(selector)
    var value: UInt32 = 0
    var size = UInt32(MemoryLayout<UInt32>.size)
    return AudioObjectGetPropertyData(id, &address, 0, nil, &size, &value) == noErr ? value : nil
}

func audioString(_ id: AudioObjectID, _ selector: AudioObjectPropertySelector) -> String? {
    var address = audioAddress(selector)
    var value: Unmanaged<CFString>?
    var size = UInt32(MemoryLayout<Unmanaged<CFString>?>.size)
    guard AudioObjectGetPropertyData(id, &address, 0, nil, &size, &value) == noErr, let string = value else {
        return nil
    }
    return string.takeRetainedValue() as String
}

func hasOutputStreams(_ id: AudioDeviceID) -> Bool {
    var address = audioAddress(kAudioDevicePropertyStreams, kAudioDevicePropertyScopeOutput)
    var size: UInt32 = 0
    return AudioObjectGetPropertyDataSize(id, &address, 0, nil, &size) == noErr && size > 0
}

func transportName(_ type: UInt32) -> String {
    switch type {
    case kAudioDeviceTransportTypeBuiltIn: return "builtin"
    case kAudioDeviceTransportTypeBluetooth, kAudioDeviceTransportTypeBluetoothLE: return "bluetooth"
    case kAudioDeviceTransportTypeHDMI, kAudioDeviceTransportTypeDisplayPort: return "display"
    case kAudioDeviceTransportTypeUSB: return "usb"
    case kAudioDeviceTransportTypeAirPlay: return "airplay"
    case kAudioDeviceTransportTypeVirtual, kAudioDeviceTransportTypeAggregate: return "virtual"
    default: return "other"
    }
}

let systemObject = AudioObjectID(kAudioObjectSystemObject)

func defaultOutputDevice() -> AudioDeviceID? {
    audioUInt32(systemObject, kAudioHardwarePropertyDefaultOutputDevice)
}

func outputDeviceIDs() -> [AudioDeviceID] {
    var address = audioAddress(kAudioHardwarePropertyDevices)
    var size: UInt32 = 0
    guard AudioObjectGetPropertyDataSize(systemObject, &address, 0, nil, &size) == noErr else { return [] }
    var ids = [AudioDeviceID](repeating: 0, count: Int(size) / MemoryLayout<AudioDeviceID>.size)
    guard AudioObjectGetPropertyData(systemObject, &address, 0, nil, &size, &ids) == noErr else { return [] }
    return ids.filter { hasOutputStreams($0) && audioUInt32($0, kAudioDevicePropertyIsHidden) != 1 }
}

// Devices are addressed by UID: AudioDeviceIDs change when a device reconnects, UIDs don't.
func outputDevices() -> [[String: Any]] {
    let current = defaultOutputDevice()
    return outputDeviceIDs().compactMap { id -> [String: Any]? in
        guard let uid = audioString(id, kAudioDevicePropertyDeviceUID) else { return nil }
        return [
            "id": uid,
            "name": audioString(id, kAudioObjectPropertyName) ?? uid,
            "transport": transportName(audioUInt32(id, kAudioDevicePropertyTransportType) ?? 0),
            "current": id == current,
        ]
    }
}

func setDefaultOutput(uid: String) -> Bool {
    guard let target = outputDeviceIDs().first(where: { audioString($0, kAudioDevicePropertyDeviceUID) == uid }) else {
        fail("no-such-device")
    }
    var address = audioAddress(kAudioHardwarePropertyDefaultOutputDevice)
    var device = target
    return AudioObjectSetPropertyData(systemObject, &address, 0, nil,
                                      UInt32(MemoryLayout<AudioDeviceID>.size), &device) == noErr
}

// MARK: - Media keys (needs Accessibility for the responsible app)

// NX_KEYTYPE_* from IOKit/hidsystem/ev_keymap.h
let mediaKeyCodes = ["play": 16, "next": 17, "prev": 18]

func postMediaKey(_ code: Int) {
    for down in [true, false] {
        let event = NSEvent.otherEvent(
            with: .systemDefined, location: .zero,
            modifierFlags: NSEvent.ModifierFlags(rawValue: down ? 0xa00 : 0xb00),
            timestamp: 0, windowNumber: 0, context: nil, subtype: 8,
            data1: (code << 16) | ((down ? 0xa : 0xb) << 8), data2: -1)
        event?.cgEvent?.post(tap: .cghidEventTap)
    }
}

// MARK: - Night Shift (private CoreBrightness, loaded at runtime)

func blueLightClient() -> (client: NSObject, cls: AnyClass)? {
    guard let bundle = Bundle(path: "/System/Library/PrivateFrameworks/CoreBrightness.framework"),
          bundle.load(),
          let cls = NSClassFromString("CBBlueLightClient") as? NSObject.Type
    else { return nil }
    return (cls.init(), cls)
}

// Status struct layout: BOOL active; BOOL enabled; BOOL sunSchedulePermitted; int mode; ...
// The buffer is oversized on purpose in case newer systems append fields.
func nightShiftStatus() -> [String: Any]? {
    guard let blc = blueLightClient() else { return nil }
    let selector = NSSelectorFromString("getBlueLightStatus:")
    guard let method = class_getInstanceMethod(blc.cls, selector) else { return nil }
    typealias GetStatus = @convention(c) (AnyObject, Selector, UnsafeMutableRawPointer) -> Bool
    let getStatus = unsafeBitCast(method_getImplementation(method), to: GetStatus.self)
    let buffer = UnsafeMutableRawPointer.allocate(byteCount: 256, alignment: 16)
    defer { buffer.deallocate() }
    buffer.initializeMemory(as: UInt8.self, repeating: 0, count: 256)
    guard getStatus(blc.client, selector, buffer) else { return nil }
    return [
        "active": buffer.load(fromByteOffset: 0, as: UInt8.self) != 0,
        "enabled": buffer.load(fromByteOffset: 1, as: UInt8.self) != 0,
        "mode": Int(buffer.load(fromByteOffset: 4, as: Int32.self)),
    ]
}

func setNightShift(_ on: Bool) -> Bool {
    guard let blc = blueLightClient() else { fail("nightshift-unavailable") }
    let selector = NSSelectorFromString("setEnabled:")
    guard let method = class_getInstanceMethod(blc.cls, selector) else { fail("nightshift-unavailable") }
    typealias SetEnabled = @convention(c) (AnyObject, Selector, Bool) -> Bool
    let ok = unsafeBitCast(method_getImplementation(method), to: SetEnabled.self)(blc.client, selector, on)
    RunLoop.current.run(until: Date().addingTimeInterval(0.3))  // let the XPC message leave before exit
    return ok
}

// MARK: - Displays (built-in brightness via private DisplayServices; externals go through m1ddc)

func displayServicesSymbol(_ name: String) -> UnsafeMutableRawPointer? {
    guard let handle = dlopen("/System/Library/PrivateFrameworks/DisplayServices.framework/DisplayServices",
                              RTLD_LAZY) else { return nil }
    return dlsym(handle, name)
}

func builtinBrightness(_ id: CGDirectDisplayID) -> Float? {
    typealias Get = @convention(c) (CGDirectDisplayID, UnsafeMutablePointer<Float>) -> Int32
    guard let symbol = displayServicesSymbol("DisplayServicesGetBrightness") else { return nil }
    var value: Float = 0
    return unsafeBitCast(symbol, to: Get.self)(id, &value) == 0 ? value : nil
}

func setBuiltinBrightness(_ id: CGDirectDisplayID, _ value: Float) -> Bool {
    typealias Set = @convention(c) (CGDirectDisplayID, Float) -> Int32
    guard let symbol = displayServicesSymbol("DisplayServicesSetBrightness") else { return false }
    return unsafeBitCast(symbol, to: Set.self)(id, value) == 0
}

func displays() -> [[String: Any]] {
    var ids = [CGDirectDisplayID](repeating: 0, count: 16)
    var count: UInt32 = 0
    guard CGGetOnlineDisplayList(16, &ids, &count) == .success else { return [] }
    let names = Dictionary(NSScreen.screens.compactMap { screen -> (CGDirectDisplayID, String)? in
        guard let number = screen.deviceDescription[NSDeviceDescriptionKey("NSScreenNumber")] as? NSNumber else {
            return nil
        }
        return (CGDirectDisplayID(number.uint32Value), screen.localizedName)
    }, uniquingKeysWith: { first, _ in first })
    return ids.prefix(Int(count)).map { id -> [String: Any] in
        let builtin = CGDisplayIsBuiltin(id) != 0
        var display: [String: Any] = [
            "id": Int(id),
            "name": names[id] ?? "Display \(id)",
            "builtin": builtin,
            "main": CGDisplayIsMain(id) != 0,
        ]
        if builtin, let value = builtinBrightness(id) {
            display["brightness"] = Int((value * 100).rounded())
        }
        return display
    }
}

// MARK: - DDC over I2C (private IOAVService, the path m1ddc uses)

// On Apple Silicon an external display's DDC/CI channel hangs off IOAVService, which is private:
// the symbols are looked up at runtime, and a missing one simply means "no DDC here". The packet
// layout and the 0x6E checksum seed come from the DDC/CI spec (as implemented by m1ddc, MIT).
let ddcChipAddress: UInt32 = 0x37
let ddcDataAddress: UInt32 = 0x51
let vcpDisplayPower: UInt8 = 0xD6

typealias AVServiceCreate = @convention(c) (CFAllocator?) -> Unmanaged<CFTypeRef>?
typealias AVWriteI2C = @convention(c) (CFTypeRef, UInt32, UInt32, UnsafeMutableRawPointer, UInt32) -> Int32

func ioKitSymbol(_ name: String) -> UnsafeMutableRawPointer? {
    guard let handle = dlopen("/System/Library/Frameworks/IOKit.framework/IOKit", RTLD_LAZY) else { return nil }
    return dlsym(handle, name)
}

// The default external display. This Mac runs in clamshell with one monitor, which is the one
// DDC talks to; several externals would need the IORegistry walk that m1ddc does.
func externalAVService() -> CFTypeRef? {
    guard let symbol = ioKitSymbol("IOAVServiceCreate") else { return nil }
    return unsafeBitCast(symbol, to: AVServiceCreate.self)(kCFAllocatorDefault)?.takeRetainedValue()
}

// One "set VCP feature" message: length, opcode, feature, value (big endian), checksum.
func ddcWrite(_ service: CFTypeRef, feature: UInt8, value: UInt16) -> Bool {
    guard let symbol = ioKitSymbol("IOAVServiceWriteI2C") else { return false }
    let write = unsafeBitCast(symbol, to: AVWriteI2C.self)
    var packet: [UInt8] = [0x84, 0x03, feature, UInt8(value >> 8), UInt8(value & 0xFF), 0]
    packet[5] = packet.prefix(5).reduce(0x6E ^ UInt8(ddcDataAddress)) { $0 ^ $1 }
    // Displays miss single messages often enough that m1ddc sends each one twice, spaced out.
    var ok = false
    for _ in 0..<2 {
        usleep(20_000)
        let sent = packet.withUnsafeMutableBufferPointer { buffer in
            write(service, ddcChipAddress, ddcDataAddress, buffer.baseAddress!, UInt32(buffer.count)) == 0
        }
        ok = ok || sent
    }
    return ok
}

// VCP D6 "display power mode": 1 = on, 4 = off (standby). Value 5, the hard off, is deliberately
// not used: some displays then only come back from their own power button, and this Mac is in
// clamshell — a display that stays dark leaves no screen at all.
func setDisplayAwake(_ awake: Bool) -> Bool {
    guard let service = externalAVService() else { fail("no-ddc-display") }
    return ddcWrite(service, feature: vcpDisplayPower, value: awake ? 0x01 : 0x04)
}

// Waits until the person at the Mac presses a key, clicks or scrolls. Moving the mouse is
// deliberately ignored: a twitchy wireless mouse lighting the display back up is exactly what
// standby is meant to stop. Ends early if the agent that started it is gone.
func waitForDeliberateInput(timeout: TimeInterval) -> Bool {
    let deadline = Date().addingTimeInterval(timeout)
    var sawQuiet = false
    while Date() < deadline, getppid() != 1 {
        let idle = [CGEventType.keyDown, .leftMouseDown, .rightMouseDown, .scrollWheel]
            .map { CGEventSource.secondsSinceLastEventType(.combinedSessionState, eventType: $0) }
            .min() ?? .greatestFiniteMagnitude
        // The click that asked for standby counts as input too, so wait for a quiet moment first.
        if idle > 2 { sawQuiet = true }
        if sawQuiet, idle < 1 { return true }
        usleep(250_000)
    }
    return false
}

// MARK: - Dispatch

let args = Array(CommandLine.arguments.dropFirst())
func arg(_ index: Int) -> String { index < args.count ? args[index] : "" }

// Connect to the window server (needed for NSScreen and icon rendering) without a Dock icon.
NSApplication.shared.setActivationPolicy(.prohibited)

switch (arg(0), arg(1)) {
case ("state", _):
    var state: [String: Any] = [
        "apps": runningApps(),
        "audioOutputs": outputDevices(),
        "displays": displays(),
        "axTrusted": AXIsProcessTrusted(),
    ]
    if let nightShift = nightShiftStatus() { state["nightShift"] = nightShift }
    emit(state)

case ("apps", "running"):
    emit(runningApps())
case ("apps", "installed"):
    emit(installedApps())
case ("apps", "icon"):
    guard let png = iconPNG(path: arg(2), size: Int(arg(3)) ?? 64) else { fail("bad-icon-path") }
    emit(["png": png])
case ("apps", "hide"):
    // hide() can return false even when it works; the next state read shows the real result.
    _ = regularApp(arg(2)).hide()
    emit(["ok": true])
case ("apps", "quit"):
    emit(["ok": regularApp(arg(2)).terminate()])
case ("apps", "force-quit"):
    emit(["ok": regularApp(arg(2)).forceTerminate()])

case ("audio", "outputs"):
    emit(outputDevices())
case ("audio", "set-output"):
    emit(["ok": setDefaultOutput(uid: arg(2))])

case ("media", let key):
    guard let code = mediaKeyCodes[key] else { fail("unknown-media-key") }
    guard AXIsProcessTrusted() else { fail("accessibility-not-granted") }
    postMediaKey(code)
    emit(["ok": true])

case ("nightshift", "get"):
    guard let status = nightShiftStatus() else { fail("nightshift-unavailable") }
    emit(status)
case ("nightshift", "set"):
    guard arg(2) == "on" || arg(2) == "off" else { fail("usage: nightshift set on|off") }
    emit(["ok": setNightShift(arg(2) == "on")])

case ("display", "list"):
    emit(displays())
case ("display", "set-brightness"):
    guard let id = UInt32(arg(2)), let value = Int(arg(3)), (0...100).contains(value) else {
        fail("usage: display set-brightness <id> <0-100>")
    }
    guard CGDisplayIsBuiltin(id) != 0 else { fail("not-builtin-display") }
    emit(["ok": setBuiltinBrightness(id, Float(value) / 100)])
case ("display", "awake"):
    guard arg(2) == "on" || arg(2) == "off" else { fail("usage: display awake on|off") }
    emit(["ok": setDisplayAwake(arg(2) == "on")])
case ("display", "wait-for-input"):
    emit(["ok": true, "input": waitForDeliberateInput(timeout: Double(arg(2)) ?? 1800)])

case ("ax-trusted", let flag):
    let options = ["AXTrustedCheckOptionPrompt": flag == "--prompt"] as CFDictionary
    emit(["trusted": AXIsProcessTrustedWithOptions(options)])

default:
    fail("usage: macctl state | apps running|installed|icon <path> [size]|hide|quit|force-quit <pid>"
        + " | audio outputs|set-output <uid> | media play|next|prev | nightshift get|set on|off"
        + " | display list|set-brightness <id> <0-100>|awake on|off|wait-for-input <seconds> | ax-trusted [--prompt]")
}
