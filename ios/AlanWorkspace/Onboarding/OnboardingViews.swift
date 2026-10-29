import SwiftUI

struct OnboardingStepLabel: View {
    let text: String

    var body: some View {
        Text(text).font(.system(size: 10, weight: .semibold, design: .monospaced)).tracking(1.5)
            .foregroundStyle(WorkspaceTheme.mint)
    }
}

struct OnboardingWelcomeView: View {
    @Environment(TelegramStore.self) private var telegram
    let onStart: () -> Void

    var body: some View {
        ScrollView {
            VStack(alignment: .leading, spacing: 24) {
                HStack(spacing: 10) {
                    Image(systemName: "circle.hexagongrid.fill").foregroundStyle(WorkspaceTheme.mint)
                    Text("ALAN’S WORKSPACE").font(.system(size: 11, weight: .semibold, design: .monospaced)).tracking(2)
                }
                .padding(.top, 24)

                Image("hermes").resizable().scaledToFit().frame(height: 190).frame(maxWidth: .infinity)
                    .accessibilityHidden(true)

                VStack(alignment: .leading, spacing: 12) {
                    Text("Your workspace,\nwherever you are.").font(.system(size: 34, weight: .medium, design: .serif)).tracking(-0.7)
                    Text("Chat, call, and watch your Hermes agents work. Setup takes a few minutes and needs the phone where you use Telegram.")
                        .font(.system(size: 15)).foregroundStyle(WorkspaceTheme.secondary).lineSpacing(5)
                        .fixedSize(horizontal: false, vertical: true)
                }

                VStack(alignment: .leading, spacing: 16) {
                    step(1, "Connect Telegram", telegram.hasBundledCredentials
                         ? "This build already includes its Telegram app ID."
                         : "Create a free Telegram app ID at my.telegram.org.")
                    step(2, "Sign in", "Use your Telegram phone number and the code Telegram sends.")
                    step(3, "Choose your Hermes bot", "Then optionally check its voice calls and desktop viewer.")
                }

                Button(action: onStart) {
                    HStack(spacing: 10) { Text("Get started"); Image(systemName: "arrow.right") }
                }
                .buttonStyle(WorkspacePrimaryButton())
                .accessibilityIdentifier("onboardingStart")
            }
            .padding(.horizontal, 28).padding(.bottom, 24)
            .frame(maxWidth: 540).frame(maxWidth: .infinity)
        }
        .background(WorkspaceTheme.background)
    }

    private func step(_ number: Int, _ title: String, _ detail: String) -> some View {
        HStack(alignment: .top, spacing: 14) {
            Text("\(number)").font(.system(size: 13, weight: .semibold, design: .monospaced))
                .frame(width: 26, height: 26).background(WorkspaceTheme.surface, in: Circle())
                .foregroundStyle(WorkspaceTheme.mint)
            VStack(alignment: .leading, spacing: 3) {
                Text(title).font(.system(size: 15, weight: .semibold))
                Text(detail).font(.system(size: 13)).foregroundStyle(WorkspaceTheme.secondary)
                    .fixedSize(horizontal: false, vertical: true)
            }
        }
        .accessibilityElement(children: .combine)
    }
}

/// Final first-run step after Telegram sign-in: pick the Hermes bot, then optionally check its voice and viewer addresses.
struct OnboardingBotSetupView: View {
    @Environment(TelegramStore.self) private var telegram
    @Environment(WorkspaceSettings.self) private var settings
    @State private var selectedChatID: Int64?
    @State private var checking = false
    @State private var username = ""
    @State private var opening = false
    @State private var errorText: String?
    @State private var voiceAddress = ""
    @State private var viewerAddress = ""
    @State private var voiceResult: ConnectionCheck.Outcome?
    @State private var viewerResult: ConnectionCheck.Outcome?
    @State private var voiceChecking = false
    @State private var viewerChecking = false

    private var bots: [TelegramChat] { telegram.chats.filter(\.isBot) }
    private var selectedBot: TelegramChat? { bots.first { $0.id == selectedChatID } }

    var body: some View {
        ScrollView {
            VStack(alignment: .leading, spacing: 22) {
                if checking, let bot = selectedBot { checks(for: bot) } else { chooser }
            }
            .padding(.horizontal, 24).padding(.top, 28).padding(.bottom, 32)
            .frame(maxWidth: 560).frame(maxWidth: .infinity)
        }
        .scrollDismissesKeyboard(.interactively)
        .background(WorkspaceTheme.background)
        .onChange(of: voiceAddress) { _, _ in voiceResult = nil }
        .onChange(of: viewerAddress) { _, _ in viewerResult = nil }
        .task {
            guard !telegram.isInterfacePreview else { return }
            do { try await telegram.loadChats() } catch { errorText = TelegramErrorText.describe(error) }
        }
    }

    @ViewBuilder private var chooser: some View {
        OnboardingStepLabel(text: "STEP 3 OF 3 · YOUR HERMES BOT")
        header("Choose your Hermes bot", "Pick the Telegram bot that runs your Hermes agent. You can open more bots later.")

        if telegram.isLoadingChats && bots.isEmpty {
            ProgressView("Loading your conversations…").frame(maxWidth: .infinity).padding(.vertical, 20)
        } else if bots.isEmpty {
            Text("No bot conversations yet. Open your bot by its username below.")
                .font(.system(size: 14)).foregroundStyle(WorkspaceTheme.secondary)
        } else {
            VStack(spacing: 10) {
                ForEach(bots) { bot in
                    Button { selectedChatID = bot.id } label: { botRow(bot) }
                        .buttonStyle(.plain)
                        .accessibilityIdentifier("onboardingBot-\(bot.id)")
                        .accessibilityValue(selectedChatID == bot.id ? "Selected" : "")
                }
            }
        }

        VStack(alignment: .leading, spacing: 8) {
            Text("OPEN A BOT BY USERNAME").font(.system(size: 10, weight: .semibold, design: .monospaced)).tracking(1.5)
                .foregroundStyle(WorkspaceTheme.secondary)
            HStack(spacing: 10) {
                TextField("@your_hermes_bot", text: $username)
                    .textInputAutocapitalization(.never).autocorrectionDisabled().modifier(WorkspaceField())
                    .accessibilityIdentifier("onboardingBotUsername")
                Button(action: openBot) {
                    if opening { ProgressView() } else { Text("Open") }
                }
                .disabled(opening || username.trimmingCharacters(in: CharacterSet(charactersIn: "@ ")).isEmpty)
                .accessibilityIdentifier("onboardingOpenBot")
            }
        }

        if let errorText { problem(errorText).accessibilityIdentifier("onboardingError") }

        Button {
            if let id = selectedChatID { viewerAddress = settings.viewerAddress(for: id) }
            checking = true
        } label: {
            HStack(spacing: 10) { Text("Continue"); Image(systemName: "arrow.right") }
        }
        .buttonStyle(WorkspacePrimaryButton())
        .disabled(selectedBot == nil).opacity(selectedBot == nil ? 0.5 : 1)
        .accessibilityIdentifier("onboardingContinue")

        Button("Skip for now") { settings.completeOnboarding() }
            .font(.footnote).foregroundStyle(WorkspaceTheme.secondary).frame(maxWidth: .infinity)
            .accessibilityIdentifier("onboardingSkip")
    }

    @ViewBuilder private func checks(for bot: TelegramChat) -> some View {
        Button { checking = false } label: { Label("Choose another bot", systemImage: "chevron.left") }
            .font(.footnote).foregroundStyle(WorkspaceTheme.secondary)
            .accessibilityIdentifier("onboardingBack")
        OnboardingStepLabel(text: "OPTIONAL · VOICE AND COMPUTER")
        header("Check \(bot.title)’s connections", "Both checks are optional. You can set these up later from the conversation.")

        checkSection(
            title: "VOICE CALLS",
            detail: "Calls open your bot’s voice Mini App. Paste its address, the app_url from the Hermes voice plugin, to check that it is reachable. This address is not saved; the bot sends it with each call.",
            placeholder: "https://voice.example.net/call/",
            address: $voiceAddress, result: voiceResult, busy: voiceChecking, identifier: "Voice"
        ) {
            voiceChecking = true
            defer { voiceChecking = false }
            guard let url = ConnectionCheck.voiceProbeURL(voiceAddress) else { voiceResult = ConnectionCheck.invalidAddress; return }
            voiceResult = await ConnectionCheck.run(url, interpret: ConnectionCheck.voice)
        }

        checkSection(
            title: "DESKTOP VIEWER",
            detail: "The Computer button opens your agent’s existing noVNC viewer. For a private tailnet address, connect Tailscale on this iPhone first. The address is saved for \(bot.title).",
            placeholder: "https://desktop.example.ts.net/vnc.html",
            address: $viewerAddress, result: viewerResult, busy: viewerChecking, identifier: "Viewer"
        ) {
            viewerChecking = true
            defer { viewerChecking = false }
            guard let url = ViewerAddress.parse(viewerAddress) else { viewerResult = ConnectionCheck.invalidAddress; return }
            viewerResult = await ConnectionCheck.run(url) { status, _ in ConnectionCheck.viewer(status: status) }
        }

        Button {
            if settings.setViewerAddress(viewerAddress, for: bot.id) { settings.completeOnboarding() }
            else { viewerResult = ConnectionCheck.invalidAddress }
        } label: {
            HStack(spacing: 10) { Text("Finish setup"); Image(systemName: "checkmark") }
        }
        .buttonStyle(WorkspacePrimaryButton())
        .accessibilityIdentifier("onboardingFinish")

        Button("Skip checks") { settings.completeOnboarding() }
            .font(.footnote).foregroundStyle(WorkspaceTheme.secondary).frame(maxWidth: .infinity)
            .accessibilityIdentifier("onboardingSkipChecks")
    }

    private func header(_ title: String, _ detail: String) -> some View {
        VStack(alignment: .leading, spacing: 10) {
            Text(title).font(.system(size: 30, weight: .medium, design: .serif)).tracking(-0.6)
            Text(detail).font(.system(size: 15)).foregroundStyle(WorkspaceTheme.secondary).lineSpacing(4)
                .fixedSize(horizontal: false, vertical: true)
        }
    }

    private func botRow(_ bot: TelegramChat) -> some View {
        HStack(spacing: 14) {
            AgentPortrait(name: settings.avatar(for: bot.id), size: 48)
            VStack(alignment: .leading, spacing: 4) {
                Text(bot.title).font(.system(size: 16, weight: .semibold)).lineLimit(1)
                if let username = bot.username {
                    Text("@\(username)").font(.system(size: 12)).foregroundStyle(WorkspaceTheme.secondary).lineLimit(1)
                }
            }
            Spacer(minLength: 0)
            Image(systemName: selectedChatID == bot.id ? "checkmark.circle.fill" : "circle")
                .font(.system(size: 20)).foregroundStyle(selectedChatID == bot.id ? WorkspaceTheme.mint : WorkspaceTheme.secondary)
        }
        .padding(14)
        .background(WorkspaceTheme.surface)
        .clipShape(RoundedRectangle(cornerRadius: 20))
        .overlay(RoundedRectangle(cornerRadius: 20).stroke(selectedChatID == bot.id ? WorkspaceTheme.mint.opacity(0.6) : WorkspaceTheme.line))
        .accessibilityElement(children: .combine)
    }

    private func checkSection(title: String, detail: String, placeholder: String, address: Binding<String>,
                              result: ConnectionCheck.Outcome?, busy: Bool, identifier: String,
                              check: @escaping () async -> Void) -> some View {
        VStack(alignment: .leading, spacing: 10) {
            Text(title).font(.system(size: 10, weight: .semibold, design: .monospaced)).tracking(1.5)
                .foregroundStyle(WorkspaceTheme.secondary)
            Text(detail).font(.system(size: 13)).foregroundStyle(WorkspaceTheme.secondary).lineSpacing(3)
                .fixedSize(horizontal: false, vertical: true)
            HStack(spacing: 10) {
                TextField(placeholder, text: address)
                    .keyboardType(.URL).textInputAutocapitalization(.never).autocorrectionDisabled()
                    .modifier(WorkspaceField())
                    .accessibilityIdentifier("onboarding\(identifier)Address")
                Button { Task { await check() } } label: {
                    if busy { ProgressView() } else { Text("Check") }
                }
                .disabled(busy || address.wrappedValue.trimmingCharacters(in: .whitespaces).isEmpty)
                .accessibilityIdentifier("onboarding\(identifier)Check")
            }
            switch result {
            case .ok(let text):
                notice(text, icon: "checkmark.circle", color: WorkspaceTheme.mint).accessibilityIdentifier("onboarding\(identifier)Result")
            case .problem(let text):
                problem(text).accessibilityIdentifier("onboarding\(identifier)Result")
            case nil:
                EmptyView()
            }
        }
    }

    private func problem(_ text: String) -> some View { notice(text, icon: "exclamationmark.circle", color: .orange) }

    private func notice(_ text: String, icon: String, color: Color) -> some View {
        Label(text, systemImage: icon)
            .font(.footnote).foregroundStyle(color).fixedSize(horizontal: false, vertical: true)
            .accessibilityElement(children: .combine)
    }

    private func openBot() {
        opening = true; errorText = nil
        Task {
            defer { opening = false }
            do { selectedChatID = try await telegram.openBot(username: username); username = "" }
            catch { errorText = TelegramErrorText.describe(error) }
        }
    }
}
