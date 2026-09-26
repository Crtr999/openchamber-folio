import SwiftUI
import AppKit
import FolioCore

struct SettingsView: View {
    @EnvironmentObject var model: AppModel
    @EnvironmentObject var voice: VoiceController
    @EnvironmentObject var calendar: CalendarController
    @EnvironmentObject var preferences: Preferences
    @Environment(\.dismiss) var dismiss
    @Environment(\.folioCloseWindow) var closeBridgeWindow
    @State private var section = 0
    @State private var key = ""
    @State private var speechKey = ""
    @State private var message = ""
    @State private var testing = false
    @State private var availableModels: [String] = []
    @State private var loadingModels = false
    @State private var hasChatKey = false
    @State private var hasSpeechKey = false
    var body: some View {
        VStack(alignment: .leading, spacing: 22) {
            HStack { Image(systemName: "leaf.fill").foregroundStyle(Palette.mint); Text("Make it yours").font(.system(size: 27, design: .serif)); Spacer(); Button("Done") { closeBridgeWindow?(); dismiss() }.buttonStyle(QuietButton(accent: true)) }
            Picker("Settings section", selection: $section) { Text("AI connections").tag(0); Text("Writing").tag(1); Text("Your data").tag(2); Text("Voice & Calendar").tag(3) }.pickerStyle(.segmented).labelsHidden()
            ScrollView {
                VStack(alignment: .leading, spacing: 20) {
                    if section == 0 { aiSettings }
                    if section == 1 { writingSettings }
                    if section == 2 { dataSettings }; if section == 3 { voiceSettings }
                }.padding(.vertical, 8)
            }
            if !message.isEmpty { Text(message).font(.system(size: 12)).foregroundStyle(Palette.mint).textSelection(.enabled) }
        }.padding(30).frame(width: 660, height: 710).background(Palette.canvas)
        .onAppear { refreshKeyStatus() }
        .onChange(of: preferences.baseURL) { _, _ in key = ""; availableModels = []; refreshKeyStatus() }
        .onChange(of: preferences.provider) { _, _ in key = ""; availableModels = []; refreshKeyStatus() }
        .onChange(of: preferences.speechURL) { _, _ in speechKey = ""; refreshKeyStatus() }
    }
    var aiSettings: some View {
        VStack(alignment: .leading, spacing: 15) {
            SectionEyebrow(text: "Chat & summaries")
            Text("Connect directly to your provider. Folio has no subscription and does not proxy your requests.").font(.system(size: 12)).foregroundStyle(Palette.muted)
            Picker("Provider", selection: $preferences.provider) {
                Text("OpenAI / compatible provider").tag(Provider.compatible); Text("Anthropic").tag(Provider.anthropic)
            }.onChange(of: preferences.provider) { _, value in preferences.baseURL = value == .anthropic ? "https://api.anthropic.com/v1" : "https://api.openai.com/v1"; preferences.model = ""; message = "" }
            field("API base URL", text: $preferences.baseURL, placeholder: "https://api.openai.com/v1")
            field("Model ID", text: $preferences.model, placeholder: "Enter a model ID available in your provider account")
            HStack {
                SecureField(hasChatKey ? "Key saved in Keychain · enter to replace" : "Paste your API key", text: $key).textFieldStyle(.roundedBorder)
                Button("Save key") { saveKey() }.buttonStyle(QuietButton()).disabled(key.isEmpty)
                if hasChatKey { Button { do { try Keychain.set("", account: preferences.chatAccount); refreshKeyStatus(); message = "Chat key removed." } catch { message = error.localizedDescription } } label: { Image(systemName: "trash") }.buttonStyle(.plain).help("Remove saved key") }
            }
            HStack {
                Button(loadingModels ? "Loading…" : "Load available models") {
                    if !key.isEmpty { saveKey() }; loadingModels = true
                    Task { defer { loadingModels = false }; do { availableModels = try await AIService.listModels(config: preferences.chatConfiguration()); message = availableModels.isEmpty ? "No model list returned. Enter a model ID manually." : "Choose a chat-capable model from the list, then test the connection." } catch { message = error.localizedDescription } }
                }.buttonStyle(QuietButton()).disabled(loadingModels)
                if !availableModels.isEmpty { Menu("Choose model") { ForEach(availableModels, id: \.self) { id in Button(id) { preferences.model = id } } }.fixedSize() }
            }
            HStack { Button(testing ? "Testing…" : "Test connection") { test() }.buttonStyle(QuietButton(accent: true)).disabled(testing); Text("Sends a small, billable test message.").font(.system(size: 10)).foregroundStyle(Palette.muted) }
            Rectangle().fill(Palette.line).frame(height: 1).padding(.vertical, 8)
            SectionEyebrow(text: "Meeting transcription")
            Text("Use an OpenAI-compatible audio transcription endpoint. Anthropic chat can be paired with a separate transcription provider.").font(.system(size: 12)).foregroundStyle(Palette.muted)
            field("Audio API base URL", text: $preferences.speechURL, placeholder: "https://api.openai.com/v1")
            field("Transcription model", text: $preferences.speechModel, placeholder: "whisper-1")
            Text("whisper-1 supplies segment timestamps. Other compatible models may return text with timestamps only at each recording segment’s start.").font(.system(size: 10)).foregroundStyle(Palette.muted)
            HStack {
                SecureField(hasSpeechKey ? "Transcription key saved · enter to replace" : "Optional if using the same OpenAI connection", text: $speechKey).textFieldStyle(.roundedBorder)
                Button("Save key") { do { try Keychain.set(speechKey.trimmingCharacters(in: .whitespacesAndNewlines), account: preferences.speechAccount); speechKey = ""; refreshKeyStatus(); message = "Transcription key saved in Keychain." } catch { message = error.localizedDescription } }.buttonStyle(QuietButton()).disabled(speechKey.isEmpty)
                if hasSpeechKey { Button { do { try Keychain.set("", account: preferences.speechAccount); refreshKeyStatus(); message = "Transcription key removed." } catch { message = error.localizedDescription } } label: { Image(systemName: "trash") }.buttonStyle(.plain).help("Remove saved transcription key") }
            }
            Text("Keys stay in macOS Keychain and are excluded from note exports. Requests go to the endpoint shown above. Your provider’s usage charges and data policies apply.").font(.system(size: 10)).foregroundStyle(Palette.muted).lineSpacing(3)
        }
    }
    var writingSettings: some View {
        VStack(alignment: .leading, spacing: 24) {
            SectionEyebrow(text: "Comfortable writing")
            HStack { Text("Text size"); Slider(value: $preferences.fontSize, in: 13...23, step: 1); Text("\(Int(preferences.fontSize)) pt").monospacedDigit().frame(width: 42) }
            HStack { Text("Highlight intensity"); Slider(value: $preferences.highlightStrength, in: 0.6...1); Text("\(Int(preferences.highlightStrength * 100))%").monospacedDigit().frame(width: 42) }
            Text("A thought worth keeping.").font(.system(size: preferences.fontSize)).foregroundStyle(Palette.sidebar).padding(12).background(Highlight.yellow.color.opacity(preferences.highlightStrength), in: RoundedRectangle(cornerRadius: 5))
            HStack(spacing: 12) { ForEach(Highlight.allCases.filter { $0 != .none }, id: \.self) { color in Text("Aa").font(.system(size: 15, weight: .medium)).foregroundStyle(Palette.sidebar).frame(width: 62, height: 44).background(color.color.opacity(preferences.highlightStrength), in: RoundedRectangle(cornerRadius: 6)) } }
            Text("Select text and press ⌘⇧H for a yellow highlight. Select text to reveal formatting, highlight colors, links, read-aloud, and AI. Use the paragraph menu to change headings or lists.").font(.system(size: 12)).foregroundStyle(Palette.muted)
            SectionEyebrow(text: "A few useful shortcuts")
            VStack(spacing: 12) { shortcut("New note", "⌘N"); shortcut("Search notes", "⌘K"); shortcut("Toggle assistant", "⌘J"); shortcut("Highlight selection", "⌘⇧H"); shortcut("Bold selection", "⌘B"); shortcut("New paragraph", "Return"); shortcut("Paragraph styles", "/"); shortcut("Export Markdown", "⌘⇧E") }
        }.font(.system(size: 13))
    }
    var voiceSettings: some View {
        VStack(alignment: .leading, spacing: 20) {
            SectionEyebrow(text: "Read aloud")
            Picker("Voice", selection: $voice.voiceID) { Text("Bella · American · bright · Lilt offline").tag(BellaVoiceEngine.voiceID); Divider(); Text("System default").tag(""); ForEach(voice.voices, id: \.identifier) { item in Text(item.name + " · " + item.language).tag(item.identifier) } }
            HStack { Text("Reading speed"); Slider(value: $voice.rate, in: 0.25...0.65); Text(String(format: "%.2f", voice.rate)).monospacedDigit() }
            Text("Bella uses the Natural Voices pack already downloaded by Lilt. It stays offline, and Folio does not make a second copy. Other choices use voices installed in macOS. Add Apple voices in System Settings → Accessibility → Read & Speak.").font(.system(size: 12)).foregroundStyle(Palette.muted)
            SectionEyebrow(text: "Listen & write")
            Text("Press Listen on a page, speak, then Stop & insert. The live transcript appears above the page and is inserted at your cursor when you stop. Dictation uses Apple’s on-device speech recognition, with no API bill. It requires an installed, supported language and microphone and speech permissions.").font(.system(size: 12)).foregroundStyle(Palette.muted)
            Divider()
            SectionEyebrow(text: "Apple Calendar")
            if calendar.connected {
                Label("Calendar connected", systemImage: "checkmark.circle").foregroundStyle(Palette.mint)
                Toggle("Prompt me when scheduled video calls start", isOn: Binding(get: { calendar.reminders }, set: { calendar.setReminders($0) }))
                Button("Show upcoming events") { model.home = true; closeBridgeWindow?(); dismiss() }.buttonStyle(QuietButton())
            } else { Button("Connect Apple Calendar") { calendar.connect() }.buttonStyle(QuietButton(accent: true)) }
            Text("Folio reads calendars in the macOS Calendar app and looks for Zoom, Teams, or Google Meet links. Reminders appear around the scheduled start while Folio is running. They do not detect an unscheduled call, and recording always requires your action. Manage access in System Settings → Privacy & Security → Calendars.").font(.system(size: 12)).foregroundStyle(Palette.muted)
        }
        .onChange(of: voice.voiceID) { _, value in UserDefaults.standard.set(value, forKey: "readVoice") }
        .onChange(of: voice.rate) { _, value in UserDefaults.standard.set(value, forKey: "readRate") }
    }
    var dataSettings: some View {
        VStack(alignment: .leading, spacing: 20) {
            SectionEyebrow(text: "Your library")
            Text("Notes, attachments, chat history, and recordings are stored on this Mac. A daily database backup is made when Folio opens. Note history keeps earlier versions as you edit.").font(.system(size: 13)).foregroundStyle(Palette.muted).lineSpacing(4)
            Text(model.library.path).font(.system(size: 11, design: .monospaced)).foregroundStyle(Palette.mint).textSelection(.enabled)
            HStack { Button("Show library in Finder") { NSWorkspace.shared.open(model.library) }.buttonStyle(QuietButton()); Button("Back up database now") { do { model.flush(); let url = model.library.appendingPathComponent("backups/manual-\(UUID().uuidString.prefix(8)).sqlite"); try model.database?.backup(to: url); message = "Database backed up. Attachments and audio remain in your library folders." } catch { message = error.localizedDescription } }.buttonStyle(QuietButton()) }
            Divider()
            SectionEyebrow(text: "Take your writing anywhere")
            HStack { Button("Import notes…") { model.importNotes() }.buttonStyle(QuietButton()); Button("Export Markdown…") { model.exportLibrary() }.buttonStyle(QuietButton()); Button("Export TXT…") { model.exportLibrary(plain: true) }.buttonStyle(QuietButton()) }
            Text("Library exports include a Folio-library.json file for restoring block colors and structure, plus attachments. Plain Markdown and TXT cannot preserve every visual detail. Exported JSON can be imported from the same folder to restore its attachments.").font(.system(size: 12)).foregroundStyle(Palette.muted).lineSpacing(4)
            Text("To back up everything, quit Folio and copy the entire library folder, including recordings and attachments, to another disk. The daily database snapshots alone are not a full media backup.").font(.system(size: 12)).foregroundStyle(Palette.muted).lineSpacing(4)
        }
    }
    func field(_ label: String, text: Binding<String>, placeholder: String) -> some View { VStack(alignment: .leading, spacing: 5) { Text(label).font(.system(size: 11)).foregroundStyle(Palette.muted); TextField(placeholder, text: text).textFieldStyle(.roundedBorder) } }
    func shortcut(_ title: String, _ keys: String) -> some View { HStack { Text(title).foregroundStyle(Palette.muted); Spacer(); Text(keys).font(.system(size: 12, design: .monospaced)) } }
    func refreshKeyStatus() { do { hasChatKey = !(try Keychain.read(preferences.chatAccount)).isEmpty; hasSpeechKey = !(try Keychain.read(preferences.speechAccount)).isEmpty } catch { message = error.localizedDescription } }
    func saveKey() { do { try Keychain.set(key.trimmingCharacters(in: .whitespacesAndNewlines), account: preferences.chatAccount); key = ""; refreshKeyStatus(); message = "API key saved in macOS Keychain." } catch { message = error.localizedDescription } }
    func test() {
        if !key.isEmpty { saveKey() }; testing = true; message = "Connecting…"
        Task { defer { testing = false }; do { let config = try preferences.chatConfiguration(); try await AIService.stream(config: config, system: "Reply with OK.", messages: [["role": "user", "content": "Connection test."]]) { _ in }; message = "Connected successfully. Your AI is ready." } catch { message = error.localizedDescription } }
    }
}
struct HistoryView: View {
    @EnvironmentObject var model: AppModel
    @Environment(\.dismiss) var dismiss
    @Environment(\.folioCloseWindow) var closeBridgeWindow
    @State private var revisions: [Revision] = []
    @State private var selected: Int64?
    var body: some View {
        VStack(alignment: .leading, spacing: 18) {
            HStack { Text("Note history").font(.system(size: 25, design: .serif)); Spacer(); Button("Done") { closeBridgeWindow?(); dismiss() }.buttonStyle(QuietButton()) }
            Text("Previous versions are saved about every two minutes of editing, and before applying AI drafts or restoring a version.").font(.system(size: 12)).foregroundStyle(Palette.muted)
            HStack(alignment: .top, spacing: 20) {
                ScrollView { VStack(alignment: .leading, spacing: 7) { ForEach(revisions) { rev in Button { selected = rev.id } label: { Text(rev.date.formatted(date: .abbreviated, time: .standard)).font(.system(size: 11)).padding(10).frame(maxWidth: .infinity, alignment: .leading).background(selected == rev.id ? Palette.raised : .clear, in: RoundedRectangle(cornerRadius: 6)) }.buttonStyle(.plain) } } }.frame(width: 180)
                if let rev = revisions.first(where: { $0.id == selected }) { ScrollView { Text(Markdown.render(rev.note)).font(.system(size: 13)).textSelection(.enabled).frame(maxWidth: .infinity, alignment: .leading) } }
                else { EmptyState(icon: "clock.arrow.circlepath", title: "A fresh beginning", detail: "Earlier versions will appear as you edit this note.") }
            }
            HStack { Spacer(); Button("Restore selected version") { if let rev = revisions.first(where: { $0.id == selected }), let id = model.selectedID { model.edit(id, { note in let created = note.created; note = rev.note; note.id = id; note.created = created }, checkpoint: true); closeBridgeWindow?(); dismiss() } }.buttonStyle(QuietButton(accent: true)).disabled(selected == nil) }
        }.padding(28).frame(width: 780, height: 560).background(Palette.canvas)
        .onAppear { model.flush(); do { if let id = model.selectedID { revisions = try model.database?.revisions(for: id) ?? []; selected = revisions.first?.id } } catch { model.error = error.localizedDescription } }
    }
}
