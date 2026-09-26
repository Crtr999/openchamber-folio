import XCTest
import AVFoundation
import ScreenCaptureKit
@testable import Folio

final class IntegrationTests: XCTestCase {
    func testEndpointValidation() throws {
        XCTAssertEqual(try AIService.endpoint("https://example.com/v1/", path: "chat/completions").absoluteString, "https://example.com/v1/chat/completions")
        XCTAssertThrowsError(try AIService.endpoint("http://example.com/v1", path: "messages"))
        XCTAssertThrowsError(try AIService.endpoint("https://user:secret@example.com", path: "messages"))
        XCTAssertThrowsError(try AIService.endpoint("file:///tmp/key", path: "messages"))
        XCTAssertNoThrow(try AIService.endpoint("http://127.0.0.1:11434/v1", path: "chat/completions"))
    }
    func testAudioBuffersBecomeRecoverableSeparateWAVSegments() throws {
        let dir = FileManager.default.temporaryDirectory.appendingPathComponent("Folio-audio-test-\(UUID())")
        defer { try? FileManager.default.removeItem(at: dir) }
        let sink = try AudioCaptureSink(directory: dir, noteID: UUID())
        let filter = SCContentFilter()
        let stream = SCStream(filter: filter, configuration: SCStreamConfiguration(), delegate: nil)
        for (time, type) in [(0.0, SCStreamOutputType.microphone), (0.2, .audio), (31.0, .microphone), (31.2, .audio)] {
            sink.stream(stream, didOutputSampleBuffer: try sample(at: time), of: type)
        }
        let result = try sink.finish()
        XCTAssertEqual(result.segments.count, 4)
        XCTAssertEqual(Set(result.segments.map(\.speaker)), Set(["You", "Call audio"]))
        XCTAssertTrue(result.segments.allSatisfy(\.hasSound))
        for segment in result.segments {
            let audio = try AVAudioFile(forReading: dir.appendingPathComponent(segment.filename))
            XCTAssertEqual(audio.length, 4800)
            XCTAssertEqual(audio.fileFormat.sampleRate, 48000)
        }
        let saved = try JSONDecoder().decode(MeetingSession.self, from: Data(contentsOf: dir.appendingPathComponent("meeting.json")))
        XCTAssertEqual(saved.segments.count, 4); XCTAssertNotNil(saved.ended)
    }
    private func sample(at seconds: Double) throws -> CMSampleBuffer {
        let format = AVAudioFormat(standardFormatWithSampleRate: 48000, channels: 1)!
        let pcm = AVAudioPCMBuffer(pcmFormat: format, frameCapacity: 4800)!
        pcm.frameLength = 4800
        for i in 0..<4800 { pcm.floatChannelData![0][i] = sin(Float(i) * 0.05) * 0.2 }
        var desc: CMAudioFormatDescription?
        XCTAssertEqual(CMAudioFormatDescriptionCreate(allocator: kCFAllocatorDefault, asbd: format.streamDescription, layoutSize: 0, layout: nil, magicCookieSize: 0, magicCookie: nil, extensions: nil, formatDescriptionOut: &desc), noErr)
        var timing = CMSampleTimingInfo(duration: CMTime(value: 1, timescale: 48000), presentationTimeStamp: CMTime(seconds: seconds, preferredTimescale: 48000), decodeTimeStamp: .invalid)
        var sample: CMSampleBuffer?
        XCTAssertEqual(CMSampleBufferCreate(allocator: kCFAllocatorDefault, dataBuffer: nil, dataReady: false, makeDataReadyCallback: nil, refcon: nil, formatDescription: desc, sampleCount: 4800, sampleTimingEntryCount: 1, sampleTimingArray: &timing, sampleSizeEntryCount: 0, sampleSizeArray: nil, sampleBufferOut: &sample), noErr)
        let result = sample!
        XCTAssertEqual(CMSampleBufferSetDataBufferFromAudioBufferList(result, blockBufferAllocator: kCFAllocatorDefault, blockBufferMemoryAllocator: kCFAllocatorDefault, flags: 0, bufferList: pcm.audioBufferList), noErr)
        XCTAssertEqual(CMSampleBufferSetDataReady(result), noErr)
        return result
    }
}

final class MockProtocol: URLProtocol {
    static var handler: ((URLRequest) throws -> (Int, String))?
    override class func canInit(with request: URLRequest) -> Bool { true }
    override class func canonicalRequest(for request: URLRequest) -> URLRequest { request }
    override func startLoading() {
        do {
            let result = try Self.handler!(request)
            let response = HTTPURLResponse(url: request.url!, statusCode: result.0, httpVersion: "HTTP/1.1", headerFields: ["Content-Type": "text/event-stream"])!
            client?.urlProtocol(self, didReceive: response, cacheStoragePolicy: .notAllowed)
            client?.urlProtocol(self, didLoad: Data(result.1.utf8)); client?.urlProtocolDidFinishLoading(self)
        } catch { client?.urlProtocol(self, didFailWithError: error) }
    }
    override func stopLoading() {}
}
@MainActor final class ProviderTests: XCTestCase {
    func session() -> URLSession { let config = URLSessionConfiguration.ephemeral; config.protocolClasses = [MockProtocol.self]; return URLSession(configuration: config) }
    func testCompatibleStreamingAndAuthorization() async throws {
        MockProtocol.handler = { request in
            XCTAssertEqual(request.url?.path, "/v1/chat/completions")
            XCTAssertEqual(request.value(forHTTPHeaderField: "Authorization"), "Bearer synthetic-test-key")
            return (200, "data: {\"choices\":[{\"delta\":{\"content\":\"Hello \"}}]}\n\ndata: {\"choices\":[{\"delta\":{\"content\":\"notebook\"}}]}\n\ndata: [DONE]\n\n")
        }
        var text = ""
        let config = AIConfiguration(provider: .compatible, baseURL: "https://example.invalid/v1", model: "test-model", key: "synthetic-test-key")
        try await AIService.stream(config: config, system: "Test", messages: [["role": "user", "content": "Hi"]], session: session()) { text += $0 }
        XCTAssertEqual(text, "Hello notebook")
    }
    func testAnthropicStreaming() async throws {
        MockProtocol.handler = { request in
            XCTAssertEqual(request.url?.path, "/v1/messages")
            XCTAssertEqual(request.value(forHTTPHeaderField: "x-api-key"), "synthetic-test-key")
            XCTAssertEqual(request.value(forHTTPHeaderField: "anthropic-version"), "2023-06-01")
            return (200, "event: content_block_delta\ndata: {\"type\":\"content_block_delta\",\"delta\":{\"type\":\"text_delta\",\"text\":\"Useful answer\"}}\n\n")
        }
        var text = ""
        let config = AIConfiguration(provider: .anthropic, baseURL: "https://example.invalid/v1", model: "test-model", key: "synthetic-test-key")
        try await AIService.stream(config: config, system: "Test", messages: [["role": "user", "content": "Hi"]], session: session()) { text += $0 }
        XCTAssertEqual(text, "Useful answer")
    }
    func testProviderErrorRemainsActionable() async {
        MockProtocol.handler = { _ in (401, "{\"error\":{\"message\":\"Invalid API key\"}}") }
        let config = AIConfiguration(provider: .compatible, baseURL: "https://example.invalid/v1", model: "test-model", key: "synthetic-test-key")
        do { try await AIService.stream(config: config, system: "Test", messages: [], session: session()) { _ in }; XCTFail("Expected failure") }
        catch { XCTAssertTrue(error.localizedDescription.contains("401")); XCTAssertTrue(error.localizedDescription.contains("Invalid API key")) }
    }
    func testTranscriptOffsetsAndSourceLabels() async throws {
        let file = FileManager.default.temporaryDirectory.appendingPathComponent("Folio-fixture-\(UUID()).wav")
        defer { try? FileManager.default.removeItem(at: file) }
        try Data("synthetic audio request fixture".utf8).write(to: file)
        MockProtocol.handler = { request in
            XCTAssertEqual(request.url?.path, "/v1/audio/transcriptions")
            XCTAssertTrue(request.value(forHTTPHeaderField: "Content-Type")?.contains("multipart/form-data") == true)
            return (200, "{\"segments\":[{\"start\":2.0,\"end\":4.0,\"text\":\"Decision made.\"}]}")
        }
        let config = AIConfiguration(provider: .compatible, baseURL: "https://example.invalid/v1", model: "whisper-1", key: "synthetic-test-key")
        let result = try await AIService.transcribe(file: file, config: config, offset: 30, speaker: "You", session: session())
        XCTAssertEqual(result.first?.start, 32); XCTAssertEqual(result.first?.end, 34); XCTAssertEqual(result.first?.speaker, "You")
    }
}
