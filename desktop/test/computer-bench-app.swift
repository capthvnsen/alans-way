import AppKit

// A fixed two-window app for scripts/computer-bench.cjs. It joins every Space
// (full-screen ones included) so it is readable without moving the user, and
// never activates itself, so the user's front app keeps focus.

// Titled windows are normally pulled back onto a screen; this one may stay off it.
final class Panel: NSPanel {
    override func constrainFrameRect(_ frameRect: NSRect, to screen: NSScreen?) -> NSRect { frameRect }
}

final class Rows: NSObject, NSTableViewDataSource, NSTableViewDelegate {
    func numberOfRows(in tableView: NSTableView) -> Int { 80 }
    func tableView(_ tableView: NSTableView, viewFor tableColumn: NSTableColumn?, row: Int) -> NSView? {
        let cell = NSTextField(labelWithString: "Row \(row + 1)")
        cell.identifier = NSUserInterfaceItemIdentifier("row")
        return cell
    }
}

final class Bench: NSObject {
    let form = Panel(contentRect: NSRect(x: 0, y: 0, width: 420, height: 520), styleMask: [.titled, .resizable, .nonactivatingPanel], backing: .buffered, defer: false)
    let notes = Panel(contentRect: NSRect(x: 0, y: 0, width: 360, height: 240), styleMask: [.titled, .resizable, .nonactivatingPanel], backing: .buffered, defer: false)
    let name = NSTextField(string: "")
    let result = NSTextField(labelWithString: "Result: none")
    let count = NSTextField(labelWithString: "Count: 0")
    let clock = NSTextField(labelWithString: "Clock stopped")
    let text = NSTextView(frame: NSRect(x: 0, y: 0, width: 320, height: 120))
    let rows = Rows()
    var counter = 0
    var ticks = 0
    var timer: Timer?

    func button(_ title: String, _ action: Selector) -> NSButton {
        let made = NSButton(title: title, target: self, action: action)
        return made
    }

    func build() {
        name.placeholderString = "Name"
        let size = NSPopUpButton(frame: .zero, pullsDown: false)
        size.addItems(withTitles: ["Small", "Medium", "Large"])
        let subscribe = NSButton(checkboxWithTitle: "Subscribe", target: nil, action: nil)
        let table = NSTableView()
        table.addTableColumn(NSTableColumn(identifier: NSUserInterfaceItemIdentifier("c")))
        table.headerView = nil
        table.dataSource = rows
        table.delegate = rows
        let scroll = NSScrollView()
        scroll.documentView = table
        scroll.hasVerticalScroller = true
        scroll.heightAnchor.constraint(equalToConstant: 160).isActive = true
        let stack = NSStackView(views: [
            name, button("Submit", #selector(submit)), result,
            button("Increment", #selector(increment)), count, subscribe, size,
            button("Start clock", #selector(startClock)), button("Stop clock", #selector(stopClock)), clock, scroll,
        ])
        stack.orientation = .vertical
        stack.alignment = .leading
        stack.edgeInsets = NSEdgeInsets(top: 12, left: 12, bottom: 12, right: 12)
        form.title = "Bench Form"
        form.contentView = stack

        text.isEditable = true
        text.string = ""
        let noteStack = NSStackView(views: [text, button("Copy name", #selector(copyName))])
        noteStack.orientation = .vertical
        noteStack.alignment = .leading
        noteStack.edgeInsets = NSEdgeInsets(top: 12, left: 12, bottom: 12, right: 12)
        notes.title = "Bench Notes"
        notes.contentView = noteStack

        let menu = NSMenu()
        let appItem = NSMenuItem()
        appItem.submenu = NSMenu()
        appItem.submenu?.addItem(NSMenuItem(title: "Quit", action: #selector(NSApplication.terminate(_:)), keyEquivalent: "q"))
        let benchItem = NSMenuItem()
        benchItem.submenu = NSMenu(title: "Bench")
        let reset = NSMenuItem(title: "Reset", action: #selector(resetAll), keyEquivalent: "r")
        reset.target = self
        benchItem.submenu?.addItem(reset)
        menu.addItem(appItem)
        menu.addItem(benchItem)
        NSApp.mainMenu = menu

        let visible = CommandLine.arguments.contains("--visible")
        let screen = NSScreen.main?.frame ?? NSRect(x: 0, y: 0, width: 1440, height: 900)
        for (index, window) in [form, notes].enumerated() {
            window.collectionBehavior = [.canJoinAllSpaces, .fullScreenAuxiliary]
            window.isReleasedWhenClosed = false
            window.hidesOnDeactivate = false
            window.level = .floating
            // Off the right edge unless asked: Accessibility reads it all the same.
            let x = visible ? screen.maxX - 440 - CGFloat(index) * 380 : screen.maxX + 40 + CGFloat(index) * 440
            window.setFrameOrigin(NSPoint(x: x, y: screen.minY + 40))
            window.orderFrontRegardless()
            window.setFrameOrigin(NSPoint(x: x, y: screen.minY + 40))
        }
    }

    @objc func submit() { result.stringValue = "Result: \(name.stringValue)" }
    @objc func increment() { counter += 1; count.stringValue = "Count: \(counter)" }
    @objc func copyName() { text.string = "Copied: \(name.stringValue)" }
    @objc func resetAll() { counter = 0; count.stringValue = "Count: 0"; result.stringValue = "Result: none"; name.stringValue = ""; text.string = "" }
    @objc func startClock() {
        timer?.invalidate()
        timer = Timer.scheduledTimer(withTimeInterval: 0.25, repeats: true) { [weak self] _ in
            guard let self else { return }
            self.ticks += 1
            self.clock.stringValue = "Clock \(self.ticks)"
        }
    }
    @objc func stopClock() { timer?.invalidate(); timer = nil; clock.stringValue = "Clock stopped" }
}

let app = NSApplication.shared
app.setActivationPolicy(.regular)
let bench = Bench()
bench.build()
app.run()
