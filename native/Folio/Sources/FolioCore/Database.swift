import Foundation
import CSQLite

public struct StorageError: LocalizedError { public let message: String; public var errorDescription: String? { message } }
public final class NoteDatabase: @unchecked Sendable {
    private var db: OpaquePointer?
    private let lock = NSRecursiveLock()
    public let directory: URL
    private let encoder = JSONEncoder()
    private let decoder = JSONDecoder()
    private let transient = unsafeBitCast(-1, to: sqlite3_destructor_type.self)
    public init(directory: URL) throws {
        self.directory = directory
        try FileManager.default.createDirectory(at: directory, withIntermediateDirectories: true)
        for name in ["assets", "recordings", "backups"] { try FileManager.default.createDirectory(at: directory.appendingPathComponent(name), withIntermediateDirectories: true) }
        let path = directory.appendingPathComponent("Folio.sqlite").path
        guard sqlite3_open_v2(path, &db, SQLITE_OPEN_CREATE | SQLITE_OPEN_READWRITE | SQLITE_OPEN_FULLMUTEX, nil) == SQLITE_OK else { throw error() }
        sqlite3_busy_timeout(db, 5_000)
        try execute("PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL; PRAGMA foreign_keys=ON;")
        let version = try statement("PRAGMA user_version")
        defer { sqlite3_finalize(version) }
        guard sqlite3_step(version) == SQLITE_ROW, sqlite3_column_int(version, 0) <= 1 else { throw StorageError(message: "This library was created by a newer version of Folio. Please update the app before opening it.") }
        try execute("""
        CREATE TABLE IF NOT EXISTS notes(id TEXT PRIMARY KEY, payload BLOB NOT NULL);
        CREATE VIRTUAL TABLE IF NOT EXISTS search USING fts5(id UNINDEXED, title, body, tags, tokenize='unicode61');
        CREATE TABLE IF NOT EXISTS revisions(id INTEGER PRIMARY KEY AUTOINCREMENT, noteID TEXT NOT NULL, created REAL NOT NULL, payload BLOB NOT NULL);
        CREATE INDEX IF NOT EXISTS revisions_note ON revisions(noteID, created);
        CREATE TABLE IF NOT EXISTS chats(id TEXT PRIMARY KEY, payload BLOB NOT NULL);
        PRAGMA user_version=1;
        """)
    }
    deinit { sqlite3_close(db) }
    private func error() -> StorageError { StorageError(message: db.map { String(cString: sqlite3_errmsg($0)) } ?? "Could not open the note library.") }
    private func execute(_ sql: String) throws { guard sqlite3_exec(db, sql, nil, nil, nil) == SQLITE_OK else { throw error() } }
    private func statement(_ sql: String) throws -> OpaquePointer {
        var stmt: OpaquePointer?
        guard sqlite3_prepare_v2(db, sql, -1, &stmt, nil) == SQLITE_OK, let stmt else { throw error() }
        return stmt
    }
    private func bind(_ s: String, to stmt: OpaquePointer, at: Int32) { sqlite3_bind_text(stmt, at, s, -1, transient) }
    private func bind(_ data: Data, to stmt: OpaquePointer, at: Int32) { _ = data.withUnsafeBytes { sqlite3_bind_blob(stmt, at, $0.baseAddress, Int32(data.count), transient) } }
    private func blob(_ stmt: OpaquePointer, _ column: Int32) -> Data { Data(bytes: sqlite3_column_blob(stmt, column), count: Int(sqlite3_column_bytes(stmt, column))) }
    private func step(_ stmt: OpaquePointer) throws { guard sqlite3_step(stmt) == SQLITE_DONE else { throw error() } }
    public func allNotes() throws -> [Note] {
        lock.lock(); defer { lock.unlock() }
        let stmt = try statement("SELECT payload FROM notes"); defer { sqlite3_finalize(stmt) }
        var notes: [Note] = []; var rc = sqlite3_step(stmt)
        while rc == SQLITE_ROW { notes.append(try decoder.decode(Note.self, from: blob(stmt, 0))); rc = sqlite3_step(stmt) }
        guard rc == SQLITE_DONE else { throw error() }; return notes
    }
    public func save(_ note: Note, forceRevision: Bool = false) throws {
        lock.lock(); defer { lock.unlock() }
        try execute("BEGIN IMMEDIATE")
        do {
            let existing = try statement("SELECT payload FROM notes WHERE id=?"); defer { sqlite3_finalize(existing) }
            bind(note.id.uuidString, to: existing, at: 1)
            if sqlite3_step(existing) == SQLITE_ROW {
                let oldData = blob(existing, 0)
                let latest = try statement("SELECT MAX(created) FROM revisions WHERE noteID=?"); defer { sqlite3_finalize(latest) }
                bind(note.id.uuidString, to: latest, at: 1)
                _ = sqlite3_step(latest)
                let lastDate = sqlite3_column_double(latest, 0)
                if forceRevision || Date().timeIntervalSince1970 - lastDate > 120 {
                    let rev = try statement("INSERT INTO revisions(noteID,created,payload) VALUES(?,?,?)"); defer { sqlite3_finalize(rev) }
                    bind(note.id.uuidString, to: rev, at: 1); sqlite3_bind_double(rev, 2, Date().timeIntervalSince1970); bind(oldData, to: rev, at: 3); try step(rev)
                }
            }
            let stmt = try statement("INSERT INTO notes(id,payload) VALUES(?,?) ON CONFLICT(id) DO UPDATE SET payload=excluded.payload"); defer { sqlite3_finalize(stmt) }
            bind(note.id.uuidString, to: stmt, at: 1); bind(try encoder.encode(note), to: stmt, at: 2); try step(stmt)
            let del = try statement("DELETE FROM search WHERE id=?"); defer { sqlite3_finalize(del) }; bind(note.id.uuidString, to: del, at: 1); try step(del)
            if !note.trashed {
                let index = try statement("INSERT INTO search(id,title,body,tags) VALUES(?,?,?,?)"); defer { sqlite3_finalize(index) }
                for (i,s) in [note.id.uuidString, note.title, note.plainBody, note.tags.joined(separator: " ")].enumerated() { bind(s, to: index, at: Int32(i + 1)) }; try step(index)
            }
            try execute("COMMIT")
        } catch { try? execute("ROLLBACK"); throw error }
    }
    public func search(_ query: String, limit: Int = 100) throws -> [UUID] {
        lock.lock(); defer { lock.unlock() }
        let words = query.components(separatedBy: CharacterSet.alphanumerics.inverted).filter { !$0.isEmpty }.prefix(24)
        guard !words.isEmpty else { return [] }
        let expression = words.map { "\"\($0)\"*" }.joined(separator: " OR ")
        let stmt = try statement("SELECT id FROM search WHERE search MATCH ? ORDER BY bm25(search,0,8,1,3) LIMIT ?"); defer { sqlite3_finalize(stmt) }
        bind(expression, to: stmt, at: 1); sqlite3_bind_int(stmt, 2, Int32(limit))
        var ids: [UUID] = []; var rc = sqlite3_step(stmt)
        while rc == SQLITE_ROW {
            if let c = sqlite3_column_text(stmt, 0), let id = UUID(uuidString: String(cString: c)) { ids.append(id) }; rc = sqlite3_step(stmt)
        }
        guard rc == SQLITE_DONE else { throw error() }; return ids
    }
    public func revisions(for id: UUID) throws -> [Revision] {
        lock.lock(); defer { lock.unlock() }
        let stmt = try statement("SELECT id,created,payload FROM revisions WHERE noteID=? ORDER BY created DESC LIMIT 60"); defer { sqlite3_finalize(stmt) }; bind(id.uuidString, to: stmt, at: 1)
        var result: [Revision] = []
        while sqlite3_step(stmt) == SQLITE_ROW { result.append(Revision(id: sqlite3_column_int64(stmt, 0), date: Date(timeIntervalSince1970: sqlite3_column_double(stmt, 1)), note: try decoder.decode(Note.self, from: blob(stmt, 2)))) }; return result
    }
    public func saveChat(_ messages: [ChatMessage], id: UUID) throws {
        lock.lock(); defer { lock.unlock() }
        let stmt = try statement("INSERT INTO chats(id,payload) VALUES(?,?) ON CONFLICT(id) DO UPDATE SET payload=excluded.payload"); defer { sqlite3_finalize(stmt) }
        bind(id.uuidString, to: stmt, at: 1); bind(try encoder.encode(messages), to: stmt, at: 2); try step(stmt)
    }
    public func chat(id: UUID) throws -> [ChatMessage] {
        lock.lock(); defer { lock.unlock() }
        let stmt = try statement("SELECT payload FROM chats WHERE id=?"); defer { sqlite3_finalize(stmt) }; bind(id.uuidString, to: stmt, at: 1)
        if sqlite3_step(stmt) == SQLITE_ROW { return try decoder.decode([ChatMessage].self, from: blob(stmt, 0)) }; return []
    }
    public func chatNoteIDs() throws -> Set<UUID> {
        lock.lock(); defer { lock.unlock() }
        let stmt = try statement("SELECT id,payload FROM chats"); defer { sqlite3_finalize(stmt) }
        var ids: Set<UUID> = []
        while sqlite3_step(stmt) == SQLITE_ROW {
            if let value = sqlite3_column_text(stmt, 0), let id = UUID(uuidString: String(cString: value)), !(try decoder.decode([ChatMessage].self, from: blob(stmt, 1))).isEmpty { ids.insert(id) }
        }
        return ids
    }
    public func backup(to url: URL) throws {
        lock.lock(); defer { lock.unlock() }
        var destination: OpaquePointer?
        guard sqlite3_open(url.path, &destination) == SQLITE_OK else { sqlite3_close(destination); throw StorageError(message: "Could not create the backup.") }
        defer { sqlite3_close(destination) }
        guard let backup = sqlite3_backup_init(destination, "main", db, "main") else { throw error() }
        let result = sqlite3_backup_step(backup, -1); let finish = sqlite3_backup_finish(backup)
        guard result == SQLITE_DONE && finish == SQLITE_OK else { throw StorageError(message: "The backup could not be completed.") }
    }
    public func exportLibrary(to directory: URL, plain: Bool = false) throws {
        let fm = FileManager.default
        try fm.createDirectory(at: directory, withIntermediateDirectories: true)
        let notes = try allNotes().filter { !$0.trashed }
        for note in notes {
            var body = Markdown.render(note, plain: plain)
            if !plain { for linked in notes { let filename = (Markdown.filename(linked) + ".md").addingPercentEncoding(withAllowedCharacters: .urlPathAllowed) ?? ""; body = body.replacingOccurrences(of: "folio://note/" + linked.id.uuidString, with: filename) } }
            try body.write(to: directory.appendingPathComponent(Markdown.filename(note) + (plain ? ".txt" : ".md")), atomically: true, encoding: .utf8)
        }
        let manifest = encoder; manifest.outputFormatting = [.prettyPrinted, .sortedKeys]
        try manifest.encode(notes).write(to: directory.appendingPathComponent("Folio-library.json"), options: .atomic)
        let target = directory.appendingPathComponent("assets")
        if !fm.fileExists(atPath: target.path) { try fm.copyItem(at: self.directory.appendingPathComponent("assets"), to: target) }
    }
}
