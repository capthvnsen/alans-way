import SwiftUI

/// The Alan's Way settings: the gateway address and sign-in. The password is used once and never stored; the session the
/// gateway returns goes to the Keychain only.
struct GatewaySettingsView: View {
    /// True when shown in its own sheet (a Done button, and it closes itself after signing in).
    var showsDone = false
    var onSetUpTelegram: (() -> Void)?
    @Environment(GatewayStore.self) private var gateway
    @Environment(\.dismiss) private var dismiss
    @State private var address = ""
    @State private var username = ""
    @State private var password = ""
    @State private var busy = false
    @State private var errorText: String?
    @State private var confirmSignOut = false
    @FocusState private var focus: Field?
    private enum Field { case address, username, password }

    private var addressProblem: String? {
        let clean = address.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !clean.isEmpty, GatewayAddress.parse(clean, allowLoopback: gateway.allowLoopback) == nil else { return nil }
        return "Use the https://….ts.net address that Tailscale shows for your Hermes machine. Plain http and other hosts are not allowed."
    }
    private var canSignIn: Bool {
        !address.trimmingCharacters(in: .whitespaces).isEmpty && addressProblem == nil && !username.trimmingCharacters(in: .whitespaces).isEmpty && !password.isEmpty
    }

    var body: some View {
        List {
            if let onSetUpTelegram, gateway.isConfigured {
                Section { Button("Set up Telegram too") { dismiss(); onSetUpTelegram() }.frame(minHeight: 44) }.listRowBackground(WorkspaceTheme.surface)
            }
            if gateway.isConfigured { connected } else { signIn }
        }
        .scrollContentBackground(.hidden).background(WorkspaceTheme.background)
        .navigationTitle("Alan’s Way").navigationBarTitleDisplayMode(.inline)
        .scrollDismissesKeyboard(.interactively)
        .toolbar { if showsDone { ToolbarItem(placement: .confirmationAction) { Button("Done") { dismiss() } } } }
        .confirmationDialog("Sign out of Alan’s Way?", isPresented: $confirmSignOut, titleVisibility: .visible) {
            if gateway.outbox.items.isEmpty {
                Button("Sign out", role: .destructive) { gateway.signOut(keepUnsent: false) }
            } else {
                Button("Sign out and keep unsent messages") { gateway.signOut(keepUnsent: true) }
                Button("Sign out and delete unsent messages", role: .destructive) { gateway.signOut(keepUnsent: false) }
            }
        } message: {
            Text(gateway.outbox.items.isEmpty ? "This removes the sign-in from this device." : "\(gateway.outbox.items.count) message(s) have not been sent yet.")
        }
    }

    @ViewBuilder private var signIn: some View {
        Section {
            TextField("https://machine.tailnet.ts.net", text: $address)
                .keyboardType(.URL).textContentType(.URL).textInputAutocapitalization(.never).autocorrectionDisabled()
                .focused($focus, equals: .address).submitLabel(.next).onSubmit { focus = .username }
                .accessibilityLabel("Hermes gateway address").accessibilityIdentifier("gatewayAddress")
            TextField("Username", text: $username)
                .textContentType(.username).textInputAutocapitalization(.never).autocorrectionDisabled()
                .focused($focus, equals: .username).submitLabel(.next).onSubmit { focus = .password }
                .accessibilityIdentifier("gatewayUsername")
            SecureField("Dashboard password", text: $password)
                .focused($focus, equals: .password).submitLabel(.go).onSubmit(submit)
                .accessibilityIdentifier("gatewayPassword")
        } header: { Text("Hermes gateway") } footer: {
            VStack(alignment: .leading, spacing: 8) {
                if let addressProblem { Text(addressProblem).foregroundStyle(.orange).accessibilityIdentifier("gatewayAddressProblem") }
                Text("Tailscale must be connected on this phone. The password signs you in once and is not kept; only the sign-in the gateway returns is saved, in this device’s Keychain.")
            }
        }.listRowBackground(WorkspaceTheme.surface)
        Section {
            Button(action: submit) {
                HStack { if busy { ProgressView() }; Text(busy ? "Signing in…" : "Sign in") }.frame(maxWidth: .infinity, minHeight: 44)
            }
            .disabled(!canSignIn || busy).accessibilityIdentifier("gatewaySignIn")
        } footer: {
            if let errorText { Label(errorText, systemImage: "exclamationmark.circle").foregroundStyle(.orange).accessibilityIdentifier("gatewayError") }
        }.listRowBackground(WorkspaceTheme.surface)
    }

    @ViewBuilder private var connected: some View {
        Section("Hermes gateway") {
            LabeledContent("Address", value: gateway.address)
            LabeledContent("Status") { Text(statusText).foregroundStyle(WorkspaceTheme.secondary) }.accessibilityIdentifier("gatewayStatus")
        }.listRowBackground(WorkspaceTheme.surface)
        Section {
            Button("Sign in again") { gateway.signOut(keepUnsent: true) }.frame(minHeight: 44)
                .disabled(gateway.linkState != .signin && gateway.linkState != .refused)
            Button("Sign out", role: .destructive) { confirmSignOut = true }.frame(minHeight: 44).accessibilityIdentifier("gatewaySignOut")
        } footer: { Text("Signing out removes the sign-in from this device. Your conversations stay on the Hermes machine.") }
            .listRowBackground(WorkspaceTheme.surface)
    }

    private var statusText: String {
        switch gateway.linkState {
        case .live: "Connected"
        case .connecting, .syncing: "Connecting…"
        case .reconnecting: "Reconnecting…"
        case .offline: "Offline"
        case .suspended, .idle, .stopped: "Not connected"
        case .signin: "Sign in again"
        case .refused: "Address not allowed"
        }
    }

    private func submit() {
        guard canSignIn, !busy else { return }
        busy = true; errorText = nil; focus = nil
        let (a, u, p) = (address, username, password)
        Task {
            defer { busy = false }
            do {
                try await gateway.signIn(address: a, username: u.trimmingCharacters(in: .whitespaces), password: p)
                password = ""; address = ""; username = ""
                if showsDone { dismiss() }
            } catch let e as GatewayError {
                errorText = e.code == "unreachable" || e.code == "timeout" ? "Could not reach the gateway. Is Tailscale connected on this phone?" : e.message
            } catch { errorText = "Could not save the sign-in on this device. \(error.localizedDescription)" }
        }
    }
}
