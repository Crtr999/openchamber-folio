import XCTest
@testable import FolioCore

final class LibraryTests: XCTestCase {
    func temporary() throws -> URL { let url = FileManager.default.temporaryDirectory.appendingPathComponent("Folio-tests-\(UUID())"); try FileManager.default.createDirectory(at: url, withIntermediateDirectories: true); return url }
    func testSaveReopenSearchAndTrash() throws {
        let dir = try temporary(); defer { try? FileManager.default.removeItem(at: dir) }
        let note = Note(title: "Project apricot", blocks: [Block(text: "The café deadline is Friday.", highlight: .yellow)], tags: ["launch"])
        do { let db = try NoteDatabase(directory: dir); try db.save(note); XCTAssertEqual(try db.search("apri"), [note.id]); XCTAssertEqual(try db.search("cafe"), [note.id]); XCTAssertEqual(try db.search("launch"), [note.id]); XCTAssertEqual(try db.search("\" OR * - ()"), []) }
        let reopened = try NoteDatabase(directory: dir)
        XCTAssertEqual(try reopened.allNotes(), [note])
        var changed = note; changed.blocks[0].text = "Now Monday"; try reopened.save(changed, forceRevision: true)
        XCTAssertEqual(try reopened.revisions(for: note.id).first?.note, note)
        XCTAssertEqual(try reopened.search("Friday"), [])
        changed.trashed = true; try reopened.save(changed)
        XCTAssertEqual(try reopened.search("apricot"), [])
        XCTAssertEqual(try reopened.allNotes().count, 1)
    }
    func testWALBackupRestoresCommittedNotesAndChats() throws {
        let dir = try temporary(); let restored = try temporary(); defer { try? FileManager.default.removeItem(at: dir); try? FileManager.default.removeItem(at: restored) }
        let db = try NoteDatabase(directory: dir)
        let note = Note(title: "Persist me", blocks: [Block(text: "Long-lived thought")]); try db.save(note)
        try db.saveChat([ChatMessage(role: "user", content: "What did I write?", sourceIDs: [note.id])], id: note.id)
        try db.backup(to: restored.appendingPathComponent("Folio.sqlite"))
        let backup = try NoteDatabase(directory: restored)
        XCTAssertEqual(try backup.allNotes(), [note]); XCTAssertEqual(try backup.chat(id: note.id).first?.sourceIDs, [note.id])
    }
    func testLongTranscriptChunkingPreservesEveryCharacter() {
        let text = String(repeating: "[10:32] You: café 🌿 action item.\n", count: 3000)
        let chunks = TranscriptChunker.split(text, limit: 18_000)
        XCTAssertGreaterThan(chunks.count, 1)
        XCTAssertTrue(chunks.allSatisfy { $0.count <= 18_000 })
        XCTAssertEqual(chunks.joined(), text)
        XCTAssertTrue(TranscriptChunker.split("", limit: 100).isEmpty)
    }
    func testMarkdownUnicodeTasksAndFences() throws {
        let raw = "# Trip ✨\n\n## Plan\n\n- [x] Book train\n\n- [ ] Pack\n\n```swift\nlet x = 1\n```\n\nA ==bright idea==."
        let note = Markdown.parse(raw)
        XCTAssertEqual(note.title, "Trip ✨"); XCTAssertEqual(note.blocks.count, 5); XCTAssertEqual(note.blocks[1].checked, true)
        let exported = Markdown.render(note); let restored = Markdown.parse(exported)
        XCTAssertEqual(restored.blocks.map(\.text), note.blocks.map(\.text)); XCTAssertEqual(restored.blocks.map(\.kind), note.blocks.map(\.kind))
        XCTAssertTrue(Markdown.render(note, plain: true).contains("A bright idea."))
        let fenced = Note(title: "Code", blocks: [Block(kind: .code, text: "```embedded```\nmore")])
        XCTAssertEqual(Markdown.parse(Markdown.render(fenced)).blocks[0].text, fenced.blocks[0].text)
    }
    func testContextCannotIncludeExcludedOrTrashedNotes() {
        let privateNote = Note(title: "Secret", blocks: [Block(text: "PRIVATE_SENTINEL")], excludedFromAI: true)
        let trashed = Note(title: "Deleted", blocks: [Block(text: "DELETED_SENTINEL")], trashed: true)
        let allowed = Note(title: "Public", blocks: [Block(text: String(repeating: "Allowed. ", count: 100))])
        let result = ContextBuilder.build(notes: [privateNote, allowed, trashed], limit: 300)
        XCTAssertEqual(result.ids, [allowed.id]); XCTAssertFalse(result.text.contains("PRIVATE_SENTINEL")); XCTAssertFalse(result.text.contains("DELETED_SENTINEL")); XCTAssertLessThanOrEqual(result.text.count, 300); XCTAssertTrue(result.text.contains("truncated"))
    }
    func testExportKeepsAssetsAndExactBlockMetadata() throws {
        let dir = try temporary(); let output = try temporary(); defer { try? FileManager.default.removeItem(at: dir); try? FileManager.default.removeItem(at: output) }
        let db = try NoteDatabase(directory: dir)
        try Data("asset".utf8).write(to: dir.appendingPathComponent("assets/example.txt"))
        let note = Note(title: "Unsafe / name: test", blocks: [Block(kind: .callout, text: "Keep color", highlight: .pink), Block(kind: .attachment, text: "example", asset: "assets/example.txt")])
        try db.save(note); try db.exportLibrary(to: output)
        let restored = try JSONDecoder().decode([Note].self, from: Data(contentsOf: output.appendingPathComponent("Folio-library.json")))
        XCTAssertEqual(restored, [note]); XCTAssertTrue(FileManager.default.fileExists(atPath: output.appendingPathComponent("assets/example.txt").path)); XCTAssertFalse(Markdown.filename(note).contains("/"))
    }
    func testRetrievalAcrossThousandNotes() throws {
        let dir = try temporary(); defer { try? FileManager.default.removeItem(at: dir) }
        let db = try NoteDatabase(directory: dir); var expected: UUID?
        for i in 0..<1000 {
            let note = Note(title: "Note \(i)", blocks: [Block(text: i == 517 ? "The distinctive kumquat decision" : "Ordinary meeting notes and project plans")])
            if i == 517 { expected = note.id }; try db.save(note)
        }
        let start = Date(); let result = try db.search("kumquat"); let elapsed = Date().timeIntervalSince(start)
        XCTAssertEqual(result, [expected!]); print("FOLIO_SEARCH_1000_NOTES_MS=\(elapsed * 1000)")
    }
}
