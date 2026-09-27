import Foundation

public enum BlockKind: String, Codable, CaseIterable, Sendable {
    case text, heading1, heading2, heading3, heading4, toggleHeading1, toggleHeading2, toggleHeading3, toggleHeading4, bullet, numbered, task, toggle, quote, callout, code, equation, divider, page, pageIn, attachment, database, table, button
    public var title: String {
        switch self {
        case .text: "Text"; case .heading1: "Heading 1"; case .heading2: "Heading 2"; case .heading3: "Heading 3"; case .heading4: "Heading 4"
        case .toggleHeading1: "Toggle heading 1"; case .toggleHeading2: "Toggle heading 2"; case .toggleHeading3: "Toggle heading 3"; case .toggleHeading4: "Toggle heading 4"
        case .bullet: "Bulleted list"; case .numbered: "Numbered list"; case .task: "To-do"; case .toggle: "Toggle list"
        case .quote: "Quote"; case .callout: "Callout"; case .code: "Code"; case .equation: "Block equation"; case .divider: "Divider"; case .page: "Page"; case .pageIn: "Page in"; case .attachment: "Attachment"; case .database: "Database"; case .table: "Table"; case .button: "Button"
        }
    }
    public var symbol: String {
        switch self {
        case .text: "text.alignleft"; case .heading1, .heading2, .heading3, .heading4: "textformat.size"
        case .toggleHeading1, .toggleHeading2, .toggleHeading3, .toggleHeading4: "chevron.right.textformat"
        case .bullet: "list.bullet"; case .numbered: "list.number"; case .task: "checkmark.square"; case .toggle: "chevron.right.2"
        case .quote: "quote.opening"; case .callout: "lightbulb"; case .code: "chevron.left.forwardslash.chevron.right"; case .equation: "function"
        case .divider: "minus"; case .page, .pageIn: "doc.text"; case .attachment: "paperclip"; case .database: "tablecells"; case .table: "tablecells"; case .button: "hand.tap"
        }
    }
    public var headingLevel: Int {
        switch self { case .heading1, .toggleHeading1: 1; case .heading2, .toggleHeading2: 2; case .heading3, .toggleHeading3: 3; case .heading4, .toggleHeading4: 4; default: 0 }
    }
    public var isToggleHeading: Bool { [.toggleHeading1, .toggleHeading2, .toggleHeading3, .toggleHeading4].contains(self) }
}
public enum Highlight: String, Codable, CaseIterable, Sendable { case none, gray, brown, orange, yellow, green, blue, purple, pink, red }
public enum InlineStyle: String, Codable, Sendable { case bold, italic, underline, strike, code, highlight, color, link }
public struct InlineMark: Codable, Equatable, Sendable {
    public var start: Int; public var length: Int; public var style: InlineStyle; public var value: String?
    public init(start: Int, length: Int, style: InlineStyle, value: String? = nil) { self.start = start; self.length = length; self.style = style; self.value = value }
}
public struct Block: Identifiable, Codable, Equatable, Sendable {
    public var id: UUID
    public var kind: BlockKind
    public var text: String
    public var checked: Bool
    public var highlight: Highlight
    public var asset: String?
    public var marks: [InlineMark]?
    /// Outline depth (0–8) for nested lists and notes; nil means top level.
    public var indent: Int?
    /// Blocks sharing a row id sit side by side, in columns numbered by `column` (the notebook's Notion-style columns).
    public var row: String?
    public var column: Int?
    /// Share of the row's width for this block's column (read from a column's first block).
    public var width: Double?
    public init(id: UUID = UUID(), kind: BlockKind = .text, text: String = "", checked: Bool = false, highlight: Highlight = .none, asset: String? = nil, marks: [InlineMark]? = nil, indent: Int? = nil, row: String? = nil, column: Int? = nil, width: Double? = nil) {
        self.id = id; self.kind = kind; self.text = text; self.checked = checked; self.highlight = highlight; self.asset = asset; self.marks = marks; self.indent = indent; self.row = row; self.column = column; self.width = width
    }
}

public enum TableViewKind: String, Codable, CaseIterable, Sendable { case table, board, chart }
public enum TableColumnKind: String, Codable, CaseIterable, Sendable { case title, text, select, status, number, date, rating, multiSelect, checkbox, url }
extension TableColumnKind {
    public var title: String {
        switch self { case .title: "Title"; case .text: "Text"; case .select: "Select"; case .status: "Status"; case .number: "Number"; case .date: "Date"; case .rating: "Rating"; case .multiSelect: "Multi-select"; case .checkbox: "Checkbox"; case .url: "URL" }
    }
}
public struct DatabaseColumn: Identifiable, Codable, Equatable, Sendable {
    public var id: String
    public var name: String
    public var kind: TableColumnKind
    public var options: [String]
    /// Option name → color name, for select, status and multi-select chips.
    public var colors: [String: String]?
    public init(id: String = UUID().uuidString, name: String, kind: TableColumnKind = .text, options: [String] = [], colors: [String: String]? = nil) { self.id = id; self.name = name; self.kind = kind; self.options = options; self.colors = colors }
}
public struct DatabaseRow: Identifiable, Codable, Equatable, Sendable {
    public var id: String
    public var values: [String: String]
    /// The row's own page (its body), a child page of the database.
    public var page: String?
    public init(id: String = UUID().uuidString, values: [String: String] = [:], page: String? = nil) { self.id = id; self.values = values; self.page = page }
}
public struct TableFilter: Codable, Equatable, Sendable { public var column: String; public var op: String; public var value: String?; public var values: [String]? }
public struct TableSort: Codable, Equatable, Sendable { public var column: String; public var desc: Bool? }
public struct TableChart: Codable, Equatable, Sendable { public var x: String?; public var kind: String?; public var bucket: String?; public var cumulative: Bool?; public var countOnly: String? }
/// A saved way of looking at a database (Notion's views): layout, visible columns, filters and sorts.
public struct TableView: Codable, Equatable, Sendable {
    public var id: String; public var name: String; public var kind: String
    public var columns: [String]?; public var sort: [TableSort]?; public var filter: [TableFilter]?; public var groupBy: String?
    public var chart: TableChart?; public var cardSize: String?; public var cover: String?
    /// Shown only where a page embeds it (Notion's linked view), not as a tab of the database.
    public var linked: Bool?
}
public struct NoteTable: Codable, Equatable, Sendable {
    public var columns: [DatabaseColumn]
    public var rows: [DatabaseRow]
    public var view: TableViewKind
    public var groupBy: String?
    public var chartBy: String?
    public var views: [TableView]?
    public var activeView: String?
    public init(columns: [DatabaseColumn], rows: [DatabaseRow] = [], view: TableViewKind = .table, groupBy: String? = nil, chartBy: String? = nil) { self.columns = columns; self.rows = rows; self.view = view; self.groupBy = groupBy ?? columns.first(where: { $0.kind == .select || $0.kind == .status })?.id; self.chartBy = chartBy ?? columns.first(where: { $0.kind == .select || $0.kind == .status })?.id }
    public static var library: NoteTable {
        NoteTable(columns: [
            DatabaseColumn(name: "Title", kind: .title),
            DatabaseColumn(name: "Author", kind: .text),
            DatabaseColumn(name: "Type", kind: .select, options: ["Fiction", "Biography", "Philosophy", "Poetry", "Economics", "History", "Self-help", "Science"]),
            DatabaseColumn(name: "Status", kind: .status, options: ["To read", "Reading", "Done"]),
            DatabaseColumn(name: "Rating", kind: .rating),
            DatabaseColumn(name: "Date started", kind: .date)
        ])
    }
    public func plainText() -> String {
        let names = columns.map(\.name)
        let body = rows.map { row in columns.map { row.values[$0.id, default: ""] }.joined(separator: " · ") }.joined(separator: "\n")
        return ([names.joined(separator: " · ")] + (body.isEmpty ? [] : [body])).joined(separator: "\n")
    }
}
public struct Note: Identifiable, Codable, Equatable, Sendable {
    public var id: UUID
    public var title: String
    public var icon: String
    public var parentID: UUID?
    public var blocks: [Block]
    public var tags: [String]
    public var favorite: Bool
    public var excludedFromAI: Bool
    public var isMeeting: Bool
    public var isChat: Bool?
    /// Position among sibling pages, set when the user drags pages into order; nil keeps the default order.
    public var order: Double?
    /// Full-width page (Notion's "Full width"), for dashboards laid out in columns.
    public var wide: Bool?
    public var table: NoteTable?
    public var trashed: Bool
    public var created: Date
    public var modified: Date
    public init(id: UUID = UUID(), title: String = "Untitled", icon: String = "doc.text", parentID: UUID? = nil, blocks: [Block] = [Block()], tags: [String] = [], favorite: Bool = false, excludedFromAI: Bool = false, isMeeting: Bool = false, isChat: Bool? = nil, table: NoteTable? = nil, trashed: Bool = false, created: Date = Date(), modified: Date = Date()) {
        self.id = id; self.title = title; self.icon = icon; self.parentID = parentID; self.blocks = blocks; self.tags = tags; self.table = table
        self.favorite = favorite; self.excludedFromAI = excludedFromAI; self.isMeeting = isMeeting; self.isChat = isChat; self.trashed = trashed
        self.created = created; self.modified = modified
    }
    public var displayTitle: String { title.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty ? "Untitled" : title }
    public var plainBody: String { [blocks.map(\.text).joined(separator: "\n\n"), table?.plainText() ?? ""].filter { !$0.isEmpty }.joined(separator: "\n\n") }
    public var wordCount: Int { plainBody.split { $0.isWhitespace || $0.isNewline }.count }
    public var preview: String { blocks.first(where: { !$0.text.isEmpty && $0.kind != .divider })?.text ?? "An empty page. A fresh start." }
}
public struct Revision: Identifiable, Sendable {
    public var id: Int64
    public var date: Date
    public var note: Note
    public init(id: Int64, date: Date, note: Note) { self.id = id; self.date = date; self.note = note }
}
public struct ChatMessage: Codable, Identifiable, Sendable {
    public var id: UUID = UUID()
    public var role: String
    public var content: String
    public var sourceIDs: [UUID] = []
    public init(role: String, content: String, sourceIDs: [UUID] = []) { self.role = role; self.content = content; self.sourceIDs = sourceIDs }
}
public enum Markdown {
    public static func render(_ note: Note, plain: Bool = false) -> String {
        let body = note.blocks.enumerated().map { index, b -> String in
            if plain {
                if b.kind == .divider { return "────────" }
                let s = b.marks == nil ? stripInline(b.text) : b.text
                return b.kind == .task ? "[\(b.checked ? "x" : " ")] \(s)" : s
            }
            let t = b.marks.map { InlineMarkup.render(b.text, marks: $0) } ?? b.text
            switch b.kind {
            case .heading1: return "# \(t)"
            case .heading2: return "## \(t)"
            case .heading3: return "### \(t)"
            case .heading4: return "#### \(t)"
            case .toggleHeading1: return "# ▸ \(t)"
            case .toggleHeading2: return "## ▸ \(t)"
            case .toggleHeading3: return "### ▸ \(t)"
            case .toggleHeading4: return "#### ▸ \(t)"
            case .bullet: return t.components(separatedBy: "\n").enumerated().map { ($0.offset == 0 ? "- " : "  ") + $0.element }.joined(separator: "\n")
            case .numbered: return "1. \(t)"
            case .task: return "- [\(b.checked ? "x" : " ")] \(t)"
            case .quote, .callout: return t.components(separatedBy: "\n").map { "> \($0)" }.joined(separator: "\n")
            case .toggle: return "- <details><summary>\(t)</summary>\n\n</details>"
            case .code:
                let longest = t.components(separatedBy: CharacterSet(charactersIn: "`").inverted).map(\.count).max() ?? 0
                let fence = String(repeating: "`", count: max(3, longest + 1))
                return "\(fence)\n\(t)\n\(fence)"
            case .equation: return "$$\n\(t)\n$$"
            case .page, .pageIn: return "[\(t)](folio://note/\(b.asset ?? ""))"
            case .divider: return "---"
            case .attachment: return "[\(t.replacingOccurrences(of: "]", with: "\\]"))](\(b.asset ?? ""))"
            case .database: return "[Database](folio://note/\(b.asset ?? ""))"
            case .table:
                let rows = b.text.components(separatedBy: "\n").map { $0.components(separatedBy: "\t").map { $0.replacingOccurrences(of: "|", with: "\\|") } }
                guard let first = rows.first else { return "" }
                let line: ([String]) -> String = { "| " + $0.joined(separator: " | ") + " |" }
                return ([line(first), line(first.map { _ in "---" })] + rows.dropFirst().map(line)).joined(separator: "\n")
            default: return t
            }
        }.joined(separator: "\n\n")
        let table = note.table.map { data -> String in
            guard !data.columns.isEmpty else { return "" }
            if plain { return data.plainText() }
            let clean: (String) -> String = { $0.replacingOccurrences(of: "|", with: "\\|").replacingOccurrences(of: "\n", with: " ") }
            let header = "| " + data.columns.map { clean($0.name) }.joined(separator: " | ") + " |"
            let separator = "| " + data.columns.map { _ in "---" }.joined(separator: " | ") + " |"
            let rows = data.rows.map { row in "| " + data.columns.map { clean(row.values[$0.id, default: ""]) }.joined(separator: " | ") + " |" }
            return ([header, separator] + rows).joined(separator: "\n")
        } ?? ""
        let combined = [body, table].filter { !$0.isEmpty }.joined(separator: "\n\n")
        return (plain ? note.displayTitle : "# \(note.displayTitle)") + "\n\n" + combined + "\n"
    }
    public static func stripInline(_ text: String) -> String {
        var s = text
        for pattern in ["\\*\\*(.+?)\\*\\*", "==(.+?)==", "::(.+?)::", "~~(.+?)~~", "`([^`]+)`"] {
            s = s.replacingOccurrences(of: pattern, with: "$1", options: .regularExpression)
        }
        s = s.replacingOccurrences(of: "\\[([^\\]]+)\\]\\([^\\)]+\\)", with: "$1", options: .regularExpression)
        return s
    }
    public static func parse(_ markdown: String, title: String = "Imported note", extractTitle: Bool = true) -> Note {
        var note = Note(title: title, blocks: [])
        var paragraph: [String] = []; var fence: String?; var code: [String] = []
        func flush() { if !paragraph.isEmpty { note.blocks.append(Block(text: paragraph.joined(separator: "\n"))); paragraph = [] } }
        for line in markdown.replacingOccurrences(of: "\r\n", with: "\n").components(separatedBy: "\n") {
            if let active = fence {
                if line.hasPrefix(active) { note.blocks.append(Block(kind: .code, text: code.joined(separator: "\n"))); code = []; fence = nil }
                else { code.append(line) }; continue
            }
            if line.hasPrefix("```") || line.hasPrefix("~~~") { flush(); let c = line.first!; fence = String(line.prefix(while: { $0 == c })); continue }
            if line.trimmingCharacters(in: .whitespaces).isEmpty { flush(); continue }
            if extractTitle && note.blocks.isEmpty && paragraph.isEmpty && line.hasPrefix("# ") { note.title = String(line.dropFirst(2)); continue }
            let prefixes: [(String, BlockKind)] = [("#### ", .heading4), ("### ", .heading3), ("## ", .heading2), ("# ", .heading1), ("- [ ] ", .task), ("- [x] ", .task), ("- [X] ", .task), ("- ", .bullet), ("* ", .bullet), ("> ", .quote)]
            if let (prefix, kind) = prefixes.first(where: { line.hasPrefix($0.0) }) {
                flush(); note.blocks.append(Block(kind: kind, text: String(line.dropFirst(prefix.count)), checked: prefix.lowercased() == "- [x] ")); continue
            }
            if line == "---" || line == "***" { flush(); note.blocks.append(Block(kind: .divider)); continue }
            if let range = line.range(of: "^\\d+\\. ", options: .regularExpression) { flush(); note.blocks.append(Block(kind: .numbered, text: String(line[range.upperBound...]))); continue }
            paragraph.append(line)
        }
        if fence != nil { note.blocks.append(Block(kind: .code, text: code.joined(separator: "\n"))) }
        flush(); if note.blocks.isEmpty { note.blocks = [Block()] }; return note
    }
    public static func filename(_ note: Note) -> String {
        let invalid = CharacterSet(charactersIn: "/\\:\n\r\0").union(.controlCharacters)
        let safe = note.displayTitle.components(separatedBy: invalid).joined(separator: "-").trimmingCharacters(in: .whitespacesAndNewlines)
        return String((safe.isEmpty || safe == "." || safe == ".." ? "Untitled" : safe).prefix(90)) + "-" + note.id.uuidString.prefix(8).lowercased()
    }
}
public enum ContextBuilder {
    public static func build(notes: [Note], limit: Int = 48_000) -> (text: String, ids: [UUID]) {
        var text = ""; var ids: [UUID] = []
        for note in notes where !note.trashed && !note.excludedFromAI {
            let header = "\n<note id=\"\(note.id.uuidString)\">\nTitle: \(note.displayTitle)\n"
            let room = limit - text.count - header.count - 40
            guard room > 0 else { break }
            let body = Markdown.render(note)
            text += header + String(body.prefix(room)) + (body.count > room ? "\n[Note truncated]" : "") + "\n</note>\n"
            ids.append(note.id)
        }
        return (text, ids)
    }
}

public enum TranscriptChunker {
    public static func split(_ text: String, limit: Int) -> [String] {
        guard limit > 0, !text.isEmpty else { return [] }
        var result: [String] = []; var start = text.startIndex
        while start < text.endIndex {
            let end = text.index(start, offsetBy: limit, limitedBy: text.endIndex) ?? text.endIndex
            result.append(String(text[start..<end])); start = end
        }
        return result
    }
}

public enum InlineMarkup {
    public static func render(_ text: String, marks: [InlineMark]) -> String {
        let source = text as NSString; let count = source.length
        let valid = marks.filter { $0.start >= 0 && $0.length > 0 && $0.start <= count && $0.length <= count - $0.start }
        guard !valid.isEmpty else { return text }
        let cuts = Set([0, count] + valid.flatMap { [$0.start, $0.start + $0.length] }).sorted()
        func html(_ s: String) -> String { s.replacingOccurrences(of: "&", with: "&amp;").replacingOccurrences(of: "<", with: "&lt;").replacingOccurrences(of: ">", with: "&gt;").replacingOccurrences(of: "\"", with: "&quot;") }
        var result = ""
        for i in 0..<(cuts.count - 1) {
            let start = cuts[i], end = cuts[i+1]
            var part = html(source.substring(with: NSRange(location: start, length: end-start)))
            let active = valid.filter { $0.start <= start && $0.start + $0.length >= end }
            for mark in active {
                switch mark.style {
                case .bold: part = "<strong>\(part)</strong>"
                case .italic: part = "<em>\(part)</em>"
                case .underline: part = "<u>\(part)</u>"
                case .strike: part = "<s>\(part)</s>"
                case .code: part = "<code>\(part)</code>"
                case .highlight:
                    let colors = ["gray":"#A8B0AC", "brown":"#BD8A62", "yellow":"#FFCC45", "orange":"#FF8F4D", "green":"#7DD69E", "blue":"#6EB8FF", "purple":"#B38AFF", "pink":"#F78CBE", "red":"#FF6E71"]
                    part = "<mark style=\"background-color:\(colors[mark.value ?? "yellow"] ?? "#FFCC45");color:#171B19\">\(part)</mark>"
                case .color:
                    let colors = ["gray":"#A8B0AC", "brown":"#BD8A62", "yellow":"#E9C44C", "orange":"#FF8F4D", "green":"#7DD69E", "blue":"#6EB8FF", "purple":"#B38AFF", "pink":"#F78CBE", "red":"#FF6E71"]
                    if let color = colors[mark.value ?? ""] { part = "<span style=\"color:\(color)\">\(part)</span>" }
                case .link: part = "<a href=\"\(html(mark.value ?? ""))\">\(part)</a>"
                }
            }; result += part
        }
        return result
    }
}
