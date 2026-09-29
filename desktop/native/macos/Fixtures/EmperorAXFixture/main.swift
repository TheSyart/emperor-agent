import AppKit

final class PaintOnlyView: NSView {
    var onClick: (() -> Void)?
    var onDrag: (() -> Void)?
    var onUp: (() -> Void)?

    override func isAccessibilityElement() -> Bool { true }
    override func accessibilityRole() -> NSAccessibility.Role? { .group }
    override func accessibilityChildren() -> [Any]? { [] }

    override func draw(_ dirtyRect: NSRect) {
        NSColor.systemTeal.setFill()
        NSBezierPath(roundedRect: bounds.insetBy(dx: 2, dy: 2), xRadius: 12, yRadius: 12).fill()
        let text = "Painted canvas — click, drag or right-click"
        text.draw(at: NSPoint(x: 14, y: bounds.midY - 8), withAttributes: [
            .font: NSFont.systemFont(ofSize: 14, weight: .semibold),
            .foregroundColor: NSColor.white,
        ])
    }

    override func mouseDown(with event: NSEvent) { onClick?() }
    override func mouseDragged(with event: NSEvent) { onDrag?() }
    override func mouseUp(with event: NSEvent) { onUp?() }
    override func menu(for event: NSEvent) -> NSMenu? {
        let menu = NSMenu(title: "Fixture Canvas")
        menu.addItem(withTitle: "Canvas Context Action", action: #selector(contextAction), keyEquivalent: "")
        return menu
    }

    @objc private func contextAction() { onClick?() }
}

@MainActor final class FixtureController: NSObject, NSApplicationDelegate,
                                          NSTableViewDataSource, NSTableViewDelegate {
    private var window: NSWindow!
    private var status: NSTextField!
    private var paymentStatus: NSTextField!
    private var password: NSSecureTextField!
    private var passwordCheck: NSTextField!
    private let rows = ["Alpha", "Beta", "Gamma", "Delta", "Epsilon"]
    private var presses = 0
    private var lastScrollOrigin: CGFloat = 0
    private let pointerFile: URL? = {
        let arguments = CommandLine.arguments
        guard let index = arguments.firstIndex(of: "--pointer-file"),
              index + 1 < arguments.count else { return nil }
        return URL(fileURLWithPath: arguments[index + 1])
    }()
    private let keyEventFile: URL? = {
        let arguments = CommandLine.arguments
        guard let index = arguments.firstIndex(of: "--key-event-file"),
              index + 1 < arguments.count else { return nil }
        return URL(fileURLWithPath: arguments[index + 1])
    }()

    private func recordPointer(_ state: String) {
        if let pointerFile { try? state.write(to: pointerFile, atomically: true, encoding: .utf8) }
    }

    func applicationDidFinishLaunching(_ notification: Notification) {
        if let keyEventFile {
            NSEvent.addLocalMonitorForEvents(matching: .keyDown) { event in
                if event.keyCode == 0 {
                    let record = "keyCode=0 shift=\(event.modifierFlags.contains(.shift)) characters=\(event.characters ?? "")"
                    try? record.write(to: keyEventFile, atomically: true, encoding: .utf8)
                }
                return event
            }
        }
        let menuBar = NSMenu()
        let appItem = NSMenuItem()
        menuBar.addItem(appItem)
        let appMenu = NSMenu(title: "EmperorAXFixture")
        appMenu.addItem(withTitle: "Quit Fixture", action: #selector(NSApplication.terminate(_:)), keyEquivalent: "q")
        appItem.submenu = appMenu
        let editItem = NSMenuItem()
        menuBar.addItem(editItem)
        let editMenu = NSMenu(title: "Edit")
        editMenu.addItem(withTitle: "Select All", action: #selector(NSText.selectAll(_:)), keyEquivalent: "a")
        editMenu.addItem(withTitle: "Paste", action: #selector(NSText.paste(_:)), keyEquivalent: "v")
        editItem.submenu = editMenu
        let fixtureItem = NSMenuItem()
        menuBar.addItem(fixtureItem)
        let fixtureMenu = NSMenu(title: "Fixture")
        fixtureMenu.addItem(withTitle: "Menu Action", action: #selector(menuAction), keyEquivalent: "m")
        fixtureItem.submenu = fixtureMenu
        NSApp.mainMenu = menuBar

        window = NSWindow(contentRect: NSRect(x: 140, y: 120, width: 720, height: 800),
                          styleMask: [.titled, .closable, .miniaturizable, .resizable],
                          backing: .buffered, defer: false)
        window.title = "Emperor AX Fixture"
        window.identifier = NSUserInterfaceItemIdentifier("fixture.window")
        // Every run starts from the same visible window. Restoration would
        // bring back a minimized state saved when a run was killed.
        window.isRestorable = false
        window.minSize = NSSize(width: 640, height: 600)

        let root = NSStackView()
        root.orientation = .vertical
        root.alignment = .leading
        root.spacing = 12
        root.edgeInsets = NSEdgeInsets(top: 20, left: 20, bottom: 20, right: 20)
        root.translatesAutoresizingMaskIntoConstraints = false
        window.contentView?.addSubview(root)
        NSLayoutConstraint.activate([
            root.leadingAnchor.constraint(equalTo: window.contentView!.leadingAnchor),
            root.trailingAnchor.constraint(equalTo: window.contentView!.trailingAnchor),
            root.topAnchor.constraint(equalTo: window.contentView!.topAnchor),
            root.bottomAnchor.constraint(equalTo: window.contentView!.bottomAnchor),
        ])

        let heading = NSTextField(labelWithString: "Emperor AX Fixture")
        heading.font = .systemFont(ofSize: 24, weight: .bold)
        root.addArrangedSubview(heading)
        status = NSTextField(labelWithString: "Status: ready")
        status.setAccessibilityIdentifier("fixture.status")
        root.addArrangedSubview(status)

        let button = NSButton(title: "Press Me", target: self, action: #selector(pressButton))
        button.setAccessibilityIdentifier("fixture.press")
        root.addArrangedSubview(button)

        let paymentButton = NSButton(title: "Pay now (fixture)", target: self,
                                     action: #selector(pressPaymentButton))
        paymentButton.setAccessibilityIdentifier("fixture.pay-now")
        root.addArrangedSubview(paymentButton)
        paymentStatus = NSTextField(labelWithString: "Payment check: not clicked")
        paymentStatus.setAccessibilityIdentifier("fixture.payment-check")
        root.addArrangedSubview(paymentStatus)

        let username = NSTextField(string: "")
        username.placeholderString = "Username"
        username.setAccessibilityLabel("Username")
        username.setAccessibilityIdentifier("fixture.username")
        username.widthAnchor.constraint(equalToConstant: 320).isActive = true
        root.addArrangedSubview(username)

        password = NSSecureTextField(string: "")
        password.placeholderString = "Password"
        password.setAccessibilityLabel("Password")
        password.setAccessibilityIdentifier("fixture.password")
        password.widthAnchor.constraint(equalToConstant: 320).isActive = true
        root.addArrangedSubview(password)
        passwordCheck = NSTextField(labelWithString: "Password check: empty")
        passwordCheck.setAccessibilityIdentifier("fixture.password-check")
        root.addArrangedSubview(passwordCheck)
        Timer.scheduledTimer(timeInterval: 0.1, target: self,
                             selector: #selector(updatePasswordCheck), userInfo: nil, repeats: true)

        let popup = NSPopUpButton()
        popup.addItems(withTitles: ["Choose one", "First", "Second", "Third"])
        popup.setAccessibilityIdentifier("fixture.popup")
        popup.target = self
        popup.action = #selector(popupChanged)
        root.addArrangedSubview(popup)

        let table = NSTableView()
        let column = NSTableColumn(identifier: NSUserInterfaceItemIdentifier("fixture.table.column"))
        column.title = "Rows"
        table.addTableColumn(column)
        table.delegate = self
        table.dataSource = self
        table.setAccessibilityIdentifier("fixture.table")
        let tableScroll = NSScrollView()
        tableScroll.documentView = table
        tableScroll.hasVerticalScroller = true
        tableScroll.heightAnchor.constraint(equalToConstant: 125).isActive = true
        tableScroll.widthAnchor.constraint(equalToConstant: 420).isActive = true
        root.addArrangedSubview(tableScroll)

        let longText = NSTextView()
        longText.isEditable = false
        longText.string = (1...80).map { "Long content line \($0): scroll here." }.joined(separator: "\n")
        longText.setAccessibilityIdentifier("fixture.long-content")
        let contentScroll = NSScrollView()
        contentScroll.documentView = longText
        contentScroll.hasVerticalScroller = true
        contentScroll.setAccessibilityLabel("Long Content Scroll")
        contentScroll.contentView.postsBoundsChangedNotifications = true
        NotificationCenter.default.addObserver(self, selector: #selector(contentDidScroll(_:)),
                                               name: NSView.boundsDidChangeNotification,
                                               object: contentScroll.contentView)
        contentScroll.heightAnchor.constraint(equalToConstant: 120).isActive = true
        contentScroll.widthAnchor.constraint(equalToConstant: 420).isActive = true
        root.addArrangedSubview(contentScroll)

        let canvas = PaintOnlyView(frame: NSRect(x: 0, y: 0, width: 420, height: 60))
        canvas.setAccessibilityIdentifier("fixture.canvas")
        canvas.setAccessibilityLabel("Painted Canvas")
        canvas.widthAnchor.constraint(equalToConstant: 420).isActive = true
        canvas.heightAnchor.constraint(equalToConstant: 60).isActive = true
        canvas.onClick = { [weak self] in
            self?.status.stringValue = "Status: canvas clicked"
            self?.recordPointer("down")
        }
        canvas.onDrag = { [weak self] in self?.status.stringValue = "Status: canvas dragged" }
        canvas.onUp = { [weak self] in self?.recordPointer("up") }
        root.addArrangedSubview(canvas)

        let sheetButton = NSButton(title: "Show Sheet", target: self, action: #selector(showSheet))
        sheetButton.setAccessibilityIdentifier("fixture.sheet")
        root.addArrangedSubview(sheetButton)

        let moveButton = NSButton(title: "Move Window", target: self, action: #selector(moveWindow))
        moveButton.setAccessibilityIdentifier("fixture.move")
        root.addArrangedSubview(moveButton)

        window.center()
        // With --left-display the window moves to a display left of the main
        // one, where global coordinates are negative; centered, away from the
        // menu bar edge, where the screenshot window match fails.
        if CommandLine.arguments.contains("--left-display"),
           let main = NSScreen.screens.first,
           let left = NSScreen.screens.min(by: { $0.frame.minX < $1.frame.minX }),
           left.frame.minX < main.frame.minX {
            let area = left.visibleFrame
            window.setFrameOrigin(NSPoint(x: area.midX - window.frame.width / 2,
                                          y: max(area.minY, area.midY - window.frame.height / 2)))
        }
        window.makeKeyAndOrderFront(nil)
        NSApp.activate(ignoringOtherApps: true)
    }

    func applicationShouldHandleReopen(_ sender: NSApplication, hasVisibleWindows: Bool) -> Bool {
        // The integration harness opens the fixture a second time to restore
        // a minimized window without creating a new window or changing PID.
        if window.isMiniaturized { window.deminiaturize(nil) }
        window.makeKeyAndOrderFront(nil)
        return true
    }

    func numberOfRows(in tableView: NSTableView) -> Int { rows.count }

    func tableView(_ tableView: NSTableView, viewFor tableColumn: NSTableColumn?, row: Int) -> NSView? {
        let cell = NSTextField(labelWithString: rows[row])
        cell.setAccessibilityIdentifier("fixture.row.\(row)")
        return cell
    }

    @objc private func pressButton() {
        presses += 1
        status.stringValue = "Status: pressed \(presses)"
    }

    @objc private func pressPaymentButton() {
        paymentStatus.stringValue = "Payment check: clicked"
    }

    @objc private func popupChanged(_ sender: NSPopUpButton) {
        status.stringValue = "Status: popup \(sender.titleOfSelectedItem ?? "unknown")"
    }

    @objc private func menuAction() { status.stringValue = "Status: menu action" }
    @objc private func contentDidScroll(_ notification: Notification) {
        guard let clip = notification.object as? NSClipView else { return }
        let origin = clip.bounds.origin.y
        guard abs(origin - lastScrollOrigin) >= 1 else { return }
        lastScrollOrigin = origin
        status.stringValue = "Status: scrolled"
    }
    @objc private func updatePasswordCheck() {
        let state = password.stringValue == "fixture-password" ? "matched" :
            (password.stringValue.isEmpty ? "empty" : "other")
        let next = "Password check: \(state)"
        if passwordCheck.stringValue != next { passwordCheck.stringValue = next }
    }

    @objc private func showSheet() {
        let alert = NSAlert()
        alert.messageText = "Fixture Sheet"
        alert.informativeText = "This sheet tests AX window identity and revisions."
        alert.addButton(withTitle: "OK")
        alert.beginSheetModal(for: window) { [weak self] _ in
            self?.status.stringValue = "Status: sheet dismissed"
        }
    }

    @objc private func moveWindow() {
        window.setFrameOrigin(NSPoint(x: window.frame.origin.x + 40,
                                      y: window.frame.origin.y + 20))
        status.stringValue = "Status: window moved"
    }
}

let application = NSApplication.shared
let controller = FixtureController()
application.delegate = controller
application.setActivationPolicy(.regular)
application.run()
