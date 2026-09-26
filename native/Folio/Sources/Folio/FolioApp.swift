import AppKit
import SwiftUI
import FolioCore

@MainActor final class AppDelegate: NSObject, NSApplicationDelegate {
    weak var model: AppModel?
    weak var recorder: MeetingRecorder?
    func applicationShouldTerminate(_ sender: NSApplication) -> NSApplication.TerminateReply {
        if recorder?.isRecording == true || recorder?.isStarting == true || recorder?.isTranscribing == true {
            model?.showMeeting = true
            let alert = NSAlert(); alert.messageText = "A meeting is still active"; alert.informativeText = "Stop recording or finish transcription before quitting Folio."; alert.addButton(withTitle: "Back to meeting"); alert.runModal(); return .terminateCancel
        }
        model?.flush()
        if model?.pending.isEmpty == false { return .terminateCancel }
        return .terminateNow
    }
    func applicationShouldTerminateAfterLastWindowClosed(_ sender: NSApplication) -> Bool { false }
}
struct FolioApp: App {
    @NSApplicationDelegateAdaptor(AppDelegate.self) var delegate
    @StateObject private var model = AppModel()
    @StateObject private var chat = ChatModel()
    @StateObject private var voice = VoiceController()
    @StateObject private var calendar = CalendarController()
    @StateObject private var recorder = MeetingRecorder()
    var body: some Scene {
        Window("Folio", id: "notebook") {
            RootView().environmentObject(model).environmentObject(model.preferences).environmentObject(chat).environmentObject(recorder).environmentObject(voice).environmentObject(calendar)
                .preferredColorScheme(.dark)
                .onAppear { delegate.model = model; delegate.recorder = recorder; NSApp.setActivationPolicy(.regular); NSApp.activate(ignoringOtherApps: true) }
        }
        .defaultSize(width: 1380, height: 900)
        .windowStyle(.hiddenTitleBar)
        .commands {
            CommandGroup(replacing: .newItem) { Button("New note") { model.create() }.keyboardShortcut("n"); Button("New meeting note") { model.create(title: "Meeting · " + Date().formatted(date: .abbreviated, time: .omitted), meeting: true); model.showMeeting = true }.keyboardShortcut("n", modifiers: [.command, .shift]) }
            CommandGroup(replacing: .appSettings) { Button("Settings…") { model.showSettings = true }.keyboardShortcut(",") }
            CommandGroup(after: .saveItem) {
                Button("Save now") { model.flush() }.keyboardShortcut("s")
                Button("Export as Markdown…") { model.exportSelected(plain: false) }.keyboardShortcut("e", modifiers: [.command, .shift])
                Button("Export as PDF…") { model.exportPDF() }
                Button("Read local files / OCR…") { model.readFiles() }
                Button("Export as plain text…") { model.exportSelected(plain: true) }
                Divider(); Button("Import notes…") { model.importNotes() }.keyboardShortcut("i", modifiers: [.command, .shift])
                Button("Export all notes…") { model.exportLibrary() }
            }
            CommandMenu("Notebook") {
                Button("Toggle assistant") { model.showAI.toggle() }.keyboardShortcut("j")
                Button("Search notes") { NotificationCenter.default.post(name: .folioSearch, object: nil) }.keyboardShortcut("k")
                Button("Note history") { model.showHistory = true }
                Button("Meeting recorder") { model.showMeeting = true }.keyboardShortcut("m", modifiers: [.command, .shift])
            }
        }
    }
}
extension Notification.Name { static let folioSearch = Notification.Name("folioSearch"); static let folioLink = Notification.Name("folioLink") }
struct RootView: View {
    @EnvironmentObject var model: AppModel
    @EnvironmentObject var recorder: MeetingRecorder
    @EnvironmentObject var voice: VoiceController
    @EnvironmentObject var calendar: CalendarController
    @EnvironmentObject var chat: ChatModel
    @Environment(\.scenePhase) var scenePhase
    var body: some View {
        Group {
            if let error = model.startupError { VStack(spacing: 20) { EmptyState(icon: "externaldrive.badge.exclamationmark", title: "Your library needs attention", detail: error); Text("Folio has not replaced or reset your library.").foregroundStyle(Palette.muted) }.padding(40) }
            else {
                HStack(spacing: 0) {
                    SidebarView().frame(width: 230)
                    Rectangle().fill(Palette.line).frame(width: 1)
                    VStack(spacing: 0) {
                        if let event = calendar.prompt {
                            HStack { Image(systemName: "calendar.badge.clock"); VStack(alignment: .leading) { Text(event.title).fontWeight(.medium); Text("Your meeting is starting. Want to record?").foregroundStyle(Palette.muted) }; Spacer(); Button("Prepare recording") { model.prepareMeeting(event); calendar.dismissPrompt() }; Button("Dismiss") { calendar.dismissPrompt() } }.font(.system(size: 12)).padding(14).background(Palette.mint.opacity(0.08))
                        }
                        if model.importing { HStack { ProgressView().controlSize(.small); Text(model.importProgress); Spacer(); Button("Cancel") { model.importTask?.cancel() } }.font(.system(size: 12)).padding(12) }
                        if recorder.isRecording { recordingBanner }
                        if model.home { HomeView() }
                        else if model.selectedNote?.isChat == true { AssistantView().id(model.selectedID) }
                        else if let note = model.selectedNote { NoteEditorView(noteID: note.id).id(note.id) }
                        else { EmptyState(icon: "square.and.pencil", title: "Room for a new idea", detail: "Create a note with ⌘N, or choose a page from your library.") }
                    }.frame(minWidth: 480, maxWidth: .infinity)
                    if model.showAI && !model.home && model.selectedNote?.isChat != true {
                        Rectangle().fill(Palette.line).frame(width: 1)
                        AssistantView().frame(width: 330)
                    }
                }
            }
        }
        .background(Palette.canvas).foregroundStyle(Palette.text)
        .frame(minWidth: model.showAI ? 1070 : 750, minHeight: 620)
        .sheet(isPresented: $model.showSettings) { SettingsView() }
        .sheet(isPresented: $model.showHistory) { HistoryView() }
        .sheet(isPresented: $model.showMeeting) { MeetingView() }
        .alert("Something needs attention", isPresented: Binding(get: { model.error != nil }, set: { if !$0 { model.error = nil } })) { Button("OK") { model.error = nil } } message: { Text(model.error ?? "") }
        .onReceive(voice.$error) { value in if let value { model.error = value; voice.error = nil } }
        .onReceive(calendar.$error) { value in if let value { model.error = value; calendar.error = nil } }
        .onReceive(NotificationCenter.default.publisher(for: .folioAskSelection)) { event in
            if let text = event.object as? String { model.aiSelection = text; model.showAI = true }
        }
        .onChange(of: scenePhase) { _, phase in if phase != .active { model.flush() } }
        .onOpenURL { _ = route($0) }
        .onReceive(NotificationCenter.default.publisher(for: .folioLink)) { notification in if let url = notification.object as? URL { _ = route(url) } }
        .environment(\.openURL, OpenURLAction { url in
            if route(url) { return .handled }
            return ["https", "http", "mailto"].contains(url.scheme ?? "") ? .systemAction : .discarded
        })
    }
    func route(_ url: URL) -> Bool {
        guard url.scheme == "folio" else { return false }
        if url.host == "note", let id = UUID(uuidString: url.lastPathComponent), model.notes.contains(where: { $0.id == id && !$0.trashed }) { model.select(id); return true }
        if url.host == "title", let note = model.notes.first(where: { !$0.trashed && $0.displayTitle.localizedCaseInsensitiveCompare(url.lastPathComponent) == .orderedSame }) { model.select(note.id); return true }
        return false
    }
    var recordingBanner: some View {
        Button { model.showMeeting = true } label: { HStack { Circle().fill(.red).frame(width: 7, height: 7); Text("Recording meeting").font(.system(size: 12, weight: .medium)); Spacer(); Text("Open recorder →").font(.system(size: 11)) }.padding(.horizontal, 24).padding(.vertical, 10).foregroundStyle(Palette.mint).background(Palette.mint.opacity(0.08)) }.buttonStyle(.plain)
    }
}
