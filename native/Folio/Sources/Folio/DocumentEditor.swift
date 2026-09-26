import AppKit
import SwiftUI
import FolioCore

extension Notification.Name {
    static let folioFormat = Notification.Name("folioFormat")
    static let folioDictate = Notification.Name("folioDictate")
    static let folioRead = Notification.Name("folioRead")
    static let folioAskSelection = Notification.Name("folioAskSelection")
}
struct DocumentEditor: NSViewRepresentable {
    var blocks: [Block]
    var size: Double
    var strength: Double
    var width: CGFloat
    var library: URL
    var voice: VoiceController
    var onChange: ([Block]) -> Void
    var onDictationFallback: (String) -> Void
    var onCreatePage: (String, Bool) -> UUID
    var onToggleBlock: (UUID) -> Void
    @Binding var height: CGFloat
    func makeCoordinator() -> Coordinator { Coordinator(self) }
    func makeNSView(context: Context) -> PageTextView {
        let view = PageTextView(frame: .zero)
        view.isRichText = true; view.importsGraphics = false; view.allowsUndo = true
        view.isAutomaticQuoteSubstitutionEnabled = false; view.isAutomaticDashSubstitutionEnabled = false
        view.isAutomaticLinkDetectionEnabled = false; view.isContinuousSpellCheckingEnabled = true
        view.drawsBackground = false; view.textContainerInset = NSSize(width: 0, height: 8)
        view.textContainer?.lineFragmentPadding = 0
        view.isVerticallyResizable = false; view.isHorizontallyResizable = false
        view.textContainer?.widthTracksTextView = false
        view.delegate = context.coordinator; view.owner = context.coordinator
        view.setAccessibilityLabel("Page text")
        context.coordinator.view = view
        context.coordinator.observe()
        return view
    }
    func updateNSView(_ view: PageTextView, context: Context) {
        let c = context.coordinator; c.parent = self
        view.setFrameSize(NSSize(width: max(100, width), height: height))
        view.textContainer?.containerSize = NSSize(width: max(100, width), height: .greatestFiniteMagnitude)
        if c.last != blocks || c.size != size || c.strength != strength {
            let selection = view.selectedRange()
            c.updating = true
            view.textStorage?.setAttributedString(RichTextCodec.document(blocks, size: size, strength: strength, library: library))
            view.setSelectedRange(NSRange(location: min(selection.location, view.string.utf16.count), length: 0))
            view.typingAttributes = RichTextCodec.attributes(kind: .text, id: blocks.last?.id ?? UUID(), size: size)
            c.last = blocks; c.size = size; c.strength = strength; c.updating = false
        }
        c.measure()
    }
    @MainActor final class Coordinator: NSObject, NSTextViewDelegate {
        var parent: DocumentEditor
        weak var view: PageTextView?
        var last: [Block] = []; var size = 0.0; var strength = 0.0
        var updating = false; var observers: [NSObjectProtocol] = []
        var popover: NSPopover?
        var selectionWorkItem: DispatchWorkItem?
        init(_ parent: DocumentEditor) { self.parent = parent }
        deinit { observers.forEach(NotificationCenter.default.removeObserver) }
        func observe() {
            for name in [Notification.Name.folioFormat, .folioDictate, .folioRead] {
                observers.append(NotificationCenter.default.addObserver(forName: name, object: nil, queue: .main) { [weak self] event in
                    MainActor.assumeIsolated {
                    guard let self, let view = self.view, view.window != nil else { return }
                    if name == .folioFormat { self.format(event.object as? String ?? "text") }
                    if name == .folioRead { let range = view.selectedRange(); self.parent.voice.read(range.length > 0 ? (view.string as NSString).substring(with: range) : view.string) }
                    if name == .folioDictate {
                        if self.parent.voice.listening { self.parent.voice.stopListening() }
                        else {
                            let range = view.selectedRange(); let original = view.string
                            let fallback = self.parent.onDictationFallback
                            self.parent.voice.listen { [weak self, weak view] text in
                                guard !text.isEmpty else { return }
                                guard let self, let view, view.window != nil else { fallback(text); return }
                                // If the user continued editing, append safely instead of replacing a stale selection.
                                let insertion = view.string == original ? range : NSRange(location: view.string.utf16.count, length: 0)
                                view.window?.makeFirstResponder(view)
                                view.insertText(text, replacementRange: insertion)
                                self.measure()
                            }
                        }
                    }
                    }
                })
            }
        }
        func textViewDidChangeSelection(_ notification: Notification) {
            guard !updating, let view, view.selectedRange().length > 0 else { selectionWorkItem?.cancel(); return }
            selectionWorkItem?.cancel()
            let work = DispatchWorkItem { [weak self, weak view] in
                guard let self, let view, view.window?.firstResponder === view, view.selectedRange().length > 0 else { return }
                self.showFormatting()
            }
            selectionWorkItem = work
            DispatchQueue.main.asyncAfter(deadline: .now() + 0.28, execute: work)
        }
        func textDidChange(_ notification: Notification) {
            guard !updating, let view, let storage = view.textStorage else { return }
            let blocks = RichTextCodec.blocks(storage, previous: last)
            last = blocks
            // Give newly split paragraphs distinct identities without replacing the text or its undo history.
            var cursor = 0
            for block in blocks {
                for _ in 0..<(block.kind == .code ? block.text.components(separatedBy: "\n").count : 1) where cursor < storage.length {
                    let range = (storage.string as NSString).paragraphRange(for: NSRange(location: cursor, length: 0))
                    storage.addAttribute(.folioID, value: block.id.uuidString, range: range)
                    // Inline highlights end at the last letter, even when a paragraph is split.
                    if range.length > 0, (storage.string as NSString).substring(with: NSRange(location: NSMaxRange(range)-1, length: 1)) == "\n", block.highlight == .none {
                        storage.removeAttribute(.backgroundColor, range: NSRange(location: NSMaxRange(range)-1, length: 1)); storage.removeAttribute(.folioHighlight, range: NSRange(location: NSMaxRange(range)-1, length: 1))
                    }
                    cursor = NSMaxRange(range)
                }
            }
            parent.onChange(blocks); measure()
        }
        func measure() {
            guard let view, let layout = view.layoutManager, let container = view.textContainer else { return }
            layout.ensureLayout(for: container)
            let h = max(400, ceil(layout.usedRect(for: container).height + 70))
            if abs(h - parent.height) > 1 { DispatchQueue.main.async { [weak self] in self?.parent.height = h } }
        }
        func textView(_ textView: NSTextView, clickedOnLink link: Any, at charIndex: Int) -> Bool {
            guard let url = link as? URL else { return false }
            if url.scheme == "folio-toggle", let id = UUID(uuidString: url.host ?? "") { parent.onToggleBlock(id); return true }
            if url.scheme == "folio-task", let id = UUID(uuidString: url.host ?? ""), let i = last.firstIndex(where: { $0.id == id }) {
                var blocks = last; blocks[i].checked.toggle(); parent.onChange(blocks); return true
            }
            if url.scheme == "folio" { NotificationCenter.default.post(name: .folioLink, object: url); return true }
            if url.isFileURL, url.standardizedFileURL.path.hasPrefix(parent.library.standardizedFileURL.path + "/assets/") { NSWorkspace.shared.open(url); return true }
            if ["https", "http", "mailto"].contains(url.scheme ?? "") { NSWorkspace.shared.open(url); return true }
            return true
        }
        func showFormatting() {
            selectionWorkItem?.cancel()
            guard let view, view.selectedRange().length > 0 else { popover?.close(); return }
            popover?.close()
            let pop = NSPopover(); pop.behavior = .semitransient
            pop.contentViewController = NSHostingController(rootView: SelectionTools(action: { [weak self] action in self?.format(action) }))
            pop.contentSize = NSSize(width: 360, height: 205)
            var rect = view.firstRect(forCharacterRange: view.selectedRange(), actualRange: nil)
            if let window = view.window { rect = view.convert(window.convertFromScreen(rect), from: nil) }
            pop.show(relativeTo: rect, of: view, preferredEdge: .maxY); popover = pop
        }
        func format(_ action: String) {
            guard let view, let storage = view.textStorage else { return }
            let range = view.selectedRange()
            if action == "read" { parent.voice.read((view.string as NSString).substring(with: range)); popover?.close(); return }
            if action == "ask" { NotificationCenter.default.post(name: .folioAskSelection, object: (view.string as NSString).substring(with: range)); popover?.close(); return }
            if action == "up" || action == "down" { moveParagraph(action == "up" ? -1 : 1); return }
            if let kind = BlockKind(rawValue: action) { changeKind(kind); return }
            guard range.length > 0 else { return }
            let changed = NSMutableAttributedString(attributedString: storage.attributedSubstring(from: range))
            let all = NSRange(location: 0, length: changed.length)
            if action.hasPrefix("color-") {
                let value = String(action.dropFirst("color-".count)); let color = Highlight(rawValue: value) ?? .none
                let kind = (storage.attribute(.folioKind, at: range.location, effectiveRange: nil) as? String).flatMap(BlockKind.init(rawValue:)) ?? .text
                let base = RichTextCodec.attributes(kind: kind, id: UUID(), size: parent.size)[.foregroundColor] as? NSColor ?? NSColor(calibratedWhite: 0.9, alpha: 1)
                changed.addAttributes([.foregroundColor: color == .none ? base : color.nsColor, .folioTextColor: value], range: all)
                view.insertText(changed, replacementRange: range); view.setSelectedRange(range); popover?.close(); view.window?.makeFirstResponder(view); return
            }
            if action == "highlight-none" {
                changed.removeAttribute(.backgroundColor, range: all); changed.removeAttribute(.folioHighlight, range: all)
                let kind = (storage.attribute(.folioKind, at: range.location, effectiveRange: nil) as? String).flatMap(BlockKind.init(rawValue:)) ?? .text
                let base = RichTextCodec.attributes(kind: kind, id: UUID(), size: parent.size)[.foregroundColor] as? NSColor ?? NSColor(calibratedWhite: 0.9, alpha: 1)
                changed.enumerateAttribute(.folioTextColor, in: all) { value, run, _ in
                    let color = (value as? String).flatMap(Highlight.init(rawValue:)) ?? .none
                    changed.addAttribute(.foregroundColor, value: color == .none ? base : color.nsColor, range: run)
                }
                view.insertText(changed, replacementRange: range); view.setSelectedRange(range); popover?.close(); view.window?.makeFirstResponder(view); return
            }
            let highlightAction = action.hasPrefix("highlight-") ? String(action.dropFirst("highlight-".count)) : action
            if let color = Highlight(rawValue: highlightAction), color != .none {
                changed.addAttributes([.backgroundColor: color.nsColor.withAlphaComponent(parent.strength), .foregroundColor: NSColor.black, .folioHighlight: color.rawValue], range: all)
                view.insertText(changed, replacementRange: range); view.setSelectedRange(range); popover?.close(); view.window?.makeFirstResponder(view); return
            }
            switch action {
            case "bold", "italic":
                let trait: NSFontTraitMask = action == "bold" ? .boldFontMask : .italicFontMask
                let first = changed.attribute(.font, at: 0, effectiveRange: nil) as? NSFont ?? .systemFont(ofSize: parent.size)
                let remove = NSFontManager.shared.traits(of: first).contains(trait)
                changed.enumerateAttribute(.font, in: all) { value, run, _ in
                    let font = value as? NSFont ?? first
                    changed.addAttribute(.font, value: remove ? NSFontManager.shared.convert(font, toNotHaveTrait: trait) : NSFontManager.shared.convert(font, toHaveTrait: trait), range: run)
                }
                if action == "bold" { changed.addAttribute(.folioBold, value: !remove, range: all) }
            case "underline", "strike":
                let key: NSAttributedString.Key = action == "underline" ? .underlineStyle : .strikethroughStyle
                changed.addAttribute(key, value: (changed.attribute(key, at: 0, effectiveRange: nil) as? Int ?? 0) == 0 ? 1 : 0, range: all)
            case "inlineCode": changed.addAttributes([.font: NSFont.monospacedSystemFont(ofSize: parent.size, weight: .regular), .folioCode: true], range: all)
            case "link":
                popover?.close()
                let alert = NSAlert(); alert.messageText = "Add a link"; alert.addButton(withTitle: "Apply"); alert.addButton(withTitle: "Cancel")
                let field = NSTextField(frame: NSRect(x: 0, y: 0, width: 320, height: 26)); field.placeholderString = "https://… or folio://note/…"; alert.accessoryView = field
                guard alert.runModal() == .alertFirstButtonReturn, let url = URL(string: field.stringValue), ["https", "http", "mailto", "folio"].contains(url.scheme ?? "") else { return }
                changed.addAttribute(.link, value: url, range: all)
            case "clear":
                for key in [NSAttributedString.Key.backgroundColor, .folioHighlight, .folioTextColor, .folioBold, .folioCode, .underlineStyle, .strikethroughStyle, .link] { changed.removeAttribute(key, range: all) }
                changed.enumerateAttribute(.folioKind, in: all) { value, run, _ in
                    let kind = (value as? String).flatMap(BlockKind.init(rawValue:)) ?? .text
                    let attrs = RichTextCodec.attributes(kind: kind, id: UUID(), size: parent.size)
                    changed.addAttribute(.font, value: attrs[.font]!, range: run); changed.addAttribute(.foregroundColor, value: attrs[.foregroundColor]!, range: run)
                }
            default: return
            }
            view.insertText(changed, replacementRange: range); view.setSelectedRange(range); popover?.close(); view.window?.makeFirstResponder(view)
        }
        func changeKind(_ kind: BlockKind) {
            guard let view, let storage = view.textStorage else { return }
            let selection = view.selectedRange()
            let range = (view.string as NSString).paragraphRange(for: selection)
            if kind == .page || kind == .pageIn {
                let title = selection.length > 0 ? (view.string as NSString).substring(with: selection).trimmingCharacters(in: .whitespacesAndNewlines) : (view.string as NSString).substring(with: range).trimmingCharacters(in: .whitespacesAndNewlines)
                let cleanTitle = title.isEmpty ? "Untitled" : title
                let pageID = parent.onCreatePage(cleanTitle, kind == .pageIn)
                let replacement = NSMutableAttributedString(attributedString: RichTextCodec.document([Block(kind: kind, text: cleanTitle, asset: pageID.uuidString, marks: [])], size: parent.size, strength: parent.strength, library: parent.library))
                if NSMaxRange(range) < storage.length || (range.length > 0 && (view.string as NSString).substring(with: range).hasSuffix("\n")) { replacement.append(NSAttributedString(string: "\n", attributes: RichTextCodec.attributes(kind: .text, id: UUID(), size: parent.size))) }
                view.insertText(replacement, replacementRange: range); popover?.close(); view.window?.makeFirstResponder(view); return
            }
            var changed = RichTextCodec.blocks(storage.attributedSubstring(from: range), previous: last)
            if range.length > 0, (view.string as NSString).substring(with: range).hasSuffix("\n") { changed.removeLast() }
            if changed.isEmpty { changed = [Block(marks: [])] }
            for i in changed.indices { changed[i].kind = kind; if changed[i].text.hasPrefix("/") { changed[i].text = ""; changed[i].marks = [] } }
            let replacement = NSMutableAttributedString(attributedString: RichTextCodec.document(changed, size: parent.size, strength: parent.strength, library: parent.library))
            if NSMaxRange(range) < storage.length || (range.length > 0 && (view.string as NSString).substring(with: range).hasSuffix("\n")) { replacement.append(NSAttributedString(string: "\n", attributes: RichTextCodec.attributes(kind: kind, id: changed.last!.id, size: parent.size))) }
            view.insertText(replacement, replacementRange: range)
            view.typingAttributes = RichTextCodec.attributes(kind: kind, id: changed[0].id, size: parent.size)
            popover?.close(); view.window?.makeFirstResponder(view)
        }
        func moveParagraph(_ delta: Int) {
            guard let view, let storage = view.textStorage, storage.length > 0 else { return }
            let location = min(view.selectedRange().location, storage.length - 1)
            let id = (storage.attribute(.folioID, at: location, effectiveRange: nil) as? String).flatMap(UUID.init(uuidString:))
            guard let index = last.firstIndex(where: { $0.id == id }), last.indices.contains(index + delta) else { return }
            var moved = last; moved.swapAt(index, index + delta)
            view.insertText(RichTextCodec.document(moved, size: parent.size, strength: parent.strength, library: parent.library), replacementRange: NSRange(location: 0, length: storage.length)); popover?.close()
        }
    }
}
final class PageTextView: NSTextView {
    weak var owner: DocumentEditor.Coordinator?
    override func mouseUp(with event: NSEvent) { super.mouseUp(with: event); owner?.selectionWorkItem?.cancel(); owner?.showFormatting() }
    override func keyDown(with event: NSEvent) {
        if event.modifierFlags.contains(.command) {
            if event.charactersIgnoringModifiers == "b" { owner?.format("bold"); return }
            if event.charactersIgnoringModifiers == "i" { owner?.format("italic"); return }
            if event.charactersIgnoringModifiers == "u" { owner?.format("underline"); return }
            if event.modifierFlags.contains(.shift), event.charactersIgnoringModifiers?.lowercased() == "h" { owner?.format("yellow"); return }
        }
        owner?.popover?.close(); super.keyDown(with: event)
        if event.modifierFlags.contains(.shift), selectedRange().length > 0 { owner?.showFormatting() }
    }
    override func insertNewline(_ sender: Any?) {
        guard let owner else { super.insertNewline(sender); return }
        let kind = (typingAttributes[.folioKind] as? String).flatMap(BlockKind.init(rawValue:)) ?? .text
        if kind == .code && NSApp.currentEvent?.modifierFlags.contains(.shift) == true { super.insertNewline(sender); return }
        let currentLine = (string as NSString).substring(with: (string as NSString).paragraphRange(for: selectedRange())).trimmingCharacters(in: .newlines)
        if [.bullet, .numbered, .task, .quote].contains(kind), currentLine.trimmingCharacters(in: .whitespaces) == RichTextCodec.prefix(Block(kind: kind)).trimmingCharacters(in: .whitespaces) { owner.changeKind(.text); return }
        let next: BlockKind = [.bullet, .numbered, .task].contains(kind) ? kind : .text
        let block = Block(kind: next, marks: [])
        let attrs = RichTextCodec.attributes(kind: next, id: block.id, size: owner.parent.size)
        insertText(NSAttributedString(string: "\n" + RichTextCodec.prefix(block), attributes: attrs), replacementRange: selectedRange())
        typingAttributes = attrs
    }
    override func insertText(_ insertString: Any, replacementRange: NSRange) {
        super.insertText(insertString, replacementRange: replacementRange)
        guard let owner else { return }
        let range = (string as NSString).paragraphRange(for: selectedRange())
        let line = (string as NSString).substring(with: range).trimmingCharacters(in: .newlines)
        let commands: [String: BlockKind] = ["# ": .heading1, "## ": .heading2, "### ": .heading3, "- ": .bullet, "1. ": .numbered, "[] ": .task, "[ ] ": .task, "> ": .quote]
        if let kind = commands[line], insertString is String {
            super.insertText("", replacementRange: range); owner.changeKind(kind)
        }
        if line == "/", insertString is String {
            let menu = NSMenu()
            for kind in BlockKind.allCases where kind != .attachment {
                let item = NSMenuItem(title: kind.title, action: #selector(slashKind(_:)), keyEquivalent: ""); item.representedObject = kind.rawValue; item.target = self; menu.addItem(item)
            }
            var rect = firstRect(forCharacterRange: selectedRange(), actualRange: nil)
            if let window { rect = convert(window.convertFromScreen(rect), from: nil) }
            menu.popUp(positioning: nil, at: NSPoint(x: rect.minX, y: rect.maxY), in: self)
        }
    }
    @objc func slashKind(_ sender: NSMenuItem) { if let raw = sender.representedObject as? String { owner?.format(raw) } }
}
struct SelectionTools: View {
    var action: (String) -> Void
    private let colors: [Highlight] = [.gray, .brown, .orange, .yellow, .green, .blue, .purple, .pink, .red]
    var body: some View {
        VStack(alignment: .leading, spacing: 12) {
            HStack {
                Menu("Turn into") { ForEach(BlockKind.allCases.filter { $0 != .attachment }, id: \.self) { kind in Button(kind.title) { action(kind.rawValue) } } }
                Spacer(); Button("↑") { action("up") }.help("Move paragraph up"); Button("↓") { action("down") }.help("Move paragraph down")
            }
            HStack(spacing: 16) {
                tool("bold", "bold", "Bold · ⌘B"); tool("italic", "italic", "Italic · ⌘I"); tool("underline", "underline", "Underline · ⌘U"); tool("strikethrough", "strike", "Strikethrough"); tool("chevron.left.forwardslash.chevron.right", "inlineCode", "Inline code"); tool("link", "link", "Link"); tool("textformat", "clear", "Clear formatting")
            }
            HStack(spacing: 12) {
                Menu {
                    Button("Default", systemImage: "a") { action("color-none") }
                    ForEach(colors, id: \.self) { color in Button { action("color-\(color.rawValue)") } label: { Label(color.rawValue.capitalized, systemImage: "circle.fill").foregroundStyle(color.color) } }
                } label: { Label("Text color", systemImage: "a.circle").labelStyle(.iconOnly) }.help("Text color")
                Menu {
                    Button("Default", systemImage: "square") { action("highlight-none") }
                    ForEach(colors, id: \.self) { color in Button { action("highlight-\(color.rawValue)") } label: { Label(color.rawValue.capitalized, systemImage: "highlighter").foregroundStyle(color.color) } }
                } label: { Label("Highlight color", systemImage: "highlighter").labelStyle(.iconOnly) }.help("Highlight color")
                Spacer(); tool("speaker.wave.2", "read", "Read selection"); tool("sparkles", "ask", "Ask AI about selection")
            }
        }.buttonStyle(.plain).padding(16).frame(width: 340).background(Palette.panel).foregroundStyle(Palette.text).preferredColorScheme(.dark)
    }
    func tool(_ icon: String, _ key: String, _ label: String) -> some View { Button { action(key) } label: { Image(systemName: icon).frame(width: 21, height: 22) }.help(label).accessibilityLabel(label) }
}
