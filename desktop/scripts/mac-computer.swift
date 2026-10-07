import AppKit
import ApplicationServices
import CoreGraphics
import Foundation
import ScreenCaptureKit

// Reads and drives a Mac app through Accessibility without moving the pointer
// or taking focus. Protocol v2: newline-delimited JSON, see `serve` below.

typealias JSON = [String: Any]

struct Fail: Error {
    let code: String
    let message: String
    init(_ code: String, _ message: String) { self.code = code; self.message = message }
}

let elementCap = 180
let depthCap = 12
let visitCap = 4000
let walkBudget = 5.0
let interactive: Set<String> = [
    "AXButton", "AXCheckBox", "AXRadioButton", "AXTextField", "AXTextArea",
    "AXPopUpButton", "AXMenuButton", "AXSlider", "AXIncrementor", "AXComboBox",
    "AXLink", "AXMenuItem", "AXScrollBar", "AXRow", "AXCell", "AXOutlineRow",
    "AXDisclosureTriangle", "AXTabGroup", "AXTab", "AXMenuBarItem",
]
let textEntry: Set<String> = ["AXTextField", "AXTextArea", "AXComboBox"]
let inFrontMessage = "That app is the one in front. Leave it in the background; the real cursor stays yours."

// MARK: policy

var policyExact: Set<String> = []
var policyContains: [String] = []

func isBlocked(_ id: String) -> Bool {
    let value = id.lowercased()
    return policyExact.contains(value) || policyContains.contains { value.contains($0) }
}

func setPolicy(_ policy: JSON) {
    policyExact = Set((policy["exact"] as? [String] ?? []).map { $0.lowercased() })
    policyContains = (policy["contains"] as? [String] ?? []).map { $0.lowercased() }
}

@discardableResult
func checkApp(_ pid: pid_t) throws -> NSRunningApplication {
    guard let app = NSRunningApplication(processIdentifier: pid), app.activationPolicy == .regular, !app.isTerminated else {
        throw Fail("not_found", "App not found.")
    }
    if isBlocked(app.bundleIdentifier ?? "") { throw Fail("off_limits", "That app is off limits.") }
    if NSWorkspace.shared.frontmostApplication?.processIdentifier == pid { throw Fail("in_front", inFrontMessage) }
    return app
}

func requireAccessibility() throws {
    guard AXIsProcessTrusted() else {
        throw Fail("permission", "Accessibility is off for this program. Turn it on in System Settings → Privacy & Security → Accessibility, then retry.")
    }
}

// MARK: Accessibility reads

func appElement(_ pid: pid_t) -> AXUIElement {
    let app = AXUIElementCreateApplication(pid)
    AXUIElementSetMessagingTimeout(app, 1.0)
    return app
}

func axValue(_ element: AXUIElement, _ name: String) -> CFTypeRef? {
    var value: CFTypeRef?
    guard AXUIElementCopyAttributeValue(element, name as CFString, &value) == .success else { return nil }
    return value
}

func axString(_ element: AXUIElement, _ name: String) -> String {
    axValue(element, name) as? String ?? ""
}

func rect(_ value: CFTypeRef?) -> CGRect? {
    guard let value, CFGetTypeID(value) == AXValueGetTypeID() else { return nil }
    var frame = CGRect.zero
    guard AXValueGetValue(value as! AXValue, .cgRect, &frame) else { return nil }
    return frame
}

func axFrame(_ element: AXUIElement) -> CGRect? { rect(axValue(element, "AXFrame")) }

func axChildren(_ element: AXUIElement) -> [AXUIElement] {
    axValue(element, "AXChildren") as? [AXUIElement] ?? []
}

func axParent(_ element: AXUIElement) -> AXUIElement? {
    guard let value = axValue(element, "AXParent"), CFGetTypeID(value) == AXUIElementGetTypeID() else { return nil }
    return (value as! AXUIElement)
}

func numberAttr(_ element: AXUIElement, _ name: String) -> Double? {
    (axValue(element, name) as? NSNumber)?.doubleValue
}

func actionNames(_ element: AXUIElement) -> [String] {
    var names: CFArray?
    guard AXUIElementCopyActionNames(element, &names) == .success else { return [] }
    return names as? [String] ?? []
}

let walkAttributes = ["AXRole", "AXSubrole", "AXTitle", "AXDescription", "AXValue", "AXEnabled", "AXFrame", "AXChildren", "AXPlaceholderValue"]

func readAttributes(_ element: AXUIElement) -> [String: CFTypeRef]? {
    var values: CFArray?
    guard AXUIElementCopyMultipleAttributeValues(element, walkAttributes as CFArray, AXCopyMultipleAttributeOptions(rawValue: 0), &values) == .success,
          let list = values as? [AnyObject] else { return nil }
    var read: [String: CFTypeRef] = [:]
    for (index, item) in list.enumerated() where index < walkAttributes.count {
        let value = item as CFTypeRef
        if CFGetTypeID(value) == AXValueGetTypeID(), AXValueGetType(value as! AXValue) == .axError { continue }
        read[walkAttributes[index]] = value
    }
    return read
}

// MARK: tree walk

final class Node {
    let element: AXUIElement
    let depth: Int
    let limit: Int
    var visited = false
    var role = ""
    var subrole = ""
    var title = ""
    var details = ""
    var placeholder = ""
    var value: CFTypeRef?
    var enabled = true
    var frame: CGRect?
    var kids: [Node] = []
    var ref = ""
    var name = ""
    var shownValue = ""
    var emitted = false

    init(_ element: AXUIElement, depth: Int, limit: Int) {
        self.element = element
        self.depth = depth
        self.limit = limit
    }

    var readable: Bool { interactive.contains(role) || role == "AXStaticText" }
    var secure: Bool { subrole == "AXSecureTextField" || role == "AXSecureTextField" }
}

struct Elem {
    var ref: String
    var role: String
    var name: String
    var value: String
    var frame: CGRect?

    var json: JSON {
        var out: JSON = ["ref": ref, "role": role, "name": name]
        if !value.isEmpty { out["value"] = value }
        if let frame {
            out["x"] = frame.origin.x
            out["y"] = frame.origin.y
            out["width"] = frame.width
            out["height"] = frame.height
        }
        return out
    }
}

func fnv(_ text: String) -> Int {
    var hash: UInt32 = 0x811C9DC5
    for byte in text.utf8 {
        hash ^= UInt32(byte)
        hash = hash &* 0x01000193
    }
    return Int(hash & 0x7fffffff)
}

func rounded(_ number: Double) -> String {
    guard number.isFinite else { return "0" }
    return String(Int((number + 0.5).rounded(.down)))
}

func generation(of elements: [Elem]) -> Int {
    fnv(elements.map { item in
        let box = item.frame.map { [rounded($0.origin.x), rounded($0.origin.y), rounded($0.width), rounded($0.height)] } ?? ["", "", "", ""]
        return ([item.ref, item.role, item.name, item.value] + box).joined(separator: "|")
    }.joined(separator: "\n"))
}

func plainText(_ value: CFTypeRef?) -> String {
    value as? String ?? ""
}

func fill(_ node: Node, _ attributes: [String: CFTypeRef]) {
    node.visited = true
    node.role = plainText(attributes["AXRole"])
    node.subrole = plainText(attributes["AXSubrole"])
    node.title = plainText(attributes["AXTitle"])
    node.details = plainText(attributes["AXDescription"])
    node.placeholder = plainText(attributes["AXPlaceholderValue"])
    node.value = attributes["AXValue"]
    node.enabled = (attributes["AXEnabled"] as? NSNumber)?.boolValue ?? true
    node.frame = rect(attributes["AXFrame"])
}

func labelOf(_ node: Node) -> String {
    node.title.isEmpty ? (node.details.isEmpty ? node.placeholder : node.details) : node.title
}

func textBelow(_ node: Node, _ levels: Int) -> [String] {
    var parts: [String] = []
    for kid in node.kids where kid.visited {
        if kid.role == "AXStaticText" || (textEntry.contains(kid.role) && !kid.secure) {
            let text = plainText(kid.value).isEmpty ? labelOf(kid) : plainText(kid.value)
            if !text.isEmpty { parts.append(text.replacingOccurrences(of: "\n", with: " ")) }
        } else if levels > 0 {
            parts += textBelow(kid, levels - 1)
        }
    }
    return parts
}

func describe(_ node: Node) {
    let role = node.role
    let text = plainText(node.value)
    var name: String
    var shown = ""
    if textEntry.contains(role) {
        name = labelOf(node)
        if !node.secure { shown = String(text.prefix(200)) }
    } else if role == "AXStaticText" {
        name = text.isEmpty ? labelOf(node) : text
    } else if role == "AXRow" || role == "AXCell" || role == "AXOutlineRow" {
        name = node.title.isEmpty ? node.details : node.title
        if name.isEmpty { name = textBelow(node, 3).joined(separator: " ") }
    } else {
        name = node.title.isEmpty ? (node.details.isEmpty ? text : node.details) : node.title
    }
    if role == "AXSlider" || role == "AXScrollBar", let number = (node.value as? NSNumber)?.doubleValue {
        // A scroll bar runs 0 to 1, so whole numbers would hide where it sits.
        let shown = role == "AXScrollBar" ? String(Double((number * 100).rounded()) / 100) : String(Int(number.rounded()))
        name = node.title.isEmpty ? shown : "\(node.title) \(shown)"
    }
    if role == "AXCheckBox" || role == "AXRadioButton", let number = (node.value as? NSNumber)?.doubleValue {
        name += number != 0 ? " on" : " off"
    }
    if !node.enabled { name += name.isEmpty ? "disabled" : " disabled" }
    node.name = String(name.prefix(120))
    node.shownValue = shown
}

struct Walk {
    var elements: [Elem]
    var nodes: [String: Node]
    var truncated: Bool
    var generation: Int
}

func walkApp(_ pid: pid_t, menubar: Bool) throws -> Walk {
    let app = appElement(pid)
    var roots: [Node] = []
    // An app with no windows answers with an empty list or "no value"; one that
    // cannot answer at all is hung, and an empty tree would pass for a blank app.
    var windows: CFTypeRef?
    let listed = AXUIElementCopyAttributeValue(app, "AXWindows" as CFString, &windows)
    if listed != .success && listed != .noValue && listed != .attributeUnsupported {
        throw Fail("unresponsive", "That app is not responding.")
    }
    for window in windows as? [AXUIElement] ?? [] { roots.append(Node(window, depth: 0, limit: depthCap)) }
    if menubar, let bar = axValue(app, "AXMenuBar"), CFGetTypeID(bar) == AXUIElementGetTypeID() {
        roots.append(Node(bar as! AXUIElement, depth: 0, limit: 1))
    }
    var queue = roots
    var head = 0
    var readable = 0
    var visits = 0
    var truncated = false
    var dropped = false
    let started = Date()
    while head < queue.count {
        if readable >= elementCap || visits >= visitCap || Date().timeIntervalSince(started) > walkBudget {
            truncated = true
            break
        }
        let node = queue[head]
        head += 1
        visits += 1
        guard let attributes = readAttributes(node.element) else {
            dropped = true
            continue
        }
        fill(node, attributes)
        if node.readable { readable += 1 }
        if node.depth < node.limit, let children = attributes["AXChildren"] as? [AXUIElement] {
            node.kids = children.map { Node($0, depth: node.depth + 1, limit: node.limit) }
            queue.append(contentsOf: node.kids)
        }
    }
    if head < queue.count || dropped { truncated = true }
    var elements: [Elem] = []
    var nodes: [String: Node] = [:]
    func emit(_ node: Node) {
        guard node.visited else { return }
        if node.readable {
            describe(node)
            // Scroll bar arrows and other collapsed parts: nothing to read or press.
            if node.name.isEmpty, let frame = node.frame, frame.width <= 0 || frame.height <= 0 { for kid in node.kids { emit(kid) }; return }
            node.ref = "c\(elements.count + 1)"
            nodes[node.ref] = node
            elements.append(Elem(ref: node.ref, role: node.role, name: node.name, value: node.shownValue, frame: node.frame))
        }
        for kid in node.kids { emit(kid) }
    }
    for root in roots { emit(root) }
    return Walk(elements: elements, nodes: nodes, truncated: truncated, generation: generation(of: elements))
}

struct Cache {
    var generation: Int
    var nodes: [String: Node]
    var menubar: Bool
}

var caches: [pid_t: Cache] = [:]

func snapshotFields(_ walk: Walk) -> JSON {
    var out: JSON = ["generation": walk.generation, "elements": walk.elements.map { $0.json }]
    if walk.truncated { out["truncated"] = true }
    return out
}

var cacheOrder: [pid_t] = []

func refresh(_ pid: pid_t, menubar: Bool) throws -> Walk {
    let walk = try walkApp(pid, menubar: menubar)
    caches[pid] = Cache(generation: walk.generation, nodes: walk.nodes, menubar: menubar)
    cacheOrder.removeAll { $0 == pid || NSRunningApplication(processIdentifier: $0) == nil }
    cacheOrder.append(pid)
    while cacheOrder.count > 16 { cacheOrder.removeFirst() }
    for key in Array(caches.keys) where !cacheOrder.contains(key) { caches[key] = nil }
    return walk
}

// A ref action is checked against the live tree, not the last walk: the app can
// change on its own between a snapshot and the action. The fresh walk's handles
// replace the cache, so the step uses what was just verified.
func ensureCache(_ pid: pid_t, _ expected: Int?, menubar: Bool) throws {
    guard let expected else {
        if caches[pid] == nil { _ = try refresh(pid, menubar: menubar) }
        return
    }
    if try refresh(pid, menubar: menubar).generation != expected {
        throw Fail("stale_ref", "stale_ref: The app changed since your snapshot. Take a fresh snapshot.")
    }
}

func resolve(_ pid: pid_t, _ ref: String) throws -> Node {
    guard let node = caches[pid]?.nodes[ref] else { throw Fail("stale_ref", "Unknown ref. Take a fresh snapshot.") }
    var value: CFTypeRef?
    let result = AXUIElementCopyAttributeValue(node.element, "AXRole" as CFString, &value)
    if result == .invalidUIElement || (result == .success && (value as? String) != node.role) {
        throw Fail("stale_ref", "That control is gone. Take a fresh snapshot.")
    }
    return node
}

// MARK: input

func cursor() -> CGPoint { CGEvent(source: nil)?.location ?? .zero }

func moved(_ before: CGPoint) -> Bool {
    let after = cursor()
    return abs(after.x - before.x) > 1 || abs(after.y - before.y) > 1
}

func restoreCursor(_ before: CGPoint) -> Bool {
    if moved(before) {
        CGWarpMouseCursorPosition(before)
        return true
    }
    return false
}

// AX frames and CGEvent mouse positions share one global space (origin at the
// primary display's top-left, y down, other displays at any offset, negative
// included), so a point passes through unchanged.
func axToQuartz(_ point: CGPoint) -> CGPoint { point }

var postedMouse = false

func postMouse(_ pid: pid_t, _ point: CGPoint, button: CGMouseButton, clicks: Int, dragTo: CGPoint?) {
    postedMouse = true
    let source = CGEventSource(stateID: .hidSystemState)
    let down: CGEventType = button == .right ? .rightMouseDown : .leftMouseDown
    let up: CGEventType = button == .right ? .rightMouseUp : .leftMouseUp
    let drag: CGEventType = button == .right ? .rightMouseDragged : .leftMouseDragged
    func post(_ type: CGEventType, _ at: CGPoint, _ state: Int) {
        let event = CGEvent(mouseEventSource: source, mouseType: type, mouseCursorPosition: at, mouseButton: button)
        event?.setIntegerValueField(.mouseEventClickState, value: Int64(state))
        event?.postToPid(pid)
    }
    post(.mouseMoved, point, 0)
    if let dragTo {
        post(down, point, 1)
        post(drag, dragTo, 1)
        post(up, dragTo, 1)
        return
    }
    for count in 1...max(1, clicks) {
        post(down, point, count)
        post(up, point, count)
    }
}

func elementAt(_ pid: pid_t, _ point: CGPoint) -> AXUIElement? {
    var element: AXUIElement?
    guard AXUIElementCopyElementAtPosition(appElement(pid), Float(point.x), Float(point.y), &element) == .success else { return nil }
    return element
}

func pressableAncestor(_ element: AXUIElement) -> AXUIElement? {
    var current = axParent(element)
    for _ in 0..<4 {
        guard let candidate = current else { return nil }
        let role = axString(candidate, "AXRole")
        if role == "AXWindow" || role == "AXApplication" { return nil }
        if actionNames(candidate).contains("AXPress") { return candidate }
        current = axParent(candidate)
    }
    return nil
}

func selectRow(_ element: AXUIElement) -> Bool {
    var current: AXUIElement? = element
    for _ in 0..<3 {
        guard let candidate = current else { return false }
        if axString(candidate, "AXRole") == "AXRow" {
            return AXUIElementSetAttributeValue(candidate, "AXSelected" as CFString, kCFBooleanTrue) == .success
        }
        current = axParent(candidate)
    }
    return false
}

func eventClick(_ pid: pid_t, _ element: AXUIElement) throws -> String {
    guard let frame = axFrame(element), frame.width > 0, frame.height > 0 else { throw Fail("failed", "Press failed.") }
    postMouse(pid, axToQuartz(CGPoint(x: frame.midX, y: frame.midY)), button: .left, clicks: 1, dragTo: nil)
    return "event"
}

func pressElement(_ pid: pid_t, _ element: AXUIElement, role: String) throws -> String {
    let result = AXUIElementPerformAction(element, "AXPress" as CFString)
    if result == .success { return "ax" }
    if result == .invalidUIElement { throw Fail("stale_ref", "That control is gone. Take a fresh snapshot.") }
    if role == "AXRow" || role == "AXCell" || role == "AXOutlineRow", selectRow(element) { return "select" }
    if let ancestor = pressableAncestor(element), AXUIElementPerformAction(ancestor, "AXPress" as CFString) == .success { return "ancestor" }
    return try eventClick(pid, element)
}

func isSecure(_ element: AXUIElement) -> Bool {
    axString(element, "AXSubrole") == "AXSecureTextField" || axString(element, "AXRole") == "AXSecureTextField"
}

// Keys land in whatever the app has focused, so a focused password field is
// as off limits as typing into it by ref.
// An app with nothing focused is fine; one that cannot answer is not.
func rejectSecureFocus(_ pid: pid_t) throws {
    var value: CFTypeRef?
    let result = AXUIElementCopyAttributeValue(appElement(pid), "AXFocusedUIElement" as CFString, &value)
    if result == .success {
        if let value, CFGetTypeID(value) == AXUIElementGetTypeID(), isSecure(value as! AXUIElement) {
            throw Fail("off_limits", "Password fields are off limits.")
        }
    } else if result != .noValue && result != .attributeUnsupported {
        throw Fail("focus_unverified", "Could not verify which field has focus; retry or snapshot first.")
    }
}

// A menu item or context menu entry (Paste) acts on the focused field, so it is
// held to the same rule as a key press.
func inMenu(_ element: AXUIElement) -> Bool {
    var current: AXUIElement? = element
    for _ in 0..<6 {
        guard let candidate = current else { return false }
        let role = axString(candidate, "AXRole")
        if role == "AXMenuItem" || role == "AXMenu" { return true }
        current = axParent(candidate)
    }
    return false
}

func rejectSecureFocusForMenu(_ pid: pid_t, _ element: AXUIElement?) throws {
    if let element, inMenu(element) { try rejectSecureFocus(pid) }
}

func rejectSecure(_ node: Node) throws {
    if node.secure { throw Fail("off_limits", "Password fields are off limits.") }
}

func setSliderValue(pid: pid_t, from: CGPoint, to: CGPoint) -> Bool {
    guard let element = elementAt(pid, from) else { return false }
    let role = axString(element, "AXRole")
    guard role == "AXSlider" || role == "AXScrollBar" else { return false }
    guard let low = numberAttr(element, "AXMinValue"), let high = numberAttr(element, "AXMaxValue"), let frame = axFrame(element) else { return false }
    let horizontal = frame.width >= frame.height
    let span = horizontal ? frame.width : frame.height
    let origin = horizontal ? frame.minX : frame.minY
    let end = horizontal ? to.x : to.y
    let fraction = span <= 0 ? 0 : min(1, max(0, (end - origin) / span))
    return AXUIElementSetAttributeValue(element, "AXValue" as CFString, NSNumber(value: low + fraction * (high - low))) == .success
}

// MARK: keys

let keyCodes: [String: CGKeyCode] = [
    "a": 0, "s": 1, "d": 2, "f": 3, "h": 4, "g": 5, "z": 6, "x": 7, "c": 8, "v": 9, "b": 11, "q": 12, "w": 13, "e": 14,
    "r": 15, "y": 16, "t": 17, "1": 18, "2": 19, "3": 20, "4": 21, "6": 22, "5": 23, "=": 24, "9": 25, "7": 26, "-": 27,
    "8": 28, "0": 29, "]": 30, "o": 31, "u": 32, "[": 33, "i": 34, "p": 35, "l": 37, "j": 38, "'": 39, "k": 40, ";": 41,
    "\\": 42, ",": 43, "/": 44, "n": 45, "m": 46, ".": 47, "`": 50,
    "return": 36, "tab": 48, "space": 49, "backspace": 51, "escape": 53, "forwarddelete": 117, "home": 115, "end": 119,
    "pageup": 116, "pagedown": 121, "left": 123, "right": 124, "down": 125, "up": 126,
    "f1": 122, "f2": 120, "f3": 99, "f4": 118, "f5": 96, "f6": 97, "f7": 98, "f8": 100, "f9": 101, "f10": 109, "f11": 103, "f12": 111,
]

func keyFlags(_ modifiers: [String]) -> CGEventFlags {
    var flags = CGEventFlags()
    for name in modifiers {
        switch name {
        case "shift": flags.insert(.maskShift)
        case "control": flags.insert(.maskControl)
        case "alt": flags.insert(.maskAlternate)
        case "meta": flags.insert(.maskCommand)
        default: break
        }
    }
    return flags
}

func postKey(_ pid: pid_t, key: String, modifiers: [String]) throws {
    let known = keyCodes[key]
    guard known != nil || key.count == 1 else { throw Fail("bad_request", "Unknown key \"\(key)\".") }
    let flags = keyFlags(modifiers)
    let source = CGEventSource(stateID: .hidSystemState)
    for isDown in [true, false] {
        guard let event = CGEvent(keyboardEventSource: source, virtualKey: known ?? 0, keyDown: isDown) else { throw Fail("failed", "Could not build the key event.") }
        event.flags = flags
        if (known == nil || (modifiers.isEmpty && key.count == 1)) {
            var units = Array(key.utf16)
            event.keyboardSetUnicodeString(stringLength: units.count, unicodeString: &units)
        }
        event.postToPid(pid)
        if isDown { usleep(8000) }
    }
}

// MARK: scroll

func scrollAreaAbove(_ element: AXUIElement) -> AXUIElement? {
    var current: AXUIElement? = element
    for _ in 0..<14 {
        guard let candidate = current else { return nil }
        if axString(candidate, "AXRole") == "AXScrollArea" { return candidate }
        current = axParent(candidate)
    }
    return nil
}

func scrollByBar(_ area: AXUIElement, direction: String, amount: Double) -> Bool? {
    let vertical = direction == "up" || direction == "down"
    guard let barValue = axValue(area, vertical ? "AXVerticalScrollBar" : "AXHorizontalScrollBar"),
          CFGetTypeID(barValue) == AXUIElementGetTypeID() else { return nil }
    let bar = barValue as! AXUIElement
    guard let current = numberAttr(bar, "AXValue") else { return nil }
    var page = 0.1
    if let areaFrame = axFrame(area),
       let contents = axValue(area, "AXContents") as? [AXUIElement], let first = contents.first, let contentFrame = axFrame(first) {
        let visible = vertical ? areaFrame.height : areaFrame.width
        let total = vertical ? contentFrame.height : contentFrame.width
        if total > visible { page = 0.9 * visible / (total - visible) }
    }
    let sign: Double = (direction == "down" || direction == "right") ? 1 : -1
    let next = min(1, max(0, current + sign * amount * page))
    if abs(next - current) < 0.0001 { return false }
    guard AXUIElementSetAttributeValue(bar, "AXValue" as CFString, NSNumber(value: next)) == .success else { return nil }
    return true
}

func scrollByWheel(_ pid: pid_t, at point: CGPoint, direction: String, amount: Double) -> Bool {
    let pixels = Int32((amount * 400).rounded())
    var dy: Int32 = 0
    var dx: Int32 = 0
    switch direction {
    case "up": dy = pixels
    case "down": dy = -pixels
    case "left": dx = pixels
    default: dx = -pixels
    }
    guard let event = CGEvent(scrollWheelEvent2Source: CGEventSource(stateID: .hidSystemState), units: .pixel, wheelCount: 2, wheel1: dy, wheel2: dx, wheel3: 0) else { return false }
    event.location = point
    postedMouse = true
    event.postToPid(pid)
    return true
}

// MARK: menus

func menuTitle(_ element: AXUIElement) -> String { axString(element, "AXTitle") }

func normalizedTitle(_ text: String) -> String {
    var value = text.replacingOccurrences(of: "&", with: "").trimmingCharacters(in: .whitespaces).lowercased()
    for tail in ["…", "..."] where value.hasSuffix(tail) { value = String(value.dropLast(tail.count)).trimmingCharacters(in: .whitespaces) }
    return value
}

func menuBar(_ pid: pid_t) throws -> AXUIElement {
    guard let bar = axValue(appElement(pid), "AXMenuBar"), CFGetTypeID(bar) == AXUIElementGetTypeID() else {
        throw Fail("unsupported_action", "That app exposes no menu bar.")
    }
    return bar as! AXUIElement
}

func menuChildren(_ container: AXUIElement) -> [AXUIElement] {
    let role = axString(container, "AXRole")
    if role == "AXMenuBar" || role == "AXMenu" { return axChildren(container) }
    // A menu bar item or menu item keeps its items inside an AXMenu child.
    return axChildren(container).first(where: { axString($0, "AXRole") == "AXMenu" }).map(axChildren) ?? []
}

func findMenuItem(_ container: AXUIElement, _ title: String) -> AXUIElement? {
    let wanted = normalizedTitle(title)
    return menuChildren(container).first { normalizedTitle(menuTitle($0)) == wanted }
}

func menuItem(_ pid: pid_t, _ path: [String]) throws -> AXUIElement {
    var current = try menuBar(pid)
    for title in path {
        guard let next = findMenuItem(current, title) else { throw Fail("not_found", "No such menu item.") }
        current = next
    }
    return current
}

func pressMenu(_ pid: pid_t, _ path: [String]) throws {
    guard !path.isEmpty else { throw Fail("bad_request", "menu needs a path.") }
    let item = try menuItem(pid, path)
    if (axValue(item, "AXEnabled") as? NSNumber)?.boolValue == false { throw Fail("failed", "That menu item is disabled.") }
    let result = AXUIElementPerformAction(item, "AXPress" as CFString)
    if result != .success { throw Fail("failed", "Press failed (\(result.rawValue)).") }
}

func shortcut(_ item: AXUIElement) -> String? {
    let key = axString(item, "AXMenuItemCmdChar")
    guard !key.isEmpty else { return nil }
    let mods = Int((axValue(item, "AXMenuItemCmdModifiers") as? NSNumber)?.intValue ?? 0)
    var text = ""
    if mods & 4 != 0 { text += "⌃" }
    if mods & 2 != 0 { text += "⌥" }
    if mods & 1 != 0 { text += "⇧" }
    if mods & 8 == 0 { text += "⌘" }
    return text + key
}

func listMenu(_ pid: pid_t, _ path: [String]) throws -> [JSON] {
    let container = try menuItem(pid, path)
    return menuChildren(container).compactMap { item in
        let title = menuTitle(item)
        if title.isEmpty { return nil }
        var out: JSON = ["title": title, "enabled": (axValue(item, "AXEnabled") as? NSNumber)?.boolValue ?? true]
        if let keys = shortcut(item) { out["shortcut"] = keys }
        if !menuChildren(item).isEmpty { out["submenu"] = true }
        return out
    }
}

// MARK: screenshot

func waitFor(_ done: () -> Bool, timeout: Double = 5) -> Bool {
    let end = Date().addingTimeInterval(timeout)
    while !done() && Date() < end { RunLoop.current.run(mode: .default, before: Date().addingTimeInterval(0.01)) }
    return done()
}

func jpegReply(_ image: CGImage, _ frame: CGRect) throws -> JSON {
    guard let jpeg = NSBitmapImageRep(cgImage: image).representation(using: .jpeg, properties: [.compressionFactor: 0.55]) else {
        throw Fail("failed", "Could not encode the window.")
    }
    return [
        "image": jpeg.base64EncodedString(), "imageWidth": image.width, "imageHeight": image.height,
        "windowX": frame.origin.x, "windowY": frame.origin.y, "windowWidth": frame.width, "windowHeight": frame.height,
    ]
}

func targetSize(_ frame: CGRect, _ maxWidth: Int) -> (width: Int, height: Int) {
    let scale = NSScreen.main?.backingScaleFactor ?? 2
    let width = max(1, min(min(max(maxWidth, 320), 1280), Int(frame.width * scale)))
    return (width, max(1, Int((Double(width) * frame.height / frame.width).rounded())))
}

// ScreenCaptureKit's screenshot call needs macOS 14; the app supports 13.
@available(macOS 14, *)
func captureWithScreenCaptureKit(_ pid: pid_t, maxWidth: Int) throws -> JSON {
    _ = NSApplication.shared
    var content: SCShareableContent?
    var finished = false
    SCShareableContent.getExcludingDesktopWindows(true, onScreenWindowsOnly: true) { found, _ in content = found; finished = true }
    guard waitFor({ finished }), let windows = content?.windows else { throw Fail("failed", "Could not list windows to capture.") }
    var best: SCWindow?
    for window in windows where window.owningApplication?.processID == pid && window.windowLayer == 0 {
        if window.frame.width < 40 || window.frame.height < 40 { continue }
        if best == nil || window.frame.width * window.frame.height > best!.frame.width * best!.frame.height { best = window }
    }
    guard let window = best else { throw Fail("no_window", "That app has no window to capture.") }
    let size = targetSize(window.frame, maxWidth)
    let configuration = SCStreamConfiguration()
    configuration.width = size.width
    configuration.height = size.height
    configuration.showsCursor = false
    var image: CGImage?
    finished = false
    SCScreenshotManager.captureImage(contentFilter: SCContentFilter(desktopIndependentWindow: window), configuration: configuration) { captured, _ in
        image = captured
        finished = true
    }
    guard waitFor({ finished }), let image else { throw Fail("failed", "Could not capture that window.") }
    return try jpegReply(image, window.frame)
}

func captureWithScreencapture(_ pid: pid_t, maxWidth: Int) throws -> JSON {
    var bestId: CGWindowID = 0
    var bestBounds = CGRect.zero
    let info = CGWindowListCopyWindowInfo([.optionOnScreenOnly, .excludeDesktopElements], kCGNullWindowID) as? [[String: Any]] ?? []
    for item in info where (item[kCGWindowOwnerPID as String] as? NSNumber)?.int32Value == pid && (item[kCGWindowLayer as String] as? NSNumber)?.intValue == 0 {
        guard let bounds = item[kCGWindowBounds as String] as? [String: Any] else { continue }
        func part(_ name: String) -> Double { (bounds[name] as? NSNumber)?.doubleValue ?? 0 }
        let frame = CGRect(x: part("X"), y: part("Y"), width: part("Width"), height: part("Height"))
        if frame.width < 40 || frame.height < 40 || frame.width * frame.height <= bestBounds.width * bestBounds.height { continue }
        bestId = (item[kCGWindowNumber as String] as? NSNumber)?.uint32Value ?? 0
        bestBounds = frame
    }
    guard bestId != 0 else { throw Fail("no_window", "That app has no window to capture.") }
    let file = FileManager.default.temporaryDirectory.appendingPathComponent("alans-way-\(bestId).png")
    defer { try? FileManager.default.removeItem(at: file) }
    let process = Process()
    process.executableURL = URL(fileURLWithPath: "/usr/sbin/screencapture")
    process.arguments = ["-l", String(bestId), "-x", "-o", "-t", "png", file.path]
    do { try process.run(); process.waitUntilExit() } catch { throw Fail("failed", "Could not capture that window.") }
    guard process.terminationStatus == 0, let data = try? Data(contentsOf: file), let source = NSBitmapImageRep(data: data), source.pixelsWide > 1 else {
        throw Fail("failed", "Could not capture that window.")
    }
    let size = targetSize(bestBounds, maxWidth)
    guard let rep = NSBitmapImageRep(bitmapDataPlanes: nil, pixelsWide: size.width, pixelsHigh: size.height, bitsPerSample: 8, samplesPerPixel: 4,
                                     hasAlpha: true, isPlanar: false, colorSpaceName: .deviceRGB, bytesPerRow: 0, bitsPerPixel: 0),
          let context = NSGraphicsContext(bitmapImageRep: rep) else { throw Fail("failed", "Could not encode the window.") }
    NSGraphicsContext.saveGraphicsState()
    NSGraphicsContext.current = context
    source.draw(in: NSRect(x: 0, y: 0, width: size.width, height: size.height))
    NSGraphicsContext.restoreGraphicsState()
    guard let image = rep.cgImage else { throw Fail("failed", "Could not encode the window.") }
    return try jpegReply(image, bestBounds)
}

func captureWindow(_ pid: pid_t, maxWidth: Int) throws -> JSON {
    guard CGPreflightScreenCaptureAccess() else {
        throw Fail("permission", "Screen Recording is off for this program. Turn it on in System Settings → Privacy & Security → Screen Recording, then retry.")
    }
    // HERMES_COMPUTER_SCREENCAPTURE=1 forces the older path, which is what macOS 13 runs.
    if #available(macOS 14, *), ProcessInfo.processInfo.environment["HERMES_COMPUTER_SCREENCAPTURE"] != "1" {
        do { return try captureWithScreenCaptureKit(pid, maxWidth: maxWidth) }
        catch let failure as Fail where failure.code != "failed" { throw failure }
        catch { /* fall through to screencapture */ }
    }
    return try captureWithScreencapture(pid, maxWidth: maxWidth)
}

// MARK: requests

func number(_ value: Any?) -> Double? { (value as? NSNumber)?.doubleValue }

func pidOf(_ request: JSON) throws -> pid_t {
    guard let value = request["pid"] as? NSNumber else { throw Fail("bad_request", "That request needs a pid.") }
    return value.int32Value
}

func pointOrRef(_ pid: pid_t, _ step: JSON) throws -> (point: CGPoint, element: AXUIElement?, node: Node?) {
    if let ref = step["ref"] as? String {
        let node = try resolve(pid, ref)
        guard let frame = axFrame(node.element) ?? node.frame, frame.width > 0, frame.height > 0 else { throw Fail("failed", "That control has no position.") }
        return (CGPoint(x: frame.midX, y: frame.midY), node.element, node)
    }
    guard let x = number(step["x"]), let y = number(step["y"]) else { throw Fail("bad_request", "That action needs a ref or x and y.") }
    let point = CGPoint(x: x, y: y)
    let hit = elementAt(pid, point)
    if let hit, isSecure(hit) { throw Fail("off_limits", "Password fields are off limits.") }
    return (point, hit, nil)
}

func runStep(_ pid: pid_t, _ step: JSON) throws -> JSON {
    let before = cursor()
    postedMouse = false
    var out: JSON = [:]
    switch step["action"] as? String ?? "" {
    case "press":
        let node = try resolve(pid, step["ref"] as? String ?? "")
        try rejectSecure(node)
        try rejectSecureFocusForMenu(pid, node.element)
        out["via"] = try pressElement(pid, node.element, role: node.role)
    case "type":
        let node = try resolve(pid, step["ref"] as? String ?? "")
        try rejectSecure(node)
        guard let text = step["text"] as? String else { throw Fail("bad_request", "type needs text.") }
        if text.count > 2000 { throw Fail("bad_request", "Text is too long.") }
        let result = AXUIElementSetAttributeValue(node.element, "AXValue" as CFString, text as CFString)
        if result != .success { throw Fail("failed", "Could not set that text (\(result.rawValue)).") }
    case "click":
        guard let x = number(step["x"]), let y = number(step["y"]) else { throw Fail("bad_request", "click needs x and y.") }
        let point = CGPoint(x: x, y: y)
        if let element = elementAt(pid, point) {
            if isSecure(element) { throw Fail("off_limits", "Password fields are off limits.") }
            try rejectSecureFocusForMenu(pid, element)
            if AXUIElementPerformAction(element, "AXPress" as CFString) == .success { out["via"] = "ax" }
            else if let ancestor = pressableAncestor(element), AXUIElementPerformAction(ancestor, "AXPress" as CFString) == .success { out["via"] = "ancestor" }
        }
        if out["via"] == nil {
            postMouse(pid, axToQuartz(point), button: .left, clicks: 1, dragTo: nil)
            out["via"] = "event"
        }
    case "double_click":
        let target = try pointOrRef(pid, step)
        if let node = target.node { try rejectSecure(node) }
        try rejectSecureFocusForMenu(pid, target.element)
        if let element = target.element, actionNames(element).contains("AXOpen"), AXUIElementPerformAction(element, "AXOpen" as CFString) == .success { out["via"] = "ax" }
        else {
            postMouse(pid, axToQuartz(target.point), button: .left, clicks: 2, dragTo: nil)
            out["via"] = "event"
        }
    case "right_click":
        let target = try pointOrRef(pid, step)
        if let node = target.node { try rejectSecure(node) }
        try rejectSecureFocusForMenu(pid, target.element)
        if let element = target.element, AXUIElementPerformAction(element, "AXShowMenu" as CFString) == .success { out["via"] = "ax" }
        else {
            postMouse(pid, axToQuartz(target.point), button: .right, clicks: 1, dragTo: nil)
            out["via"] = "event"
        }
    case "drag":
        guard let x = number(step["x"]), let y = number(step["y"]), let x2 = number(step["x2"]), let y2 = number(step["y2"]) else {
            throw Fail("bad_request", "drag needs x y x2 y2.")
        }
        let start = CGPoint(x: x, y: y), end = CGPoint(x: x2, y: y2)
        if let element = elementAt(pid, start), isSecure(element) { throw Fail("off_limits", "Password fields are off limits.") }
        if let element = elementAt(pid, end), isSecure(element) { throw Fail("off_limits", "Password fields are off limits.") }
        if setSliderValue(pid: pid, from: start, to: end) { out["via"] = "ax" }
        else {
            postMouse(pid, axToQuartz(start), button: .left, clicks: 1, dragTo: axToQuartz(end))
            out["via"] = "event"
        }
    case "scroll":
        let direction = step["direction"] as? String ?? "down"
        let amount = number(step["amount"]) ?? 1
        var anchor: (point: CGPoint, element: AXUIElement?, node: Node?)?
        if step["ref"] != nil || step["x"] != nil { anchor = try pointOrRef(pid, step) }
        if anchor == nil, let window = (axValue(appElement(pid), "AXFocusedWindow") ?? (axValue(appElement(pid), "AXWindows") as? [AXUIElement])?.first),
           CFGetTypeID(window) == AXUIElementGetTypeID(), let frame = axFrame(window as! AXUIElement) {
            anchor = (CGPoint(x: frame.midX, y: frame.midY), elementAt(pid, CGPoint(x: frame.midX, y: frame.midY)), nil)
        }
        guard let anchor else { throw Fail("no_window", "That app has no window to scroll.") }
        var scrolled: Bool?
        if let element = anchor.element, let area = scrollAreaAbove(element) { scrolled = scrollByBar(area, direction: direction, amount: amount) }
        if scrolled == nil { scrolled = scrollByWheel(pid, at: axToQuartz(anchor.point), direction: direction, amount: amount) }
        out["scrolled"] = scrolled ?? false
    case "key":
        try rejectSecureFocus(pid)
        try postKey(pid, key: step["key"] as? String ?? "", modifiers: step["modifiers"] as? [String] ?? [])
    case "menu":
        try rejectSecureFocus(pid)
        try pressMenu(pid, step["path"] as? [String] ?? [])
    default:
        throw Fail("unsupported_action", "That action is not supported.")
    }
    out["ok"] = true
    if out["via"] as? String == "event" {
        out["note"] = "Posted as mouse events, which background windows often ignore. Check the returned tree."
    }
    // Only a step that posted mouse events can have moved the pointer; any other
    // movement is the person's own and must not be undone.
    out["cursorMoved"] = postedMouse ? restoreCursor(before) : false
    return out
}

func act(_ request: JSON) throws -> JSON {
    let pid = try pidOf(request)
    try requireAccessibility()
    try checkApp(pid)
    let steps = request["steps"] as? [JSON] ?? []
    let menubar = request["menubar"] as? Bool ?? caches[pid]?.menubar ?? false
    if steps.contains(where: { $0["ref"] is String }) {
        try ensureCache(pid, (request["generation"] as? NSNumber)?.intValue, menubar: menubar)
    }
    var results: [JSON] = []
    var succeeded = false
    for step in steps {
        do {
            results.append(try runStep(pid, step))
            succeeded = true
        } catch let failure as Fail {
            results.append(["ok": false, "error": failure.message, "code": failure.code])
            break
        }
    }
    var reply: JSON = ["results": results]
    if succeeded, request["snapshot"] as? Bool ?? true {
        usleep(UInt32(max(0, min(1000, (request["settleMs"] as? NSNumber)?.intValue ?? 60))) * 1000)
        // The steps already ran; a tree that cannot be read afterwards must not hide their results.
        if let walk = try? refresh(pid, menubar: menubar) { for (key, value) in snapshotFields(walk) { reply[key] = value } }
        else { reply["note"] = "unresponsive: the steps ran but the app stopped responding, so there is no tree. Do not repeat them; take a fresh snapshot." }
    }
    return reply
}

func dispatch(_ request: JSON) throws -> JSON {
    if let policy = request["policy"] as? JSON { setPolicy(policy) }
    switch request["cmd"] as? String ?? "" {
    case "init":
        return ["protocol": 2]
    case "selftest":
        return try selftest()
    case "apps":
        try requireAccessibility()
        let front = NSWorkspace.shared.frontmostApplication?.processIdentifier
        let apps = NSWorkspace.shared.runningApplications.filter { $0.activationPolicy == .regular }.map { app -> JSON in
            ["name": app.localizedName ?? "", "bundleId": app.bundleIdentifier ?? "", "pid": Int(app.processIdentifier), "frontmost": app.processIdentifier == front]
        }
        return ["apps": apps]
    case "snapshot":
        let pid = try pidOf(request)
        try requireAccessibility()
        try checkApp(pid)
        return snapshotFields(try refresh(pid, menubar: request["menubar"] as? Bool ?? false))
    case "act":
        return try act(request)
    case "menu":
        let pid = try pidOf(request)
        try requireAccessibility()
        try checkApp(pid)
        return ["items": try listMenu(pid, request["path"] as? [String] ?? [])]
    case "shot":
        let pid = try pidOf(request)
        try checkApp(pid)
        return try captureWindow(pid, maxWidth: (request["maxWidth"] as? NSNumber)?.intValue ?? 960)
    default:
        throw Fail("bad_request", "unknown command \(request["cmd"] as? String ?? "")")
    }
}

func respond(_ request: JSON) -> JSON {
    var out: JSON
    do {
        out = try dispatch(request)
        out["ok"] = true
    } catch let failure as Fail {
        out = ["ok": false, "error": failure.message, "code": failure.code]
    } catch {
        out = ["ok": false, "error": "\(error)", "code": "failed"]
    }
    if let id = request["id"] { out["id"] = id }
    return out
}

func write(_ value: JSON) {
    guard let data = try? JSONSerialization.data(withJSONObject: value, options: [.withoutEscapingSlashes]) else { return }
    FileHandle.standardOutput.write(data)
    FileHandle.standardOutput.write(Data([0x0A]))
}

func parse(_ line: String) -> JSON? {
    guard let data = line.data(using: .utf8), let value = try? JSONSerialization.jsonObject(with: data) else { return nil }
    return value as? JSON
}

// MARK: self test

func selftest() throws -> JSON {
    var checks = 0
    func expect(_ condition: Bool, _ message: String) throws {
        checks += 1
        if !condition { throw Fail("failed", "selftest: \(message)") }
    }
    for frame in [CGRect(x: 100, y: 80, width: 300, height: 200), CGRect(x: -1920, y: -300, width: 640, height: 480), CGRect(x: 2560, y: 40, width: 100, height: 100)] {
        let center = CGPoint(x: frame.midX, y: frame.midY)
        try expect(axToQuartz(center) == center, "axToQuartz must not flip \(center)")
    }
    try expect(fnv("abc") == 440920331, "fnv abc")
    try expect(fnv("") == 18652613, "fnv empty")
    let sample = [
        Elem(ref: "c1", role: "AXButton", name: "Save", value: "", frame: CGRect(x: 10, y: 20, width: 30, height: 40)),
        Elem(ref: "c2", role: "AXTextField", name: "Name", value: "héllo", frame: CGRect(x: 0, y: 0, width: 5, height: 6)),
    ]
    try expect(generation(of: sample) == 1574858671, "generation vector")
    try expect(rounded(2.5) == "3" && rounded(-0.5) == "0" && rounded(10.4) == "10", "rounding")
    let saved = (policyExact, policyContains)
    setPolicy(["exact": ["com.apple.Passwords"], "contains": ["1Password"]])
    try expect(isBlocked("com.apple.passwords") && isBlocked("com.1password.1password") && !isBlocked("com.apple.TextEdit") && !isBlocked(""), "policy matching")
    (policyExact, policyContains) = saved
    try expect(normalizedTitle("Save As…") == "save as" && normalizedTitle("&Open...") == "open", "menu titles")
    try expect(keyCodes["return"] == 36 && keyCodes["f5"] == 96 && keyCodes["a"] == 0, "key codes")
    try expect(keyFlags(["shift", "meta"]) == [.maskShift, .maskCommand], "key flags")
    return ["checks": checks]
}

// MARK: entry

func serve() -> Never {
    setvbuf(stdout, nil, _IOLBF, 0)
    // Requests run on the main thread so NSWorkspace keeps its view of the
    // frontmost app current.
    Thread.detachNewThread {
        while let line = readLine(strippingNewline: true) {
            if line.trimmingCharacters(in: .whitespaces).isEmpty { continue }
            DispatchQueue.main.sync {
                if let request = parse(line) { write(respond(request)) }
                else { write(["ok": false, "error": "Invalid JSON.", "code": "bad_request"]) }
            }
        }
        exit(0)
    }
    RunLoop.main.run()
    exit(0)
}

func legacyRequest(_ args: [String]) -> JSON? {
    func pid(_ index: Int) -> Int? { args.count > index ? Int(args[index]) : nil }
    func num(_ index: Int) -> Double? { args.count > index ? Double(args[index]) : nil }
    switch args[0] {
    case "apps": return ["cmd": "apps"]
    case "snapshot": return pid(1).map { ["cmd": "snapshot", "pid": $0] }
    case "shot": return pid(1).map { ["cmd": "shot", "pid": $0, "maxWidth": args.count > 2 ? Int(args[2]) ?? 960 : 960] }
    case "press": return pid(1).flatMap { p in args.count > 2 ? ["cmd": "act", "pid": p, "snapshot": false, "steps": [["action": "press", "ref": args[2]]]] : nil }
    case "type": return pid(1).flatMap { p in args.count > 3 ? ["cmd": "act", "pid": p, "snapshot": false, "steps": [["action": "type", "ref": args[2], "text": args[3]]]] : nil }
    case "click":
        guard let p = pid(1), let x = num(2), let y = num(3) else { return nil }
        return ["cmd": "act", "pid": p, "snapshot": false, "steps": [["action": "click", "x": x, "y": y]]]
    case "drag":
        guard let p = pid(1), let x = num(2), let y = num(3), let x2 = num(4), let y2 = num(5) else { return nil }
        return ["cmd": "act", "pid": p, "snapshot": false, "steps": [["action": "drag", "x": x, "y": y, "x2": x2, "y2": y2]]]
    default: return nil
    }
}

func finish(_ response: JSON) -> Never {
    write(response)
    exit(response["ok"] as? Bool == true ? 0 : 1)
}

let args = Array(CommandLine.arguments.dropFirst())
// The system-wide element sets the default for every element in this process, so a hung app costs one second per call, not the system default.
AXUIElementSetMessagingTimeout(AXUIElementCreateSystemWide(), 1.0)
guard let mode = args.first else { finish(["ok": false, "error": "missing command", "code": "bad_request"]) }

switch mode {
case "serve":
    serve()
case "once":
    guard let line = readLine(), let request = parse(line) else { finish(["ok": false, "error": "Invalid JSON.", "code": "bad_request"]) }
    finish(respond(request))
case "selftest":
    finish(respond(["cmd": "selftest"]))
default:
    guard let request = legacyRequest(args) else { finish(["ok": false, "error": "unknown command \(mode)", "code": "bad_request"]) }
    var response = respond(request)
    if request["cmd"] as? String == "act", response["ok"] as? Bool == true, let first = (response["results"] as? [JSON])?.first {
        response = first
    }
    response["id"] = nil
    finish(response)
}
