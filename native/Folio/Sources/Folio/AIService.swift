import Foundation
import Security
import SwiftUI
import FolioCore

struct AppError: LocalizedError { var message: String; var errorDescription: String? { message } }
enum Provider: String, CaseIterable, Codable { case compatible = "OpenAI compatible", anthropic = "Anthropic" }
struct AIConfiguration {
    var provider: Provider; var baseURL: String; var model: String; var key: String
}
enum Keychain {
    static let service = "app.folio.personal.keys"
    static func read(_ account: String) throws -> String {
        let query: [String: Any] = [kSecClass as String: kSecClassGenericPassword, kSecAttrService as String: service, kSecAttrAccount as String: account, kSecReturnData as String: true, kSecMatchLimit as String: kSecMatchLimitOne]
        var result: CFTypeRef?; let status = SecItemCopyMatching(query as CFDictionary, &result)
        if status == errSecItemNotFound { return "" }
        guard status == errSecSuccess, let data = result as? Data else { throw AppError(message: "Keychain could not read the API key (\(status)).") }
        return String(data: data, encoding: .utf8) ?? ""
    }
    static func set(_ value: String, account: String) throws {
        let query: [String: Any] = [kSecClass as String: kSecClassGenericPassword, kSecAttrService as String: service, kSecAttrAccount as String: account]
        if value.isEmpty { let s = SecItemDelete(query as CFDictionary); guard s == errSecSuccess || s == errSecItemNotFound else { throw AppError(message: "Could not remove key (\(s)).") }; return }
        let data = Data(value.utf8)
        var status = SecItemUpdate(query as CFDictionary, [kSecValueData as String: data] as CFDictionary)
        if status == errSecItemNotFound {
            var item = query; item[kSecValueData as String] = data; item[kSecAttrAccessible as String] = kSecAttrAccessibleAfterFirstUnlockThisDeviceOnly
            status = SecItemAdd(item as CFDictionary, nil)
        }
        guard status == errSecSuccess else { throw AppError(message: "Keychain could not save the API key (\(status)).") }
    }
}
@MainActor final class Preferences: ObservableObject {
    @Published var provider: Provider { didSet { save() } }
    @Published var baseURL: String { didSet { save() } }
    @Published var model: String { didSet { save() } }
    @Published var speechURL: String { didSet { save() } }
    @Published var speechModel: String { didSet { save() } }
    @Published var fontSize: Double { didSet { save() } }
    @Published var highlightStrength: Double { didSet { save() } }
    private let defaults = UserDefaults.standard
    init() {
        provider = Provider(rawValue: defaults.string(forKey: "provider") ?? "") ?? .compatible
        baseURL = defaults.string(forKey: "baseURL") ?? "https://api.openai.com/v1"
        model = defaults.string(forKey: "model") ?? ""
        speechURL = defaults.string(forKey: "speechURL") ?? "https://api.openai.com/v1"
        speechModel = defaults.string(forKey: "speechModel") ?? "whisper-1"
        fontSize = defaults.object(forKey: "fontSize") as? Double ?? 16
        highlightStrength = defaults.object(forKey: "highlightStrength") as? Double ?? 0.9
    }
    var chatAccount: String { "chat:\(provider.rawValue):\(baseURL.trimmingCharacters(in: .whitespacesAndNewlines))" }
    var speechAccount: String { "speech:\(speechURL.trimmingCharacters(in: .whitespacesAndNewlines))" }
    func chatConfiguration() throws -> AIConfiguration { AIConfiguration(provider: provider, baseURL: baseURL, model: model, key: try Keychain.read(chatAccount)) }
    func speechConfiguration() throws -> AIConfiguration {
        var key = try Keychain.read(speechAccount)
        if key.isEmpty && provider == .compatible && speechURL == baseURL { key = try Keychain.read(chatAccount) }
        return AIConfiguration(provider: .compatible, baseURL: speechURL, model: speechModel, key: key)
    }
    func save() {
        defaults.set(provider.rawValue, forKey: "provider"); defaults.set(baseURL, forKey: "baseURL"); defaults.set(model, forKey: "model")
        defaults.set(speechURL, forKey: "speechURL"); defaults.set(speechModel, forKey: "speechModel"); defaults.set(fontSize, forKey: "fontSize"); defaults.set(highlightStrength, forKey: "highlightStrength")
    }
}
final class NoRedirect: NSObject, URLSessionTaskDelegate {
    func urlSession(_ session: URLSession, task: URLSessionTask, willPerformHTTPRedirection response: HTTPURLResponse, newRequest request: URLRequest, completionHandler: @escaping (URLRequest?) -> Void) { completionHandler(nil) }
}
struct TranscriptPiece: Codable, Identifiable {
    var id = UUID(); var start: Double; var end: Double; var speaker: String; var text: String
}
enum AIService {
    static let session: URLSession = {
        let config = URLSessionConfiguration.ephemeral
        config.timeoutIntervalForRequest = 180; config.timeoutIntervalForResource = 900
        return URLSession(configuration: config, delegate: NoRedirect(), delegateQueue: nil)
    }()
    static func endpoint(_ base: String, path: String) throws -> URL {
        let clean = base.trimmingCharacters(in: .whitespacesAndNewlines).trimmingCharacters(in: CharacterSet(charactersIn: "/"))
        guard let url = URL(string: clean), let host = url.host, url.user == nil, url.password == nil,
              url.query == nil, url.fragment == nil, url.scheme == "https" || (url.scheme == "http" && ["localhost", "127.0.0.1", "::1", "[::1]"].contains(host)) else {
            throw AppError(message: "Use an HTTPS API base URL, such as https://api.openai.com/v1. HTTP is allowed only for a local server.")
        }
        return url.appendingPathComponent(path)
    }
    static func validate(_ config: AIConfiguration) throws {
        guard !config.model.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty else { throw AppError(message: "Choose a model ID in Settings → AI connections first.") }
        let url = try endpoint(config.baseURL, path: "")
        if config.key.isEmpty && !["localhost", "127.0.0.1", "::1", "[::1]"].contains(url.host ?? "") { throw AppError(message: "Add your API key in Settings → AI connections first.") }
    }
    static func stream(config: AIConfiguration, system: String, messages: [[String: String]], session: URLSession = AIService.session, onDelta: @escaping @MainActor (String) -> Void) async throws {
        try validate(config)
        var request = URLRequest(url: try endpoint(config.baseURL, path: config.provider == .anthropic ? "messages" : "chat/completions"))
        request.httpMethod = "POST"; request.setValue("application/json", forHTTPHeaderField: "Content-Type")
        var body: [String: Any] = ["model": config.model, "stream": true]
        if config.provider == .anthropic {
            request.setValue(config.key, forHTTPHeaderField: "x-api-key"); request.setValue("2023-06-01", forHTTPHeaderField: "anthropic-version")
            body["system"] = system; body["messages"] = messages; body["max_tokens"] = 4096
        } else {
            if !config.key.isEmpty { request.setValue("Bearer \(config.key)", forHTTPHeaderField: "Authorization") }
            body["messages"] = [["role": "system", "content": system]] + messages
        }
        request.httpBody = try JSONSerialization.data(withJSONObject: body)
        let (bytes, response) = try await session.bytes(for: request)
        guard let http = response as? HTTPURLResponse else { throw AppError(message: "The AI provider returned an invalid response.") }
        guard (200..<300).contains(http.statusCode) else {
            var data = Data(); for try await byte in bytes { if data.count < 6000 { data.append(byte) } else { break } }
            throw serviceError(data, status: http.statusCode)
        }
        var received = false
        for try await line in bytes.lines {
            try Task.checkCancellation()
            guard line.hasPrefix("data:") else { continue }
            let value = String(line.dropFirst(5)).trimmingCharacters(in: .whitespaces)
            if value == "[DONE]" { break }
            guard let data = value.data(using: .utf8), let json = try JSONSerialization.jsonObject(with: data) as? [String: Any] else { continue }
            if let error = json["error"] as? [String: Any] { throw AppError(message: error["message"] as? String ?? "The provider interrupted the response.") }
            let delta: String?
            if config.provider == .anthropic { delta = (json["delta"] as? [String: Any])?["text"] as? String }
            else { delta = (((json["choices"] as? [[String: Any]])?.first)?["delta"] as? [String: Any])?["content"] as? String }
            if let delta { received = true; await onDelta(delta) }
        }
        if !received { throw AppError(message: "The model returned no text. Check that this model supports streaming chat with the selected provider.") }
    }
    static func listModels(config: AIConfiguration, session: URLSession = AIService.session) async throws -> [String] {
        var checked = config; checked.model = "model-list"; try validate(checked)
        var request = URLRequest(url: try endpoint(config.baseURL, path: "models"))
        if config.provider == .anthropic { request.setValue(config.key, forHTTPHeaderField: "x-api-key"); request.setValue("2023-06-01", forHTTPHeaderField: "anthropic-version") }
        else if !config.key.isEmpty { request.setValue("Bearer " + config.key, forHTTPHeaderField: "Authorization") }
        let (data, response) = try await session.data(for: request)
        guard let http = response as? HTTPURLResponse else { throw AppError(message: "Invalid model-list response.") }
        guard (200..<300).contains(http.statusCode) else { throw serviceError(data, status: http.statusCode) }
        let json = try JSONSerialization.jsonObject(with: data) as? [String: Any]
        return ((json?["data"] as? [[String: Any]]) ?? []).compactMap { $0["id"] as? String }.sorted()
    }
    static func serviceError(_ data: Data, status: Int) -> AppError {
        let json = (try? JSONSerialization.jsonObject(with: data)) as? [String: Any]
        let reason = (json?["error"] as? [String: Any])?["message"] as? String
        return AppError(message: "Provider error \(status): \(String((reason ?? "Check your API key, model, endpoint, and account balance.").prefix(700)))")
    }
    static func transcribe(file: URL, config: AIConfiguration, offset: Double, speaker: String, session: URLSession = AIService.session) async throws -> [TranscriptPiece] {
        try validate(config)
        let data = try Data(contentsOf: file)
        guard data.count < 24_000_000 else { throw AppError(message: "This audio file is too large. Use a recording under 24 MB or record inside Folio, which splits audio into smaller segments.") }
        let boundary = "Folio-\(UUID().uuidString)"
        var body = Data()
        func field(_ name: String, _ value: String) { body.append(Data("--\(boundary)\r\nContent-Disposition: form-data; name=\"\(name)\"\r\n\r\n\(value)\r\n".utf8)) }
        field("model", config.model)
        let detailed = config.model == "whisper-1"
        field("response_format", detailed ? "verbose_json" : "json")
        let safeName = "recording." + file.pathExtension.lowercased()
        body.append(Data("--\(boundary)\r\nContent-Disposition: form-data; name=\"file\"; filename=\"\(safeName)\"\r\nContent-Type: application/octet-stream\r\n\r\n".utf8))
        body.append(data); body.append(Data("\r\n--\(boundary)--\r\n".utf8))
        var request = URLRequest(url: try endpoint(config.baseURL, path: "audio/transcriptions")); request.httpMethod = "POST"
        request.setValue("multipart/form-data; boundary=\(boundary)", forHTTPHeaderField: "Content-Type")
        if !config.key.isEmpty { request.setValue("Bearer \(config.key)", forHTTPHeaderField: "Authorization") }; request.httpBody = body
        let (result, response) = try await session.data(for: request)
        guard let http = response as? HTTPURLResponse else { throw AppError(message: "Invalid transcription response.") }
        guard (200..<300).contains(http.statusCode) else { throw serviceError(result, status: http.statusCode) }
        guard let json = try JSONSerialization.jsonObject(with: result) as? [String: Any] else { throw AppError(message: "The provider returned an unreadable transcript.") }
        if let segments = json["segments"] as? [[String: Any]], !segments.isEmpty {
            return segments.compactMap { s in
                guard let text = s["text"] as? String, !text.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty else { return nil }
                return TranscriptPiece(start: offset + (s["start"] as? Double ?? 0), end: offset + (s["end"] as? Double ?? 0), speaker: speaker, text: text)
            }
        }
        if let text = json["text"] as? String { return text.isEmpty ? [] : [TranscriptPiece(start: offset, end: offset, speaker: speaker, text: text)] }
        throw AppError(message: "The provider returned no transcript text.")
    }
}
