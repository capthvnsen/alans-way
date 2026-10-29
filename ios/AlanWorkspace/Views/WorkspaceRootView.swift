import SwiftUI

struct WorkspaceRootView: View {
    @Environment(TelegramStore.self) private var telegram
    @Environment(WorkspaceSettings.self) private var settings
    @State private var welcomeDismissed = false

    var body: some View {
        VStack(spacing: 0) {
            Group {
                if telegram.authState == .ready {
                    if settings.hasCompletedOnboarding { AgentListView() } else { OnboardingBotSetupView() }
                } else if !settings.hasCompletedOnboarding && !welcomeDismissed {
                    OnboardingWelcomeView { welcomeDismissed = true }
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
    @Environment(WorkspaceSettings.self) private var settings
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
        case .closed: "Your workspace,\nwherever you are."
        default: "Connect Telegram"
        }
    }

    private var step: String {
        switch telegram.authState {
        case .configuring, .error: "STEP 1 OF 3 · TELEGRAM APP"
        default: "STEP 2 OF 3 · SIGN IN"
        }
    }

    private var showsAppCredentials: Bool {
        switch telegram.authState {
        case .configuring, .error: true
        default: false
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

                    if !showsAppCredentials {
                        ZStack {
                            Circle().fill(WorkspaceTheme.mint.opacity(0.035)).frame(width: 270, height: 270)
                            Circle().stroke(WorkspaceTheme.mint.opacity(0.13), lineWidth: 0.5).frame(width: 265, height: 265)
                            Image("hermes").resizable().scaledToFit().frame(height: 255)
                        }
                        .frame(maxWidth: .infinity)
                        .padding(.top, 10)
                        .accessibilityHidden(true)
                    }

                    VStack(alignment: .leading, spacing: 12) {
                        if !settings.hasCompletedOnboarding && telegram.authState != .closed { OnboardingStepLabel(text: step) }
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

                    if telegram.authState == .waitPhoneNumber && !telegram.hasBundledCredentials {
                        Button("Use different app credentials", action: resetCredentials)
                            .font(.footnote).foregroundStyle(WorkspaceTheme.secondary).frame(maxWidth: .infinity)
                            .disabled(busy)
                            .accessibilityIdentifier("resetAppCredentials")
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
        default: "Telegram asks every app to use its own free API ID. Create one once, then sign in with your usual Telegram account."
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
            VStack(alignment: .leading, spacing: 12) {
                instruction(1, "Open my.telegram.org and log in with your Telegram phone number.")
                Link(destination: URL(string: "https://my.telegram.org/apps")!) {
                    Label("Open my.telegram.org/apps", systemImage: "arrow.up.right.square")
                        .font(.system(size: 14, weight: .medium))
                }
                .padding(.leading, 36)
                .accessibilityIdentifier("telegramDeveloperLink")
                instruction(2, "Choose API development tools and create an app. Any title works, such as Alan’s Workspace.")
                instruction(3, "Copy App api_id and App api_hash here.")
                TextField("App api_id", text: $apiID)
                    .keyboardType(.numberPad).modifier(WorkspaceField()).accessibilityIdentifier("telegramAPIID")
                SecureField("App api_hash", text: $apiHash)
                    .textInputAutocapitalization(.never).autocorrectionDisabled().modifier(WorkspaceField())
                    .accessibilityIdentifier("telegramAPIHash")
                if !apiID.isEmpty && !apiHash.isEmpty, let problem = TelegramAppCredentials.problem(apiID: apiID, apiHash: apiHash) {
                    Text(problem).font(.caption).foregroundStyle(.orange).accessibilityIdentifier("telegramCredentialHint")
                }
                Label("Saved only in this device’s Keychain. This is not your bot token; never share the API hash.", systemImage: "lock")
                    .font(.caption).foregroundStyle(WorkspaceTheme.secondary).lineSpacing(3)
                    .fixedSize(horizontal: false, vertical: true)
            }
        }
    }

    private func instruction(_ number: Int, _ text: String) -> some View {
        HStack(alignment: .top, spacing: 12) {
            Text("\(number)").font(.system(size: 12, weight: .semibold, design: .monospaced))
                .frame(width: 24, height: 24).background(WorkspaceTheme.surface, in: Circle())
                .foregroundStyle(WorkspaceTheme.mint)
            Text(text).font(.system(size: 14)).foregroundStyle(WorkspaceTheme.secondary)
                .fixedSize(horizontal: false, vertical: true)
        }
        .accessibilityElement(children: .combine)
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
        default: TelegramAppCredentials.problem(apiID: apiID, apiHash: apiHash) == nil
        }
    }

    private var buttonTitle: String {
        if telegram.authState == .closed { return "Sign in again" }
        return telegram.authState == .configuring ? "Connect Telegram" : "Continue"
    }

    private func resetCredentials() {
        busy = true; errorText = nil
        Task {
            defer { busy = false }
            do { try await telegram.resetAppCredentials(); phone = "" }
            catch { errorText = TelegramErrorText.describe(error) }
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
                    guard let id = Int32(apiID.trimmingCharacters(in: .whitespacesAndNewlines)) else { return }
                    try await telegram.configure(apiID: id, apiHash: apiHash.trimmingCharacters(in: .whitespacesAndNewlines))
                    apiHash = ""
                }
            } catch { errorText = TelegramErrorText.describe(error) }
        }
    }
}
