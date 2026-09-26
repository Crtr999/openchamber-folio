import Foundation
import SherpaOnnx

/// Uses the Kokoro pack Lilt has already downloaded on this Mac. Folio neither
/// copies the 330 MB model nor sends reading text to a service.
final class BellaVoiceEngine: @unchecked Sendable {
    static let voiceID = "neural:bella"
    static var modelDirectory: URL? {
        let home = FileManager.default.homeDirectoryForCurrentUser
        let candidates = [
            home.appendingPathComponent("Library/Containers/com.carterlaborde.Lilt/Data/Library/Application Support/Lilt/NaturalVoices/kokoro-en-v0_19"),
            home.appendingPathComponent("Library/Application Support/Lilt/NaturalVoices/kokoro-en-v0_19")
        ]
        return candidates.first { FileManager.default.fileExists(atPath: $0.appendingPathComponent("model.onnx").path) }
    }

    private let tts: SherpaOnnxOfflineTtsWrapper

    init(directory: URL) throws {
        let kokoro = sherpaOnnxOfflineTtsKokoroModelConfig(
            model: directory.appendingPathComponent("model.onnx").path,
            voices: directory.appendingPathComponent("voices.bin").path,
            tokens: directory.appendingPathComponent("tokens.txt").path,
            dataDir: directory.appendingPathComponent("espeak-ng-data").path,
            lang: "en-us"
        )
        let model = sherpaOnnxOfflineTtsModelConfig(kokoro: kokoro, numThreads: max(2, ProcessInfo.processInfo.activeProcessorCount / 2), provider: "cpu")
        var config = sherpaOnnxOfflineTtsConfig(model: model)
        let engine = withUnsafePointer(to: &config) { SherpaOnnxOfflineTtsWrapper(config: $0) }
        guard engine.tts != nil, engine.numSpeakers > 1 else {
            throw AppError(message: "Lilt’s Bella voice could not be opened. Open Lilt and check that its Natural Voices download is complete.")
        }
        tts = engine
    }

    func wav(for text: String, speed: Float) throws -> Data {
        let temporary = FileManager.default.temporaryDirectory.appendingPathComponent("folio-bella-\(UUID().uuidString).wav")
        defer { try? FileManager.default.removeItem(at: temporary) }
        let audio = tts.generate(text: text, sid: 1, speed: speed)
        guard audio.n > 0, audio.save(filename: temporary.path) == 1 else { throw AppError(message: "Bella couldn’t generate audio for this text.") }
        return try Data(contentsOf: temporary)
    }
}
