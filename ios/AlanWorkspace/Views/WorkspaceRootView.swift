import SwiftUI

struct WorkspaceRootView: View {
    @Environment(TelegramStore.self) private var telegram

    var body: some View {
        VStack(spacing: 0) {
            Group {
                if telegram.authState == .ready {
                    AgentListView()
                } else {
                    TelegramSignInView()
                }
            }
            .frame(maxWidth: .infinity, maxHeight: .infinity)
            if telegram.isInterfacePreview {
                Text("INTERFACE PREVIEW · SAMPLE DATA")
                    .font(.system(size: 9, weight: .semibold, design: .monospaced)).tracking(1)
                    .foregroundStyle(WorkspaceTheme.mint)
                    .frame(maxWidth: .infinity).padding(7).background(WorkspaceTheme.surface)
            }
        }
        .background(WorkspaceTheme.background)
    }
}

struct TelegramSignInView: View {
    @Environment(TelegramStore.self) private var telegram
    @State private var apiID = ""
    @State private var apiHash = ""
    @State private var phone = ""
    @State private var code = ""
    @State private var password = ""
    @State private var email = ""
    @State private var emailCode = ""
    @State private var busy = false
    @State private var errorText: String?

    private var title: String {
        switch telegram.authState {
        case .waitCode: "Check your Telegram"
        case .waitEmailAddress, .waitEmailCode: "Check your email"
        case .waitPassword: "One more step"
        case .waitPhoneNumber: "Bring your agents along."
        default: "Your workspace,\nwherever you are."
        }
    }

    var body: some View {
        GeometryReader { geometry in
            ScrollView {
                VStack(alignment: .leading, spacing: 24) {
                    HStack(spacing: 10) {
                        Image(systemName: "circle.hexagongrid.fill").foregroundStyle(WorkspaceTheme.mint)
                        Text("ALAN’S WORKSPACE").font(.system(size: 11, weight: .semibold, design: .monospaced)).tracking(2)
                        Spacer()
                    }
                    .padding(.top, 24)

                    ZStack {
                        Circle().fill(WorkspaceTheme.mint.opacity(0.035)).frame(width: 270, height: 270)
                        Circle().stroke(WorkspaceTheme.mint.opacity(0.13), lineWidth: 0.5).frame(width: 265, height: 265)
                        Image("hermes").resizable().scaledToFit().frame(height: 255)
                    }
                    .frame(maxWidth: .infinity)
                    .padding(.top, 10)
                    .accessibilityHidden(true)

                    VStack(alignment: .leading, spacing: 12) {
                        Text(title).font(.system(size: 34, weight: .medium, design: .serif)).tracking(-0.7)
                        Text(explanation)
                            .font(.system(size: 15)).foregroundStyle(WorkspaceTheme.secondary).lineSpacing(5)
                            .fixedSize(horizontal: false, vertical: true)
                    }

                    fields

                    if let message = errorText ?? authError {
                        Label(message, systemImage: "exclamationmark.circle")
                            .font(.footnote).foregroundStyle(.orange).fixedSize(horizontal: false, vertical: true)
                            .accessibilityIdentifier("signInError")
                    }

                    Button(action: submit) {
                        HStack(spacing: 10) {
                            if busy { ProgressView().tint(WorkspaceTheme.background) }
                            Text(buttonTitle)
                            if !busy { Image(systemName: "arrow.right") }
                        }
                    }
                    .buttonStyle(WorkspacePrimaryButton())
                    .disabled(busy || !canSubmit)
                    .opacity(canSubmit ? 1 : 0.5)
                    .accessibilityIdentifier("signInContinue")

                    if telegram.authState == .configuring || telegram.authState == .closed {
                        VStack(alignment: .leading, spacing: 15) {
                            feature("bubble.left.and.bubble.right", "Your existing Telegram conversations")
                            feature("waveform", "Talk to the agent you already know")
                            feature("desktopcomputer", "A window into your agent’s computer")
                        }.padding(.top, 8)
                        Link("Telegram developer setup", destination: URL(string: "https://my.telegram.org/apps")!)
                            .font(.footnote).foregroundStyle(WorkspaceTheme.secondary)
                    }
                    Spacer(minLength: 12)
                    Text("CONNECTED THROUGH TELEGRAM")
                        .font(.system(size: 9, weight: .medium, design: .monospaced)).tracking(1.7)
                        .foregroundStyle(WorkspaceTheme.secondary).frame(maxWidth: .infinity)
                }
                .padding(.horizontal, 28)
                .padding(.bottom, 24)
                .frame(minHeight: geometry.size.height)
                .frame(maxWidth: 540)
                .frame(maxWidth: .infinity)
            }
            .scrollDismissesKeyboard(.interactively)
            .background(WorkspaceTheme.background)
        }
    }

    private var explanation: String {
        switch telegram.authState {
        case .waitPhoneNumber: "Sign in with the phone number you use for Telegram. Your bots and conversations will be right here."
        case .waitCode: "Enter the sign-in code Telegram sent you. Your existing conversations stay connected across devices."
        case .waitPassword: "Your Telegram account has two-step verification. Enter your password to finish signing in."
        case .waitEmailAddress: "Telegram requires a sign-in email for this account. Enter the email address you use with Telegram."
        case .waitEmailCode: "Enter the verification code Telegram sent to your email address."
        case .closed: "Sign in to Telegram again using the app credentials saved securely on this device."
        default: "Chat, call, and watch your Hermes agents work. Connect your Telegram account to pick up where you left off."
        }
    }

    @ViewBuilder private var fields: some View {
        switch telegram.authState {
        case .closed:
            EmptyView()
        case .waitPhoneNumber:
            TextField("Phone number, including country code", text: $phone)
                .keyboardType(.phonePad).textContentType(.telephoneNumber).modifier(WorkspaceField())
                .accessibilityIdentifier("telegramPhone")
        case .waitCode:
            TextField("Sign-in code", text: $code)
                .keyboardType(.numberPad).textContentType(.oneTimeCode).modifier(WorkspaceField())
                .accessibilityIdentifier("telegramCode")
        case .waitPassword:
            SecureField("Telegram password", text: $password)
                .textContentType(.password).modifier(WorkspaceField())
                .accessibilityIdentifier("telegramPassword")
        case .waitEmailAddress:
            TextField("Telegram sign-in email", text: $email)
                .keyboardType(.emailAddress).textContentType(.emailAddress).textInputAutocapitalization(.never)
                .autocorrectionDisabled().modifier(WorkspaceField())
                .accessibilityIdentifier("telegramEmail")
        case .waitEmailCode:
            TextField("Email verification code", text: $emailCode)
                .keyboardType(.numberPad).textContentType(.oneTimeCode).modifier(WorkspaceField())
                .accessibilityIdentifier("telegramEmailCode")
        default:
            VStack(alignment: .leading, spacing: 10) {
                Text("CONNECT THIS BUILD").font(.system(size: 10, weight: .semibold, design: .monospaced)).tracking(1.5)
                    .foregroundStyle(WorkspaceTheme.secondary)
                TextField("Telegram API ID", text: $apiID)
                    .keyboardType(.numberPad).modifier(WorkspaceField()).accessibilityIdentifier("telegramAPIID")
                SecureField("Telegram API hash", text: $apiHash)
                    .textInputAutocapitalization(.never).autocorrectionDisabled().modifier(WorkspaceField())
                    .accessibilityIdentifier("telegramAPIHash")
                Text("For this private build, enter your Telegram app credentials. They are stored securely on this device.")
                    .font(.caption).foregroundStyle(WorkspaceTheme.secondary).lineSpacing(3)
            }
        }
    }

    private var authError: String? {
        if case .error(let text) = telegram.authState { return text }
        return nil
    }

    private var canSubmit: Bool {
        switch telegram.authState {
        case .closed: true
        case .waitPhoneNumber: phone.trimmingCharacters(in: .whitespaces).count >= 7
        case .waitCode: !code.trimmingCharacters(in: .whitespaces).isEmpty
        case .waitPassword: !password.isEmpty
        case .waitEmailAddress: email.contains("@")
        case .waitEmailCode: !emailCode.trimmingCharacters(in: .whitespaces).isEmpty
        default: (Int32(apiID) ?? 0) > 0 && apiHash.trimmingCharacters(in: .whitespacesAndNewlines).count >= 16
        }
    }

    private var buttonTitle: String {
        if telegram.authState == .closed { return "Sign in again" }
        return telegram.authState == .configuring ? "Connect Telegram" : "Continue"
    }

    private func feature(_ icon: String, _ text: String) -> some View {
        HStack(spacing: 13) {
            Image(systemName: icon).font(.system(size: 16)).frame(width: 22).foregroundStyle(WorkspaceTheme.mint)
            Text(text).font(.system(size: 13)).foregroundStyle(WorkspaceTheme.secondary)
        }
    }

    private func submit() {
        busy = true; errorText = nil
        Task {
            defer { busy = false }
            do {
                switch telegram.authState {
                case .closed: await telegram.restoreSession()
                case .waitPhoneNumber: try await telegram.submitPhoneNumber(phone)
                case .waitCode: try await telegram.submitCode(code); code = ""
                case .waitPassword: try await telegram.submitPassword(password); password = ""
                case .waitEmailAddress: try await telegram.submitEmailAddress(email)
                case .waitEmailCode: try await telegram.submitEmailCode(emailCode); emailCode = ""
                default:
                    guard let id = Int32(apiID) else { return }
                    try await telegram.configure(apiID: id, apiHash: apiHash.trimmingCharacters(in: .whitespacesAndNewlines))
                    apiHash = ""
                }
            } catch { errorText = error.localizedDescription }
        }
    }
}
