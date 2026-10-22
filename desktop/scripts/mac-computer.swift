import AppKit
import ApplicationServices
import CoreGraphics
import Foundation
import ScreenCaptureKit

// Reads and drives a Mac app through Accessibility without moving the pointer.
// Explicit activation requires idle input. Protocol v2: JSON lines, see `serve`.

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
// Close, minimize and zoom never need the agent, and every window has them.
let windowChrome: Set<String> = ["AXCloseButton", "AXMinimizeButton", "AXZoomButton", "AXFullScreenButton"]
let rowRoles: Set<String> = ["AXRow", "AXOutlineRow"]
// The C macro for any input event is not imported by Swift.
let kCGAnyInputEventType = CGEventType(rawValue: UInt32.max)!
let inFrontMessage = "You are using that app right now. Retry in a few seconds after you stop using the keyboard and mouse."

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

// While the screen is locked Accessibility answers with menu-bar strips in
// place of windows, so say so instead of handing back that tree.
func screenLocked() -> Bool {
    (CGSessionCopyCurrentDictionary() as? [String: Any])?["CGSSessionScreenIsLocked"] as? Bool == true
}

@discardableResult
func checkApp(_ pid: pid_t, action: Bool = false, activating: Bool = false) throws -> NSRunningApplication {
    guard let app = NSRunningApplication(processIdentifier: pid), app.activationPolicy == .regular, !app.isTerminated else {
        throw Fail("not_found", "App not found.")
    }
    if isBlocked(app.bundleIdentifier ?? "") { throw Fail("off_limits", "That app is off limits.") }
    if screenLocked() { throw Fail("locked", "The screen is locked, so apps cannot be read or driven. Ask the user to unlock it, then retry.") }
    if action && (activating || NSWorkspace.shared.frontmostApplication?.processIdentifier == pid),
       CGEventSource.secondsSinceLastEventType(.combinedSessionState, eventType: kCGAnyInputEventType) < 2 {
        throw Fail("in_front", inFrontMessage)
    }
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

let walkAttributes = ["AXRole", "AXSubrole", "AXTitle", "AXDescription", "AXValue", "AXEnabled", "AXFrame", "AXChildren", "AXPlaceholderValue", "AXExpanded", "AXDisclosing"]

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
    var expanded: NSNumber?
    var frame: CGRect?
    var kids: [Node] = []
    var ref = ""
    var name = ""
    var shownValue = ""
    // The visible rect of the nearest scroll area above, and whether a row is.
    var clip: CGRect?
    var inRow = false
    // The name of the row a control sits in: a recycled row keeps its buttons.
    var context = ""

    init(_ element: AXUIElement, depth: Int, limit: Int) {
        self.element = element
        self.depth = depth
        self.limit = limit
    }

    // Cells and text inside a row are read into the row's name, not listed again.
    var readable: Bool {
        if inRow && (role == "AXCell" || role == "AXStaticText") { return false }
        return interactive.contains(role) || role == "AXStaticText"
    }
    var secure: Bool { subrole == "AXSecureTextField" || role == "AXSecureTextField" }
}

struct Elem {
    var ref: String
    var role: String
    var name: String
    var value: String
    var frame: CGRect?
    var actions: [String] = []

    var json: JSON {
        var out: JSON = ["ref": ref, "role": role, "name": name]
        if !value.isEmpty { out["value"] = value }
        if !actions.isEmpty { out["actions"] = actions }
        if let frame {
            out["x"] = whole(frame.origin.x)
            out["y"] = whole(frame.origin.y)
            out["width"] = whole(frame.width)
            out["height"] = whole(frame.height)
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

func whole(_ number: Double) -> Int { Int(rounded(number)) ?? 0 }

func generation(of elements: [Elem]) -> Int {
    fnv(elements.map { item in
        let box = item.frame.map { [rounded($0.origin.x), rounded($0.origin.y), rounded($0.width), rounded($0.height)] } ?? ["", "", "", ""]
        return ([item.ref, item.role, item.name, item.value] + box + item.actions).joined(separator: "|")
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
    node.expanded = (attributes["AXExpanded"] as? NSNumber) ?? (attributes["AXDisclosing"] as? NSNumber)
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
    // The raw state feeds the tree hash: a flip hidden by a cut label, mixed, or a triangle's state still changes it.
    if toggles.contains(role), let number = node.value as? NSNumber { shown = String(number.intValue) }
    if !node.enabled { name += name.isEmpty ? "disabled" : " disabled" }
    node.name = String(name.prefix(120))
    node.shownValue = shown
}

struct Walk {
    var elements: [Elem]
    var nodes: [String: Node]
    var truncated: Bool
    var generation: Int
    var hidden = 0
    var note: String?
    var windowId: CGWindowID?
    var windowFrame: CGRect?
}

// MARK: stable refs

// AXUIElement equality is the app's own identity for a control, so a control
// keeps its ref across walks while it exists. Apps that rebuild their tree get
// the ref of the control with the same role, name and position among
// namesakes, and anything new gets the next unused number.
struct AXKey: Hashable {
    let element: AXUIElement
    static func == (a: AXKey, b: AXKey) -> Bool { CFEqual(a.element, b.element) }
    func hash(into hasher: inout Hasher) { hasher.combine(CFHash(element)) }
}

final class RefBook {
    var byElement: [AXKey: String] = [:]
    var byLabel: [String: String] = [:]
    var next = 1
    // What each ref named in the last few trees handed out.
    var history: [(generation: Int, windowId: CGWindowID?, seen: [String: Seen])] = []
    // A caller still acting from a tree: a batch that waits walks every 150 ms
    // and would push it out of history before its later steps run.
    var pinned: [(generation: Int, windowId: CGWindowID?, seen: [String: Seen])] = []
}

struct Seen {
    let key: AXKey
    let signature: String
}

// A toggle's own state, apart from its label: a long label is cut before " on"/" off", mixed reads as "on", and a disclosure triangle shows none.
let toggles: Set<String> = ["AXCheckBox", "AXRadioButton", "AXDisclosureTriangle"]

func signature(_ node: Node) -> String {
    let state = toggles.contains(node.role) ? (node.value as? NSNumber).map { "|\($0.intValue)" } ?? "" : ""
    // Expand/collapse joins the label check too: a press must not undo a tree
    // item the user opened or shut since the snapshot.
    let expanded = node.expanded.map { "|\($0.boolValue ? 1 : 0)" } ?? ""
    return "\(node.role)|\(node.name)|\(node.context)\(state)\(expanded)"
}

// A ref from an older tree still means what the caller saw only when it is the
// same control (a ref re-bound by label in an app that rebuilt its tree is not)
// with the same label in the same row and, for a toggle, the same state.
func stillSame(_ then: Seen, _ node: Node) -> Bool {
    then.key == AXKey(element: node.element) && then.signature == signature(node)
}

var refBooks: [pid_t: RefBook] = [:]

func assignRefs(_ items: [(key: AXKey, label: String)], _ book: RefBook) -> [String] {
    var refs = [String?](repeating: nil, count: items.count)
    var used: Set<String> = []
    for (index, item) in items.enumerated() {
        if let ref = book.byElement[item.key], !used.contains(ref) { refs[index] = ref; used.insert(ref) }
    }
    for (index, item) in items.enumerated() where refs[index] == nil {
        if let ref = book.byLabel[item.label], !used.contains(ref) { refs[index] = ref; used.insert(ref) }
    }
    var byElement: [AXKey: String] = [:]
    var byLabel: [String: String] = [:]
    for (index, item) in items.enumerated() {
        let ref = refs[index] ?? { defer { book.next += 1 }; return "c\(book.next)" }()
        refs[index] = ref
        byElement[item.key] = ref
        byLabel[item.label] = ref
    }
    book.byElement = byElement
    book.byLabel = byLabel
    return refs.map { $0! }
}

func seenMap(_ walk: Walk) -> [String: Seen] {
    walk.nodes.mapValues { Seen(key: AXKey(element: $0.element), signature: signature($0)) }
}

func remember(_ book: RefBook, _ walk: Walk) {
    // Only identical records ever share a generation: a conflicting walk takes
    // the next free one first (see conflicts), so the record a generation first
    // named always stands.
    if book.history.last?.generation == walk.generation { return }
    book.history.append((walk.generation, walk.windowId, seenMap(walk)))
    if book.history.count > 8 { book.history.removeFirst() }
}

func seenAt(_ book: RefBook, _ generation: Int) -> [String: Seen]? {
    book.history.last(where: { $0.generation == generation })?.seen ?? book.pinned.last(where: { $0.generation == generation })?.seen
}

// True when the generation is already taken by a record that names different
// controls or states — same fingerprint, new identities. The walk then takes
// the next free generation instead of borrowing the record callers still cite.
func conflicts(_ book: RefBook, _ generation: Int, _ seen: [String: Seen]) -> Bool {
    guard let recorded = seenAt(book, generation) else { return false }
    if recorded.count != seen.count { return true }
    for (ref, now) in seen {
        guard let then = recorded[ref], then.key == now.key, then.signature == now.signature else { return true }
    }
    return false
}

func pin(_ book: RefBook, _ generation: Int) {
    guard let seen = seenAt(book, generation) else { return }
    let windowId = (book.history + book.pinned).last(where: { $0.generation == generation })?.windowId
    book.pinned.removeAll { $0.generation == generation }
    book.pinned.append((generation, windowId, seen))
    if book.pinned.count > 4 { book.pinned.removeFirst() }
}

// MARK: windows Accessibility cannot see

// Apps also own untitled off-screen windows that are never shown (a 500x500
// one at the screen's bottom-left, menu-bar strips); a real window on another
// Space has its title. Titles need Screen Recording; without it this says no.
func hasOffscreenWindow(_ pid: pid_t) -> Bool {
    let info = CGWindowListCopyWindowInfo([.optionAll, .excludeDesktopElements], kCGNullWindowID) as? [[String: Any]] ?? []
    return info.contains { item in
        guard (item[kCGWindowOwnerPID as String] as? NSNumber)?.int32Value == pid,
              (item[kCGWindowLayer as String] as? NSNumber)?.intValue == 0,
              (item[kCGWindowIsOnscreen as String] as? NSNumber)?.boolValue != true,
              !(item[kCGWindowName as String] as? String ?? "").isEmpty,
              let bounds = item[kCGWindowBounds as String] as? [String: Any] else { return false }
        return ((bounds["Width"] as? NSNumber)?.doubleValue ?? 0) >= 40 && ((bounds["Height"] as? NSNumber)?.doubleValue ?? 0) >= 40
    }
}

let otherSpaceNote = "No window of this app is readable: its windows are on another Space, minimized or hidden (a full-screen app in front puts them on another Space). Its menus and a screenshot still work. To use its controls, bring it forward with activate, then take a fresh snapshot."
let noWindowNote = "This app has no open windows. Open one with its shortcut (for example cmd+n or cmd+o) or its menus (menubar:true, for example File > New), then take a fresh snapshot."
let unsureWindowNote = "Window titles are unavailable. This does not mean the app is closed. Continue with its available controls and menus; if it has no task window, open one."

func walkApp(_ pid: pid_t, menubar: Bool, windowId: CGWindowID? = nil) throws -> Walk {
    let app = appElement(pid)
    var roots: [Node] = []
    // An app with no windows answers with an empty list or "no value"; one that
    // cannot answer at all is hung, and an empty tree would pass for a blank app.
    var windows: CFTypeRef?
    let listed = AXUIElementCopyAttributeValue(app, "AXWindows" as CFString, &windows)
    if listed != .success && listed != .noValue && listed != .attributeUnsupported {
        throw Fail("unresponsive", "That app is not responding.")
    }
    let selected = try selectedWindow(pid, windowId)
    if let selected, selected.onScreen {
        let readableWindows = windows as? [AXUIElement] ?? []
        let matches = readableWindows.filter { matchesWindow($0, selected) }
        guard matches.count == 1 else { throw Fail("window_unverified", "Could not match that window to its controls. Take a fresh snapshot.") }
        roots.append(Node(matches[0], depth: 0, limit: depthCap))
    }
    let note = roots.isEmpty ? (hasOffscreenWindow(pid) ? otherSpaceNote : CGPreflightScreenCaptureAccess() ? noWindowNote : unsureWindowNote) : nil
    if menubar {
        roots.append(Node(try menuBar(pid), depth: 0, limit: 1))
    }
    var queue = roots
    var head = 0
    var readable = 0
    var visits = 0
    var truncated = false
    var dropped = false
    var hidden = 0
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
        if windowChrome.contains(node.subrole) { node.visited = false; continue }
        // Scrolled out of view: the agent scrolls to reach it, as a person would.
        if let clip = node.clip, let frame = node.frame, frame.width > 0, frame.height > 0, !frame.intersects(clip) {
            node.visited = false
            hidden += 1
            continue
        }
        if node.readable { readable += 1 }
        if node.depth < node.limit, let children = attributes["AXChildren"] as? [AXUIElement] {
            var clip = node.clip
            if node.role == "AXScrollArea", let frame = node.frame, frame.width > 0, frame.height > 0 { clip = clip.map { $0.intersection(frame) } ?? frame }
            let inRow = node.inRow || rowRoles.contains(node.role)
            node.kids = children.map { child in
                let kid = Node(child, depth: node.depth + 1, limit: node.limit)
                kid.clip = clip
                kid.inRow = inRow
                return kid
            }
            queue.append(contentsOf: node.kids)
        }
    }
    if head < queue.count || dropped { truncated = true }
    var found: [Node] = []
    func emit(_ node: Node, _ row: String) {
        guard node.visited else { return }
        var row = row
        if node.readable {
            describe(node)
            // Scroll bar arrows and other collapsed parts: nothing to read or press.
            if node.name.isEmpty, let frame = node.frame, frame.width <= 0 || frame.height <= 0 { for kid in node.kids { emit(kid, row) }; return }
            node.context = row
            if rowRoles.contains(node.role) { row = node.name }
            found.append(node)
        }
        for kid in node.kids { emit(kid, row) }
    }
    for root in roots { emit(root, "") }
    let book = refBooks[pid] ?? RefBook()
    refBooks[pid] = book
    return record(found, book, truncated: truncated, hidden: hidden, note: note, windowId: selected?.id, windowFrame: selected?.frame)
}

func record(_ found: [Node], _ book: RefBook, truncated: Bool = false, hidden: Int = 0, note: String? = nil, windowId: CGWindowID? = nil, windowFrame: CGRect? = nil) -> Walk {
    var namesakes: [String: Int] = [:]
    let items = found.map { node -> (key: AXKey, label: String) in
        let label = "\(node.role)|\(node.name)"
        let ordinal = namesakes[label, default: 0]
        namesakes[label] = ordinal + 1
        return (AXKey(element: node.element), "\(label)|\(ordinal)")
    }
    var elements: [Elem] = []
    var nodes: [String: Node] = [:]
    for (node, ref) in zip(found, assignRefs(items, book)) {
        node.ref = ref
        nodes[ref] = node
        elements.append(Elem(ref: ref, role: node.role, name: node.name, value: node.shownValue, frame: node.frame, actions: node.secure || !interactive.contains(node.role) ? [] : actionNames(node.element).filter { secondaryActions.contains($0) }))
    }
    var walk = Walk(elements: elements, nodes: nodes, truncated: truncated, generation: windowId.map { fnv("\($0)|\(generation(of: elements))") } ?? generation(of: elements), hidden: hidden, note: note, windowId: windowId, windowFrame: windowFrame)
    // A changed identity or state behind an identical fingerprint takes its own
    // generation: the record callers still cite keeps its generation, so a
    // stale request stays rejected until they take a fresh snapshot.
    let seen = seenMap(walk)
    while conflicts(book, walk.generation, seen) || (book.history + book.pinned).contains(where: { $0.generation == walk.generation && $0.windowId != windowId }) { walk.generation += 1 }
    remember(book, walk)
    return walk
}

struct Cache {
    var generation: Int
    var nodes: [String: Node]
    var menubar: Bool
    var windowId: CGWindowID?
}

var caches: [pid_t: Cache] = [:]

func snapshotFields(_ walk: Walk) -> JSON {
    var out: JSON = ["generation": walk.generation, "elements": walk.elements.map { $0.json }]
    // Compact replies must also say when this walk stopped early.
    out["truncated"] = walk.truncated
    if let id = walk.windowId { out["windowId"] = id }
    if let frame = walk.windowFrame { out["window"] = ["x": frame.origin.x, "y": frame.origin.y, "width": frame.width, "height": frame.height] }
    if walk.hidden > 0 { out["hidden"] = walk.hidden }
    if let note = walk.note { out["note"] = note }
    return out
}

var cacheOrder: [pid_t] = []

func refresh(_ pid: pid_t, menubar: Bool, windowId: CGWindowID? = nil) throws -> Walk {
    let walk = try walkApp(pid, menubar: menubar, windowId: windowId)
    caches[pid] = Cache(generation: walk.generation, nodes: walk.nodes, menubar: menubar, windowId: walk.windowId)
    cacheOrder.removeAll { $0 == pid || NSRunningApplication(processIdentifier: $0) == nil }
    cacheOrder.append(pid)
    while cacheOrder.count > 16 { cacheOrder.removeFirst() }
    for key in Array(caches.keys) where !cacheOrder.contains(key) { caches[key] = nil }
    for key in Array(refBooks.keys) where !cacheOrder.contains(key) { refBooks[key] = nil }
    return walk
}

// A ref action is checked against the live tree, not the last walk: the app can
// change on its own between a snapshot and the action. The fresh walk's handles
// replace the cache, so the step uses what was just verified. A tree that moved
// on elsewhere (a clock, a counter the last step bumped) still takes the action
// when every ref it uses is the very control the caller saw, still labelled the same.
// The caller's tree is pinned before the walk, which could push it out of history.
func ensureCache(_ pid: pid_t, _ expected: Int?, refs: [String], menubar: Bool, walker: (pid_t, Bool) throws -> Walk = { try refresh($0, menubar: $1) }) throws {
    if let expected, let book = refBooks[pid] { pin(book, expected) }
    if refs.isEmpty { return }
    guard let expected else {
        if caches[pid] == nil { _ = try refresh(pid, menubar: menubar) }
        return
    }
    // The caller's record is read before the walk — a changed tree takes a new
    // generation, so the record stands — and matching fingerprints still have
    // to prove each ref is the same control the caller saw.
    guard let seen = (refBooks[pid].flatMap { seenAt($0, expected) }) else {
        throw Fail("stale_ref", "stale_ref: The app changed since your snapshot. Take a fresh snapshot.")
    }
    let previousWindow = (refBooks[pid].map { $0.history + $0.pinned })?.last(where: { $0.generation == expected })?.windowId
    let walk = try walker(pid, menubar)
    guard previousWindow == walk.windowId else { throw Fail("stale_ref", "The selected window changed. Take a fresh snapshot.") }
    for ref in refs {
        guard let then = seen[ref], let node = walk.nodes[ref], stillSame(then, node) else {
            throw Fail("stale_ref", "stale_ref: \(ref) is gone or changed since your snapshot. Take a fresh snapshot.")
        }
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
        // Open and Save panels run in another process: only session delivery reaches them while the app is in front.
        if NSWorkspace.shared.frontmostApplication?.processIdentifier == pid { event.post(tap: .cghidEventTap) } else { event.postToPid(pid) }
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
    let app = appElement(pid)
    for attempt in 0...1 {
        var bar: CFTypeRef?
        let result = AXUIElementCopyAttributeValue(app, "AXMenuBar" as CFString, &bar)
        if result == .success, let bar, CFGetTypeID(bar) == AXUIElementGetTypeID() { return bar as! AXUIElement }
        if result == .cannotComplete || result == .noValue {
            if attempt == 0 {
                RunLoop.current.run(until: Date().addingTimeInterval(0.15))
                continue
            }
            throw Fail("unresponsive", "The app's menu bar is not ready (\(result.rawValue)). Wait a moment and retry.")
        }
        throw Fail("unsupported_action", "That app exposes no menu bar (\(result.rawValue)).")
    }
    throw Fail("unresponsive", "The app's menu bar is not ready. Wait a moment and retry.")
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

struct WindowCandidate { let onScreen: Bool; let titled: Bool; let frame: CGRect }

// The largest window of the app on the current Space. Only when it has none there
// (another Space, minimized, hidden) is its largest titled window elsewhere used, the
// one view of it Accessibility leaves; untitled off-screen windows are never shown ones.
func pickWindow(_ windows: [WindowCandidate]) -> (index: Int, elsewhere: Bool)? {
    let sized = windows.indices.filter { windows[$0].frame.width >= 40 && windows[$0].frame.height >= 40 }
    let here = sized.filter { windows[$0].onScreen }
    let pool = here.isEmpty ? sized.filter { windows[$0].titled } : here
    guard let best = pool.max(by: { windows[$0].frame.width * windows[$0].frame.height < windows[$1].frame.width * windows[$1].frame.height }) else { return nil }
    return (best, here.isEmpty)
}

struct SelectedWindow {
    let id: CGWindowID
    let frame: CGRect
    let onScreen: Bool
    let titled: Bool
}

func chooseWindow(_ windows: [SelectedWindow], _ id: CGWindowID?) throws -> SelectedWindow? {
    if let id {
        guard let window = windows.first(where: { $0.id == id }) else { throw Fail("stale_window", "That window is gone or belongs to another app. Take a fresh snapshot.") }
        return window
    }
    let candidates = windows.map { WindowCandidate(onScreen: $0.onScreen, titled: $0.titled, frame: $0.frame) }
    return pickWindow(candidates).map { windows[$0.index] }
}

func selectedWindow(_ pid: pid_t, _ id: CGWindowID?) throws -> SelectedWindow? {
    let info = CGWindowListCopyWindowInfo([.optionAll, .excludeDesktopElements], kCGNullWindowID) as? [[String: Any]] ?? []
    let windows = info.compactMap { item -> SelectedWindow? in
        guard (item[kCGWindowOwnerPID as String] as? NSNumber)?.int32Value == pid,
              (item[kCGWindowLayer as String] as? NSNumber)?.intValue == 0,
              let number = item[kCGWindowNumber as String] as? NSNumber,
              let bounds = item[kCGWindowBounds as String] as? [String: Any] else { return nil }
        func part(_ name: String) -> Double { (bounds[name] as? NSNumber)?.doubleValue ?? 0 }
        let frame = CGRect(x: part("X"), y: part("Y"), width: part("Width"), height: part("Height"))
        guard frame.width >= 40, frame.height >= 40 else { return nil }
        return SelectedWindow(id: number.uint32Value, frame: frame, onScreen: (item[kCGWindowIsOnscreen as String] as? NSNumber)?.boolValue == true, titled: !(item[kCGWindowName as String] as? String ?? "").isEmpty)
    }
    return try chooseWindow(windows, id)
}

func hasOnScreenWindow(_ pid: pid_t) -> Bool {
    let info = CGWindowListCopyWindowInfo([.optionAll, .excludeDesktopElements], kCGNullWindowID) as? [[String: Any]] ?? []
    return info.contains { ($0[kCGWindowOwnerPID as String] as? NSNumber)?.int32Value == pid && ($0[kCGWindowLayer as String] as? NSNumber)?.intValue == 0 && ($0[kCGWindowIsOnscreen as String] as? NSNumber)?.boolValue == true }
}

func matchesWindow(_ element: AXUIElement, _ selected: SelectedWindow) -> Bool {
    if let id = numberAttr(element, "AXWindowNumber") { return id == Double(selected.id) }
    guard let frame = axFrame(element) else { return false }
    return abs(frame.minX - selected.frame.minX) <= 1 && abs(frame.minY - selected.frame.minY) <= 1 && abs(frame.width - selected.frame.width) <= 1 && abs(frame.height - selected.frame.height) <= 1
}

func windowIdOf(_ request: JSON) throws -> CGWindowID? {
    guard let raw = request["windowId"] else { return nil }
    guard let value = raw as? NSNumber, CFGetTypeID(value) != CFBooleanGetTypeID(), value.doubleValue >= 1, value.doubleValue <= Double(UInt32.max), value.doubleValue.rounded() == value.doubleValue else {
        throw Fail("bad_request", "windowId must be a positive window number.")
    }
    return value.uint32Value
}

let elsewhereShotNote = "Read only: this window is on another Space, minimized or hidden, where Accessibility cannot reach it and clicks at these coordinates may not land. To act on it, bring it forward with activate, then take a fresh snapshot."

// ScreenCaptureKit's screenshot call needs macOS 14; the app supports 13.
@available(macOS 14, *)
func captureWithScreenCaptureKit(_ pid: pid_t, maxWidth: Int, selected: SelectedWindow) throws -> JSON {
    _ = NSApplication.shared
    var content: SCShareableContent?
    var finished = false
    // Include other Spaces so an app with no window on this one still has its
    // titled window available as a read-only fallback.
    SCShareableContent.getExcludingDesktopWindows(true, onScreenWindowsOnly: false) { found, _ in content = found; finished = true }
    guard waitFor({ finished }), let windows = content?.windows else { throw Fail("failed", "Could not list windows to capture.") }
    guard let window = windows.first(where: { $0.windowID == selected.id && $0.owningApplication?.processID == pid && $0.windowLayer == 0 }) else { throw Fail("stale_window", "That window is no longer available. Take a fresh snapshot.") }
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
    var reply = try jpegReply(image, window.frame)
    reply["windowId"] = selected.id
    if !selected.onScreen { reply["note"] = elsewhereShotNote }
    return reply
}

func captureWithScreencapture(_ pid: pid_t, maxWidth: Int, selected: SelectedWindow) throws -> JSON {
    guard selected.onScreen else { throw Fail("no_window", "That window is not on the current screen.") }
    let bestId = selected.id
    let bestBounds = selected.frame
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
    var reply = try jpegReply(image, bestBounds)
    reply["windowId"] = selected.id
    return reply
}

func captureWindow(_ pid: pid_t, maxWidth: Int, windowId: CGWindowID? = nil) throws -> JSON {
    guard CGPreflightScreenCaptureAccess() else {
        throw Fail("permission", "Screen Recording is off for this program. Turn it on in System Settings → Privacy & Security → Screen Recording, then retry.")
    }
    guard let selected = try selectedWindow(pid, windowId) else { throw Fail("no_window", "That app has no window to capture.") }
    // HERMES_COMPUTER_SCREENCAPTURE=1 forces the older path, which is what macOS 13 runs.
    if #available(macOS 14, *), ProcessInfo.processInfo.environment["HERMES_COMPUTER_SCREENCAPTURE"] != "1" {
        do { return try captureWithScreenCaptureKit(pid, maxWidth: maxWidth, selected: selected) }
        catch let failure as Fail where failure.code != "failed" { throw failure }
        catch { /* fall through to screencapture */ }
    }
    return try captureWithScreencapture(pid, maxWidth: maxWidth, selected: selected)
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

let secondaryActions: Set<String> = ["AXShowMenu", "AXIncrement", "AXDecrement", "AXConfirm", "AXPick"]

func selectionRange(_ value: String, text: String, prefix: String, suffix: String, selection: String) throws -> CFRange {
    guard !text.isEmpty, text.utf16.count <= 2000, prefix.utf16.count <= 2000, suffix.utf16.count <= 2000,
          ["text", "cursor_before", "cursor_after"].contains(selection) else { throw Fail("bad_request", "Invalid text selection.") }
    let source = value as NSString
    let needle = prefix + text + suffix
    var offset = 0
    var matches: [NSRange] = []
    while offset < source.length {
        let found = source.range(of: needle, options: .literal, range: NSRange(location: offset, length: source.length - offset))
        if found.location == NSNotFound { break }
        matches.append(NSRange(location: found.location + prefix.utf16.count, length: text.utf16.count))
        if matches.count > 1 { throw Fail("ambiguous_text", "That text appears more than once. Supply adjacent prefix or suffix text.") }
        offset = found.location + 1
    }
    guard let match = matches.first else { throw Fail("text_not_found", "That text was not found with the supplied context.") }
    return CFRange(location: selection == "cursor_after" ? NSMaxRange(match) : match.location, length: selection == "text" ? match.length : 0)
}

func runStep(_ pid: pid_t, _ step: JSON, windowId: CGWindowID?) throws -> JSON {
    let before = cursor()
    postedMouse = false
    var out: JSON = [:]
    switch step["action"] as? String ?? "" {
    case "activate":
        let app = try checkApp(pid, action: true, activating: true)
        try rejectSecureFocus(pid)
        if !hasOnScreenWindow(pid) {
            // Its windows are on another Space, minimized or hidden: bring the app forward like a Dock click.
            app.unhide()
            for window in axValue(appElement(pid), "AXWindows") as? [AXUIElement] ?? [] where axValue(window, "AXMinimized") as? Bool == true {
                AXUIElementSetAttributeValue(window, "AXMinimized" as CFString, kCFBooleanFalse)
            }
            guard app.activate(options: [.activateAllWindows, .activateIgnoringOtherApps]),
                  waitFor({ NSWorkspace.shared.frontmostApplication?.processIdentifier == pid }, timeout: 2) else {
                throw Fail("failed", "Could not bring that app forward. Ask the user to show it.")
            }
            out["note"] = waitFor({ hasOnScreenWindow(pid) }, timeout: 1)
                ? "Brought the app's window onto this screen. Take a fresh snapshot before acting."
                : noWindowNote
            break
        }
        guard let selected = try selectedWindow(pid, windowId), selected.onScreen,
              let windows = axValue(appElement(pid), "AXWindows") as? [AXUIElement] else {
            throw Fail("window_unverified", "Take a snapshot of the window before bringing it forward.")
        }
        let matches = windows.filter { matchesWindow($0, selected) }
        guard matches.count == 1 else { throw Fail("window_unverified", "Could not verify the selected window. Take a fresh snapshot.") }
        try checkApp(pid, action: true, activating: true)
        guard AXUIElementPerformAction(matches[0], "AXRaise" as CFString) == .success,
              app.activate(options: [.activateIgnoringOtherApps]) else {
            throw Fail("failed", "Could not bring the selected window forward. Take a fresh snapshot.")
        }
        guard waitFor({
            guard NSWorkspace.shared.frontmostApplication?.processIdentifier == pid,
                  let focused = axValue(appElement(pid), "AXFocusedWindow"), CFGetTypeID(focused) == AXUIElementGetTypeID() else { return false }
            return belongsToWindow(focused as! AXUIElement, selected)
        }, timeout: 1) else { throw Fail("window_unverified", "Could not confirm keyboard focus in the selected window. Take a fresh snapshot.") }
    case "press":
        let node = try resolve(pid, step["ref"] as? String ?? "")
        try rejectSecure(node)
        try rejectSecureFocusForMenu(pid, node.element)
        out["via"] = try pressElement(pid, node.element, role: node.role)
    case "select_text":
        let node = try resolve(pid, step["ref"] as? String ?? "")
        try rejectSecure(node)
        guard !isSecure(node.element) else { throw Fail("off_limits", "Password fields are off limits.") }
        guard textEntry.contains(node.role), let text = step["text"] as? String,
              let value = axValue(node.element, "AXValue") as? String else { throw Fail("unsupported_action", "That control does not expose selectable text.") }
        for key in ["prefix", "suffix", "selection"] where step[key] != nil && !(step[key] is String) { throw Fail("bad_request", "Invalid text selection.") }
        var range = try selectionRange(value, text: text, prefix: step["prefix"] as? String ?? "", suffix: step["suffix"] as? String ?? "", selection: step["selection"] as? String ?? "text")
        guard let selected = AXValueCreate(.cfRange, &range),
              AXUIElementSetAttributeValue(node.element, "AXSelectedTextRange" as CFString, selected) == .success else {
            throw Fail("unsupported_action", "That app could not select the text.")
        }
    case "secondary_action":
        let node = try resolve(pid, step["ref"] as? String ?? "")
        try rejectSecure(node)
        guard !isSecure(node.element) else { throw Fail("off_limits", "Password fields are off limits.") }
        try rejectSecureFocus(pid)
        guard let action = step["secondaryAction"] as? String, secondaryActions.contains(action), actionNames(node.element).contains(action) else {
            throw Fail("unsupported_action", "That control does not advertise that action.")
        }
        let result = AXUIElementPerformAction(node.element, action as CFString)
        guard result == .success else { throw Fail("failed", "The app could not perform that action (\(result.rawValue)).") }
        out["via"] = "ax"
    case "type":
        guard let text = step["text"] as? String else { throw Fail("bad_request", "type needs text.") }
        if text.count > 2000 { throw Fail("bad_request", "Text is too long.") }
        guard let ref = step["ref"] as? String, !ref.isEmpty else {
            // No field named: type into whatever has keyboard focus, such as a rename box the tree does not list.
            try rejectSecureFocus(pid)
            if NSWorkspace.shared.frontmostApplication?.processIdentifier != pid {
                let app = try checkApp(pid, action: true, activating: true)
                _ = app.activate(options: [.activateIgnoringOtherApps])
                _ = waitFor({ NSWorkspace.shared.frontmostApplication?.processIdentifier == pid }, timeout: 1)
            }
            for character in text { try postKey(pid, key: character == "\n" ? "return" : String(character), modifiers: []) }
            out["via"] = "keys"
            break
        }
        let node = try resolve(pid, ref)
        try rejectSecure(node)
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
        if anchor == nil, let selected = try selectedWindow(pid, windowId) {
            let point = CGPoint(x: selected.frame.midX, y: selected.frame.midY)
            anchor = (point, elementAt(pid, point), nil)
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

// Notifications only shorten the wait after an event. Silent/unsupported apps
// retain the conservative fallback; semantic completion still uses wait steps.
struct SettleClock {
    var lastEvent: Double?
    func done(_ now: Double, started: Double, deadline: Double) -> Bool {
        now >= deadline || (lastEvent.map { now - $0 >= 0.020 } ?? (now - started >= 0.060))
    }
}

final class AXSettler {
    var observer: AXObserver?
    var clock = SettleClock()
    let notifications = ["AXValueChanged", "AXUIElementDestroyed", "AXWindowCreated", "AXFocusedUIElementChanged", "AXLayoutChanged", "AXSelectedChildrenChanged", "AXMoved", "AXResized", "AXTitleChanged", "AXRowCountChanged"]
    init(_ pid: pid_t, refs: [String]) {
        var created: AXObserver?
        guard AXObserverCreate(pid, { _, _, _, context in
            guard let context else { return }
            Unmanaged<AXSettler>.fromOpaque(context).takeUnretainedValue().clock.lastEvent = ProcessInfo.processInfo.systemUptime
        }, &created) == .success, let created else { return }
        observer = created
        let context = Unmanaged.passUnretained(self).toOpaque()
        let app = appElement(pid)
        var elements = [app] + refs.compactMap { caches[pid]?.nodes[$0]?.element }
        if let id = caches[pid]?.windowId, let selected = try? selectedWindow(pid, id),
           let windows = axValue(app, "AXWindows") as? [AXUIElement] {
            elements += windows.filter { matchesWindow($0, selected) }
        }
        for element in elements {
            for notification in notifications { AXObserverAddNotification(created, element, notification as CFString, context) }
        }
        CFRunLoopAddSource(CFRunLoopGetCurrent(), AXObserverGetRunLoopSource(created), .defaultMode)
    }
    func wait(timeoutMs: Int) {
        let started = ProcessInfo.processInfo.systemUptime
        // An event delivered during the actions still needs a quiet interval
        // after the final action, rather than after an earlier batch step.
        if clock.lastEvent != nil { clock.lastEvent = started }
        let deadline = started + Double(timeoutMs) / 1000
        while !clock.done(ProcessInfo.processInfo.systemUptime, started: started, deadline: deadline) {
            CFRunLoopRunInMode(.defaultMode, 0.005, false)
        }
    }
    func close() {
        if let observer { CFRunLoopRemoveSource(CFRunLoopGetCurrent(), AXObserverGetRunLoopSource(observer), .defaultMode) }
        observer = nil
    }
}

func belongsToWindow(_ element: AXUIElement, _ selected: SelectedWindow) -> Bool {
    var current: AXUIElement? = element
    var seen = Set<AXKey>()
    // SwiftUI controls can omit AXWindow; sheets still belong to their parent window.
    for _ in 0..<32 {
        guard let candidate = current, seen.insert(AXKey(element: candidate)).inserted else { return false }
        if axString(candidate, "AXRole") == "AXWindow" { return matchesWindow(candidate, selected) }
        if let window = axValue(candidate, "AXWindow"), CFGetTypeID(window) == AXUIElementGetTypeID() {
            return matchesWindow(window as! AXUIElement, selected)
        }
        current = axParent(candidate)
    }
    return false
}

func validateWindowStep(_ pid: pid_t, _ step: JSON, _ selected: SelectedWindow?) throws {
    let action = step["action"] as? String ?? ""
    let node = (step["ref"] as? String).flatMap { caches[pid]?.nodes[$0] }
    let menuRef = node.map { inMenu($0.element) } ?? false
    // A Cmd shortcut is an app command: with the app in front it reaches that app's key window or panel, whichever window was read.
    if action == "key", (step["modifiers"] as? [String] ?? []).contains("meta"),
       NSWorkspace.shared.frontmostApplication?.processIdentifier == pid { return }
    guard let selected else {
        if action == "menu" || action == "activate" || menuRef { return }
        // With no window at all, a shortcut can only reach the app itself, which must be in front.
        if action == "key" && !hasOnScreenWindow(pid) && NSWorkspace.shared.frontmostApplication?.processIdentifier == pid { return }
        throw Fail("no_window", hasOnScreenWindow(pid) ? "Take a window snapshot before acting." : noWindowNote)
    }
    guard selected.onScreen || action == "activate" else { throw Fail("stale_window", "That window is not on the current screen. Bring it forward with activate, then take a fresh snapshot.") }
    for (x, y) in [("x", "y"), ("x2", "y2")] {
        if let px = number(step[x]), let py = number(step[y]) {
            let point = CGPoint(x: px, y: py)
            guard selected.frame.contains(point), let hit = elementAt(pid, point),
                  belongsToWindow(hit, selected) else {
                throw Fail("stale_window", "Those coordinates do not reach the selected window.")
            }
        }
    }
    if let node, !menuRef, !belongsToWindow(node.element, selected) {
        throw Fail("stale_ref", "That control is no longer in the selected window. Take a fresh snapshot.")
    }
    if action == "key" || (action == "type" && step["ref"] == nil) || action == "menu" || menuRef {
        guard let focused = axValue(appElement(pid), "AXFocusedWindow"), CFGetTypeID(focused) == AXUIElementGetTypeID(), belongsToWindow(focused as! AXUIElement, selected) else {
            throw Fail("window_unverified", "The selected window does not have keyboard focus. Bring that window forward when you are idle, then take a fresh snapshot.")
        }
    }
}

func act(_ request: JSON) throws -> JSON {
    let pid = try pidOf(request)
    try requireAccessibility()
    try checkApp(pid, action: true)
    let steps = request["steps"] as? [JSON] ?? []
    let menubar = request["menubar"] as? Bool ?? caches[pid]?.menubar ?? false
    let expected = (request["generation"] as? NSNumber)?.intValue
    let held = refBooks[pid].flatMap { book in (book.history + book.pinned).last(where: { $0.generation == expected }) }
    let windowId = try windowIdOf(request) ?? held?.windowId ?? caches[pid]?.windowId
    if expected != nil && (held == nil || held?.windowId != windowId) {
        throw Fail("stale_ref", "The selected window changed. Take a fresh snapshot.")
    }
    let selected = try selectedWindow(pid, windowId)
    let refs = steps.compactMap { $0["ref"] as? String }
    try ensureCache(pid, expected, refs: refs, menubar: menubar) { try refresh($0, menubar: $1, windowId: selected?.id) }
    let settling = AXSettler(pid, refs: refs)
    defer { settling.close() }
    var results: [JSON] = []
    var succeeded = false
    for step in steps {
        do {
            try checkApp(pid, action: true)
            try validateWindowStep(pid, step, try selectedWindow(pid, selected?.id))
            results.append(try runStep(pid, step, windowId: selected?.id))
            succeeded = true
        } catch let failure as Fail {
            results.append(["ok": false, "error": failure.message, "code": failure.code])
            break
        }
    }
    var reply: JSON = ["results": results]
    if succeeded, request["snapshot"] as? Bool ?? true {
        settling.wait(timeoutMs: max(0, min(1000, (request["settleMs"] as? NSNumber)?.intValue ?? 250)))
        // The steps already ran; a tree that cannot be read afterwards must not hide their results.
        if let walk = try? refresh(pid, menubar: menubar, windowId: selected?.id) { for (key, value) in snapshotFields(walk) { reply[key] = value } }
        else { reply["note"] = "unresponsive: the steps ran but the app stopped responding, so there is no tree. Do not repeat them; take a fresh snapshot." }
    }
    return reply
}

func launchApp(_ request: JSON) throws -> JSON {
    guard let name = request["app"] as? String, !name.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty,
          name.count <= 200, !name.contains("/"), !name.contains(":"), !name.contains("\n") else {
        throw Fail("bad_request", "Choose an app by its name or bundle identifier.")
    }
    if isBlocked(name) { throw Fail("off_limits", "That app is off limits.") }
    let url = NSWorkspace.shared.urlForApplication(withBundleIdentifier: name)
        ?? NSWorkspace.shared.fullPath(forApplication: name).map { URL(fileURLWithPath: $0) }
    guard let url, let id = Bundle(url: url)?.bundleIdentifier else { throw Fail("not_found", "App not found.") }
    if isBlocked(id) { throw Fail("off_limits", "That app is off limits.") }
    if screenLocked() { throw Fail("locked", "The screen is locked. Ask the user to unlock it, then retry.") }
    let configuration = NSWorkspace.OpenConfiguration()
    configuration.activates = false
    var finished = false
    var launched: NSRunningApplication?
    NSWorkspace.shared.openApplication(at: url, configuration: configuration) { app, _ in launched = app; finished = true }
    guard waitFor({ finished }), let launched else { throw Fail("failed", "Could not open that app. Check whether it opened before retrying.") }
    // An instance macOS lost track of (automatic termination gone wrong) reports pid -1 and has no windows.
    guard launched.processIdentifier > 0 else { throw Fail("unresponsive", "That app is running but macOS cannot reach it. Ask the user to quit it, then retry.") }
    return ["pid": Int(launched.processIdentifier), "bundleId": id]
}

func dispatch(_ request: JSON) throws -> JSON {
    if let policy = request["policy"] as? JSON { setPolicy(policy) }
    switch request["cmd"] as? String ?? "" {
    case "init":
        return ["protocol": 2, "windowBinding": true]
    case "selftest":
        return try selftest()
    case "permissions":
        return ["accessibility": AXIsProcessTrusted(), "screenRecording": CGPreflightScreenCaptureAccess()]
    case "request_screen":
        return ["screenRecording": CGPreflightScreenCaptureAccess() || CGRequestScreenCaptureAccess()]
    case "launch":
        return try launchApp(request)
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
        if let generation = (request["pin"] as? NSNumber)?.intValue, let book = refBooks[pid] { pin(book, generation) }
        return snapshotFields(try refresh(pid, menubar: request["menubar"] as? Bool ?? false, windowId: try windowIdOf(request)))
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
        return try captureWindow(pid, maxWidth: (request["maxWidth"] as? NSNumber)?.intValue ?? 960, windowId: try windowIdOf(request))
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
    let repeated = try selectionRange("😀 first word; second word.", text: "word", prefix: "second ", suffix: ".", selection: "text")
    try expect(repeated.location == 22 && repeated.length == 4, "context selects repeated text in UTF16")
    let overlap = try selectionRange("aaa", text: "aa", prefix: "a", suffix: "", selection: "cursor_after")
    try expect(overlap.location == 3 && overlap.length == 0, "overlapping match and cursor after")
    for mode in ["text", "cursor_before", "cursor_after"] {
        let range = try selectionRange("abc", text: "b", prefix: "", suffix: "", selection: mode)
        try expect(range.location == (mode == "cursor_after" ? 2 : 1) && range.length == (mode == "text" ? 1 : 0), "selection modes")
    }
    for text in ["word word", "missing"] {
        do { _ = try selectionRange(text, text: "word", prefix: "", suffix: "", selection: "text"); throw Fail("selftest", "ambiguous or absent match accepted") }
        catch let error as Fail { try expect(["ambiguous_text", "text_not_found"].contains(error.code), "refuse ambiguous or absent text") }
    }
    let afterPreview = try selectionRange(String(repeating: "x", count: 250) + " target", text: "target", prefix: " ", suffix: "", selection: "text")
    try expect(afterPreview.location == 251, "selection reads beyond the short snapshot preview")
    for input in [("", "text"), ("word", "all")] {
        do { _ = try selectionRange("word", text: input.0, prefix: "", suffix: "", selection: input.1); throw Fail("selftest", "invalid selection accepted") }
        catch let error as Fail { try expect(error.code == "bad_request", "invalid selections refused") }
    }
    let plain = Elem(ref: "c1", role: "AXPopUpButton", name: "Size", value: "", frame: nil)
    var alternate = plain
    alternate.actions = ["AXShowMenu"]
    try expect(generation(of: [plain]) != generation(of: [alternate]), "advertised actions change the generation")
    try expect(alternate.json["actions"] as? [String] == ["AXShowMenu"], "advertised actions reach snapshots")
    let fakeElement = AXUIElementCreateApplication(123456)
    let securePid: pid_t = 123456
    let secure = Node(fakeElement, depth: 0, limit: 0)
    secure.role = "AXTextField"
    secure.subrole = "AXSecureTextField"
    caches[securePid] = Cache(generation: 1, nodes: ["secure": secure], menubar: false)
    for action in ["select_text", "secondary_action"] {
        do { _ = try runStep(securePid, ["action": action, "ref": "secure", "text": "word", "secondaryAction": "AXShowMenu"], windowId: nil); throw Fail("selftest", "secure action accepted") }
        catch let error as Fail { try expect(error.code == "off_limits", "secure fields refused by new actions") }
    }
    caches[securePid] = nil
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
    try expect(whole(94.5) == 95 && whole(-3.2) == -3, "whole points")
    let first = AXKey(element: AXUIElementCreateApplication(1)), second = AXKey(element: AXUIElementCreateApplication(2))
    try expect(first == AXKey(element: AXUIElementCreateApplication(1)) && first != second && Set([first, first, second]).count == 2, "element identity")
    let book = RefBook()
    try expect(assignRefs([(first, "AXButton|Go|0"), (second, "AXButton|Go|1")], book) == ["c1", "c2"], "fresh refs")
    let third = AXKey(element: AXUIElementCreateApplication(3))
    // An inserted control takes a new number; the others keep theirs, a rebuilt one by its label.
    try expect(assignRefs([(third, "AXButton|New|0"), (second, "AXButton|Go|1"), (AXKey(element: AXUIElementCreateApplication(4)), "AXButton|Go|0")], book) == ["c3", "c2", "c1"], "stable refs")
    // c1 now names a rebuilt control found by label: an action from the older tree must not reach it.
    let rebuilt = Node(AXUIElementCreateApplication(4), depth: 0, limit: 0)
    rebuilt.role = "AXButton"
    rebuilt.name = "Go"
    try expect(!stillSame(Seen(key: first, signature: "AXButton|Go|"), rebuilt), "rebound ref refused")
    try expect(stillSame(Seen(key: AXKey(element: AXUIElementCreateApplication(4)), signature: "AXButton|Go|"), rebuilt), "same control accepted")
    rebuilt.context = "Row 7"
    try expect(!stillSame(Seen(key: AXKey(element: AXUIElementCreateApplication(4)), signature: "AXButton|Go|Row 3"), rebuilt), "recycled row refused")

    let longLabel = String(repeating: "x", count: 120)
    let box = Node(AXUIElementCreateApplication(5), depth: 0, limit: 0)
    box.role = "AXCheckBox"
    box.name = longLabel
    box.value = NSNumber(value: 0)
    let boxOff = Seen(key: AXKey(element: box.element), signature: signature(box))
    try expect(stillSame(boxOff, box), "unchanged checkbox accepted")
    box.value = NSNumber(value: 1)
    try expect(!stillSame(boxOff, box), "checkbox state checked")
    let boxOn = Seen(key: AXKey(element: box.element), signature: signature(box))
    box.value = NSNumber(value: 2)
    try expect(!stillSame(boxOn, box), "mixed checkbox state checked")
    let disclosure = Node(AXUIElementCreateApplication(6), depth: 0, limit: 0)
    disclosure.role = "AXDisclosureTriangle"
    disclosure.value = NSNumber(value: 0)
    let disclosureClosed = Seen(key: AXKey(element: disclosure.element), signature: signature(disclosure))
    disclosure.value = NSNumber(value: 1)
    try expect(!stillSame(disclosureClosed, disclosure), "disclosure state checked")
    let button = Node(AXUIElementCreateApplication(7), depth: 0, limit: 0)
    button.role = "AXButton"
    button.name = "Go"
    button.value = NSNumber(value: 0)
    let buttonSeen = Seen(key: AXKey(element: button.element), signature: signature(button))
    button.value = NSNumber(value: 1)
    try expect(stillSame(buttonSeen, button), "button value ignored")
    let rowItem = Node(AXUIElementCreateApplication(8), depth: 0, limit: 0)
    rowItem.role = "AXOutlineRow"
    rowItem.name = "Item"
    rowItem.expanded = NSNumber(value: 0)
    let rowCollapsed = Seen(key: AXKey(element: rowItem.element), signature: signature(rowItem))
    rowItem.expanded = NSNumber(value: 1)
    try expect(!stillSame(rowCollapsed, rowItem), "expand state checked")

    let pinnedBook = RefBook()
    remember(pinnedBook, Walk(elements: [], nodes: [:], truncated: false, generation: 100))
    pin(pinnedBook, 100)
    for value in 101...120 { remember(pinnedBook, Walk(elements: [], nodes: [:], truncated: false, generation: value)) }
    try expect(seenAt(pinnedBook, 100) != nil, "pinned generation kept")
    try expect(seenAt(pinnedBook, 101) == nil, "old unpinned generation dropped")
    try expect(seenAt(pinnedBook, 120) != nil, "latest generation kept")
    let pinnedCount = pinnedBook.pinned.count
    pin(pinnedBook, 99)
    try expect(pinnedBook.pinned.count == pinnedCount, "unknown generation not pinned")
    for value in 116...120 { pin(pinnedBook, value) }
    try expect(pinnedBook.pinned.map(\.generation) == [117, 118, 119, 120], "only four generations pinned")

    let here = pickWindow([
        WindowCandidate(onScreen: false, titled: true, frame: CGRect(x: 0, y: 0, width: 500, height: 500)),
        WindowCandidate(onScreen: true, titled: true, frame: CGRect(x: 0, y: 0, width: 100, height: 100)),
    ])
    try expect(here?.index == 1 && here?.elsewhere == false, "on-screen window preferred")
    let elsewhere = pickWindow([
        WindowCandidate(onScreen: false, titled: true, frame: CGRect(x: 0, y: 0, width: 200, height: 100)),
        WindowCandidate(onScreen: false, titled: true, frame: CGRect(x: 0, y: 0, width: 300, height: 100)),
    ])
    try expect(elsewhere?.index == 1 && elsewhere?.elsewhere == true, "largest elsewhere window picked")
    try expect(pickWindow([WindowCandidate(onScreen: false, titled: false, frame: CGRect(x: 0, y: 0, width: 100, height: 100))]) == nil, "untitled elsewhere window skipped")
    try expect(pickWindow([WindowCandidate(onScreen: true, titled: true, frame: CGRect(x: 0, y: 0, width: 39, height: 100))]) == nil, "small window skipped")
    try expect(pickWindow([]) == nil, "empty windows skipped")

    // Through ensureCache with a fake walker: a toggle the user flipped after the snapshot must refuse the ref.
    let fakePid: pid_t = -7
    defer { refBooks[fakePid] = nil }
    func stale(_ expected: Int, _ walk: () -> Walk) -> Bool {
        do { try ensureCache(fakePid, expected, refs: ["c1"], menubar: false) { _, _ in walk() }; return false }
        catch let failure as Fail { return failure.code == "stale_ref" } catch { return false }
    }
    for (index, (role, before, after)) in [("AXCheckBox", 0, 1), ("AXCheckBox", 1, 2), ("AXDisclosureTriangle", 0, 1), ("AXRadioButton", 1, 0)].enumerated() {
        let toggleBook = RefBook()
        refBooks[fakePid] = toggleBook
        let toggle = Node(AXUIElementCreateApplication(pid_t(20 + index)), depth: 0, limit: 0)
        toggle.role = role
        toggle.title = String(repeating: "y", count: 130)
        toggle.value = NSNumber(value: before)
        describe(toggle)
        let seen = record([toggle], toggleBook).generation
        try expect(!stale(seen) { record([toggle], toggleBook) }, "\(role) unchanged accepted")
        toggle.value = NSNumber(value: after)
        describe(toggle)
        try expect(stale(seen) { record([toggle], toggleBook) }, "\(role) \(before) to \(after) refused")
    }
    // The caller's tree is the oldest of eight and the walk pushes it out; pinning first keeps it.
    let movingBook = RefBook()
    refBooks[fakePid] = movingBook
    let go = Node(AXUIElementCreateApplication(30), depth: 0, limit: 0)
    go.role = "AXButton"
    go.title = "Go"
    let clock = Node(AXUIElementCreateApplication(31), depth: 0, limit: 0)
    clock.role = "AXStaticText"
    func tick(_ time: Int) -> Walk {
        clock.value = "\(time)" as CFString
        for node in [go, clock] { describe(node) }
        return record([go, clock], movingBook)
    }
    let callerGeneration = tick(0).generation
    for time in 1...7 { _ = tick(time) }
    try expect(!stale(callerGeneration) { tick(8) }, "caller's tree pinned before the walk")

    // A control rebuilt behind an identical tree keeps the same fingerprint but
    // a new element: the rebuilt walk must take its own generation, and a
    // request still citing the caller's generation stays rejected on retry.
    let rebuiltBook = RefBook()
    refBooks[fakePid] = rebuiltBook
    let oldGo = Node(AXUIElementCreateApplication(40), depth: 0, limit: 0)
    oldGo.role = "AXButton"
    oldGo.title = "Go"
    describe(oldGo)
    let sameGeneration = record([oldGo], rebuiltBook).generation
    let newGo = Node(AXUIElementCreateApplication(41), depth: 0, limit: 0)
    newGo.role = "AXButton"
    newGo.title = "Go"
    describe(newGo)
    // The probe book leaves the caller's record untouched: the rebuilt walk's
    // fingerprint matches, so generation alone cannot tell the controls apart.
    try expect(record([newGo], RefBook()).generation == sameGeneration, "rebuilt control shares the generation")
    let rebuiltGeneration = record([newGo], rebuiltBook).generation
    try expect(rebuiltGeneration != sameGeneration, "rebuilt control claims its own generation")
    try expect(stale(sameGeneration) { record([newGo], rebuiltBook) }, "rebuilt control refused behind an unchanged generation")
    try expect(stale(sameGeneration) { record([newGo], rebuiltBook) }, "stale request stays refused on retry")
    try expect(!stale(rebuiltGeneration) { record([newGo], rebuiltBook) }, "fresh snapshot accepted")
    let firstWindow = SelectedWindow(id: 41, frame: CGRect(x: 0, y: 0, width: 420, height: 520), onScreen: true, titled: true)
    let secondWindow = SelectedWindow(id: 42, frame: CGRect(x: 500, y: 0, width: 360, height: 240), onScreen: true, titled: true)
    try expect((try chooseWindow([firstWindow, secondWindow], nil)?.id == 41), "default window")
    try expect((try chooseWindow([firstWindow, secondWindow], 42)?.id == 42), "explicit smaller window")
    do { _ = try chooseWindow([firstWindow], 42); throw Fail("selftest", "foreign window accepted") }
    catch let failure as Fail { try expect(failure.code == "stale_window", "foreign or closed window refused") }
    for raw: Any in [0, -1, 1.5, "42", true, 4294967296.0] {
        do { _ = try windowIdOf(["windowId": raw]); throw Fail("selftest", "invalid window id accepted") }
        catch let failure as Fail { try expect(failure.code == "bad_request", "invalid window id refused") }
    }
    try expect((try windowIdOf(["windowId": 42])) == 42, "valid window id")
    let sameText = record([go], RefBook(), windowId: 41)
    let otherWindow = record([go], RefBook(), windowId: 42)
    try expect(sameText.generation != otherWindow.generation, "window identity participates in generation")
    let windowBook = RefBook()
    refBooks[fakePid] = windowBook
    let windowGeneration = record([go], windowBook, windowId: 41).generation
    try expect(stale(windowGeneration) { record([go], windowBook, windowId: 42) }, "same control in another window refused")
    pin(windowBook, windowGeneration)
    windowBook.history.removeAll()
    pin(windowBook, windowGeneration)
    try expect(windowBook.pinned.last?.windowId == 41, "repinning preserves the held window after history expires")
    let fields = snapshotFields(record([go], RefBook(), truncated: true, windowId: 42, windowFrame: secondWindow.frame))
    try expect(fields["windowId"] as? UInt32 == 42 && fields["window"] is [String: CGFloat] && fields["truncated"] as? Bool == true, "window geometry and truncation")
    let quiet = SettleClock(lastEvent: 0.010)
    try expect(!quiet.done(0.015, started: 0, deadline: 0.250), "event not yet quiet")
    try expect(quiet.done(0.031, started: 0, deadline: 0.250), "event quiet before fixed pause")
    try expect(!SettleClock().done(0.030, started: 0, deadline: 0.250), "silent app retains fallback")
    try expect(SettleClock().done(0.061, started: 0, deadline: 0.250), "silent app fallback bounded")
    try expect(SettleClock(lastEvent: 0.249).done(0.250, started: 0, deadline: 0.250), "continuous events bounded")
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
