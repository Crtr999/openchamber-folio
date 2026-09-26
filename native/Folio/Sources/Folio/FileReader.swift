import AppKit
import PDFKit
import Vision
import UniformTypeIdentifiers
import FolioCore

enum LocalFileReader {
    static func read(_ url: URL, forceOCR: Bool = false, progress: @escaping @Sendable (String) -> Void = { _ in }) throws -> String {
        try Task.checkCancellation()
        let ext = url.pathExtension.lowercased()
        if ext == "pdf" {
            guard let pdf = PDFDocument(url: url), !pdf.isLocked else { throw AppError(message: "This PDF could not be opened or requires a password.") }
            var pages: [String] = []
            for index in 0..<pdf.pageCount {
                try Task.checkCancellation(); progress("Reading page \(index + 1) of \(pdf.pageCount)…")
                guard let page = pdf.page(at: index) else { continue }
                let existing = page.string?.trimmingCharacters(in: .whitespacesAndNewlines) ?? ""
                let text: String
                if !forceOCR && existing.count >= 10 { text = existing }
                else {
                    let bounds = page.bounds(for: .mediaBox)
                    let scale = min(3, 2400 / max(bounds.width, bounds.height))
                    let image = page.thumbnail(of: NSSize(width: bounds.width * scale, height: bounds.height * scale), for: .mediaBox)
                    guard let cg = image.cgImage(forProposedRect: nil, context: nil, hints: nil) else { throw AppError(message: "Could not render PDF page \(index + 1).") }
                    text = try recognize(cg)
                }
                pages.append("## Page \(index + 1)\n\n" + (text.isEmpty ? "[No readable text found on this page.]" : text))
            }
            return pages.joined(separator: "\n\n")
        }
        if ["png", "jpg", "jpeg", "heic", "tiff", "tif", "bmp", "webp"].contains(ext) {
            let request = VNRecognizeTextRequest(); request.recognitionLevel = .accurate; request.usesLanguageCorrection = true; request.automaticallyDetectsLanguage = true
            try VNImageRequestHandler(url: url).perform([request]); try Task.checkCancellation()
            return (request.results ?? []).compactMap { $0.topCandidates(1).first?.string }.joined(separator: "\n")
        }
        if ["rtf", "rtfd", "docx", "doc", "odt"].contains(ext) {
            return try NSAttributedString(url: url, options: [:], documentAttributes: nil).string
        }
        let data = try Data(contentsOf: url)
        if let value = String(data: data, encoding: .utf8) { return value }
        if data.starts(with: [0xff, 0xfe]) || data.starts(with: [0xfe, 0xff]), let value = String(data: data, encoding: .utf16) { return value }
        throw AppError(message: "Unsupported text encoding or document format for \(url.lastPathComponent). Choose a PDF, image, Word/RTF, Markdown, or UTF-8 text file.")
    }
    static func recognize(_ image: CGImage) throws -> String {
        let request = VNRecognizeTextRequest(); request.recognitionLevel = .accurate; request.usesLanguageCorrection = true; request.automaticallyDetectsLanguage = true
        try VNImageRequestHandler(cgImage: image).perform([request]); try Task.checkCancellation()
        return (request.results ?? []).compactMap { $0.topCandidates(1).first?.string }.joined(separator: "\n")
    }
}
extension AppModel {
    func readFiles(forceOCR: Bool = false) {
        guard !importing else { return }
        let panel = NSOpenPanel(); panel.allowsMultipleSelection = true
        panel.allowedContentTypes = [.pdf, .image, .plainText, .rtf, .rtfd, UTType(filenameExtension: "docx")!, UTType(filenameExtension: "doc")!, UTType(filenameExtension: "odt")!]
        panel.message = forceOCR ? "Recognize text on every PDF page, including text inside images." : "Read local documents into searchable notes. Scanned PDFs and images use on-device OCR."
        guard panel.runModal() == .OK else { return }
        let urls = panel.urls; importing = true
        importTask = Task {
            defer { importing = false; importProgress = ""; importTask = nil }
            do {
                for url in urls {
                    try Task.checkCancellation(); importProgress = "Reading \(url.lastPathComponent)…"
                    let worker = Task.detached(priority: .userInitiated) { try LocalFileReader.read(url, forceOCR: forceOCR) { progress in Task { @MainActor [weak self] in self?.importProgress = url.lastPathComponent + " · " + progress } } }
                    let text = try await withTaskCancellationHandler(operation: { try await worker.value }, onCancel: { worker.cancel() })
                    try Task.checkCancellation()
                    guard !text.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty else { throw AppError(message: "No readable text found in \(url.lastPathComponent).") }
                    let asset = try copyAsset(url)
                    let parsed = Markdown.parse(text, title: url.deletingPathExtension().lastPathComponent, extractTitle: false)
                    let blocks = [Block(kind: .attachment, text: url.lastPathComponent, asset: asset)] + parsed.blocks
                    create(title: parsed.title, blocks: blocks); status = "Document imported · text is searchable and available to AI"
                }
            } catch is CancellationError { status = "Import cancelled; completed documents were kept" }
            catch { self.error = error.localizedDescription }
        }
    }
}
