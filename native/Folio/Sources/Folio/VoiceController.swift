import SwiftUI
import Speech
import AVFoundation

@MainActor final class VoiceController: NSObject, ObservableObject, AVSpeechSynthesizerDelegate, AVAudioPlayerDelegate {
    @Published var listening = false
    @Published var partial = ""
    @Published var speaking = false
    @Published var paused = false
    @Published var error: String?
    @Published var voiceID: String = BellaVoiceEngine.voiceID
    @Published var rate: Double = UserDefaults.standard.object(forKey: "readRate") as? Double ?? 0.48
    let synthesizer = AVSpeechSynthesizer()
    private var engine: AVAudioEngine?
    private var request: SFSpeechAudioBufferRecognitionRequest?
    private var task: SFSpeechRecognitionTask?
    private var completion: ((String) -> Void)?
    private var session = UUID()
    private var bellaEngine: BellaVoiceEngine?
    private var bellaPlayer: AVAudioPlayer?
    private var bellaQueue: [String] = []
    private var bellaIndex = 0
    private var bellaSession = UUID()
    override init() {
        super.init()
        if !UserDefaults.standard.bool(forKey: "didSelectBellaReaderDefault") {
            UserDefaults.standard.set(BellaVoiceEngine.voiceID, forKey: "readVoice")
            UserDefaults.standard.set(true, forKey: "didSelectBellaReaderDefault")
        }
        voiceID = UserDefaults.standard.string(forKey: "readVoice") ?? BellaVoiceEngine.voiceID
        synthesizer.delegate = self
    }
    var voices: [AVSpeechSynthesisVoice] { AVSpeechSynthesisVoice.speechVoices().sorted { $0.name < $1.name } }
    func listen(completion: @escaping (String) -> Void) {
        guard !listening else { stopListening(); return }
        guard self.completion == nil else { return }
        self.completion = completion
        Task {
            let authorization = await withCheckedContinuation { continuation in SFSpeechRecognizer.requestAuthorization { continuation.resume(returning: $0) } }
            guard authorization == .authorized else { error = "Allow Speech Recognition for Folio in System Settings → Privacy & Security."; finish(); return }
            guard await AVCaptureDevice.requestAccess(for: .audio) else { error = "Allow microphone access for Folio in System Settings → Privacy & Security."; finish(); return }
            guard let recognizer = SFSpeechRecognizer(locale: .current), recognizer.isAvailable, recognizer.supportsOnDeviceRecognition else { error = "On-device dictation isn’t available for this language. Install the language’s speech support in macOS settings and try again."; finish(); return }
            do {
                stopReading(); partial = ""; session = UUID(); let token = session
                let engine = AVAudioEngine(); let request = SFSpeechAudioBufferRecognitionRequest()
                request.shouldReportPartialResults = true; request.requiresOnDeviceRecognition = true; request.addsPunctuation = true
                let input = engine.inputNode; let format = input.outputFormat(forBus: 0)
                guard format.sampleRate > 0 else { throw AppError(message: "No microphone is available.") }
                input.installTap(onBus: 0, bufferSize: 1024, format: format) { buffer, _ in request.append(buffer) }
                self.engine = engine; self.request = request
                task = recognizer.recognitionTask(with: request) { [weak self] result, failure in
                    Task { @MainActor in
                        guard let self, self.session == token else { return }
                        if let result { self.partial = result.bestTranscription.formattedString }
                        if result?.isFinal == true { self.finish() }
                        else if let failure { self.error = failure.localizedDescription; self.finish() }
                    }
                }
                engine.prepare(); try engine.start(); listening = true
            } catch { self.error = error.localizedDescription; finish() }
        }
    }
    func stopListening() {
        engine?.stop(); engine?.inputNode.removeTap(onBus: 0); engine = nil; request?.endAudio(); listening = false
        let token = session
        Task { try? await Task.sleep(for: .seconds(1)); if session == token { finish() } }
    }
    private func finish() {
        session = UUID(); engine?.stop(); engine?.inputNode.removeTap(onBus: 0); engine = nil
        request?.endAudio(); request = nil; task?.cancel(); task = nil; listening = false
        let done = completion; completion = nil; done?(partial); partial = ""
    }
    func read(_ text: String) {
        guard !text.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty else { return }
        stopReading()
        if voiceID == BellaVoiceEngine.voiceID {
            guard let directory = BellaVoiceEngine.modelDirectory else {
                error = "Bella’s offline voice needs the Natural Voices download already stored by Lilt. Open Lilt and finish that download, then try again."
                return
            }
            error = nil; bellaQueue = Self.chunks(text); bellaIndex = 0; speaking = true; paused = false
            let token = bellaSession
            Task {
                do {
                    if bellaEngine == nil { bellaEngine = try await Task.detached(priority: .userInitiated) { try BellaVoiceEngine(directory: directory) }.value }
                    guard token == bellaSession else { return }
                    playBellaNext()
                } catch { if token == bellaSession { self.error = error.localizedDescription; stopReading() } }
            }
            return
        }
        let utterance = AVSpeechUtterance(string: text)
        utterance.voice = AVSpeechSynthesisVoice(identifier: voiceID) ?? AVSpeechSynthesisVoice(language: Locale.current.language.languageCode?.identifier ?? "en-US")
        utterance.rate = Float(rate); UserDefaults.standard.set(voiceID, forKey: "readVoice"); UserDefaults.standard.set(rate, forKey: "readRate")
        speaking = true; paused = false; synthesizer.speak(utterance)
    }
    func pauseResume() {
        if let bellaPlayer { if paused { bellaPlayer.play() } else { bellaPlayer.pause() } }
        else if paused { synthesizer.continueSpeaking() } else { synthesizer.pauseSpeaking(at: .word) }
        paused.toggle()
    }
    func stopReading() {
        bellaSession = UUID(); bellaQueue = []; bellaIndex = 0; bellaPlayer?.stop(); bellaPlayer = nil
        synthesizer.stopSpeaking(at: .immediate); speaking = false; paused = false
    }
    private func playBellaNext() {
        guard speaking, bellaIndex < bellaQueue.count, let bellaEngine else { if bellaIndex >= bellaQueue.count { speaking = false; paused = false }; return }
        let text = bellaQueue[bellaIndex], token = bellaSession
        let speed = Float(max(0.75, min(1.4, rate / 0.48)))
        Task {
            do {
                let data = try await Task.detached(priority: .userInitiated) { try bellaEngine.wav(for: text, speed: speed) }.value
                guard token == bellaSession, speaking else { return }
                let player = try AVAudioPlayer(data: data); player.delegate = self; bellaPlayer = player; player.prepareToPlay(); if !paused { player.play() }
            } catch { if token == bellaSession { self.error = error.localizedDescription; stopReading() } }
        }
    }
    private static func chunks(_ text: String) -> [String] {
        var result: [String] = [], current = ""
        for sentence in text.components(separatedBy: CharacterSet(charactersIn: ".!?\n")).map({ $0.trimmingCharacters(in: .whitespacesAndNewlines) }).filter({ !$0.isEmpty }) {
            let addition = current.isEmpty ? sentence : current + ". " + sentence
            if addition.count > 300, !current.isEmpty { result.append(current); current = sentence } else { current = addition }
        }
        if !current.isEmpty { result.append(current) }
        return result
    }
    nonisolated func audioPlayerDidFinishPlaying(_ player: AVAudioPlayer, successfully flag: Bool) { Task { @MainActor in if self.bellaPlayer === player { self.bellaPlayer = nil; self.bellaIndex += 1; self.playBellaNext() } } }
    nonisolated func speechSynthesizer(_ synthesizer: AVSpeechSynthesizer, didFinish utterance: AVSpeechUtterance) { Task { @MainActor in if !self.synthesizer.isSpeaking && self.bellaPlayer == nil { self.speaking = false; self.paused = false } } }
}
