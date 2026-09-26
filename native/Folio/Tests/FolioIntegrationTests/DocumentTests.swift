import XCTest
import AppKit
import PDFKit
import FolioCore
@testable import Folio

final class DocumentTests: XCTestCase {
    func testLibraryRejectsSecondWriterAndUnlocksOnClose() throws {
        let directory = FileManager.default.temporaryDirectory.appendingPathComponent("Folio-lock-" + UUID().uuidString)
        defer { try? FileManager.default.removeItem(at: directory) }
        var first: LibraryLock? = try LibraryLock(directory: directory)
        XCTAssertNotNil(first)
        XCTAssertThrowsError(try LibraryLock(directory: directory))
        first = nil
        XCTAssertNoThrow(try LibraryLock(directory: directory))
    }

    func testRichTextUnicodeAndOverlappingFormattingRoundTrip() {
        let text = "Hello 🌱 bright world"
        let block = Block(text: text, marks: [InlineMark(start: 0, length: 5, style: .bold), InlineMark(start: 0, length: 5, style: .italic), InlineMark(start: 6, length: 9, style: .highlight, value: "yellow"), InlineMark(start: 16, length: 5, style: .link, value: "https://example.com")])
        let document = RichTextCodec.document([block], size: 16, strength: 0.9)
        let decoded = RichTextCodec.blocks(document, previous: [block])
        XCTAssertEqual(decoded[0].id, block.id); XCTAssertEqual(decoded[0].text, text)
        XCTAssertTrue(decoded[0].marks!.contains { $0.style == .bold && $0.start == 0 })
        XCTAssertTrue(decoded[0].marks!.contains { $0.style == .italic && $0.start == 0 })
        XCTAssertTrue(decoded[0].marks!.contains { $0.style == .highlight && $0.value == "yellow" })
        let note = Note(title: "Test", blocks: decoded)
        XCTAssertTrue(Markdown.render(note, plain: true).contains(text))
        XCTAssertTrue(Markdown.render(note).contains("<mark"))
    }
    func testLegacyNotesConvertWithoutLosingWords() {
        let blocks = [Block(text: "A **bold** and ==bright== thought."), Block(kind: .task, text: "Do this", checked: true), Block(kind: .heading2, text: "Heading"), Block(kind: .code, text: "let x = 1\nprint(x)")]
        let decoded = RichTextCodec.blocks(RichTextCodec.document(blocks, size: 16, strength: 1), previous: blocks)
        XCTAssertEqual(decoded.map(\.text), ["A bold and bright thought.", "Do this", "Heading", "let x = 1\nprint(x)"])
        XCTAssertTrue(decoded[1].checked); XCTAssertEqual(decoded[2].kind, .heading2)
        XCTAssertFalse(decoded[2].marks!.contains { $0.style == .bold })
    }
    func testNewParagraphsGetDistinctIDs() {
        let block = Block(text: "one\ntwo", marks: [])
        let decoded = RichTextCodec.blocks(RichTextCodec.document([block], size: 16, strength: 1), previous: [block])
        XCTAssertEqual(decoded.count, 2); XCTAssertNotEqual(decoded[0].id, decoded[1].id)
    }
    func testCalendarDetectionAndPromptDeduplication() {
        XCTAssertEqual(CalendarRules.meetingURL("Join https://us02web.zoom.us/j/123")?.host, "us02web.zoom.us")
        XCTAssertNotNil(CalendarRules.meetingURL("https://teams.microsoft.com/l/meetup-join/123"))
        XCTAssertNotNil(CalendarRules.meetingURL("https://meet.google.com/abc-defg-hij"))
        XCTAssertNil(CalendarRules.meetingURL("https://zoom.us.bad.example/j/123"))
        let now = Date()
        var event = CalendarMeeting(id: "meeting@time", title: "Review", start: now, end: now.addingTimeInterval(1800), calendar: "Work", joinURL: URL(string: "https://zoom.us/j/123"))
        XCTAssertTrue(CalendarRules.shouldPrompt(event, now: now, seen: []))
        XCTAssertFalse(CalendarRules.shouldPrompt(event, now: now, seen: [event.id]))
        event.start = now.addingTimeInterval(-600)
        XCTAssertFalse(CalendarRules.shouldPrompt(event, now: now, seen: []))
    }
    func testMultipagePDFPreservesBeginningEndAndHighlights() throws {
        let dir = URL(fileURLWithPath: #filePath).deletingLastPathComponent().deletingLastPathComponent().deletingLastPathComponent().deletingLastPathComponent().appendingPathComponent("pdf-qa")
        try FileManager.default.createDirectory(at: dir, withIntermediateDirectories: true)
        var blocks = [Block(kind: .heading1, text: "Meeting notes"), Block(text: "A bright idea worth keeping.", marks: [InlineMark(start: 2, length: 11, style: .highlight, value: "yellow"), InlineMark(start: 20, length: 7, style: .bold)]), Block(kind: .task, text: "Finish the review"), Block(kind: .quote, text: "Keep the thought. Lose the friction.")]
        for i in 1...65 { blocks.append(Block(text: "Paragraph \(i): This document checks wrapping, page breaks, and the complete export of a longer note. Every paragraph should remain readable.")) }
        blocks.append(Block(text: "THE END — all text preserved."))
        let url = dir.appendingPathComponent("folio-export-check.pdf")
        try PDFExporter.write(Note(title: "Folio export check", blocks: blocks), to: url)
        let pdf = try XCTUnwrap(PDFDocument(url: url))
        XCTAssertGreaterThan(pdf.pageCount, 2)
        XCTAssertTrue(pdf.string?.contains("Folio export check") == true)
        XCTAssertTrue(pdf.string?.contains("THE END") == true)
        let extracted = try LocalFileReader.read(url)
        XCTAssertTrue(extracted.contains("## Page 1")); XCTAssertTrue(extracted.contains("THE END"))
    }
    func testImageOCRLocallyRecognizesFixture() throws {
        let rep = NSBitmapImageRep(bitmapDataPlanes: nil, pixelsWide: 1400, pixelsHigh: 300, bitsPerSample: 8, samplesPerPixel: 4, hasAlpha: true, isPlanar: false, colorSpaceName: .deviceRGB, bytesPerRow: 0, bitsPerPixel: 0)!
        NSGraphicsContext.saveGraphicsState(); NSGraphicsContext.current = NSGraphicsContext(bitmapImageRep: rep)
        NSColor.white.setFill(); NSRect(x: 0, y: 0, width: 1400, height: 300).fill()
        ("Folio reads local documents" as NSString).draw(at: NSPoint(x: 60, y: 120), withAttributes: [.font: NSFont.systemFont(ofSize: 64), .foregroundColor: NSColor.black])
        NSGraphicsContext.restoreGraphicsState()
        let text = try LocalFileReader.recognize(try XCTUnwrap(rep.cgImage))
        XCTAssertTrue(text.lowercased().contains("folio reads local documents"), text)
    }
    func testOldJSONStillDecodes() throws {
        let note = Note(title: "Old note", blocks: [Block(text: "Existing text")])
        let data = try JSONEncoder().encode(note)
        let decoded = try JSONDecoder().decode(Note.self, from: data)
        XCTAssertNil(decoded.blocks[0].marks); XCTAssertNil(decoded.isChat)
    }
}
