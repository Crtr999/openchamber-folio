import AppKit
import CoreText
import FolioCore

enum PDFExporter {
    static func write(_ note: Note, to url: URL) throws {
        let titleStyle = NSMutableParagraphStyle(); titleStyle.paragraphSpacing = 16
        let content = NSMutableAttributedString(string: note.displayTitle + "\n", attributes: [.font: NSFont.systemFont(ofSize: 24, weight: .bold), .foregroundColor: NSColor.black, .paragraphStyle: titleStyle])
        content.append(RichTextCodec.document(note.blocks, size: 11, strength: 0.7, light: true))
        // Embed standard, stable font faces for readers that cannot reproduce macOS UI variable fonts.
        content.enumerateAttribute(.font, in: NSRange(location: 0, length: content.length)) { value, range, _ in
            guard let font = value as? NSFont else { return }
            let traits = NSFontManager.shared.traits(of: font)
            let mono = traits.contains(.fixedPitchFontMask)
            let bold = traits.contains(.boldFontMask); let italic = traits.contains(.italicFontMask)
            let name = mono ? "Courier" + (bold && italic ? "-BoldOblique" : bold ? "-Bold" : italic ? "-Oblique" : "") : "Helvetica" + (bold && italic ? "-BoldOblique" : bold ? "-Bold" : italic ? "-Oblique" : "")
            content.addAttribute(.font, value: NSFont(name: name, size: font.pointSize) ?? font, range: range)
        }
        // Strip app-only attributes.
        let all = NSRange(location: 0, length: content.length)
        for key in [NSAttributedString.Key.folioID, .folioKind, .folioCode, .folioBold, .folioHighlight] { content.removeAttribute(key, range: all) }
        var mediaBox = CGRect(x: 0, y: 0, width: 612, height: 792)
        let data = NSMutableData()
        guard let consumer = CGDataConsumer(data: data as CFMutableData), let context = CGContext(consumer: consumer, mediaBox: &mediaBox, [kCGPDFContextTitle as String: note.displayTitle] as CFDictionary) else { throw AppError(message: "Could not create the PDF.") }
        let framesetter = CTFramesetterCreateWithAttributedString(content)
        let path = CGPath(rect: CGRect(x: 46, y: 48, width: 520, height: 692), transform: nil)
        var cursor = 0; var page = 0
        while cursor < content.length {
            context.beginPDFPage(nil); context.saveGState(); context.textMatrix = .identity; context.textPosition = .zero; page += 1
            let frame = CTFramesetterCreateFrame(framesetter, CFRange(location: cursor, length: 0), path, nil)
            let visible = CTFrameGetVisibleStringRange(frame)
            guard visible.length > 0 else { context.endPDFPage(); throw AppError(message: "A paragraph could not fit into the PDF page.") }
            let lines = CTFrameGetLines(frame) as! [CTLine]
            var origins = Array(repeating: CGPoint.zero, count: lines.count)
            CTFrameGetLineOrigins(frame, CFRange(location: 0, length: 0), &origins)
            for (i, line) in lines.enumerated() {
                for run in CTLineGetGlyphRuns(line) as! [CTRun] {
                    let attrs = CTRunGetAttributes(run) as NSDictionary
                    guard let color = attrs[NSAttributedString.Key.backgroundColor] as? NSColor, let cg = color.usingColorSpace(.deviceRGB)?.cgColor else { continue }
                    var ascent: CGFloat = 0; var descent: CGFloat = 0
                    let width = CTRunGetTypographicBounds(run, CFRange(location: 0, length: 0), &ascent, &descent, nil)
                    let offset = CTLineGetOffsetForStringIndex(line, CTRunGetStringRange(run).location, nil)
                    context.setFillColor(cg); context.fill(CGRect(x: 46 + origins[i].x + offset - 1, y: 48 + origins[i].y - descent - 2, width: width + 2, height: ascent + descent + 4))
                }
            }
            context.textMatrix = .identity; context.textPosition = .zero; CTFrameDraw(frame, context)
            let footer = CTLineCreateWithAttributedString(NSAttributedString(string: "\(page)", attributes: [.font: NSFont.systemFont(ofSize: 9), .foregroundColor: NSColor.gray]))
            context.textPosition = CGPoint(x: 302, y: 25); CTLineDraw(footer, context)
            context.restoreGState(); context.endPDFPage(); cursor += visible.length
        }
        context.closePDF(); try (data as Data).write(to: url, options: .atomic)
    }
}
extension AppModel {
    func exportPDF() {
        guard let note = exportNote else { return }; flush()
        let panel = NSSavePanel(); panel.allowedContentTypes = [.pdf]; panel.nameFieldStringValue = Markdown.filename(note) + ".pdf"
        guard panel.runModal() == .OK, let url = panel.url else { return }
        do { try PDFExporter.write(note, to: url); status = "Exported \(url.lastPathComponent)" } catch { self.error = error.localizedDescription }
    }
}
