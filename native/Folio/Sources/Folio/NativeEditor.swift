import SwiftUI
import AppKit
import FolioCore

extension Highlight {
    var nsColor: NSColor {
        switch self {
        case .none: return .clear
        case .gray: return NSColor(red: 0.66, green: 0.69, blue: 0.68, alpha: 1)
        case .brown: return NSColor(red: 0.74, green: 0.54, blue: 0.38, alpha: 1)
        case .yellow: return NSColor(red: 1, green: 0.80, blue: 0.27, alpha: 1)
        case .orange: return NSColor(red: 1, green: 0.56, blue: 0.30, alpha: 1)
        case .green: return NSColor(red: 0.49, green: 0.84, blue: 0.62, alpha: 1)
        case .blue: return NSColor(red: 0.43, green: 0.72, blue: 1, alpha: 1)
        case .purple: return NSColor(red: 0.70, green: 0.55, blue: 1, alpha: 1)
        case .pink: return NSColor(red: 0.97, green: 0.55, blue: 0.74, alpha: 1)
        case .red: return NSColor(red: 1, green: 0.43, blue: 0.44, alpha: 1)
        }
    }
    var color: Color { Color(nsColor) }
}
final class FolioTextView: NSTextView {
    var formatSelection: ((String) -> Void)?
    override func keyDown(with event: NSEvent) {
        if event.modifierFlags.contains(.command), event.charactersIgnoringModifiers?.lowercased() == "h", event.modifierFlags.contains(.shift) { wrapSelection("=="); return }
        if event.modifierFlags.contains(.command), event.charactersIgnoringModifiers?.lowercased() == "b" { wrapSelection("**"); return }
        super.keyDown(with: event)
    }
    func wrapSelection(_ marker: String) {
        let range = selectedRange(); guard range.length > 0, NSMaxRange(range) <= (string as NSString).length else { return }
        let content = (string as NSString).substring(with: range)
        insertText(marker + content + marker, replacementRange: range)
        setSelectedRange(NSRange(location: range.location + marker.utf16.count, length: range.length))
    }
}
struct NativeBlockEditor: NSViewRepresentable {
    @Binding var text: String
    var kind: BlockKind
    var blockHighlight: Highlight
    var fontSize: Double
    var strength: Double
    var width: CGFloat
    var shouldFocus: Bool
    var onFocused: () -> Void
    var onSplit: (String, String) -> Void
    var onBackspace: () -> Void
    @Binding var height: CGFloat
    func makeCoordinator() -> Coordinator { Coordinator(self) }
    func makeNSView(context: Context) -> FolioTextView {
        let view = FolioTextView(frame: .zero)
        view.isRichText = false; view.importsGraphics = false; view.isEditable = true; view.isSelectable = true
        view.drawsBackground = false; view.backgroundColor = .clear; view.allowsUndo = true
        view.isAutomaticQuoteSubstitutionEnabled = false; view.isAutomaticDashSubstitutionEnabled = false
        view.isAutomaticSpellingCorrectionEnabled = false; view.isContinuousSpellCheckingEnabled = true
        view.isVerticallyResizable = false; view.isHorizontallyResizable = false
        view.minSize = .zero; view.maxSize = NSSize(width: CGFloat.greatestFiniteMagnitude, height: CGFloat.greatestFiniteMagnitude)
        view.textContainerInset = NSSize(width: 0, height: 3); view.textContainer?.lineFragmentPadding = 0
        view.textContainer?.widthTracksTextView = false; view.textContainer?.lineBreakMode = .byWordWrapping; view.autoresizingMask = [.width]
        view.setContentCompressionResistancePriority(.defaultLow, for: .horizontal)
        view.delegate = context.coordinator; view.string = text
        context.coordinator.view = view; context.coordinator.style(); return view
    }
    func updateNSView(_ view: FolioTextView, context: Context) {
        context.coordinator.parent = self
        view.setFrameSize(NSSize(width: max(1, width), height: max(28, height)))
        view.textContainer?.containerSize = NSSize(width: max(1, width), height: .greatestFiniteMagnitude)
        if view.string != text {
            let range = view.selectedRange(); view.string = text
            view.setSelectedRange(NSRange(location: min(range.location, (text as NSString).length), length: 0))
        }
        context.coordinator.style()
        view.setBoundsOrigin(.zero); view.needsDisplay = true
        if shouldFocus { DispatchQueue.main.async { if view.window?.firstResponder !== view { view.window?.makeFirstResponder(view) }; onFocused() } }
    }
    func sizeThatFits(_ proposal: ProposedViewSize, nsView: FolioTextView, context: Context) -> CGSize? {
        CGSize(width: max(1, width), height: max(28, height))
    }
    class Coordinator: NSObject, NSTextViewDelegate {
        var parent: NativeBlockEditor; weak var view: FolioTextView?
        var styling = false
        init(_ parent: NativeBlockEditor) { self.parent = parent }
        func textDidChange(_ notification: Notification) { guard !styling, let view else { return }; parent.text = view.string; style(); view.invalidateIntrinsicContentSize() }
        func textView(_ textView: NSTextView, doCommandBy commandSelector: Selector) -> Bool {
            if commandSelector == #selector(NSResponder.insertNewline(_:)), parent.kind != .code,
               !(NSApp.currentEvent?.modifierFlags.contains(.shift) ?? false) {
                let range = textView.selectedRange(); let value = textView.string as NSString
                parent.onSplit(value.substring(to: range.location), value.substring(from: NSMaxRange(range))); return true
            }
            if commandSelector == #selector(NSResponder.deleteBackward(_:)), textView.string.isEmpty { parent.onBackspace(); return true }
            return false
        }
        func textView(_ textView: NSTextView, clickedOnLink link: Any, at charIndex: Int) -> Bool {
            let url = (link as? URL) ?? (link as? String).flatMap(URL.init(string:))
            if let url, url.scheme == "folio" { NotificationCenter.default.post(name: .folioLink, object: url); return true }
            return false
        }
        func style() {
            guard let view, let storage = view.textStorage else { return }; styling = true; defer { styling = false }
            let size: Double = switch parent.kind.headingLevel { case 1: parent.fontSize + 13; case 2: parent.fontSize + 7; case 3: parent.fontSize + 3; case 4: parent.fontSize + 1; default: parent.fontSize }
            let bold = parent.kind.headingLevel > 0
            let font = parent.kind == .code ? NSFont.monospacedSystemFont(ofSize: size - 2, weight: .regular) : NSFont.systemFont(ofSize: size, weight: bold ? .semibold : .regular)
            let textColor = parent.blockHighlight == .none ? NSColor(calibratedWhite: 0.88, alpha: 1) : NSColor(calibratedWhite: 0.10, alpha: 1)
            let paragraph = NSMutableParagraphStyle(); paragraph.lineSpacing = parent.kind == .code ? 3 : 5
            let full = NSRange(location: 0, length: storage.length)
            let base: [NSAttributedString.Key: Any] = [.font: font, .foregroundColor: textColor, .paragraphStyle: paragraph]
            storage.beginEditing(); storage.setAttributes(base, range: full)
            if parent.kind != .code {
                let value = view.string
                func matches(_ pattern: String, _ apply: (NSTextCheckingResult) -> Void) {
                    guard let regex = try? NSRegularExpression(pattern: pattern) else { return }; regex.enumerateMatches(in: value, range: full) { match, _, _ in if let match { apply(match) } }
                }
                matches("(?:==|::)(.+?)(?:==|::)") { match in
                    storage.addAttributes([.backgroundColor: Highlight.yellow.nsColor.withAlphaComponent(parent.strength), .foregroundColor: NSColor(calibratedWhite: 0.08, alpha: 1)], range: match.range)
                }
                matches("\\*\\*(.+?)\\*\\*") { match in storage.addAttribute(.font, value: NSFont.systemFont(ofSize: size, weight: .bold), range: match.range) }
                matches("\\[\\[([^\\]]+)\\]\\]") { match in
                    let title = (value as NSString).substring(with: match.range(at: 1))
                    let link = URL(string: "folio://title")!.appendingPathComponent(title)
                    storage.addAttributes([.link: link, .foregroundColor: NSColor.systemMint], range: match.range)
                }
                matches("`([^`]+)`") { match in storage.addAttributes([.font: NSFont.monospacedSystemFont(ofSize: size - 1, weight: .regular), .foregroundColor: NSColor.systemOrange], range: match.range) }
                matches("\\[([^\\]]+)\\]\\(([^\\)]+)\\)") { match in
                    let url = (value as NSString).substring(with: match.range(at: 2))
                    if let link = URL(string: url), ["https", "http", "folio"].contains(link.scheme ?? "") { storage.addAttributes([.link: link, .foregroundColor: NSColor.systemMint], range: match.range(at: 1)) }
                }
            }
            storage.endEditing(); view.typingAttributes = base; view.insertionPointColor = textColor
            if let container = view.textContainer, let layout = view.layoutManager, parent.width > 1 {
                container.containerSize = NSSize(width: parent.width, height: .greatestFiniteMagnitude)
                layout.ensureLayout(for: container)
                let needed = max(28, ceil(layout.usedRect(for: container).height) + 8)
                if abs(parent.height - needed) > 0.5 { DispatchQueue.main.async { [weak self] in self?.parent.height = needed } }
            }
        }
    }
}
