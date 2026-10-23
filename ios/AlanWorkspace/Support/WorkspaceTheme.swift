import SwiftUI

enum WorkspaceTheme {
    static let background = Color(red: 0.047, green: 0.055, blue: 0.059)
    static let surface = Color(red: 0.080, green: 0.090, blue: 0.094)
    static let raised = Color(red: 0.119, green: 0.135, blue: 0.137)
    static let mint = Color(red: 0.72, green: 0.88, blue: 0.80)
    static let secondary = Color(red: 0.56, green: 0.61, blue: 0.59)
    static let line = Color.white.opacity(0.08)
}

struct AgentPortrait: View {
    var name: String = "hermes"
    var size: CGFloat = 52

    var body: some View {
        Image(name)
            .resizable()
            .scaledToFit()
            .padding(.top, size * 0.1)
            .frame(width: size, height: size)
            .background(WorkspaceTheme.raised)
            .clipShape(RoundedRectangle(cornerRadius: size * 0.30, style: .continuous))
            .accessibilityHidden(true)
    }
}

struct WorkspacePrimaryButton: ButtonStyle {
    func makeBody(configuration: Configuration) -> some View {
        configuration.label
            .font(.system(size: 16, weight: .semibold))
            .frame(maxWidth: .infinity)
            .padding(.vertical, 17)
            .foregroundStyle(WorkspaceTheme.background)
            .background(WorkspaceTheme.mint.opacity(configuration.isPressed ? 0.7 : 1))
            .clipShape(RoundedRectangle(cornerRadius: 18))
    }
}

struct WorkspaceField: ViewModifier {
    func body(content: Content) -> some View {
        content
            .padding(16)
            .background(WorkspaceTheme.surface)
            .clipShape(RoundedRectangle(cornerRadius: 16))
            .overlay(RoundedRectangle(cornerRadius: 16).stroke(WorkspaceTheme.line))
    }
}
