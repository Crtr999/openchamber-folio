import UIKit
import Capacitor

// The iPhone page editor, written natively. The web view's editor made every keystroke wait on
// iOS, so a page opens here instead: one UITextView holding the whole page, one paragraph per
// Folio block. Notes still live in the web app's store; this editor receives a page as JSON and
// hands back the edited page (same block ids, kinds, marks) as you type.

// MARK: - Plugin

public class FolioEditorPlugin: CAPPlugin, CAPBridgedPlugin {
    public let identifier = "FolioEditorPlugin"
    public let jsName = "FolioEditor"
    public let pluginMethods: [CAPPluginMethod] = [
        CAPPluginMethod(name: "open", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "close", returnType: CAPPluginReturnPromise),
    ]
    private var editor: FolioNoteEditorController?

    @objc func open(_ call: CAPPluginCall) {
        guard let note = call.getObject("note") as [String: Any]? else { call.reject("note is required"); return }
        let titles = (call.getObject("titles") as [String: Any]?)?.compactMapValues { $0 as? String } ?? [:]
        DispatchQueue.main.async {
            guard let host = self.bridge?.viewController else { call.reject("No window"); return }
            if let current = self.editor { current.finish(animated: false, notify: false) }
            let controller = FolioNoteEditorController(note: note, titles: titles)
            controller.onChange = { [weak self] note in self?.notifyListeners("change", data: ["note": note]) }
            controller.onClose = { [weak self, weak controller] noteID in
                if self?.editor === controller { self?.editor = nil }
                self?.notifyListeners("closed", data: ["noteID": noteID])
            }
            controller.onOpenNote = { [weak self] id in self?.notifyListeners("openNote", data: ["noteID": id]) }
            controller.onAction = { [weak self] kind, noteID in self?.notifyListeners("action", data: ["kind": kind, "noteID": noteID]) }
            self.editor = controller
            controller.show(in: host)
            call.resolve()
        }
    }

    @objc func close(_ call: CAPPluginCall) {
        DispatchQueue.main.async {
            self.editor?.finish(animated: true, notify: true)
            self.editor = nil
            call.resolve()
        }
    }
}

// MARK: - Page <-> text

extension NSAttributedString.Key {
    static let folioID = Self("FolioBlockID")
    static let folioKind = Self("FolioKind")
    static let folioIndent = Self("FolioIndent")
    static let folioBold = Self("FolioBold")
    static let folioCode = Self("FolioCode")
    static let folioHighlight = Self("FolioInlineHighlight")
    static let folioTextColor = Self("FolioTextColor")
}

enum FolioCodec {
    static let baseSize: CGFloat = 17
    static let palette: [String: UInt32] = ["gray": 0xA8B0AC, "brown": 0xBD8A62, "orange": 0xFF8F4D, "yellow": 0xFFCC45, "green": 0x7DD69E, "blue": 0x6EB8FF, "purple": 0xB38AFF, "pink": 0xF78CBE, "red": 0xFF6E71]
    static func color(_ name: String?) -> UIColor? {
        guard let name, let hex = palette[name] else { return nil }
        return UIColor(red: CGFloat((hex >> 16) & 0xFF) / 255, green: CGFloat((hex >> 8) & 0xFF) / 255, blue: CGFloat(hex & 0xFF) / 255, alpha: 1)
    }

    /// Kinds whose line is not typed text: kept exactly as they were.
    static let locked: Set<String> = ["divider", "page", "pageIn", "attachment"]
    static let listKinds: Set<String> = ["bullet", "numbered", "task", "toggle", "quote", "callout"]
    static let prefixPattern = try! NSRegularExpression(pattern: "^(•  |\\d+\\.  |☐  |☑  |▾  |▸  |│  |✦  |📎  |📄  )")

    static func headingLevel(_ kind: String) -> Int {
        if let last = kind.last, let level = Int(String(last)), kind.lowercased().contains("heading") { return level }
        return 0
    }
    static func prefix(kind: String, checked: Bool, number: Int = 1) -> String {
        switch kind {
        case "bullet": return "•  "
        case "numbered": return "\(number).  "
        case "task": return checked ? "☑  " : "☐  "
        case "toggle", "toggleHeading1", "toggleHeading2", "toggleHeading3", "toggleHeading4": return "▾  "
        case "quote": return "│  "
        case "callout": return "✦  "
        case "attachment": return "📎  "
        case "page", "pageIn": return "📄  "
        default: return ""
        }
    }
    static func font(kind: String) -> UIFont {
        if kind == "code" || kind == "equation" { return .monospacedSystemFont(ofSize: baseSize - 2, weight: .regular) }
        switch headingLevel(kind) {
        case 1: return .systemFont(ofSize: 28, weight: .bold)
        case 2: return .systemFont(ofSize: 22, weight: .semibold)
        case 3: return .systemFont(ofSize: 19, weight: .semibold)
        case 4: return .systemFont(ofSize: 17, weight: .semibold)
        default: return .systemFont(ofSize: baseSize)
        }
    }
    static func paragraph(kind: String, indent: Int) -> NSParagraphStyle {
        let style = NSMutableParagraphStyle()
        let level = headingLevel(kind)
        style.lineSpacing = 3
        style.paragraphSpacing = level > 0 ? 6 : 5
        style.paragraphSpacingBefore = level > 0 ? 12 : 0
        let step: CGFloat = 24
        style.firstLineHeadIndent = CGFloat(indent) * step
        style.headIndent = CGFloat(indent) * step + (listKinds.contains(kind) || kind == "toggle" ? step : 0)
        return style
    }
    static func lineAttributes(kind: String, id: String, indent: Int) -> [NSAttributedString.Key: Any] {
        var attrs: [NSAttributedString.Key: Any] = [.font: font(kind: kind), .foregroundColor: UIColor.label, .paragraphStyle: paragraph(kind: kind, indent: indent), .folioID: id, .folioKind: kind, .folioIndent: indent]
        if kind == "quote" || kind == "code" { attrs[.foregroundColor] = UIColor.secondaryLabel }
        return attrs
    }
    static func withTrait(_ font: UIFont, _ trait: UIFontDescriptor.SymbolicTraits) -> UIFont {
        guard let descriptor = font.fontDescriptor.withSymbolicTraits(font.fontDescriptor.symbolicTraits.union(trait)) else { return font }
        return UIFont(descriptor: descriptor, size: font.pointSize)
    }
    static func withoutTrait(_ font: UIFont, _ trait: UIFontDescriptor.SymbolicTraits) -> UIFont {
        guard let descriptor = font.fontDescriptor.withSymbolicTraits(font.fontDescriptor.symbolicTraits.subtracting(trait)) else { return font }
        return UIFont(descriptor: descriptor, size: font.pointSize)
    }

    static func string(_ value: Any?) -> String { value as? String ?? "" }
    static func int(_ value: Any?) -> Int { (value as? NSNumber)?.intValue ?? 0 }
    static func bool(_ value: Any?) -> Bool { (value as? NSNumber)?.boolValue ?? false }

    /// One line of the page: prefix, then the block's text with its marks.
    static func line(_ block: [String: Any], number: Int, titles: [String: String]) -> NSMutableAttributedString {
        let kind = string(block["kind"]), id = string(block["id"]), indent = int(block["indent"])
        let attrs = lineAttributes(kind: kind, id: id, indent: indent)
        let base = attrs[.font] as! UIFont
        let line = NSMutableAttributedString(string: prefix(kind: kind, checked: bool(block["checked"]), number: number), attributes: attrs)
        if kind == "task", bool(block["checked"]) { line.addAttribute(.foregroundColor, value: UIColor.secondaryLabel, range: NSRange(location: 0, length: line.length)) }
        let text: String
        switch kind {
        case "divider": text = "──────────────"
        case "page", "pageIn": text = titles[string(block["asset"])] ?? (string(block["text"]).isEmpty ? "Untitled" : string(block["text"]))
        default: text = string(block["text"])
        }
        let body = NSMutableAttributedString(string: text, attributes: attrs)
        if kind == "task", bool(block["checked"]) {
            body.addAttributes([.strikethroughStyle: NSUnderlineStyle.single.rawValue, .foregroundColor: UIColor.secondaryLabel], range: NSRange(location: 0, length: body.length))
        }
        if kind == "page" || kind == "pageIn" { body.addAttribute(.foregroundColor, value: UIColor.link, range: NSRange(location: 0, length: body.length)) }
        if !locked.contains(kind), kind != "code", let marks = block["marks"] as? [Any] {
            for case let mark as [String: Any] in marks {
                let start = int(mark["start"]), length = int(mark["length"])
                guard start >= 0, length > 0, start + length <= body.length else { continue }
                let range = NSRange(location: start, length: length)
                switch string(mark["style"]) {
                case "bold":
                    body.enumerateAttribute(.font, in: range) { value, run, _ in body.addAttribute(.font, value: withTrait(value as? UIFont ?? base, .traitBold), range: run) }
                    body.addAttribute(.folioBold, value: true, range: range)
                case "italic":
                    body.enumerateAttribute(.font, in: range) { value, run, _ in body.addAttribute(.font, value: withTrait(value as? UIFont ?? base, .traitItalic), range: run) }
                case "underline": body.addAttribute(.underlineStyle, value: NSUnderlineStyle.single.rawValue, range: range)
                case "strike": body.addAttribute(.strikethroughStyle, value: NSUnderlineStyle.single.rawValue, range: range)
                case "code": body.addAttributes([.font: UIFont.monospacedSystemFont(ofSize: base.pointSize - 1, weight: .regular), .folioCode: true, .backgroundColor: UIColor.secondarySystemFill], range: range)
                case "highlight":
                    let name = string(mark["value"]).isEmpty ? "yellow" : string(mark["value"])
                    body.addAttributes([.backgroundColor: (color(name) ?? .systemYellow).withAlphaComponent(0.45), .folioHighlight: name], range: range)
                case "color":
                    let name = string(mark["value"])
                    if let ink = color(name) { body.addAttributes([.foregroundColor: ink, .folioTextColor: name], range: range) }
                case "link":
                    if let url = URL(string: string(mark["value"])), ["https", "http", "mailto", "folio"].contains(url.scheme ?? "") { body.addAttribute(.link, value: url, range: range) }
                default: break
                }
            }
        }
        line.append(body)
        let highlight = string(block["highlight"])
        if highlight != "none", let tint = color(highlight) { line.addAttribute(.backgroundColor, value: tint.withAlphaComponent(0.3), range: NSRange(location: 0, length: line.length)) }
        return line
    }

    static func document(_ blocks: [[String: Any]], titles: [String: String]) -> NSAttributedString {
        let doc = NSMutableAttributedString()
        var number = 0
        for (index, block) in blocks.enumerated() {
            number = string(block["kind"]) == "numbered" ? number + 1 : 0
            let line = line(block, number: max(number, 1), titles: titles)
            if index < blocks.count - 1 {
                let kind = string(block["kind"])
                line.append(NSAttributedString(string: "\n", attributes: lineAttributes(kind: kind, id: string(block["id"]), indent: int(block["indent"]))))
            }
            doc.append(line)
        }
        if doc.length == 0 { return NSAttributedString(string: "", attributes: lineAttributes(kind: "text", id: UUID().uuidString, indent: 0)) }
        return doc
    }

    /// The page's blocks read back from the text. Ids, and everything the editor does not show, come
    /// from the previous blocks, so nothing is lost; a line copied by Enter gets a fresh id.
    static func blocks(from document: NSAttributedString, previous: [[String: Any]]) -> [[String: Any]] {
        let text = document.string as NSString
        let previousByID = Dictionary(previous.map { (string($0["id"]).uppercased(), $0) }, uniquingKeysWith: { first, _ in first })
        var output: [[String: Any]] = []
        var seen = Set<String>()
        var cursor = 0
        func fresh() -> String { UUID().uuidString.uppercased() }
        if text.length == 0 { return [newBlock(id: string(previous.first?["id"]).isEmpty ? fresh() : string(previous.first?["id"]))] }
        while cursor < text.length {
            let range = text.paragraphRange(for: NSRange(location: cursor, length: 0))
            var content = range
            while content.length > 0 {
                let last = text.substring(with: NSRange(location: NSMaxRange(content) - 1, length: 1))
                if last == "\n" || last == "\r" { content.length -= 1 } else { break }
            }
            let attrs = content.length > 0 ? document.attributes(at: content.location, effectiveRange: nil) : document.attributes(at: min(range.location, document.length - 1), effectiveRange: nil)
            let originalID = string(attrs[.folioID]).uppercased()
            let kind = (attrs[.folioKind] as? String) ?? "text"
            let indent = int(attrs[.folioIndent])
            let old = previousByID[originalID]
            // A code block's lines stay one block.
            if kind == "code", let lastIndex = output.indices.last, string(output[lastIndex]["id"]) == originalID {
                output[lastIndex]["text"] = string(output[lastIndex]["text"]) + "\n" + text.substring(with: content)
                cursor = NSMaxRange(range); continue
            }
            let id = (!originalID.isEmpty && !seen.contains(originalID)) ? originalID : fresh()
            seen.insert(id)
            if locked.contains(kind), let old, id == originalID {
                output.append(old); cursor = NSMaxRange(range); continue
            }
            var block = (id == originalID ? old : nil) ?? newBlock(id: id)
            block["id"] = id
            block["kind"] = kind
            if indent > 0 { block["indent"] = indent } else { block.removeValue(forKey: "indent") }
            var body = content
            if listKinds.contains(kind) || kind.hasPrefix("toggle") || locked.contains(kind) {
                let line = text.substring(with: content)
                if let match = prefixPattern.firstMatch(in: line, range: NSRange(location: 0, length: (line as NSString).length)) {
                    let shown = (line as NSString).substring(with: match.range)
                    if kind == "task" { block["checked"] = shown.hasPrefix("☑") }
                    body = NSRange(location: content.location + match.range.length, length: content.length - match.range.length)
                }
            }
            block["text"] = kind == "divider" ? "" : text.substring(with: body)
            var marks: [[String: Any]] = []
            if kind != "code" && body.length > 0 {
                let heading = headingLevel(kind) > 0
                document.enumerateAttributes(in: body) { run, runRange, _ in
                    let start = runRange.location - body.location
                    func add(_ style: String, _ value: String? = nil) {
                        var mark: [String: Any] = ["start": start, "length": runRange.length, "style": style]
                        if let value { mark["value"] = value }
                        marks.append(mark)
                    }
                    if let font = run[.font] as? UIFont {
                        let traits = font.fontDescriptor.symbolicTraits
                        if run[.folioBold] as? Bool == true || (traits.contains(.traitBold) && !heading) { add("bold") }
                        if traits.contains(.traitItalic) { add("italic") }
                    }
                    if int(run[.underlineStyle]) != 0 { add("underline") }
                    if int(run[.strikethroughStyle]) != 0 && !(kind == "task" && bool(block["checked"])) { add("strike") }
                    if run[.folioCode] as? Bool == true { add("code") }
                    if let name = run[.folioHighlight] as? String { add("highlight", name) }
                    if let name = run[.folioTextColor] as? String { add("color", name) }
                    if let link = run[.link] as? URL { add("link", link.absoluteString) }
                    else if let link = run[.link] as? String { add("link", link) }
                }
            }
            block["marks"] = marks
            output.append(block)
            cursor = NSMaxRange(range)
        }
        if text.hasSuffix("\n") { output.append(newBlock(id: fresh())) }
        return output.isEmpty ? [newBlock(id: fresh())] : output
    }

    static func newBlock(id: String, kind: String = "text") -> [String: Any] {
        ["id": id, "kind": kind, "text": "", "checked": false, "highlight": "none", "marks": [Any]()]
    }
}

// MARK: - Editor

final class FolioNoteEditorController: UIViewController, UITextViewDelegate, UITextFieldDelegate, UIGestureRecognizerDelegate {
    var onChange: (([String: Any]) -> Void)?
    var onClose: ((String) -> Void)?
    var onOpenNote: ((String) -> Void)?
    var onAction: ((String, String) -> Void)?

    private var note: [String: Any]
    private var blocks: [[String: Any]]
    private let titles: [String: String]
    private let textView = UITextView()
    private let titleField = UITextField()
    private var saveTimer: Timer?
    private var dirty = false
    private var finished = false
    private var noteID: String { FolioCodec.string(note["id"]) }

    init(note: [String: Any], titles: [String: String]) {
        self.note = note
        self.blocks = (note["blocks"] as? [Any])?.compactMap { $0 as? [String: Any] } ?? []
        self.titles = titles
        super.init(nibName: nil, bundle: nil)
    }
    required init?(coder: NSCoder) { fatalError("init(coder:) is not used") }

    func show(in host: UIViewController) {
        host.addChild(self)
        view.frame = host.view.bounds
        view.autoresizingMask = [.flexibleWidth, .flexibleHeight]
        host.view.addSubview(view)
        didMove(toParent: host)
        view.transform = CGAffineTransform(translationX: host.view.bounds.width, y: 0)
        UIView.animate(withDuration: 0.28, delay: 0, options: [.curveEaseOut]) { self.view.transform = .identity }
        // An empty page starts with the keyboard up, like a new note in Notes.
        if FolioCodec.string(note["title"]).isEmpty && blocks.allSatisfy({ FolioCodec.string($0["text"]).isEmpty }) { titleField.becomeFirstResponder() }
    }

    /// Saves, then slides away. `notify` tells the web app the page closed (so it goes home).
    func finish(animated: Bool, notify: Bool) {
        guard !finished else { return }
        finished = true
        save()
        view.endEditing(true)
        let done = {
            self.willMove(toParent: nil); self.view.removeFromSuperview(); self.removeFromParent()
            if notify { self.onClose?(self.noteID) }
        }
        if animated {
            UIView.animate(withDuration: 0.22, delay: 0, options: [.curveEaseIn], animations: { self.view.transform = CGAffineTransform(translationX: self.view.bounds.width, y: 0) }, completion: { _ in done() })
        } else { done() }
    }

    override func viewDidLayoutSubviews() {
        super.viewDidLayoutSubviews()
        // A fixed shadow path: without it the shadow is recomputed from the page's pixels on every change.
        view.layer.shadowPath = UIBezierPath(rect: view.bounds).cgPath
    }

    override func viewDidLoad() {
        super.viewDidLoad()
        view.backgroundColor = .systemBackground
        view.layer.shadowColor = UIColor.black.cgColor
        view.layer.shadowOpacity = 0.25
        view.layer.shadowRadius = 12

        let back = UIButton(type: .system)
        back.setImage(UIImage(systemName: "chevron.left", withConfiguration: UIImage.SymbolConfiguration(pointSize: 20, weight: .semibold)), for: .normal)
        back.tintColor = .label
        back.accessibilityLabel = "Back"
        back.addAction(UIAction { [weak self] _ in self?.finish(animated: true, notify: true) }, for: .touchUpInside)

        titleField.text = FolioCodec.string(note["title"])
        titleField.placeholder = "Untitled"
        titleField.font = .systemFont(ofSize: 20, weight: .semibold)
        titleField.returnKeyType = .next
        titleField.delegate = self
        titleField.addAction(UIAction { [weak self] _ in self?.changed() }, for: .editingChanged)

        let more = UIButton(type: .system)
        more.setImage(UIImage(systemName: "ellipsis.circle", withConfiguration: UIImage.SymbolConfiguration(pointSize: 20)), for: .normal)
        more.tintColor = .label
        more.accessibilityLabel = "More"
        more.showsMenuAsPrimaryAction = true
        more.menu = UIMenu(children: [
            UIAction(title: "Ask AI about this page", image: UIImage(systemName: "sparkles")) { [weak self] _ in self?.action("ask") },
            UIAction(title: "Summarize", image: UIImage(systemName: "text.badge.star")) { [weak self] _ in self?.action("summarize") },
            UIAction(title: "Read aloud", image: UIImage(systemName: "speaker.wave.2")) { [weak self] _ in self?.action("read") },
            UIAction(title: "Share", image: UIImage(systemName: "square.and.arrow.up")) { [weak self] _ in self?.action("share") },
            UIAction(title: "Open classic editor", image: UIImage(systemName: "doc.richtext")) { [weak self] _ in self?.action("classic") },
            UIAction(title: "Move to Trash", image: UIImage(systemName: "trash"), attributes: .destructive) { [weak self] _ in self?.action("trash") },
        ])

        let header = UIStackView(arrangedSubviews: [back, titleField, more])
        header.axis = .horizontal; header.spacing = 8; header.alignment = .center
        header.translatesAutoresizingMaskIntoConstraints = false
        back.widthAnchor.constraint(equalToConstant: 36).isActive = true
        more.widthAnchor.constraint(equalToConstant: 36).isActive = true
        view.addSubview(header)

        textView.translatesAutoresizingMaskIntoConstraints = false
        textView.backgroundColor = .systemBackground
        textView.alwaysBounceVertical = true
        textView.keyboardDismissMode = .interactive
        textView.textContainerInset = UIEdgeInsets(top: 8, left: 14, bottom: 160, right: 14)
        textView.allowsEditingTextAttributes = true
        textView.delegate = self
        textView.linkTextAttributes = [.foregroundColor: UIColor.link, .underlineStyle: NSUnderlineStyle.single.rawValue]
        textView.attributedText = FolioCodec.document(blocks, titles: titles)
        textView.inputAccessoryView = makeToolbar()
        view.addSubview(textView)

        NSLayoutConstraint.activate([
            header.topAnchor.constraint(equalTo: view.safeAreaLayoutGuide.topAnchor, constant: 4),
            header.leadingAnchor.constraint(equalTo: view.leadingAnchor, constant: 10),
            header.trailingAnchor.constraint(equalTo: view.trailingAnchor, constant: -10),
            header.heightAnchor.constraint(equalToConstant: 44),
            textView.topAnchor.constraint(equalTo: header.bottomAnchor),
            textView.leadingAnchor.constraint(equalTo: view.leadingAnchor),
            textView.trailingAnchor.constraint(equalTo: view.trailingAnchor),
            textView.bottomAnchor.constraint(equalTo: view.keyboardLayoutGuide.topAnchor),
        ])

        let tap = UITapGestureRecognizer(target: self, action: #selector(tapped(_:)))
        tap.delegate = self
        textView.addGestureRecognizer(tap)
        let edge = UIScreenEdgePanGestureRecognizer(target: self, action: #selector(edgePan(_:)))
        edge.edges = .left
        view.addGestureRecognizer(edge)
        NotificationCenter.default.addObserver(self, selector: #selector(appWillResign), name: UIApplication.willResignActiveNotification, object: nil)
    }

    // MARK: Saving

    private func changed() {
        dirty = true
        saveTimer?.invalidate()
        saveTimer = Timer.scheduledTimer(withTimeInterval: 0.5, repeats: false) { [weak self] _ in self?.save() }
    }
    private func save() {
        saveTimer?.invalidate(); saveTimer = nil
        guard dirty else { return }
        dirty = false
        blocks = FolioCodec.blocks(from: textView.attributedText, previous: blocks)
        note["blocks"] = blocks
        note["title"] = titleField.text ?? ""
        onChange?(note)
    }
    @objc private func appWillResign() { save() }
    private func action(_ kind: String) {
        save()
        onAction?(kind, noteID)
    }

    // MARK: Text view

    func textViewDidChange(_ textView: UITextView) { changed() }

    func textFieldShouldReturn(_ textField: UITextField) -> Bool {
        textView.becomeFirstResponder()
        textView.selectedRange = NSRange(location: 0, length: 0)
        return false
    }

    private var storage: NSTextStorage { textView.textStorage }
    private func paragraphRange(at location: Int) -> NSRange {
        (storage.string as NSString).paragraphRange(for: NSRange(location: min(location, storage.length), length: 0))
    }
    private func lineInfo(at location: Int) -> (range: NSRange, kind: String, id: String, indent: Int, prefixLength: Int, content: String) {
        let range = paragraphRange(at: location)
        let probe = range.length > 0 ? range.location : max(0, range.location - 1)
        let attrs = storage.length > 0 ? storage.attributes(at: min(probe, storage.length - 1), effectiveRange: nil) : [:]
        var line = (storage.string as NSString).substring(with: range)
        if line.hasSuffix("\n") { line.removeLast() }
        let kind = attrs[.folioKind] as? String ?? "text"
        var prefixLength = 0
        if FolioCodec.listKinds.contains(kind) || kind.hasPrefix("toggle"),
           let match = FolioCodec.prefixPattern.firstMatch(in: line, range: NSRange(location: 0, length: (line as NSString).length)) { prefixLength = match.range.length }
        return (range, kind, attrs[.folioID] as? String ?? "", FolioCodec.int(attrs[.folioIndent]), prefixLength, (line as NSString).substring(from: prefixLength))
    }

    func textView(_ textView: UITextView, shouldChangeTextIn range: NSRange, replacementText text: String) -> Bool {
        let line = lineInfo(at: range.location)
        // Enter: lists continue, an empty list line ends the list, a heading is followed by text.
        if text == "\n" && range.length == 0 && line.kind != "code" {
            if FolioCodec.listKinds.contains(line.kind) && line.content.isEmpty {
                restructure { blocks, index in blocks[index]["kind"] = "text" }
                return false
            }
            let nextKind = FolioCodec.listKinds.contains(line.kind) ? line.kind : "text"
            let number = nextKind == "numbered" ? (Int(((storage.string as NSString).substring(with: line.range)).split(separator: ".").first ?? "1") ?? 1) + 1 : 1
            let attrs = FolioCodec.lineAttributes(kind: nextKind, id: UUID().uuidString.uppercased(), indent: line.indent)
            let insert = NSMutableAttributedString(string: "\n", attributes: storage.attributes(at: max(0, min(range.location, storage.length) - 1), effectiveRange: nil).filter { [.folioID, .folioKind, .folioIndent, .paragraphStyle, .font].contains($0.key) })
            insert.append(NSAttributedString(string: FolioCodec.prefix(kind: nextKind, checked: false, number: number), attributes: attrs))
            storage.replaceCharacters(in: range, with: insert)
            textView.selectedRange = NSRange(location: range.location + insert.length, length: 0)
            textView.typingAttributes = attrs
            changed()
            return false
        }
        // Markdown shortcuts typed at the start of a plain line.
        if text == " " && line.kind == "text" && range.location == line.range.location + (line.content as NSString).length {
            let shortcuts = ["#": "heading1", "##": "heading2", "###": "heading3", "-": "bullet", "*": "bullet", "[]": "task", "1.": "numbered", ">": "quote", "\"": "quote"]
            if let kind = shortcuts[line.content] {
                restructure(caretAtContentEnd: true) { blocks, index in blocks[index]["kind"] = kind; blocks[index]["text"] = ""; blocks[index]["marks"] = [Any]() }
                return false
            }
        }
        // Deleting into a list marker turns the line back into plain text.
        if text.isEmpty && line.prefixLength > 0 && range.location < line.range.location + line.prefixLength && range.location >= line.range.location {
            restructure { blocks, index in blocks[index]["kind"] = "text" }
            return false
        }
        return true
    }

    func textViewDidChangeSelection(_ textView: UITextView) {
        // Keep the caret out of list markers.
        let range = textView.selectedRange
        guard range.length == 0 else { return }
        let line = lineInfo(at: range.location)
        if line.prefixLength > 0 && range.location < line.range.location + line.prefixLength {
            textView.selectedRange = NSRange(location: line.range.location + line.prefixLength, length: 0)
        }
    }

    /// Structural edits (change a line's kind, indent, tick a box) go through the blocks, then the page is redrawn.
    private func restructure(caretAtContentEnd: Bool = false, _ change: (inout [[String: Any]], Int) -> Void) {
        let caret = textView.selectedRange.location
        let oldLine = lineInfo(at: caret)
        let offsetInContent = max(0, caret - oldLine.range.location - oldLine.prefixLength)
        let lines = paragraphs()
        guard let index = (lines.last(where: { $0.range.location <= caret }) ?? lines.first)?.block else { return }
        var current = FolioCodec.blocks(from: storage, previous: blocks)
        guard index < current.count else { return }
        change(&current, index)
        blocks = current
        storage.setAttributedString(FolioCodec.document(current, titles: titles))
        textView.undoManager?.removeAllActions()
        if let target = paragraphs().first(where: { $0.block == index }) {
            let line = lineInfo(at: target.range.location)
            let length = (line.content as NSString).length
            let position = line.range.location + line.prefixLength + (caretAtContentEnd ? length : min(offsetInContent, length))
            textView.selectedRange = NSRange(location: min(position, storage.length), length: 0)
            textView.typingAttributes = FolioCodec.lineAttributes(kind: line.kind, id: line.id, indent: line.indent)
        }
        changed()
    }

    /// Every paragraph with the index of the block it belongs to, counted exactly as the codec reads
    /// blocks back (a code block's lines share one block).
    private func paragraphs() -> [(range: NSRange, block: Int)] {
        let text = storage.string as NSString
        var result: [(range: NSRange, block: Int)] = []
        var location = 0, block = -1
        var previousID = "", previousKind = ""
        repeat {
            let range = text.paragraphRange(for: NSRange(location: location, length: 0))
            let attrs = storage.length > 0 ? storage.attributes(at: min(range.location, storage.length - 1), effectiveRange: nil) : [:]
            let id = FolioCodec.string(attrs[.folioID]).uppercased(), kind = attrs[.folioKind] as? String ?? "text"
            if !(kind == "code" && previousKind == "code" && id == previousID && block >= 0) { block += 1 }
            result.append((range, block))
            previousID = id; previousKind = kind
            location = NSMaxRange(range)
            if range.length == 0 { break }
        } while location < text.length
        // Text ending in a newline has one more, empty, line after it.
        if text.length > 0 && text.hasSuffix("\n") { result.append((NSRange(location: text.length, length: 0), block + 1)) }
        return result
    }

    // MARK: Taps: tick a box, open a linked page

    func gestureRecognizer(_ gestureRecognizer: UIGestureRecognizer, shouldRecognizeSimultaneouslyWith other: UIGestureRecognizer) -> Bool { true }

    @objc private func tapped(_ gesture: UITapGestureRecognizer) {
        let point = gesture.location(in: textView)
        guard let position = textView.closestPosition(to: point) else { return }
        let location = textView.offset(from: textView.beginningOfDocument, to: position)
        let line = lineInfo(at: location)
        if line.kind == "task" && location <= line.range.location + 2 {
            restructure { blocks, index in blocks[index]["checked"] = !FolioCodec.bool(blocks[index]["checked"]) }
        } else if line.kind == "page" || line.kind == "pageIn", let block = blocks.first(where: { FolioCodec.string($0["id"]).uppercased() == line.id.uppercased() }) {
            let target = FolioCodec.string(block["asset"])
            if !target.isEmpty { save(); onOpenNote?(target) }
        }
    }

    // MARK: Swipe from the left edge to go back

    @objc private func edgePan(_ gesture: UIScreenEdgePanGestureRecognizer) {
        let dx = max(0, gesture.translation(in: view.superview).x)
        switch gesture.state {
        case .began: view.endEditing(true)
        case .changed: view.transform = CGAffineTransform(translationX: dx, y: 0)
        case .ended, .cancelled:
            if dx > view.bounds.width / 3 || gesture.velocity(in: view).x > 700 { finish(animated: true, notify: true) }
            else { UIView.animate(withDuration: 0.2) { self.view.transform = .identity } }
        default: break
        }
    }

    // MARK: Keyboard toolbar

    private func makeToolbar() -> UIView {
        let bar = UIToolbar(frame: CGRect(x: 0, y: 0, width: 320, height: 44))
        func item(_ symbol: String, _ label: String, _ handler: @escaping () -> Void) -> UIBarButtonItem {
            let button = UIBarButtonItem(image: UIImage(systemName: symbol), primaryAction: UIAction { _ in handler() })
            button.accessibilityLabel = label
            return button
        }
        let kinds: [(String, String)] = [("Text", "text"), ("Heading 1", "heading1"), ("Heading 2", "heading2"), ("Heading 3", "heading3"), ("Bulleted list", "bullet"), ("Numbered list", "numbered"), ("To-do", "task"), ("Quote", "quote"), ("Callout", "callout"), ("Code", "code")]
        let turnInto = UIBarButtonItem(image: UIImage(systemName: "textformat"), menu: UIMenu(title: "Turn into", children: kinds.map { title, kind in
            UIAction(title: title) { [weak self] _ in self?.restructure { blocks, index in blocks[index]["kind"] = kind } }
        }))
        turnInto.accessibilityLabel = "Turn into"
        let items: [UIBarButtonItem] = [
            turnInto,
            item("checkmark.square", "To-do") { [weak self] in self?.toggleKind("task") },
            item("list.bullet", "Bulleted list") { [weak self] in self?.toggleKind("bullet") },
            item("bold", "Bold") { [weak self] in self?.toggleTrait(.traitBold) },
            item("italic", "Italic") { [weak self] in self?.toggleTrait(.traitItalic) },
            item("decrease.indent", "Outdent") { [weak self] in self?.indent(-1) },
            item("increase.indent", "Indent") { [weak self] in self?.indent(1) },
            item("arrow.uturn.backward", "Undo") { [weak self] in self?.textView.undoManager?.undo() },
            .flexibleSpace(),
            item("keyboard.chevron.compact.down", "Hide keyboard") { [weak self] in self?.view.endEditing(true) },
        ]
        bar.items = items
        bar.sizeToFit()
        return bar
    }
    private func toggleKind(_ kind: String) {
        let line = lineInfo(at: textView.selectedRange.location)
        restructure { blocks, index in blocks[index]["kind"] = line.kind == kind ? "text" : kind }
    }
    private func indent(_ delta: Int) {
        restructure { blocks, index in
            let next = max(0, min(8, FolioCodec.int(blocks[index]["indent"]) + delta))
            if next > 0 { blocks[index]["indent"] = next } else { blocks[index].removeValue(forKey: "indent") }
        }
    }
    private func toggleTrait(_ trait: UIFontDescriptor.SymbolicTraits) {
        let range = textView.selectedRange
        if range.length == 0 {
            var attrs = textView.typingAttributes
            let font = attrs[.font] as? UIFont ?? .systemFont(ofSize: FolioCodec.baseSize)
            let on = font.fontDescriptor.symbolicTraits.contains(trait)
            attrs[.font] = on ? FolioCodec.withoutTrait(font, trait) : FolioCodec.withTrait(font, trait)
            if trait == .traitBold { if on { attrs.removeValue(forKey: .folioBold) } else { attrs[.folioBold] = true } }
            textView.typingAttributes = attrs
            return
        }
        let first = storage.attribute(.font, at: range.location, effectiveRange: nil) as? UIFont
        let on = first?.fontDescriptor.symbolicTraits.contains(trait) ?? false
        storage.beginEditing()
        storage.enumerateAttribute(.font, in: range) { value, run, _ in
            let font = value as? UIFont ?? .systemFont(ofSize: FolioCodec.baseSize)
            storage.addAttribute(.font, value: on ? FolioCodec.withoutTrait(font, trait) : FolioCodec.withTrait(font, trait), range: run)
        }
        if trait == .traitBold { if on { storage.removeAttribute(.folioBold, range: range) } else { storage.addAttribute(.folioBold, value: true, range: range) } }
        storage.endEditing()
        changed()
    }
}
