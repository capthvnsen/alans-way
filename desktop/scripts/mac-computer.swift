import AppKit
import ApplicationServices
import CoreGraphics
import Foundation

struct Out: Encodable {
    var ok: Bool
    var error: String?
    var apps: [AppInfo]?
    var elements: [Element]?
    var text: String?
    var cursorMoved: Bool?
    var image: String?
}

struct AppInfo: Encodable {
    var name: String
    var bundleId: String
    var pid: Int32
    var frontmost: Bool
}

struct Element: Encodable {
    var ref: String
    var role: String
    var name: String
    var x: Double
    var y: Double
    var width: Double
    var height: Double
}

let interactive: Set<String> = [
    "AXButton", "AXCheckBox", "AXRadioButton", "AXTextField", "AXTextArea",
    "AXPopUpButton", "AXMenuButton", "AXSlider", "AXIncrementor", "AXComboBox",
    "AXLink", "AXMenuItem",
]

func emit(_ value: Out) -> Never {
    let data = try! JSONEncoder().encode(value)
    FileHandle.standardOutput.write(data)
    FileHandle.standardOutput.write(Data([0x0A]))
    exit(value.ok ? 0 : 1)
}

func fail(_ message: String) -> Never {
    emit(Out(ok: false, error: message, apps: nil, elements: nil, text: nil, cursorMoved: nil, image: nil))
}

func axValue(_ element: AXUIElement, _ name: String) -> CFTypeRef? {
    var value: CFTypeRef?
    guard AXUIElementCopyAttributeValue(element, name as CFString, &value) == .success else { return nil }
    return value
}

func axString(_ element: AXUIElement, _ name: String) -> String {
    axValue(element, name) as? String ?? ""
}

func axFrame(_ element: AXUIElement) -> CGRect {
    var value: CFTypeRef?
    guard AXUIElementCopyAttributeValue(element, "AXFrame" as CFString, &value) == .success,
          let value else { return .zero }
    var rect = CGRect.zero
    guard AXValueGetValue(value as! AXValue, .cgRect, &rect) else { return .zero }
    return rect
}

func axChildren(_ element: AXUIElement) -> [AXUIElement] {
    axValue(element, "AXChildren") as? [AXUIElement] ?? []
}

func appElement(_ pid: pid_t) -> AXUIElement {
    AXUIElementCreateApplication(pid)
}

func findRef(_ pid: pid_t, _ ref: String) -> AXUIElement? {
    var found: AXUIElement?
    var index = 0
    func walk(_ element: AXUIElement, _ depth: Int) {
        if found != nil || depth > 12 || index > 400 { return }
        let role = axString(element, "AXRole")
        if interactive.contains(role) || role == "AXStaticText" {
            index += 1
            if "c\(index)" == ref { found = element; return }
        }
        for child in axChildren(element) { walk(child, depth + 1) }
    }
    for window in axValue(appElement(pid), "AXWindows") as? [AXUIElement] ?? [] {
        walk(window, 0)
    }
    return found
}

func cursor() -> CGPoint { CGEvent(source: nil)?.location ?? .zero }

func moved(_ before: CGPoint) -> Bool {
    let after = cursor()
    return abs(after.x - before.x) > 1 || abs(after.y - before.y) > 1
}

func postClick(_ pid: pid_t, _ point: CGPoint, dragTo: CGPoint?) {
    let source = CGEventSource(stateID: .hidSystemState)
    let before = cursor()
    func post(_ type: CGEventType, _ at: CGPoint) {
        let event = CGEvent(mouseEventSource: source, mouseType: type, mouseCursorPosition: at, mouseButton: .left)
        event?.postToPid(pid)
    }
    post(.mouseMoved, point)
    post(.leftMouseDown, point)
    if let dragTo {
        post(.leftMouseDragged, dragTo)
        post(.leftMouseUp, dragTo)
    } else {
        post(.leftMouseUp, point)
    }
    if abs(cursor().x - before.x) > 1 || abs(cursor().y - before.y) > 1 {
        CGWarpMouseCursorPosition(before)
    }
}

func pressAtPoint(_ pid: pid_t, _ axPoint: CGPoint) -> Bool {
    var element: AXUIElement?
    let app = AXUIElementCreateApplication(pid)
    guard AXUIElementCopyElementAtPosition(app, Float(axPoint.x), Float(axPoint.y), &element) == .success,
          let element else { return false }
    return AXUIElementPerformAction(element, "AXPress" as CFString) == .success
}

func axToQuartz(_ point: CGPoint) -> CGPoint {
    for screen in NSScreen.screens {
        let frame = screen.frame
        // Accessibility frames use a top-left origin. Quartz mouse events use bottom-left.
        let top = frame.maxY
        if point.x >= frame.minX && point.x <= frame.maxX && point.y >= 0 {
            let flippedY = top - point.y
            if flippedY >= frame.minY && flippedY <= frame.maxY {
                return CGPoint(x: point.x, y: flippedY)
            }
        }
    }
    let height = NSScreen.screens.map(\.frame.maxY).max() ?? 0
    return CGPoint(x: point.x, y: height - point.y)
}

let args = Array(CommandLine.arguments.dropFirst())
guard let command = args.first else { fail("missing command") }
guard AXIsProcessTrusted() else {
    fail("Accessibility is off for this program. Turn it on in System Settings → Privacy & Security → Accessibility, then retry.")
}

switch command {
case "apps":
    let front = NSWorkspace.shared.frontmostApplication?.processIdentifier
    let apps = NSWorkspace.shared.runningApplications.filter { $0.activationPolicy == .regular }.map {
        AppInfo(name: $0.localizedName ?? "", bundleId: $0.bundleIdentifier ?? "", pid: $0.processIdentifier, frontmost: $0.processIdentifier == front)
    }
    emit(Out(ok: true, error: nil, apps: apps, elements: nil, text: nil, cursorMoved: nil, image: nil))
case "snapshot":
    guard args.count > 1, let pid = Int32(args[1]) else { fail("snapshot needs a pid") }
    var elements: [Element] = []
    var index = 0
    func walk(_ element: AXUIElement, _ depth: Int) {
        if depth > 12 || elements.count >= 180 { return }
        let role = axString(element, "AXRole")
        if interactive.contains(role) || role == "AXStaticText" {
            index += 1
            let frame = axFrame(element)
            let title = axString(element, "AXTitle")
            let description = axString(element, "AXDescription")
            let value = axString(element, "AXValue")
            let name = (role == "AXStaticText" || role == "AXTextField" || role == "AXTextArea")
                ? (value.isEmpty ? (title.isEmpty ? description : title) : value)
                : (title.isEmpty ? (description.isEmpty ? value : description) : title)
            elements.append(Element(ref: "c\(index)", role: role, name: String(name.prefix(120)),
                                    x: frame.origin.x, y: frame.origin.y, width: frame.width, height: frame.height))
        }
        for child in axChildren(element) { walk(child, depth + 1) }
    }
    for window in axValue(appElement(pid), "AXWindows") as? [AXUIElement] ?? [] {
        walk(window, 0)
    }
    emit(Out(ok: true, error: nil, apps: nil, elements: elements, text: nil, cursorMoved: nil, image: nil))
case "press":
    guard args.count > 2, let pid = Int32(args[1]) else { fail("press needs a pid and a ref") }
    guard let element = findRef(pid, args[2]) else { fail("Unknown ref. Take a fresh snapshot.") }
    if axString(element, "AXRole") == "AXSecureTextField" || axString(element, "AXSubrole") == "AXSecureTextField" {
        fail("Password fields are off limits.")
    }
    let before = cursor()
    let result = AXUIElementPerformAction(element, "AXPress" as CFString)
    if result != .success {
        let frame = axFrame(element)
        guard frame.width > 0, frame.height > 0 else { fail("Press failed (\(result.rawValue)).") }
        postClick(pid, axToQuartz(CGPoint(x: frame.midX, y: frame.midY)), dragTo: nil)
    }
    if moved(before) { CGWarpMouseCursorPosition(before) }
    emit(Out(ok: true, error: nil, apps: nil, elements: nil, text: nil, cursorMoved: moved(before), image: nil))
case "click", "drag":
    guard args.count > 3, let pid = Int32(args[1]), let x = Double(args[2]), let y = Double(args[3]) else {
        fail("\(command) needs pid x y")
    }
    let before = cursor()
    let axPoint = CGPoint(x: x, y: y)
    if command == "click", pressAtPoint(pid, axPoint) {
        emit(Out(ok: true, error: nil, apps: nil, elements: nil, text: nil, cursorMoved: moved(before), image: nil))
    }
    let origin = axToQuartz(axPoint)
    if command == "drag" {
        guard args.count > 5, let x2 = Double(args[4]), let y2 = Double(args[5]) else { fail("drag needs x2 y2") }
        postClick(pid, origin, dragTo: axToQuartz(CGPoint(x: x2, y: y2)))
    } else {
        postClick(pid, origin, dragTo: nil)
    }
    emit(Out(ok: true, error: nil, apps: nil, elements: nil, text: nil, cursorMoved: moved(before), image: nil))
default:
    fail("unknown command \(command)")
}
