import MetricKit
import SwiftUI

@main
struct AlanWorkspaceApp: App {
    @State private var telegram: TelegramStore
    @State private var settings = WorkspaceSettings()
    @State private var gateway: GatewayStore
    @Environment(\.scenePhase) private var scenePhase
    @State private var invalidCallDismissed = false

    init() {
        MXMetricManager.shared.add(DiagnosticsStore.shared)
        #if DEBUG
        let loopback = ProcessInfo.processInfo.arguments.contains("--gateway-allow-loopback")
        if ProcessInfo.processInfo.arguments.contains("--gateway-reset") {
            try? KeychainGatewaySessionStore().clear()
            try? FileManager.default.removeItem(at: GatewayOutbox.defaultURL)
        }
        _gateway = State(initialValue: GatewayStore(allowLoopback: loopback))
        #else
        _gateway = State(initialValue: GatewayStore())
        #endif
        // UI tests never restore a session, so they start at the setup form rather than waiting on TDLib.
        let store = TelegramStore(authState: ProcessInfo.processInfo.arguments.contains("--ui-testing") ? .configuring : .starting)
        #if DEBUG
        _telegram = State(initialValue: ProcessInfo.processInfo.arguments.contains("--interface-preview") ? TelegramStore.interfacePreview() : store)
        #else
        _telegram = State(initialValue: store)
        #endif
    }

    var body: some Scene {
        WindowGroup {
            launchView
                .environment(telegram)
                .environment(settings)
                .environment(gateway)
                .preferredColorScheme(.dark)
                .tint(WorkspaceTheme.mint)
                .task { gateway.start() }
                .onChange(of: scenePhase) { _, phase in if phase != .inactive { gateway.setActive(phase == .active) } }
                .task {
                    if !ProcessInfo.processInfo.arguments.contains("--ui-testing") && !telegram.isInterfacePreview {
                        await telegram.restoreSession()
                    }
                }
        }
    }

    @ViewBuilder private var launchView: some View {
        #if DEBUG
        if ProcessInfo.processInfo.arguments.contains("--invalid-call-host") && !invalidCallDismissed {
            CallSheet(url: URL(string: "http://invalid.local/call")!, botName: "Call host test", onClose: { invalidCallDismissed = true })
        } else { WorkspaceRootView() }
        #else
        WorkspaceRootView()
        #endif
    }
}
