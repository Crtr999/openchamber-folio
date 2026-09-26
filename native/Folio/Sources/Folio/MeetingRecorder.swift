import Foundation
import ScreenCaptureKit
import AVFoundation
import SwiftUI
import FolioCore

struct AudioSegment: Codable, Identifiable {
    var id = UUID(); var filename: String; var speaker: String; var start: Double; var duration: Double = 0; var hasSound: Bool = false
}
struct MeetingSession: Codable, Identifiable {
    var id: UUID; var noteID: UUID; var started: Date; var ended: Date?; var segments: [AudioSegment]; var transcript: [TranscriptPiece] = []; var completedSegmentIDs: [UUID] = []
}
final class SegmentWriter {
    var file: AVAudioFile?; var segment: AudioSegment?; var format: AVAudioFormat?; var bytes: Int = 0
}
final class AudioCaptureSink: NSObject, SCStreamOutput, SCStreamDelegate, @unchecked Sendable {
    let queue = DispatchQueue(label: "app.folio.audio", qos: .userInitiated)
    let directory: URL
    var session: MeetingSession
    var writers: [String: SegmentWriter] = [:]
    var origin: Double?
    var onLevel: ((String, Float) -> Void)?
    var onFailure: ((String) -> Void)?
    var lastMeter: [String: Double] = [:]
    var accepting = true
    init(directory: URL, noteID: UUID) throws {
        self.directory = directory
        session = MeetingSession(id: UUID(), noteID: noteID, started: Date(), segments: [])
        try FileManager.default.createDirectory(at: directory, withIntermediateDirectories: true)
        super.init(); try persist()
    }
    func persist() throws { let e = JSONEncoder(); e.outputFormatting = .prettyPrinted; try e.encode(session).write(to: directory.appendingPathComponent("meeting.json"), options: .atomic) }
    func stream(_ stream: SCStream, didStopWithError error: Error) { onFailure?(error.localizedDescription) }
    func stream(_ stream: SCStream, didOutputSampleBuffer sampleBuffer: CMSampleBuffer, of type: SCStreamOutputType) {
        guard accepting, type == .audio || type == .microphone, sampleBuffer.isValid,
              let desc = sampleBuffer.formatDescription, let asbd = CMAudioFormatDescriptionGetStreamBasicDescription(desc),
              let format = AVAudioFormat(streamDescription: asbd) else { return }
        let count = CMSampleBufferGetNumSamples(sampleBuffer); guard count > 0 else { return }
        guard let buffer = AVAudioPCMBuffer(pcmFormat: format, frameCapacity: AVAudioFrameCount(count)) else { return }
        buffer.frameLength = AVAudioFrameCount(count)
        guard CMSampleBufferCopyPCMDataIntoAudioBufferList(sampleBuffer, at: 0, frameCount: Int32(count), into: buffer.mutableAudioBufferList) == noErr else { return }
        let pts = sampleBuffer.presentationTimeStamp.seconds
        if origin == nil { origin = pts }; let time = max(0, pts - (origin ?? pts))
        let speaker = type == .microphone ? "You" : "Call audio"
        let writer = writers[speaker] ?? SegmentWriter(); writers[speaker] = writer
        do {
            if writer.file != nil, (time - (writer.segment?.start ?? time) >= 30 || writer.bytes > 10_000_000 || writer.format != format) { try close(writer) }
            if writer.file == nil {
                let name = "\(speaker == "You" ? "mic" : "call")-\(UUID().uuidString).wav"
                writer.segment = AudioSegment(filename: name, speaker: speaker, start: time)
                writer.format = format; writer.bytes = 0
                let settings: [String: Any] = [AVFormatIDKey: kAudioFormatLinearPCM, AVSampleRateKey: format.sampleRate, AVNumberOfChannelsKey: format.channelCount, AVLinearPCMBitDepthKey: 16, AVLinearPCMIsFloatKey: false, AVLinearPCMIsBigEndianKey: false, AVLinearPCMIsNonInterleaved: false]
                writer.file = try AVAudioFile(forWriting: directory.appendingPathComponent(name), settings: settings, commonFormat: format.commonFormat, interleaved: format.isInterleaved)
            }
            try writer.file?.write(from: buffer)
            writer.bytes += count * Int(format.channelCount) * 2
            let segmentStart = writer.segment?.start ?? time
            writer.segment?.duration = time - segmentStart + Double(count) / format.sampleRate
            var power: Float = 0
            if let samples = buffer.floatChannelData {
                let stride = format.isInterleaved ? Int(format.channelCount) : 1
                for i in Swift.stride(from: 0, to: count, by: 8) { power = max(power, abs(samples[0][i * stride])) }
            } else { power = 0.05 }
            if power > 0.008 { writer.segment?.hasSound = true }
            if time - (lastMeter[speaker] ?? -1) > 0.12 { lastMeter[speaker] = time; onLevel?(speaker, min(1, power * 4)) }
        } catch { accepting = false; onFailure?("Audio could not be saved: \(error.localizedDescription)") }
    }
    func close(_ writer: SegmentWriter) throws {
        writer.file = nil
        if let segment = writer.segment { session.segments.append(segment); writer.segment = nil; try persist() }
    }
    func finish() throws -> MeetingSession {
        accepting = false
        for writer in writers.values { try close(writer) }
        session.ended = Date(); try persist(); return session
    }
}
@MainActor final class MeetingRecorder: ObservableObject {
    @Published var isRecording = false
    @Published var isStarting = false
    @Published var isTranscribing = false
    @Published var microphoneLevel: Float = 0
    @Published var systemLevel: Float = 0
    @Published var session: MeetingSession?
    @Published var sessionDirectory: URL?
    @Published var progress = ""
    @Published var error: String?
    private var stream: SCStream?
    private var sink: AudioCaptureSink?
    private var transcriptionTask: Task<Void, Never>?
    func start(noteID: UUID, library: URL) async {
        guard !isRecording && !isStarting && !isTranscribing else { return }
        isStarting = true; error = nil; defer { isStarting = false }
        do {
            guard await AVCaptureDevice.requestAccess(for: .audio) else { throw AppError(message: "Microphone access is off. Enable Folio in System Settings → Privacy & Security → Microphone.") }
            let content = try await SCShareableContent.excludingDesktopWindows(false, onScreenWindowsOnly: true)
            guard let display = content.displays.first else { throw AppError(message: "No display is available for capturing call audio.") }
            let ownApps = content.applications.filter { $0.processID == ProcessInfo.processInfo.processIdentifier }
            let filter = SCContentFilter(display: display, excludingApplications: ownApps, exceptingWindows: [])
            let config = SCStreamConfiguration(); config.width = 2; config.height = 2; config.minimumFrameInterval = CMTime(seconds: 1, preferredTimescale: 1)
            config.capturesAudio = true; config.captureMicrophone = true; config.excludesCurrentProcessAudio = true; config.sampleRate = 48000; config.channelCount = 1
            let dir = library.appendingPathComponent("recordings/\(UUID().uuidString)")
            let sink = try AudioCaptureSink(directory: dir, noteID: noteID)
            sink.onLevel = { [weak self] speaker, level in Task { @MainActor in if speaker == "You" { self?.microphoneLevel = level } else { self?.systemLevel = level } } }
            sink.onFailure = { [weak self] message in Task { @MainActor in self?.error = message; await self?.stop() } }
            let stream = SCStream(filter: filter, configuration: config, delegate: sink)
            try stream.addStreamOutput(sink, type: .audio, sampleHandlerQueue: sink.queue)
            try stream.addStreamOutput(sink, type: .microphone, sampleHandlerQueue: sink.queue)
            self.stream = stream; self.sink = sink; session = sink.session; sessionDirectory = dir
            try await stream.startCapture(); isRecording = true; progress = "Recording locally"
        } catch { self.error = error.localizedDescription; stream = nil; sink = nil }
    }
    func stop() async {
        guard let stream, let sink else { return }
        self.stream = nil
        do { try await stream.stopCapture() } catch { self.error = error.localizedDescription }
        do {
            session = try await withCheckedThrowingContinuation { continuation in sink.queue.async { do { continuation.resume(returning: try sink.finish()) } catch { continuation.resume(throwing: error) } } }
            progress = "Recording saved on this Mac"
        } catch { self.error = error.localizedDescription }
        self.sink = nil; isRecording = false; microphoneLevel = 0; systemLevel = 0
    }
    func loadLatest(library: URL, noteID: UUID) {
        guard !isRecording && !isTranscribing else { return }
        session = nil; sessionDirectory = nil; error = nil
        do {
            let root = library.appendingPathComponent("recordings")
            let folders = try FileManager.default.contentsOfDirectory(at: root, includingPropertiesForKeys: [.contentModificationDateKey])
            var matches: [(MeetingSession, URL)] = []
            for folder in folders {
                if let data = try? Data(contentsOf: folder.appendingPathComponent("meeting.json")), let value = try? JSONDecoder().decode(MeetingSession.self, from: data), value.noteID == noteID { matches.append((value, folder)) }
            }
            if let latest = matches.sorted(by: { $0.0.started > $1.0.started }).first { session = latest.0; sessionDirectory = latest.1; progress = latest.0.ended == nil ? "Recovered recording — completed segments are available" : "Saved recording" }
        } catch { self.error = error.localizedDescription }
    }
    func importAudio(noteID: UUID, library: URL) {
        let panel = NSOpenPanel(); panel.allowedContentTypes = [.audio]
        guard panel.runModal() == .OK, let file = panel.url else { return }
        do {
            let size = try file.resourceValues(forKeys: [.fileSizeKey]).fileSize ?? 0
            guard size < 24_000_000 else { throw AppError(message: "Choose an audio file under 24 MB. Meetings recorded in Folio are automatically split into small files.") }
            let id = UUID(); let dir = library.appendingPathComponent("recordings/\(id)"); try FileManager.default.createDirectory(at: dir, withIntermediateDirectories: true)
            let filename = "imported." + file.pathExtension; try FileManager.default.copyItem(at: file, to: dir.appendingPathComponent(filename))
            session = MeetingSession(id: id, noteID: noteID, started: Date(), ended: Date(), segments: [AudioSegment(filename: filename, speaker: "Recording", start: 0, hasSound: true)])
            sessionDirectory = dir; try persistSession(); progress = "Audio imported"
        } catch { self.error = error.localizedDescription }
    }
    func persistSession() throws {
        guard let session, let sessionDirectory else { return }
        try JSONEncoder().encode(session).write(to: sessionDirectory.appendingPathComponent("meeting.json"), options: .atomic)
    }
    func transcribe(config: AIConfiguration, model: AppModel) {
        guard !isRecording, !isTranscribing, let value = session, let directory = sessionDirectory else { return }
        guard model.notes.first(where: { $0.id == value.noteID })?.excludedFromAI != true else { error = "This note is excluded from AI. Allow AI in its note options before uploading audio."; return }
        isTranscribing = true; error = nil
        transcriptionTask = Task {
            defer { isTranscribing = false }
            do {
                let segments = value.segments.filter { $0.hasSound && !value.completedSegmentIDs.contains($0.id) }
                for (i, segment) in segments.enumerated() {
                    try Task.checkCancellation(); progress = "Transcribing segment \(i + 1) of \(segments.count)…"
                    let pieces = try await AIService.transcribe(file: directory.appendingPathComponent(segment.filename), config: config, offset: segment.start, speaker: segment.speaker)
                    session?.transcript.append(contentsOf: pieces); session?.completedSegmentIDs.append(segment.id); try persistSession()
                }
                guard let session, !session.transcript.isEmpty else { throw AppError(message: "No speech was found. Check the audio meters when recording and try again.") }
                let text = Self.transcriptMarkdown(session.transcript)
                let heading = "Transcript · " + session.started.formatted(date: .abbreviated, time: .shortened)
                model.edit(value.noteID, { note in
                    note.isMeeting = true
                    if let i = note.blocks.firstIndex(where: { $0.kind == .heading2 && $0.text == heading }), i + 1 < note.blocks.count { note.blocks[i+1].text = text }
                    else { note.blocks.append(Block(kind: .heading2, text: heading)); note.blocks.append(Block(text: text)) }
                }, checkpoint: true)
                progress = "Transcript added to your note"
            } catch is CancellationError { progress = "Paused. Finished segments are saved; you can resume." }
            catch { self.error = error.localizedDescription; progress = "Finished segments are saved. Retry to continue." }
        }
    }
    func cancelTranscription() { transcriptionTask?.cancel() }
    static func transcriptMarkdown(_ pieces: [TranscriptPiece]) -> String {
        pieces.sorted { $0.start < $1.start }.map { piece in
            let seconds = max(0, Int(piece.start)); let stamp = String(format: "%02d:%02d", seconds / 60, seconds % 60)
            return "[\(stamp)] **\(piece.speaker)**  \(piece.text.trimmingCharacters(in: .whitespacesAndNewlines))"
        }.joined(separator: "\n\n")
    }
}
