import AppKit
import SwiftUI
import UniformTypeIdentifiers
import FolioCore

@MainActor final class AppModel: ObservableObject {
    @Published var chatIDs: Set<UUID> = []
    @Published var home = false
    @Published var aiSelection = ""
    @Published var importing = false
    @Published var importProgress = ""
    var importTask: Task<Void, Never>?
    @Published var notes: [Note] = []
    @Published var selectedID: UUID?
    @Published var filter = "all"
    @Published var query = ""
    @Published var searchIDs: [UUID] = []
    @Published var showAI = true
    @Published var showSettings = false
    @Published var showHistory = false
    @Published var showMeeting = false
    @Published var error: String?
    @Published var status = "All changes saved"
    @Published var focusedBlock: UUID?
    @Published var startupError: String?
    let preferences = Preferences()
    private var libraryLock: LibraryLock?
    var database: NoteDatabase?
    var pending: [UUID: Note] = [:]
    private var saveWork: DispatchWorkItem?
    var selectedNote: Note? { notes.first { $0.id == selectedID } }
    var exportNote: Note? {
        guard var note = selectedNote else { return nil }
        if note.isChat == true, let messages = try? database?.chat(id: note.id) {
            note.blocks = messages.flatMap { [Block(kind: .heading2, text: $0.role == "user" ? "You" : "Assistant")] + Markdown.parse($0.content, title: "", extractTitle: false).blocks }
        }
        return note
    }
    var library: URL {
        if let database { return database.directory }
        return FileManager.default.urls(for: .applicationSupportDirectory, in: .userDomainMask)[0].appendingPathComponent("Folio")
    }
    init() {
        do {
            var directory = FileManager.default.urls(for: .applicationSupportDirectory, in: .userDomainMask)[0].appendingPathComponent("Folio")
            if let path = ProcessInfo.processInfo.environment["FOLIO_LIBRARY_PATH"], !path.isEmpty { directory = URL(fileURLWithPath: path).standardizedFileURL }
            if let i = CommandLine.arguments.firstIndex(of: "--library"), CommandLine.arguments.count > i + 1 { directory = URL(fileURLWithPath: CommandLine.arguments[i+1]) }
            libraryLock = try LibraryLock(directory: directory)
            let db = try NoteDatabase(directory: directory); database = db; notes = try db.allNotes().sorted { $0.modified > $1.modified }
            if notes.isEmpty { for note in Self.welcomeNotes { try db.save(note) }; notes = Self.welcomeNotes }
            chatIDs = try db.chatNoteIDs()
            let saved = UserDefaults.standard.string(forKey: "selectedNote").flatMap(UUID.init(uuidString:))
            selectedID = notes.first { $0.id == saved && !$0.trashed }?.id ?? notes.first { !$0.trashed }?.id
            try dailyBackup()
        } catch { startupError = error.localizedDescription }
    }
    var visibleNotes: [Note] {
        var list = notes.filter { filter == "trash" ? $0.trashed : !$0.trashed }
        if filter == "favorites" { list = list.filter(\.favorite) }
        if filter == "chats" { list = list.filter { $0.isChat == true || chatIDs.contains($0.id) } }
        if filter == "pages" { list = list.filter { !$0.isMeeting && $0.isChat != true } }
        if filter == "meetings" { list = list.filter(\.isMeeting) }
        if filter.hasPrefix("tag:") { list = list.filter { $0.tags.contains(String(filter.dropFirst(4))) } }
        if !query.isEmpty {
            if filter == "trash" { return list.filter { $0.title.localizedCaseInsensitiveContains(query) || $0.plainBody.localizedCaseInsensitiveContains(query) } }
            let ranks = Dictionary(uniqueKeysWithValues: searchIDs.enumerated().map { ($0.element, $0.offset) })
            list = list.filter { ranks[$0.id] != nil }.sorted { ranks[$0.id, default: 0] < ranks[$1.id, default: 0] }
        }
        return list
    }
    var tags: [String] { Array(Set(notes.filter { !$0.trashed }.flatMap(\.tags))).sorted() }
    func select(_ id: UUID) { home = false; flush(); selectedID = id; focusedBlock = nil; UserDefaults.standard.set(id.uuidString, forKey: "selectedNote") }
    func search() { flush(); do { searchIDs = try database?.search(query) ?? [] } catch { self.error = error.localizedDescription } }
    func edit(_ id: UUID, _ change: (inout Note) -> Void, checkpoint: Bool = false) {
        guard let index = notes.firstIndex(where: { $0.id == id }) else { return }
        if checkpoint {
            flush()
            let previous = notes[index]
            NSApp.keyWindow?.undoManager?.registerUndo(withTarget: self) { target in target.edit(id, { $0 = previous }, checkpoint: true) }
            NSApp.keyWindow?.undoManager?.setActionName("Change note")
        }
        change(&notes[index]); notes[index].modified = Date()
        if checkpoint {
            do { try database?.save(notes[index], forceRevision: true); status = "All changes saved" } catch { pending[id] = notes[index]; self.error = error.localizedDescription; status = "Save failed — retry needed" }
        } else {
            pending[id] = notes[index]; status = "Saving…"; saveWork?.cancel()
            let work = DispatchWorkItem { [weak self] in self?.flush() }; saveWork = work; DispatchQueue.main.asyncAfter(deadline: .now() + 0.3, execute: work)
        }
    }
    func editBlock(noteID: UUID, blockID: UUID, _ change: (inout Block) -> Void) { edit(noteID) { note in if let i = note.blocks.firstIndex(where: { $0.id == blockID }) { change(&note.blocks[i]) } } }
    func flush() {
        saveWork?.cancel()
        do {
            for (id, note) in pending { try database?.save(note); pending.removeValue(forKey: id) }
            status = "All changes saved"
        } catch { self.error = error.localizedDescription; status = "Save failed — retry needed" }
    }
    @discardableResult func create(title: String = "", parent: UUID? = nil, meeting: Bool = false, blocks: [Block]? = nil) -> UUID {
        flush()
        let note = Note(title: title, icon: meeting ? "waveform" : "doc.text", parentID: parent, blocks: blocks ?? [Block()], isMeeting: meeting)
        do { try database?.save(note); notes.insert(note, at: 0); filter = "all"; query = ""; select(note.id) } catch { self.error = error.localizedDescription }
        return note.id
    }
    @discardableResult func createLibraryTable(parent: UUID? = nil) -> UUID {
        flush()
        let note = Note(title: "Library", icon: "books.vertical", parentID: parent, blocks: [], table: .library)
        do { try database?.save(note); notes.insert(note, at: 0); filter = "all"; query = ""; select(note.id) }
        catch { self.error = error.localizedDescription }
        return note.id
    }
    @discardableResult func createTable(parent: UUID? = nil) -> UUID {
        flush()
        let note = Note(title: "Untitled database", icon: "tablecells", parentID: parent, blocks: [], table: NoteTable(columns: [DatabaseColumn(name: "Name", kind: .title), DatabaseColumn(name: "Status", kind: .status, options: ["Not started", "In progress", "Done"])]))
        do { try database?.save(note); notes.insert(note, at: 0); filter = "all"; query = ""; select(note.id) }
        catch { self.error = error.localizedDescription }
        return note.id
    }
    @discardableResult func createLinkedSubpage(title: String, parent: UUID) -> UUID {
        flush()
        let note = Note(title: title.isEmpty ? "Untitled" : title, parentID: parent)
        do { try database?.save(note); notes.insert(note, at: 0) }
        catch { self.error = error.localizedDescription }
        return note.id
    }
    func importTableCSV(into noteID: UUID) {
        let panel = NSOpenPanel(); panel.allowedContentTypes = [.commaSeparatedText, .plainText]; panel.allowsMultipleSelection = false
        panel.message = "Choose a CSV exported from Notion. The first row becomes column names."
        guard panel.runModal() == .OK, let url = panel.url else { return }
        do {
            let matrix = Self.parseCSV(try String(contentsOf: url, encoding: .utf8))
            guard let header = matrix.first, !header.isEmpty else { throw AppError(message: "This CSV does not contain a header row.") }
            let columns = header.enumerated().map { i, name in DatabaseColumn(name: name.isEmpty ? "Column \(i + 1)" : name, kind: i == 0 ? .title : .text) }
            let rows = matrix.dropFirst().filter { !$0.allSatisfy(\.isEmpty) }.map { values in
                DatabaseRow(values: Dictionary(uniqueKeysWithValues: columns.enumerated().map { index, column in (column.id, values.indices.contains(index) ? values[index] : "") }))
            }
            edit(noteID, { $0.table = NoteTable(columns: columns, rows: rows) }, checkpoint: true)
            status = "Imported \(rows.count) rows from CSV"
        } catch { self.error = error.localizedDescription }
    }
    func exportTableCSV(_ note: Note) {
        guard let table = note.table else { return }
        let panel = NSSavePanel(); panel.nameFieldStringValue = note.displayTitle + ".csv"; panel.allowedContentTypes = [.commaSeparatedText]
        guard panel.runModal() == .OK, let url = panel.url else { return }
        let rows = [table.columns.map(\.name)] + table.rows.map { row in table.columns.map { row.values[$0.id, default: ""] } }
        let csv = rows.map { row in row.map { value in "\"" + value.replacingOccurrences(of: "\"", with: "\"\"") + "\"" }.joined(separator: ",") }.joined(separator: "\n") + "\n"
        do { try csv.write(to: url, atomically: true, encoding: .utf8); status = "CSV exported" } catch { self.error = error.localizedDescription }
    }
    private static func parseCSV(_ text: String) -> [[String]] {
        var rows: [[String]] = [], row: [String] = [], cell = "", quoted = false
        let chars = Array(text); var index = 0
        while index < chars.count {
            let char = chars[index]
            if char == "\"" {
                if quoted && index + 1 < chars.count && chars[index + 1] == "\"" { cell.append("\""); index += 1 }
                else { quoted.toggle() }
            } else if char == "," && !quoted { row.append(cell); cell = "" }
            else if (char == "\n" || char == "\r") && !quoted {
                if char == "\r", index + 1 < chars.count, chars[index + 1] == "\n" { index += 1 }
                row.append(cell); rows.append(row); row = []; cell = ""
            } else { cell.append(char) }
            index += 1
        }
        if !cell.isEmpty || !row.isEmpty { row.append(cell); rows.append(row) }
        return rows
    }
    func addBlock(after blockID: UUID? = nil, kind: BlockKind = .text, text: String = "") {
        guard let id = selectedID else { return }; let b = Block(kind: kind, text: text)
        edit(id) { note in let i = blockID.flatMap { id in note.blocks.firstIndex { $0.id == id }.map { $0 + 1 } } ?? note.blocks.count; note.blocks.insert(b, at: i) }; focusedBlock = b.id
    }
    func moveBlock(_ blockID: UUID, to targetID: UUID) {
        guard let id = selectedID else { return }
        edit(id, { note in
            guard let source = note.blocks.firstIndex(where: { $0.id == blockID }), let target = note.blocks.firstIndex(where: { $0.id == targetID }), source != target else { return }
            let value = note.blocks.remove(at: source); note.blocks.insert(value, at: min(target, note.blocks.count))
        }, checkpoint: true)
    }
    func shiftBlock(_ blockID: UUID, by delta: Int) {
        guard let note = selectedNote, let index = note.blocks.firstIndex(where: { $0.id == blockID }), note.blocks.indices.contains(index + delta) else { return }
        moveBlock(blockID, to: note.blocks[index + delta].id)
    }
    func removeBlock(_ blockID: UUID) {
        guard let id = selectedID else { return }
        edit(id, { note in note.blocks.removeAll { $0.id == blockID }; if note.blocks.isEmpty { note.blocks = [Block()] } }, checkpoint: true)
    }
    func trash(_ id: UUID, restore: Bool = false) { edit(id, { $0.trashed = !restore }, checkpoint: true); if !restore && selectedID == id { selectedID = notes.first { !$0.trashed && $0.id != id }?.id } }
    func duplicate(_ note: Note) { var blocks = note.blocks; for i in blocks.indices { blocks[i].id = UUID() }; _ = create(title: note.displayTitle + " copy", blocks: blocks) }
    func setParent(_ parent: UUID?, for id: UUID) {
        var current = parent; var seen: Set<UUID> = []
        while let node = current { if node == id || !seen.insert(node).inserted { return }; current = notes.first { $0.id == node }?.parentID }
        edit(id) { $0.parentID = parent }
    }
    func appendAI(_ text: String, noteID: UUID, replace: Bool = false) {
        let parsed = Markdown.parse(text, title: "AI draft", extractTitle: false)
        edit(noteID, { note in if replace { note.blocks = parsed.blocks } else { note.blocks.append(Block(kind: .divider)); note.blocks += parsed.blocks } }, checkpoint: true)
    }
    func importNotes() {
        let panel = NSOpenPanel(); panel.allowedContentTypes = [.plainText, .json]; panel.allowsMultipleSelection = true; panel.message = "Import Markdown, TXT, or a Folio-library.json export."
        guard panel.runModal() == .OK else { return }
        do {
            for url in panel.urls {
                var imported: [Note]
                if url.pathExtension.lowercased() == "json" { imported = try JSONDecoder().decode([Note].self, from: Data(contentsOf: url)) }
                else { imported = [Markdown.parse(try String(contentsOf: url, encoding: .utf8), title: url.deletingPathExtension().lastPathComponent)] }
                var mapping: [UUID: UUID] = [:]
                for note in imported { if mapping[note.id] != nil { throw AppError(message: "This import contains duplicate note IDs.") }; mapping[note.id] = UUID() }
                for var note in imported {
                    note.id = mapping[note.id]!; note.parentID = note.parentID.flatMap { mapping[$0] }; note.trashed = false
                    for i in note.blocks.indices {
                        note.blocks[i].id = UUID()
                        for (oldID, newID) in mapping {
                            note.blocks[i].text = note.blocks[i].text.replacingOccurrences(of: "folio://note/" + oldID.uuidString, with: "folio://note/" + newID.uuidString)
                            if var marks = note.blocks[i].marks { for j in marks.indices where marks[j].style == .link { marks[j].value = marks[j].value?.replacingOccurrences(of: "folio://note/" + oldID.uuidString, with: "folio://note/" + newID.uuidString) }; note.blocks[i].marks = marks }
                        }
                        if let asset = note.blocks[i].asset {
                            let source = url.deletingLastPathComponent().appendingPathComponent(asset).standardizedFileURL
                            let root = url.deletingLastPathComponent().standardizedFileURL.path + "/"
                            if source.resolvingSymlinksInPath().path.hasPrefix(root), FileManager.default.fileExists(atPath: source.path) { note.blocks[i].asset = try copyAsset(source) }
                            else { note.blocks[i].asset = nil }
                        }
                    }
                    try database?.save(note); notes.insert(note, at: 0); selectedID = note.id
                }
            }; filter = "all"; status = "Notes imported"
        } catch { self.error = "Import stopped: \(error.localizedDescription)" }
    }
    func exportSelected(plain: Bool) {
        guard let note = exportNote else { return }; flush()
        let panel = NSSavePanel(); panel.nameFieldStringValue = Markdown.filename(note) + (plain ? ".txt" : ".md"); panel.canCreateDirectories = true
        guard panel.runModal() == .OK, let url = panel.url else { return }
        do {
            if !plain {
                let assets = note.blocks.compactMap(\.asset)
                for asset in assets {
                    let destination = url.deletingLastPathComponent().appendingPathComponent(asset)
                    try FileManager.default.createDirectory(at: destination.deletingLastPathComponent(), withIntermediateDirectories: true)
                    if !FileManager.default.fileExists(atPath: destination.path) { try FileManager.default.copyItem(at: library.appendingPathComponent(asset), to: destination) }
                }
            }
            try Markdown.render(note, plain: plain).write(to: url, atomically: true, encoding: .utf8); status = "Exported \(url.lastPathComponent)"
        } catch { self.error = error.localizedDescription }
    }
    func exportLibrary(plain: Bool = false) {
        flush(); let panel = NSOpenPanel(); panel.canChooseDirectories = true; panel.canChooseFiles = false; panel.canCreateDirectories = true; panel.prompt = "Export here"
        guard panel.runModal() == .OK, let url = panel.url else { return }
        do {
            let directory = url.appendingPathComponent("Folio export \(Self.fileDate())-\(UUID().uuidString.prefix(4))")
            try database?.exportLibrary(to: directory, plain: plain); NSWorkspace.shared.activateFileViewerSelecting([directory])
        } catch { self.error = error.localizedDescription }
    }
    func attachFile() {
        guard let id = selectedID else { return }; let panel = NSOpenPanel(); panel.allowsMultipleSelection = true
        guard panel.runModal() == .OK else { return }
        do { for url in panel.urls { let asset = try copyAsset(url); edit(id) { $0.blocks.append(Block(kind: .attachment, text: url.lastPathComponent, asset: asset)) } } } catch { self.error = error.localizedDescription }
    }
    func copyAsset(_ url: URL) throws -> String {
        let name = UUID().uuidString + (url.pathExtension.isEmpty ? "" : "." + url.pathExtension)
        let relative = "assets/" + name; try FileManager.default.copyItem(at: url, to: library.appendingPathComponent(relative)); return relative
    }
    func dailyBackup() throws {
        guard let database else { return }
        let path = library.appendingPathComponent("backups/\(Self.fileDate()).sqlite")
        if !FileManager.default.fileExists(atPath: path.path) { try database.backup(to: path) }
    }
    static func fileDate() -> String { let f = DateFormatter(); f.dateFormat = "yyyy-MM-dd"; return f.string(from: Date()) }
    static let welcomeNotes: [Note] = {
        let welcome = Note(title: "A little space for everything.", icon: "sparkle", blocks: [
            Block(kind: .callout, text: "Your notes live on this Mac. Your ideas stay yours.", highlight: .green),
            Block(text: "Welcome to Folio. A quiet place to think, connect ideas, and turn conversations into something worth keeping."),
            Block(kind: .heading2, text: "Make yourself at home"),
            Block(text: "Write naturally. Use **bold**, `code`, and ==a highlight you can actually see==. Select text and press ⌘⇧H to highlight it."),
            Block(kind: .task, text: "Create your first note with ⌘N"),
            Block(kind: .task, text: "Add your own API key and model in Settings"),
            Block(kind: .task, text: "Start a meeting when you’re ready"),
            Block(kind: .heading2, text: "A notebook that thinks with you"),
            Block(text: "Open the assistant to ask questions about this page or search your library. Every answer can become a new note, or a draft you review before applying."),
            Block(kind: .quote, text: "Keep the thought. Lose the friction."),
            Block(kind: .divider),
            Block(text: "Click into the page and write. Type / for paragraph styles, or select text for formatting and paragraph movement. Export as Markdown, plain text, or PDF from the page toolbar.")
        ], tags: ["getting-started"], favorite: true)
        let meeting = Note(title: "Better meeting notes", icon: "waveform", blocks: [
            Block(kind: .heading2, text: "Before the conversation"),
            Block(text: "Write an agenda here. Folio can capture your microphone and audio playing on your Mac, including calls through headphones."),
            Block(kind: .callout, text: "Recording is always started by you. Let everyone know before you begin.", highlight: .yellow),
            Block(kind: .heading2, text: "After the conversation"),
            Block(text: "Stop recording, then transcribe with your own API key. Audio is saved locally in short segments so you can retry a failed upload. You can review the transcript before asking the assistant for a summary."),
            Block(kind: .bullet, text: "Capture decisions and action items"),
            Block(kind: .bullet, text: "Keep microphone and call-audio labels separate"),
            Block(kind: .bullet, text: "Turn a summary into a new note or add it to this one")
        ], tags: ["getting-started"], isMeeting: true)
        return [welcome, meeting]
    }()
}
