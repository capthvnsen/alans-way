import SwiftUI

/// Just enough Markdown for a chat reply: paragraphs with inline styling, headings, lists, quotes and fenced code.
/// An unclosed fence (a reply still streaming) is shown as code up to the end.
enum GatewayMarkdown {
    enum Block: Equatable {
        case paragraph(String)
        case heading(level: Int, text: String)
        case listItem(marker: String, text: String)
        case quote(String)
        case code(language: String, text: String)
    }

    static func blocks(_ source: String) -> [Block] {
        var blocks: [Block] = []
        var paragraph: [String] = []
        var code: (language: String, lines: [String])?
        func flush() { if !paragraph.isEmpty { blocks.append(.paragraph(paragraph.joined(separator: "\n"))); paragraph = [] } }
        for line in source.replacingOccurrences(of: "\r\n", with: "\n").components(separatedBy: "\n") {
            let trimmed = line.trimmingCharacters(in: .whitespaces)
            if var open = code {
                if trimmed.hasPrefix("```") { blocks.append(.code(language: open.language, text: open.lines.joined(separator: "\n"))); code = nil }
                else { open.lines.append(line); code = open }
                continue
            }
            if trimmed.hasPrefix("```") {
                flush()
                code = (String(trimmed.drop { $0 == "`" }).trimmingCharacters(in: .whitespaces), [])
            } else if trimmed.isEmpty {
                flush()
            } else if let h = heading(trimmed) {
                flush(); blocks.append(.heading(level: h.0, text: h.1))
            } else if let item = listItem(line) {
                flush(); blocks.append(.listItem(marker: item.0, text: item.1))
            } else if trimmed.hasPrefix(">") {
                flush(); blocks.append(.quote(String(trimmed.dropFirst()).trimmingCharacters(in: .whitespaces)))
            } else {
                paragraph.append(line)
            }
        }
        if let open = code { blocks.append(.code(language: open.language, text: open.lines.joined(separator: "\n"))) }
        flush()
        return blocks
    }

    private static func heading(_ line: String) -> (Int, String)? {
        let hashes = line.prefix { $0 == "#" }
        guard (1...6).contains(hashes.count), line.dropFirst(hashes.count).first == " " else { return nil }
        return (hashes.count, line.dropFirst(hashes.count).trimmingCharacters(in: .whitespaces))
    }

    private static func listItem(_ line: String) -> (String, String)? {
        let body = line.drop { $0 == " " || $0 == "\t" }
        if let first = body.first, "-*+".contains(first), body.dropFirst().first == " " {
            return ("•", body.dropFirst(2).trimmingCharacters(in: .whitespaces))
        }
        let digits = body.prefix { $0.isNumber }
        if (1...3).contains(digits.count), let mark = body.dropFirst(digits.count).first, ".)".contains(mark), body.dropFirst(digits.count + 1).first == " " {
            return ("\(digits).", body.dropFirst(digits.count + 2).trimmingCharacters(in: .whitespaces))
        }
        return nil
    }

    /// Inline Markdown to styled text. Links other than web and mail links are dropped.
    static func inline(_ text: String) -> AttributedString {
        let options = AttributedString.MarkdownParsingOptions(allowsExtendedAttributes: false, interpretedSyntax: .inlineOnlyPreservingWhitespace,
                                                              failurePolicy: .returnPartiallyParsedIfPossible)
        var out = (try? AttributedString(markdown: text, options: options)) ?? AttributedString(text)
        for run in out.runs {
            if let link = run.link, !["http", "https", "mailto"].contains(link.scheme?.lowercased() ?? "") { out[run.range].link = nil }
        }
        return out
    }
}

struct GatewayMarkdownView: View {
    let text: String
    @ScaledMetric(relativeTo: .body) private var size: CGFloat = 15
    @Environment(\.accessibilityReduceMotion) private var reduceMotion

    var body: some View {
        VStack(alignment: .leading, spacing: 10) {
            ForEach(Array(GatewayMarkdown.blocks(text).enumerated()), id: \.offset) { _, block in
                switch block {
                case .paragraph(let t):
                    Text(GatewayMarkdown.inline(t)).font(.system(size: size)).lineSpacing(5).fixedSize(horizontal: false, vertical: true)
                case .heading(let level, let t):
                    Text(GatewayMarkdown.inline(t)).font(.system(size: size + CGFloat(max(0, 4 - level)) * 2, weight: .semibold)).padding(.top, 2)
                        .accessibilityAddTraits(.isHeader)
                case .listItem(let marker, let t):
                    HStack(alignment: .firstTextBaseline, spacing: 8) {
                        Text(marker).font(.system(size: size)).foregroundStyle(WorkspaceTheme.secondary).frame(minWidth: 14, alignment: .trailing)
                        Text(GatewayMarkdown.inline(t)).font(.system(size: size)).lineSpacing(4).fixedSize(horizontal: false, vertical: true)
                    }
                case .quote(let t):
                    HStack(spacing: 10) {
                        Rectangle().fill(WorkspaceTheme.mint.opacity(0.5)).frame(width: 2)
                        Text(GatewayMarkdown.inline(t)).font(.system(size: size)).foregroundStyle(WorkspaceTheme.secondary).fixedSize(horizontal: false, vertical: true)
                    }
                case .code(let language, let t):
                    GatewayCodeBlock(language: language, text: t, size: size)
                }
            }
        }
        .tint(WorkspaceTheme.mint)
        .textSelection(.enabled)
    }
}

private struct GatewayCodeBlock: View {
    let language: String
    let text: String
    let size: CGFloat
    @State private var copied = false

    var body: some View {
        VStack(alignment: .leading, spacing: 0) {
            HStack {
                Text(language.isEmpty ? "code" : language).font(.system(size: size - 4, weight: .medium, design: .monospaced)).foregroundStyle(WorkspaceTheme.secondary)
                Spacer()
                Button {
                    UIPasteboard.general.string = text
                    copied = true
                    Task { try? await Task.sleep(nanoseconds: 1_500_000_000); copied = false }
                } label: {
                    Label(copied ? "Copied" : "Copy", systemImage: copied ? "checkmark" : "doc.on.doc")
                        .font(.system(size: size - 3)).frame(minHeight: 44).padding(.horizontal, 6)
                }
                .accessibilityLabel(copied ? "Copied" : "Copy code")
            }
            .padding(.leading, 12).padding(.trailing, 4)
            ScrollView(.horizontal, showsIndicators: false) {
                Text(text).font(.system(size: size - 1, design: .monospaced)).lineSpacing(3)
                    .fixedSize(horizontal: true, vertical: true).padding(.horizontal, 12).padding(.bottom, 12).padding(.top, 2)
            }
        }
        .background(WorkspaceTheme.background, in: RoundedRectangle(cornerRadius: 12))
        .overlay(RoundedRectangle(cornerRadius: 12).stroke(WorkspaceTheme.line))
        .accessibilityElement(children: .contain)
    }
}
