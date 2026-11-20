import SwiftUI

enum WorkspaceTheme {
    static let background = Color(red: 0.047, green: 0.055, blue: 0.059)
    static let surface = Color(red: 0.080, green: 0.090, blue: 0.094)
    static let raised = Color(red: 0.119, green: 0.135, blue: 0.137)
    static let mint = Color(red: 0.72, green: 0.88, blue: 0.80)
    static let secondary = Color(red: 0.56, green: 0.61, blue: 0.59)
    static let line = Color.white.opacity(0.08)
}

/// A fixed design size that follows the user's text size, scaled along the system text style closest to it.
struct ScaledFont: ViewModifier {
    @ScaledMetric private var size: CGFloat
    private let weight: Font.Weight
    private let design: Font.Design

    init(size: CGFloat, weight: Font.Weight, design: Font.Design) {
        _size = ScaledMetric(wrappedValue: size, relativeTo: Self.style(for: size))
        self.weight = weight
        self.design = design
    }

    static func style(for size: CGFloat) -> Font.TextStyle {
        let styles: [(CGFloat, Font.TextStyle)] = [(11, .caption2), (12, .caption), (13, .footnote), (15, .subheadline),
                                                   (16, .callout), (17, .body), (20, .title3), (22, .title2), (28, .title), (34, .largeTitle)]
        return styles.min { abs($0.0 - size) < abs($1.0 - size) }!.1
    }

    func body(content: Content) -> some View { content.font(.system(size: size, weight: weight, design: design)) }
}

extension View {
    func scaledFont(_ size: CGFloat, weight: Font.Weight = .regular, design: Font.Design = .default) -> some View {
        modifier(ScaledFont(size: size, weight: weight, design: design))
    }
}

struct WorkspacePrimaryButton: ButtonStyle {
    func makeBody(configuration: Configuration) -> some View {
        configuration.label
            .scaledFont(16, weight: .semibold)
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
