import AppKit
import FolioCore

extension NSAttributedString.Key {
    static let folioID = Self("FolioBlockID")
    static let folioKind = Self("FolioKind")
    static let folioHighlight = Self("FolioInlineHighlight")
    static let folioBold = Self("FolioBold")
    static let folioCode = Self("FolioCode")
    static let folioTextColor = Self("FolioTextColor")
}
enum RichTextCodec {
    static func inline(_ block: Block, font: NSFont, ink: NSColor, strength: Double = 0.9) -> NSMutableAttributedString {
        let result: NSMutableAttributedString
        if let marks = block.marks {
            result = NSMutableAttributedString(string: block.text, attributes: [.font: font, .foregroundColor: ink])
            for mark in marks {
                guard mark.start >= 0, mark.length > 0, mark.start <= result.length, mark.length <= result.length - mark.start else { continue }
                let range = NSRange(location: mark.start, length: mark.length)
                switch mark.style {
                case .bold: result.addAttributes([.font: NSFontManager.shared.convert(font, toHaveTrait: .boldFontMask), .folioBold: true], range: range)
                case .italic:
                    result.enumerateAttribute(.font, in: range) { f, r, _ in result.addAttribute(.font, value: NSFontManager.shared.convert(f as? NSFont ?? font, toHaveTrait: .italicFontMask), range: r) }
                case .underline: result.addAttribute(.underlineStyle, value: NSUnderlineStyle.single.rawValue, range: range)
                case .strike: result.addAttribute(.strikethroughStyle, value: NSUnderlineStyle.single.rawValue, range: range)
                case .code: result.addAttributes([.font: NSFont.monospacedSystemFont(ofSize: font.pointSize - 1, weight: .regular), .folioCode: true], range: range)
                case .highlight:
                    let color = Highlight(rawValue: mark.value ?? "yellow") ?? .yellow
                    result.addAttributes([.backgroundColor: color.nsColor.withAlphaComponent(strength), .foregroundColor: NSColor(calibratedWhite: 0.08, alpha: 1), .folioHighlight: color.rawValue], range: range)
                case .color:
                    let color = Highlight(rawValue: mark.value ?? "none") ?? .none
                    result.addAttributes([.foregroundColor: color == .none ? ink : color.nsColor, .folioTextColor: color.rawValue], range: range)
                case .link: if let value = mark.value, let url = URL(string: value), ["https", "http", "mailto", "folio"].contains(url.scheme ?? "") { result.addAttribute(.link, value: url, range: range) }
                }
            }
        } else {
            result = NSMutableAttributedString(string: block.text, attributes: [.font: font, .foregroundColor: ink])
            // Convert familiar legacy Markdown to editable rich text, without visible markers.
            for (pattern, style) in [("\\*\\*(.+?)\\*\\*", "bold"), ("==(.+?)==", "highlight"), ("::(.+?)::", "highlight"), ("~~(.+?)~~", "strike"), ("`([^`]+)`", "code"), ("(?<!\\*)\\*([^*]+)\\*(?!\\*)", "italic")] {
                guard let regex = try? NSRegularExpression(pattern: pattern) else { continue }
                for match in regex.matches(in: result.string, range: NSRange(location: 0, length: result.length)).reversed() {
                    let inner = result.attributedSubstring(from: match.range(at: 1)); let replacement = NSMutableAttributedString(attributedString: inner)
                    let r = NSRange(location: 0, length: replacement.length)
                    switch style {
                    case "bold": replacement.addAttributes([.font: NSFontManager.shared.convert(font, toHaveTrait: .boldFontMask), .folioBold: true], range: r)
                    case "italic": replacement.addAttribute(.font, value: NSFontManager.shared.convert(font, toHaveTrait: .italicFontMask), range: r)
                    case "highlight": replacement.addAttributes([.backgroundColor: Highlight.yellow.nsColor.withAlphaComponent(strength), .foregroundColor: NSColor.black, .folioHighlight: "yellow"], range: r)
                    case "strike": replacement.addAttribute(.strikethroughStyle, value: 1, range: r)
                    default: replacement.addAttributes([.font: NSFont.monospacedSystemFont(ofSize: font.pointSize - 1, weight: .regular), .folioCode: true], range: r)
                    }
                    result.replaceCharacters(in: match.range, with: replacement)
                }
            }
            if let regex = try? NSRegularExpression(pattern: "\\[([^\\]]+)\\]\\(([^\\)]+)\\)") {
                for match in regex.matches(in: result.string, range: NSRange(location: 0, length: result.length)).reversed() {
                    let target = (result.string as NSString).substring(with: match.range(at: 2)); let label = (result.string as NSString).substring(with: match.range(at: 1))
                    guard let url = URL(string: target), ["https", "http", "mailto", "folio"].contains(url.scheme ?? "") else { continue }
                    result.replaceCharacters(in: match.range, with: NSAttributedString(string: label, attributes: [.font: font, .foregroundColor: ink, .link: url]))
                }
            }
        }
        return result
    }
    static func attributes(kind: BlockKind, id: UUID, size: Double, light: Bool = false) -> [NSAttributedString.Key: Any] {
        let heading = kind.headingLevel > 0
        let point: Double = switch kind.headingLevel { case 1: size + 12; case 2: size + 7; case 3: size + 3; case 4: size + 1; default: size }
        let font = [.code, .equation].contains(kind) ? NSFont.monospacedSystemFont(ofSize: size - 1, weight: .regular) : NSFont.systemFont(ofSize: point, weight: heading ? .semibold : .regular)
        let paragraph = NSMutableParagraphStyle(); paragraph.lineSpacing = 4; paragraph.paragraphSpacing = heading ? 9 : 7; paragraph.paragraphSpacingBefore = heading ? 10 : 0
        if [.bullet, .numbered, .task, .toggle, .quote].contains(kind) { paragraph.headIndent = 23; paragraph.firstLineHeadIndent = 0 }
        return [.font: font, .foregroundColor: light ? NSColor(calibratedWhite: 0.12, alpha: 1) : NSColor(calibratedWhite: 0.90, alpha: 1), .paragraphStyle: paragraph, .folioID: id.uuidString, .folioKind: kind.rawValue]
    }
    static func prefix(_ block: Block) -> String {
        switch block.kind { case .bullet: return "•  "; case .numbered: return "1.  "; case .task: return block.checked ? "☑  " : "☐  "; case .toggle: return block.checked ? "▸  " : "▾  "; case .toggleHeading1, .toggleHeading2, .toggleHeading3, .toggleHeading4: return block.checked ? "▸  " : "▾  "; case .quote: return "│  "; case .callout: return "✦  "; case .attachment: return "📎  "; default: return "" }
    }
    static func document(_ blocks: [Block], size: Double, strength: Double, light: Bool = false, library: URL? = nil) -> NSAttributedString {
        let document = NSMutableAttributedString(string: "")
        for (index, block) in blocks.enumerated() {
            let attrs = attributes(kind: block.kind, id: block.id, size: size, light: light)
            let font = attrs[.font] as! NSFont
            let baseInk = attrs[.foregroundColor] as! NSColor
            let ink = block.highlight == .none ? baseInk : NSColor(calibratedWhite: 0.10, alpha: 1)
            let body = block.kind == .code ? NSMutableAttributedString(string: block.text, attributes: [.font: font, .foregroundColor: ink]) : inline(block, font: font, ink: ink, strength: strength)
            let line = NSMutableAttributedString(string: prefix(block), attributes: attrs)
            line.append(block.kind == .divider ? NSAttributedString(string: "────────────────────────", attributes: attrs) : body)
            if index < blocks.count - 1 { line.append(NSAttributedString(string: "\n", attributes: attrs)) }
            let range = NSRange(location: 0, length: line.length)
            for key in [NSAttributedString.Key.folioID, .folioKind, .paragraphStyle] { if let value = attrs[key] { line.addAttribute(key, value: value, range: range) } }
            if block.highlight != .none { line.addAttribute(.backgroundColor, value: block.highlight.nsColor.withAlphaComponent(strength), range: range); line.addAttribute(.foregroundColor, value: ink, range: range) }
            if block.kind == .attachment, let asset = block.asset, let library { line.addAttribute(.link, value: library.appendingPathComponent(asset), range: range) }
            if [.page, .pageIn].contains(block.kind), let id = block.asset, let page = UUID(uuidString: id), let url = URL(string: "folio://note/\(page.uuidString)") { line.addAttribute(.link, value: url, range: range) }
            if block.kind == .task { line.addAttribute(.link, value: URL(string: "folio-task://" + block.id.uuidString)!, range: NSRange(location: 0, length: 1)) }
            if block.kind == .toggle || block.kind.isToggleHeading { line.addAttribute(.link, value: URL(string: "folio-toggle://" + block.id.uuidString)!, range: NSRange(location: 0, length: 1)) }
            document.append(line)
        }
        return document
    }
    static func blocks(_ document: NSAttributedString, previous: [Block]) -> [Block] {
        let string = document.string as NSString
        if string.length == 0 { return [Block(id: previous.first?.id ?? UUID(), marks: [])] }
        let previousByID = Dictionary(previous.map { ($0.id, $0) }, uniquingKeysWith: { first, _ in first })
        var output: [Block] = []; var seen: Set<UUID> = []; var cursor = 0
        while cursor < string.length {
            let range = string.paragraphRange(for: NSRange(location: cursor, length: 0))
            var contentRange = range
            while contentRange.length > 0 && ["\n", "\r"].contains(string.substring(with: NSRange(location: NSMaxRange(contentRange)-1, length: 1))) { contentRange.length -= 1 }
            let attrs = document.attributes(at: cursor, effectiveRange: nil)
            let originalID = (attrs[.folioID] as? String).flatMap(UUID.init(uuidString:))
            let id = originalID.flatMap { seen.contains($0) ? nil : $0 } ?? UUID(); seen.insert(id)
            let old = originalID.flatMap { previousByID[$0] }
            let kind = (attrs[.folioKind] as? String).flatMap(BlockKind.init(rawValue:)) ?? .text
            var block = old ?? Block(id: id, kind: kind, marks: []); block.id = id; block.kind = kind
            let prefix = prefix(block)
            if !prefix.isEmpty, string.substring(with: contentRange).hasPrefix(prefix) { contentRange.location += (prefix as NSString).length; contentRange.length -= (prefix as NSString).length }
            block.text = kind == .divider ? "" : string.substring(with: contentRange); block.marks = []
            document.enumerateAttributes(in: contentRange) { attributes, run, _ in
                let start = run.location - contentRange.location
                func mark(_ style: InlineStyle, value: String? = nil) { block.marks?.append(InlineMark(start: start, length: run.length, style: style, value: value)) }
                if let font = attributes[.font] as? NSFont {
                    let traits = NSFontManager.shared.traits(of: font)
                    if attributes[.folioBold] as? Bool == true || (traits.contains(.boldFontMask) && kind.headingLevel == 0) { mark(.bold) }
                    if traits.contains(.italicFontMask) { mark(.italic) }
                }
                if (attributes[.underlineStyle] as? Int ?? 0) != 0 { mark(.underline) }
                if (attributes[.strikethroughStyle] as? Int ?? 0) != 0 { mark(.strike) }
                if attributes[.folioCode] as? Bool == true && kind != .code { mark(.code) }
                if let color = attributes[.folioHighlight] as? String { mark(.highlight, value: color) }
                if let color = attributes[.folioTextColor] as? String { mark(.color, value: color) }
                if let link = attributes[.link] as? URL, ["https", "http", "mailto", "folio"].contains(link.scheme ?? "") { mark(.link, value: link.absoluteString) }
            }
            // Adjacent paragraphs within a code block remain one block.
            if kind == .code, let last = output.last, last.id == originalID { output[output.count-1].text += "\n" + block.text }
            else { output.append(block) }
            cursor = NSMaxRange(range)
        }
        if string.hasSuffix("\n") { output.append(Block(id: previous.last.flatMap { !seen.contains($0.id) && $0.text.isEmpty ? $0.id : nil } ?? UUID(), marks: [])) }
        return output.isEmpty ? [Block(marks: [])] : output
    }
}
