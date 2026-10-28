import MetricKit
import SwiftUI

@main
struct AlanWorkspaceApp: App {
    @State private var telegram: TelegramStore
    @State private var settings = WorkspaceSettings()
    @State private var invalidCallDismissed = false

    init() {
        MXMetricManager.shared.add(DiagnosticsStore.shared)
        #if DEBUG
        _telegram = State(initialValue: ProcessInfo.processInfo.arguments.contains("--interface-preview") ? TelegramStore.interfacePreview() : TelegramStore())
        #else
        _telegram = State(initialValue: TelegramStore())
        #endif
    }

    var body: some Scene {
        WindowGroup {
            launchView
                .environment(telegram)
                .environment(settings)
                .preferredColorScheme(.dark)
                .tint(WorkspaceTheme.mint)
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
