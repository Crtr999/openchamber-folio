import AppKit
import SwiftUI
import FolioCore
import Combine

private struct FolioCloseWindowKey: EnvironmentKey { static let defaultValue: (() -> Void)? = nil }
extension EnvironmentValues {
    var folioCloseWindow: (() -> Void)? {
        get { self[FolioCloseWindowKey.self] }
        set { self[FolioCloseWindowKey.self] = newValue }
    }
}
struct BridgeRequest: Decodable {
    var id: String
    var command: String
    var noteID: UUID?
    var note: Note?
    var expectedModified: Date?
    var text: String?
    var kind: String?
    var parentID: UUID?
    var flag: Bool?
    var voiceID: String?
    var rate: Double?
    var blockID: UUID?
    var revisionID: Int64?
    var eventID: String?
}
struct BridgeVoice: Codable { var id: String; var name: String }
struct BridgeRevision: Codable { var id: Int64; var date: Date; var note: Note }
struct BridgeStatus: Codable {
    var selectedID: UUID?
    var notes: [Note]
    var status: String
    var error: String?
    var importing: Bool
    var importProgress: String
    var listening: Bool
    var dictation: String
    var speaking: Bool
    var paused: Bool
    var voiceID: String
    var rate: Double
    var voices: [BridgeVoice]
    var recording: Bool
    var recordingStarting: Bool
    var transcribing: Bool
    var recordingProgress: String
    var microphoneLevel: Float
    var systemLevel: Float
    var meeting: MeetingSession?
    var calendarConnected: Bool
    var events: [CalendarMeeting]
    var calendarPrompt: CalendarMeeting?
    var reminders: Bool
    var fontSize: Double
    var highlightStrength: Double
    var aiBusy: Bool
    var messages: [ChatMessage]
}
struct BridgeResponse: Encodable {
    var id: String
    var ok: Bool
    var state: BridgeStatus?
    var error: String?
    var text: String?
    var revisions: [BridgeRevision]?
}
@MainActor final class FolioBridge {
    let model = AppModel()
    let voice = VoiceController()
    let calendar = CalendarController()
    let recorder = MeetingRecorder()
    let chat = ChatModel()
    /// Opened on first use by the iPhone app's "read aloud"; the phone plays the audio it returns.
    private var bella: BellaVoiceEngine?
    private var windows: [String:NSWindow] = [:]
    private var subscriptions = Set<AnyCancellable>()
    init() {
        model.showAI = false
        for (publisher, name) in [(model.$showSettings.eraseToAnyPublisher(), "settings"), (model.$showAI.eraseToAnyPublisher(), "assistant"), (model.$showHistory.eraseToAnyPublisher(), "history"), (model.$showMeeting.eraseToAnyPublisher(), "meeting"), (model.$home.eraseToAnyPublisher(), "calendar")] {
            publisher.dropFirst().filter { $0 }.sink { [weak self] _ in
                DispatchQueue.main.async { [weak self] in
                    guard let self else { return }
                    do { try self.utility(name) } catch { self.model.error = error.localizedDescription }
                    switch name { case "settings": self.model.showSettings = false; case "assistant": self.model.showAI = false; case "history": self.model.showHistory = false; case "meeting": self.model.showMeeting = false; default: self.model.home = false }
                }
            }.store(in: &subscriptions)
        }
    }
    func snapshot() -> BridgeStatus {
        let selected = model.selectedID
        if let selected { chat.load(selected, model: model) }
        return BridgeStatus(selectedID:selected, notes:model.notes, status:model.status, error:model.startupError ?? model.error ?? voice.error ?? recorder.error ?? calendar.error, importing:model.importing, importProgress:model.importProgress, listening:voice.listening, dictation:voice.partial, speaking:voice.speaking, paused:voice.paused, voiceID:voice.voiceID, rate:voice.rate, voices:[BridgeVoice(id:BellaVoiceEngine.voiceID,name:"Bella · American · bright")] + voice.voices.map { BridgeVoice(id:$0.identifier,name:$0.name) }, recording:recorder.isRecording, recordingStarting:recorder.isStarting, transcribing:recorder.isTranscribing, recordingProgress:recorder.progress, microphoneLevel:recorder.microphoneLevel, systemLevel:recorder.systemLevel, meeting:recorder.session, calendarConnected:calendar.connected, events:calendar.events, calendarPrompt:calendar.prompt, reminders:calendar.reminders, fontSize:model.preferences.fontSize, highlightStrength:model.preferences.highlightStrength, aiBusy:chat.busyNote != nil, messages:selected.flatMap { chat.messages[$0] } ?? [])
    }
    func utility(_ name: String) throws {
        windows[name]?.close()
        let content: AnyView
        switch name {
        case "settings": content=AnyView(SettingsView())
        case "assistant": content=AnyView(AssistantView().frame(minWidth:600,minHeight:650))
        case "meeting": content=AnyView(MeetingView())
        case "calendar": content=AnyView(HomeView().frame(minWidth:720,minHeight:650))
        case "history": content=AnyView(HistoryView())
        default: throw AppError(message:"Unknown Folio window")
        }
        let hosted=content.environment(\.folioCloseWindow, { [weak self] in self?.windows[name]?.close() }).environmentObject(model).environmentObject(model.preferences).environmentObject(voice).environmentObject(calendar).environmentObject(recorder).environmentObject(chat).preferredColorScheme(.dark)
        let window=NSWindow(contentViewController:NSHostingController(rootView:hosted))
        window.title="Folio · " + name.capitalized
        window.styleMask=[.titled,.closable,.resizable,.miniaturizable]
        window.setContentSize(NSSize(width: name == "settings" ? 660 : 780,height:740))
        window.isReleasedWhenClosed=false;window.center();windows[name]=window
        window.makeKeyAndOrderFront(nil);NSApp.activate(ignoringOtherApps:true)
    }
    func handle(_ request: BridgeRequest) async -> BridgeResponse {
        do {
            if let startup=model.startupError { throw AppError(message:startup) }
            var text: String?
            var revisions: [BridgeRevision]?
            // Sync-only commands answer without the whole notebook state.
            var lean=false
            let id=request.noteID ?? model.selectedID
            func selected() throws -> Note { guard let id, let note=model.notes.first(where:{$0.id==id}) else {throw AppError(message:"Choose a Folio page first")}; return note }
            switch request.command {
            case "state": break
            case "select":
                let note=try selected();model.select(note.id);recorder.loadLatest(library:model.library,noteID:note.id)
            case "create":
                switch request.kind {
                case "library": model.createLibraryTable(parent:request.parentID)
                case "table": model.createTable(parent:request.parentID)
                case "chat": model.createChat()
                default: model.create(title:request.text ?? "",parent:request.parentID,meeting:request.kind=="meeting")
                }
            case "save":
                guard var incoming=request.note,let index=model.notes.firstIndex(where:{$0.id==incoming.id}) else {throw AppError(message:"Page was not found")}
                guard request.expectedModified == model.notes[index].modified else {throw AppError(message:"This page changed in another view. Reload the saved page before editing again.")}
                guard incoming.title.count<=1000,incoming.blocks.count<=10000 else {throw AppError(message:"Page is too large")}
                let existingAssets=Set(model.notes[index].blocks.compactMap(\.asset))
                for block in incoming.blocks {
                    if let asset=block.asset,block.kind == .attachment,!existingAssets.contains(asset) {throw AppError(message:"Attachments must be chosen through the file picker")}
                    let count=(block.text as NSString).length
                    guard (block.marks ?? []).allSatisfy({$0.start>=0 && $0.length>=0 && $0.start<=count && $0.length<=count-$0.start}) else {throw AppError(message:"Invalid text formatting range")}
                }
                var parent=incoming.parentID;var seen=Set<UUID>()
                while let value=parent {guard value != incoming.id,seen.insert(value).inserted,let p=model.notes.first(where:{$0.id==value}) else {throw AppError(message:"Invalid page parent")};parent=p.parentID}
                incoming.modified=Date();incoming.created=model.notes[index].created
                try model.database?.save(incoming,forceRevision:request.flag == true)
                model.notes[index]=incoming;model.pending.removeValue(forKey:incoming.id);model.status="All changes saved"
            case "upsert":
                // Sync from the iPhone app: store the page as sent, keeping its own modified date so it is not echoed back.
                guard var incoming=request.note else {throw AppError(message:"Page was not found")}
                guard incoming.title.count<=1000,incoming.blocks.count<=10000 else {throw AppError(message:"Page is too large")}
                let existing=model.notes.first(where:{$0.id==incoming.id})
                let knownAssets=Set(existing?.blocks.compactMap(\.asset) ?? [])
                let assetRoot=model.library.resolvingSymlinksInPath().standardizedFileURL
                func inLibrary(_ asset: String) -> Bool {
                    let file=assetRoot.appendingPathComponent(asset).resolvingSymlinksInPath().standardizedFileURL
                    return file.path.hasPrefix(assetRoot.path+"/assets/") && FileManager.default.fileExists(atPath:file.path)
                }
                for index in incoming.blocks.indices {
                    let block=incoming.blocks[index]
                    let count=(block.text as NSString).length
                    guard (block.marks ?? []).allSatisfy({$0.start>=0 && $0.length>=0 && $0.start<=count && $0.length<=count-$0.start}) else {throw AppError(message:"Invalid text formatting range")}
                    // Only files already in this Mac library may be referenced. The phone uploads its files first (asset-write).
                    if block.kind == .attachment, let asset=block.asset, !knownAssets.contains(asset), !inLibrary(asset) {incoming.blocks[index].asset=nil}
                }
                var seen=Set<UUID>();var parent=incoming.parentID
                while let value=parent {
                    guard value != incoming.id,seen.insert(value).inserted,let p=model.notes.first(where:{$0.id==value}) else {incoming.parentID=nil;break}
                    parent=p.parentID
                }
                incoming.created=existing?.created ?? incoming.created
                try model.database?.save(incoming)
                if let index=model.notes.firstIndex(where:{$0.id==incoming.id}) {model.notes[index]=incoming} else {model.notes.insert(incoming,at:0)}
                model.pending.removeValue(forKey:incoming.id)
            case "trash": model.trash(try selected().id,restore:request.flag == true)
            case "duplicate":
                var copy=try selected();copy.id=UUID();copy.title += " copy";copy.created=Date();copy.modified=Date()
                for i in copy.blocks.indices {copy.blocks[i].id=UUID()}
                try model.database?.save(copy);model.notes.insert(copy,at:0);model.select(copy.id)
            case "search":
                model.query=request.text ?? "";model.search();text=try String(data:JSONEncoder().encode(model.searchIDs),encoding:.utf8)
            case "markdown":
                let note=try selected();guard !note.excludedFromAI || request.flag != true else {throw AppError(message:"This page is excluded from AI")};text=Markdown.render(note,plain:request.kind=="text")
            case "export":
                model.select(try selected().id);NSApp.activate(ignoringOtherApps:true)
                switch request.kind {case "pdf":model.exportPDF();case "csv":model.exportTableCSV(try selected());case "txt":model.exportSelected(plain:true);default:model.exportSelected(plain:false)}
            case "export-library": NSApp.activate(ignoringOtherApps:true);model.exportLibrary(plain:request.kind=="txt")
            case "import":
                NSApp.activate(ignoringOtherApps:true)
                switch request.kind {case "csv":model.importTableCSV(into:try selected().id);case "notes":model.importNotes();default:model.readFiles(forceOCR:request.flag == true)}
            case "cancel-import": model.importTask?.cancel()
            case "attach": model.select(try selected().id);NSApp.activate(ignoringOtherApps:true);model.attachFile()
            case "open-attachment":
                let note=try selected();guard let block=note.blocks.first(where:{$0.id==request.blockID}),let asset=block.asset,block.kind == .attachment else {throw AppError(message:"Attachment was not found")}
                let root=model.library.resolvingSymlinksInPath().standardizedFileURL
                let file=root.appendingPathComponent(asset).resolvingSymlinksInPath().standardizedFileURL
                guard file.path.hasPrefix(root.path+"/assets/") else {throw AppError(message:"Attachment is outside the library")};NSWorkspace.shared.open(file)
            case "read": voice.read(try request.text ?? selected().plainBody)
            case "pause-reading":voice.pauseResume()
            case "stop-reading":voice.stopReading()
            case "voice":
                if let value=request.voiceID {guard value==BellaVoiceEngine.voiceID || voice.voices.contains(where:{$0.identifier==value}) else {throw AppError(message:"Unknown voice")};voice.voiceID=value;UserDefaults.standard.set(value,forKey:"readVoice")}
                if let rate=request.rate {voice.rate=min(0.7,max(0.2,rate));UserDefaults.standard.set(voice.rate,forKey:"readRate")}
            case "listen":
                let note=try selected();let target=note.id
                voice.listen { [weak self] words in guard let self,!words.isEmpty else{return};self.model.edit(target,{$0.blocks.append(Block(text:words))},checkpoint:true) }
            case "stop-listening":voice.stopListening()
            case "record":
                let note=try selected();guard request.flag == true else {throw AppError(message:"Confirm participants know before starting a recording")};await recorder.start(noteID:note.id,library:model.library)
            case "stop-recording":await recorder.stop()
            case "import-audio":NSApp.activate(ignoringOtherApps:true);recorder.importAudio(noteID:try selected().id,library:model.library)
            case "transcribe":recorder.transcribe(config:try model.preferences.speechConfiguration(),model:model)
            case "cancel-transcription":recorder.cancelTranscription()
            case "summarize":guard let meeting=recorder.session else {throw AppError(message:"Choose a saved recording")};chat.summarizeMeeting(meeting,model:model)
            case "calendar-connect":calendar.connect()
            case "calendar-refresh":calendar.refresh()
            case "calendar-reminders":calendar.setReminders(request.flag == true)
            case "calendar-dismiss":calendar.dismissPrompt()
            case "calendar-prepare":guard let event=calendar.events.first(where:{$0.id==request.eventID}) else {throw AppError(message:"Calendar event was not found")};model.prepareMeeting(event);calendar.dismissPrompt()
            case "utility":if let id {model.select(id)};try utility(request.kind ?? "settings")
            case "history":revisions=try model.database?.revisions(for:try selected().id).map {BridgeRevision(id:$0.id,date:$0.date,note:$0.note)} ?? []
            case "restore-revision":
                let note=try selected();guard let revision=try model.database?.revisions(for:note.id).first(where:{$0.id==request.revisionID}) else {throw AppError(message:"Revision was not found")};model.edit(note.id,{$0=revision.note},checkpoint:true)
            case "append":let note=try selected();model.appendAI(request.text ?? "",noteID:note.id,replace:request.flag == true)
            case "stop-ai":chat.stop()
            case "chat-list":
                // Every assistant conversation, keyed by the page it lives on, for iPhone sync.
                lean=true
                var all: [String:[ChatMessage]] = [:]
                for chatID in model.chatIDs { chat.load(chatID, model:model); if let list=chat.messages[chatID], !list.isEmpty { all[chatID.uuidString]=list } }
                text=String(data:try JSONEncoder().encode(all),encoding:.utf8)
            case "chat-put":
                lean=true
                guard let target=request.noteID, model.notes.contains(where:{$0.id==target}) else {throw AppError(message:"Page was not found")}
                guard chat.busyNote != target else {throw AppError(message:"The assistant is still answering in this chat on your Mac.")}
                let incoming=try JSONDecoder().decode([ChatMessage].self,from:Data((request.text ?? "[]").utf8))
                guard incoming.count<=5000 else {throw AppError(message:"Chat is too long")}
                try model.database?.saveChat(incoming,id:target)
                chat.messages[target]=incoming
                if incoming.isEmpty {model.chatIDs.remove(target)} else {model.chatIDs.insert(target)}
            case "asset-read":
                lean=true
                let root=model.library.resolvingSymlinksInPath().standardizedFileURL
                let file=root.appendingPathComponent(request.text ?? "").resolvingSymlinksInPath().standardizedFileURL
                guard file.path.hasPrefix(root.path+"/assets/") else {throw AppError(message:"Attachment is outside the library")}
                let size=(try FileManager.default.attributesOfItem(atPath:file.path)[.size] as? NSNumber)?.intValue ?? 0
                guard size<=40_000_000 else {throw AppError(message:"This attachment is too large to copy to iPhone")}
                text=try Data(contentsOf:file).base64EncodedString()
            case "asset-write":
                lean=true
                guard let data=Data(base64Encoded:request.text ?? ""),data.count<=40_000_000 else {throw AppError(message:"Attachment could not be read")}
                let ext=String(URL(fileURLWithPath:request.kind ?? "file").pathExtension.filter{$0.isLetter || $0.isNumber}.prefix(10))
                let relative="assets/"+UUID().uuidString+(ext.isEmpty ? "" : "."+ext)
                try FileManager.default.createDirectory(at:model.library.appendingPathComponent("assets"),withIntermediateDirectories:true)
                try data.write(to:model.library.appendingPathComponent(relative),options:.atomic)
                text=relative
            case "bella":
                lean=true
                guard let directory=BellaVoiceEngine.modelDirectory else {throw AppError(message:"Bella is not installed on this Mac")}
                let words=String((request.text ?? "").prefix(1500))
                guard !words.trimmingCharacters(in:.whitespacesAndNewlines).isEmpty else {throw AppError(message:"Nothing to read")}
                if bella == nil {bella=try await Task.detached(priority:.userInitiated){try BellaVoiceEngine(directory:directory)}.value}
                guard let engine=bella else {throw AppError(message:"Bella could not start")}
                let speed=Float(max(0.75,min(1.4,request.rate ?? 1)))
                text=try await Task.detached(priority:.userInitiated){try engine.wav(for:words,speed:speed)}.value.base64EncodedString()
            case "clear-error":model.error=nil;voice.error=nil;recorder.error=nil;calendar.error=nil
            case "shutdown":
                if recorder.isRecording {await recorder.stop()};voice.stopReading();voice.stopListening();chat.stop();model.flush()
                guard model.pending.isEmpty else {throw AppError(message:"Some notes could not be saved. Keep Folio open and retry.")}
            default:throw AppError(message:"Unsupported Folio command")
            }
            model.flush()
            return BridgeResponse(id:request.id,ok:true,state:lean ? nil : snapshot(),text:text,revisions:revisions)
        } catch {return BridgeResponse(id:request.id,ok:false,state:snapshot(),error:error.localizedDescription)}
    }
}
@main struct BridgeMain {
    @MainActor static func main() {
        let app=NSApplication.shared;app.setActivationPolicy(.accessory)
        let bridge=FolioBridge()
        // Requests and replies stay on inherited pipes, never a network listener.
        Thread.detachNewThread {
            while let line=readLine() {
                guard line.utf8.count<=72_000_000 else {continue}
                do {
                    let request=try JSONDecoder().decode(BridgeRequest.self,from:Data(line.utf8))
                    Task { @MainActor in
                        let response=await bridge.handle(request)
                        if let data=try? JSONEncoder().encode(response) {FileHandle.standardOutput.write(data);FileHandle.standardOutput.write(Data([10]))}
                    }
                } catch {FileHandle.standardError.write(Data("Invalid Folio request\n".utf8))}
            }
            Task { @MainActor in
                let request=BridgeRequest(id:"eof",command:"shutdown")
                _=await bridge.handle(request);NSApp.terminate(nil)
            }
        }
        app.run()
    }
}
