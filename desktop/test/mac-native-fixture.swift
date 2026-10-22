// OS responses only; all policy, menu, binding and dispatch code is production.
var fixtureTrusted = true
var fixtureScreen = false
var screenRequests = 0
func fixtureRequestScreen() -> Bool { screenRequests += 1; return fixtureScreen }
var fixtureLocked = false
var fixtureOnScreen = true
var activateShowsWindow = true
var posted: [String] = []
func fixturePost(_ event: CGEvent, _ pid: pid_t) {
    var length = 0
    var units = [UniChar](repeating: 0, count: 8)
    event.keyboardGetUnicodeString(maxStringLength: 8, actualStringLength: &length, unicodeString: &units)
    if event.type == .keyDown { posted.append(String(utf16CodeUnits: units, count: length)) }
}
var fixtureIdle = 0.0
var fixtureFront: pid_t? = 7
var fixtureBundleId = "com.example.editor"
var attributes: [AXKey: JSON] = [:]
var menuReads = 0
var menuFailures = 0
var menuError = AXError.cannotComplete
var performed: [String] = []
var opened = 0
var bundleURL: URL?
var launchUnregistered = false
let registeredApp = NSWorkspace.shared.runningApplications.first { $0.processIdentifier > 0 }!
let app = appElement(7)
let window = AXUIElementCreateApplication(1001)
let field = AXUIElementCreateApplication(1002)
let sheet = AXUIElementCreateApplication(1003)
let foreign = AXUIElementCreateApplication(1004)
let bar = AXUIElementCreateApplication(1005)
let selected = SelectedWindow(id: 41, frame: CGRect(x: 10, y: 20, width: 420, height: 520), onScreen: true, titled: true)

func fixtureAttribute(_ element: AXUIElement, _ name: CFString, _ value: UnsafeMutablePointer<CFTypeRef?>) -> AXError {
    let key = name as String
    if key == "AXMenuBar" {
        menuReads += 1
        if menuReads <= menuFailures { return menuError }
    }
    guard let found = attributes[AXKey(element: element)]?[key] else { return .noValue }
    if let error = found as? AXError { return error }
    value.pointee = found as CFTypeRef
    return .success
}
func fixtureAttributes(_ element: AXUIElement, _ names: CFArray, _ options: AXCopyMultipleAttributeOptions, _ values: UnsafeMutablePointer<CFArray?>) -> AXError {
    let record = attributes[AXKey(element: element)] ?? [:]
    values.pointee = (names as! [String]).map { record[$0] ?? NSNull() } as CFArray
    return .success
}
func fixturePerform(_ element: AXUIElement, _ action: CFString) -> AXError {
    performed.append(action as String)
    return .success
}
func fixtureSet(_ element: AXUIElement, _ name: CFString, _ value: CFTypeRef) -> AXError {
    attributes[AXKey(element: element), default: [:]][name as String] = value
    return .success
}
func fixtureWindows(_ options: CGWindowListOption, _ id: CGWindowID) -> CFArray? {
    return [[kCGWindowOwnerPID as String: 7, kCGWindowLayer as String: 0, kCGWindowNumber as String: 41,
             kCGWindowBounds as String: ["X": 10, "Y": 20, "Width": 420, "Height": 520],
             kCGWindowIsOnscreen as String: fixtureOnScreen, kCGWindowName as String: "Task"]] as CFArray
}
func fixtureURL(withBundleIdentifier id: String) -> URL? { bundleURL }
func fixturePath(forApplication name: String) -> String? { bundleURL?.path }
func fixtureOpen(at url: URL, configuration: NSWorkspace.OpenConfiguration, completionHandler: ((NSRunningApplication?, Error?) -> Void)?) {
    opened += 1
    if configuration.activates { fatalError("launch must stay in background") }
    // A command-line process is not registered with LaunchServices, so its own entry reports pid -1.
    completionHandler?(launchUnregistered ? NSRunningApplication.current : registeredApp, nil)
}
func fixtureActivate(_ target: NSRunningApplication, options: NSApplication.ActivationOptions) -> Bool {
    fixtureFront = 7
    fixtureOnScreen = activateShowsWindow
    attributes[AXKey(element: app), default: [:]]["AXFocusedWindow"] = window
    return true
}
func expectFixture(_ condition: Bool, _ message: String) throws {
    if !condition { throw Fail("fixture", message) }
}
func refuses(_ code: String, _ work: () throws -> Void) throws {
    do { try work() } catch let failure as Fail {
        try expectFixture(failure.code == code, "expected \(code), got \(failure.code): \(failure.message)")
        return
    }
    throw Fail("fixture", "expected refusal: \(code)")
}
func fixture() throws {
    attributes[AXKey(element: app)] = ["AXWindows": [window], "AXFocusedWindow": window, "AXMenuBar": bar]
    attributes[AXKey(element: window)] = ["AXRole": "AXWindow", "AXWindowNumber": 41, "AXChildren": [field]]
    attributes[AXKey(element: field)] = ["AXRole": "AXButton", "AXTitle": "General", "AXParent": window]
    attributes[AXKey(element: sheet)] = ["AXRole": "AXSheet", "AXParent": window, "AXWindow": window]
    attributes[AXKey(element: foreign)] = ["AXRole": "AXWindow", "AXWindowNumber": 42]
    attributes[AXKey(element: bar)] = ["AXRole": "AXMenuBar", "AXChildren": []]
    switch CommandLine.arguments[1] {
    case "front-read":
        _ = try dispatch(["cmd": "snapshot", "pid": 7])
        _ = try dispatch(["cmd": "menu", "pid": 7])
        fixtureLocked = true
        try refuses("locked") { _ = try dispatch(["cmd": "snapshot", "pid": 7]) }
    case "front-action":
        for idle in [0.0, 1.999, 2.0, 8.0] {
            fixtureIdle = idle
            let reply = respond(["cmd": "act", "pid": 7, "snapshot": false, "steps": []])
            try expectFixture(reply["ok"] as? Bool == (idle >= 2), "front action idle boundary \(idle): \(reply)")
        }
        policyExact = [fixtureBundleId]
        try refuses("off_limits") { _ = try checkApp(7) }
    case "menu-retry":
        for error in [AXError.cannotComplete, .noValue] {
            menuReads = 0; menuFailures = 1; menuError = error
            _ = try menuBar(7)
            try expectFixture(menuReads == 2, "transient menu read must retry once")
        }
        menuReads = 0; menuFailures = 3
        try refuses("unresponsive") { _ = try menuBar(7) }
        try expectFixture(menuReads == 2, "menu retry must be bounded")
        menuReads = 0; menuError = .attributeUnsupported
        try refuses("unsupported_action") { _ = try menuBar(7) }
        try expectFixture(menuReads == 1, "unsupported menu must not retry")
    case "launch":
        let dir = FileManager.default.temporaryDirectory.appendingPathComponent(UUID().uuidString + ".app")
        try FileManager.default.createDirectory(at: dir.appendingPathComponent("Contents"), withIntermediateDirectories: true)
        defer { try? FileManager.default.removeItem(at: dir) }
        let data = try PropertyListSerialization.data(fromPropertyList: ["CFBundleIdentifier": "com.example.calculator"], format: .xml, options: 0)
        try data.write(to: dir.appendingPathComponent("Contents/Info.plist"))
        bundleURL = dir
        for name in ["com.example.calculator", "Calculator"] {
            let reply = try dispatch(["cmd": "launch", "app": name])
            try expectFixture(reply["pid"] as? Int == Int(registeredApp.processIdentifier), "launch returns pid")
        }
        launchUnregistered = true
        try refuses("unresponsive") { _ = try dispatch(["cmd": "launch", "app": "Calculator"]) }
        launchUnregistered = false
        policyExact = ["com.example.calculator"]
        try refuses("off_limits") { _ = try dispatch(["cmd": "launch", "app": "Calculator"]) }
        try expectFixture(opened == 3, "blocked launch must not open")
        for name in ["", "/Applications/Calculator.app", "https://example.com"] {
            try refuses("bad_request") { _ = try dispatch(["cmd": "launch", "app": name]) }
        }
        policyExact = []; fixtureLocked = true
        try refuses("locked") { _ = try dispatch(["cmd": "launch", "app": "Calculator"]) }
    case "window-focus":
        attributes[AXKey(element: app)]?["AXFocusedWindow"] = sheet
        try validateWindowStep(7, ["action": "key"], selected)
        attributes[AXKey(element: app)]?["AXFocusedWindow"] = foreign
        try refuses("window_unverified") { try validateWindowStep(7, ["action": "key"], selected) }
    case "window-ref":
        let walk = try refresh(7, menubar: false, windowId: 41)
        guard let ref = walk.elements.first?.ref else { throw Fail("fixture", "fresh snapshot missing field") }
        try validateWindowStep(7, ["action": "press", "ref": ref], selected)
        attributes[AXKey(element: field)]?["AXParent"] = foreign
        try refuses("stale_ref") { try validateWindowStep(7, ["action": "press", "ref": ref], selected) }
        attributes[AXKey(element: field)]?["AXParent"] = field
        try expectFixture(!belongsToWindow(field, selected), "parent cycles fail closed")
    case "permissions":
        for trusted in [true, false] { for screen in [true, false] {
            fixtureTrusted = trusted; fixtureScreen = screen
            let reply = try dispatch(["cmd": "permissions"])
            try expectFixture(reply["accessibility"] as? Bool == trusted && reply["screenRecording"] as? Bool == screen, "permissions must be measured")
        } }
    case "screen-request":
        fixtureTrusted = false
        for granted in [false, true] {
            fixtureScreen = granted
            let reply = try dispatch(["cmd": "request_screen"])
            try expectFixture(reply["screenRecording"] as? Bool == granted, "screen request reports its actual result")
        }
        try expectFixture(screenRequests == 1 && performed.isEmpty, "only missing access is requested; no input is sent")
        try expectFixture(!unsureWindowNote.contains("no open") && unsureWindowNote.contains("Continue"), "unknown titles must not end the task")
    case "activate":
        fixtureFront = 99; fixtureIdle = 1
        try refuses("in_front") { _ = try runStep(7, ["action": "activate"], windowId: 41) }
        fixtureIdle = 2
        _ = try runStep(7, ["action": "activate"], windowId: 41)
        try expectFixture(fixtureFront == 7 && performed == ["AXRaise"], "only the selected app window is raised")
        try refuses("stale_window") { _ = try runStep(7, ["action": "activate"], windowId: 42) }
        attributes[AXKey(element: app)]?["AXFocusedUIElement"] = field
        attributes[AXKey(element: field)]?["AXSubrole"] = "AXSecureTextField"
        try refuses("off_limits") { _ = try runStep(7, ["action": "activate"], windowId: 41) }
    case "activate-offscreen":
        fixtureFront = 99; fixtureIdle = 2; fixtureOnScreen = false
        try validateWindowStep(7, ["action": "activate"], try selectedWindow(7, 41))
        try validateWindowStep(7, ["action": "activate"], nil)
        try refuses("stale_window") { try validateWindowStep(7, ["action": "key"], try selectedWindow(7, 41)) }
        let reply = try runStep(7, ["action": "activate"], windowId: 41)
        try expectFixture(fixtureFront == 7 && (reply["note"] as? String ?? "").contains("snapshot"), "a window on another Space is brought forward, then re-read")
        try expectFixture(performed.isEmpty, "no window is raised before it can be verified")
    case "activate-nowindow":
        fixtureFront = 99; fixtureIdle = 2; fixtureOnScreen = false; activateShowsWindow = false
        let reply = try runStep(7, ["action": "activate"], windowId: nil)
        try expectFixture(fixtureFront == 7 && (reply["note"] as? String ?? "").contains("menu"), "an app with no window comes forward and says how to open one")
        try validateWindowStep(7, ["action": "key"], nil)
        fixtureFront = 99
        do { try validateWindowStep(7, ["action": "key"], nil); throw Fail("fixture", "key to a windowless app in back must be refused") }
        catch let failure as Fail { try expectFixture(failure.code == "no_window" && failure.message.contains("cmd+n"), "the refusal names a way to open a window: \(failure.message)") }
        do { try validateWindowStep(7, ["action": "click", "x": 1, "y": 1], nil); throw Fail("fixture", "click without a window must be refused") }
        catch let failure as Fail { try expectFixture(failure.code == "no_window", "click needs a window") }
    case "type-focused":
        fixtureIdle = 2
        _ = try runStep(7, ["action": "type", "text": "final.txt"], windowId: 41)
        try expectFixture(posted.joined() == "final.txt", "focused typing posts each character: \(posted)")
        try validateWindowStep(7, ["action": "type", "text": "x"], selected)
        attributes[AXKey(element: app)]?["AXFocusedWindow"] = foreign
        try refuses("window_unverified") { try validateWindowStep(7, ["action": "type", "text": "x"], selected) }
        attributes[AXKey(element: app)]?["AXFocusedWindow"] = window
        attributes[AXKey(element: app)]?["AXFocusedUIElement"] = field
        attributes[AXKey(element: field)]?["AXSubrole"] = "AXSecureTextField"
        try refuses("off_limits") { _ = try runStep(7, ["action": "type", "text": "secret"], windowId: 41) }
    default: throw Fail("fixture", "unknown scenario")
    }
}
do { try fixture(); write(["ok": true]) }
catch let failure as Fail { write(["ok": false, "error": failure.message, "code": failure.code]); exit(1) }
catch { write(["ok": false, "error": "\(error)"]); exit(1) }
