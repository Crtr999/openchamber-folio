import SwiftUI
import FolioCore
struct MeetingView: View {
    @EnvironmentObject var model: AppModel
    @EnvironmentObject var recorder: MeetingRecorder
    @EnvironmentObject var chat: ChatModel
    @Environment(\.dismiss) var dismiss
    @Environment(\.folioCloseWindow) var closeBridgeWindow
    @State private var participantsKnow = false
    @State private var replacing = false
    var body: some View {
        VStack(alignment: .leading, spacing: 22) {
            HStack { Image(systemName: "waveform").font(.system(size: 24)).foregroundStyle(Palette.mint); Text("Be in the conversation.").font(.system(size: 27, design: .serif)); Spacer(); Button { closeBridgeWindow?(); dismiss() } label: { Image(systemName: "xmark") }.buttonStyle(.plain) }
            Text("Folio records your microphone and audio playing on your Mac. It works with calls through headphones. No meeting bot joins the call.").font(.system(size: 13)).lineSpacing(4).foregroundStyle(Palette.muted)
            HStack(spacing: 16) { meter("Your microphone", symbol: "mic", level: recorder.microphoneLevel); meter("Call audio", symbol: "speaker.wave.2", level: recorder.systemLevel) }
            if recorder.isRecording, let session = recorder.session {
                HStack(spacing: 10) { Circle().fill(.red).frame(width: 8, height: 8); Text("Recording"); Text(session.started, style: .timer).monospacedDigit(); Spacer(); Button("Stop recording") { Task { await recorder.stop() } }.buttonStyle(QuietButton(accent: true)) }.font(.system(size: 13))
                Text("Audio is being saved on this Mac. Nothing is uploaded while recording.").font(.system(size: 11)).foregroundStyle(Palette.muted)
            } else {
                Toggle("Everyone knows this meeting will be recorded.", isOn: $participantsKnow).font(.system(size: 12))
                HStack {
                    Button(recorder.isStarting ? "Starting…" : "Start recording") { if recorder.session != nil { replacing = true } else { start() } }.buttonStyle(QuietButton(accent: true)).disabled(!participantsKnow || recorder.isStarting || recorder.isTranscribing || model.selectedID == nil)
                    Button("Import audio…") { if let id = model.selectedID { recorder.importAudio(noteID: id, library: model.library) } }.buttonStyle(QuietButton()).disabled(recorder.isStarting || recorder.isTranscribing)
                    Spacer()
                }
                Text("macOS will ask for microphone and screen/system-audio access. Folio saves audio only; it does not save screen video. Close unrelated audio before recording.").font(.system(size: 11)).foregroundStyle(Palette.muted).lineSpacing(3)
            }
            if let session = recorder.session, !recorder.isRecording {
                Rectangle().fill(Palette.line).frame(height: 1)
                HStack { VStack(alignment: .leading, spacing: 5) { SectionEyebrow(text: "Saved session"); Text(session.started.formatted(date: .abbreviated, time: .shortened)).font(.system(size: 13)); Text("\(session.segments.count) audio segments · \(session.completedSegmentIDs.count) transcribed").font(.system(size: 11)).foregroundStyle(Palette.muted) }; Spacer(); if let directory = recorder.sessionDirectory { Button("Show audio") { NSWorkspace.shared.open(directory) }.buttonStyle(QuietButton()) } }
                if recorder.isTranscribing { HStack { ProgressView().controlSize(.small); Text(recorder.progress).font(.system(size: 12)); Spacer(); Button("Pause") { recorder.cancelTranscription() }.buttonStyle(QuietButton()) } }
                else {
                    HStack {
                        Button(session.transcript.isEmpty ? "Transcribe with my API key" : "Resume / add transcript") { do { recorder.transcribe(config: try model.preferences.speechConfiguration(), model: model) } catch { recorder.error = error.localizedDescription } }.buttonStyle(QuietButton(accent: true)).disabled(session.segments.isEmpty)
                        if !session.transcript.isEmpty {
                            Button("Create summary") { model.select(session.noteID); model.showAI = true; chat.scope = .page; chat.summarizeMeeting(session, model: model); closeBridgeWindow?(); dismiss() }.buttonStyle(QuietButton()).disabled(chat.busyNote != nil)
                        }
                    }
                    Text("Transcribe uploads this session’s audio to \(URL(string: model.preferences.speechURL)?.host ?? "your configured provider"). API usage is billed by that provider. Saved audio stays on your Mac until you remove it.").font(.system(size: 10)).foregroundStyle(Palette.muted).lineSpacing(3)
                    Text(recorder.progress).font(.system(size: 11)).foregroundStyle(Palette.mint)
                }
            }
            if let error = recorder.error { Text(error).font(.system(size: 12)).foregroundStyle(.orange).textSelection(.enabled) }
            Spacer(minLength: 0)
            HStack { Text("“You” and “Call audio” identify audio sources, not individual remote speakers.").font(.system(size: 10)).foregroundStyle(Palette.muted); Spacer(); Button("AI settings") { closeBridgeWindow?(); dismiss(); DispatchQueue.main.asyncAfter(deadline: .now() + 0.2) { model.showSettings = true } }.buttonStyle(.plain).font(.system(size: 11)).foregroundStyle(Palette.mint) }
        }.padding(30).frame(width: 720, height: 670).background(Palette.canvas)
        .onAppear { if let id = model.selectedID { recorder.loadLatest(library: model.library, noteID: id) } }
        .confirmationDialog("Start a new recording?", isPresented: $replacing) { Button("Start new recording") { start() } } message: { Text("The previous recording stays in your library’s recordings folder.") }
    }
    func start() { if let id = model.selectedID { model.edit(id) { $0.isMeeting = true }; Task { await recorder.start(noteID: id, library: model.library) } } }
    func meter(_ title: String, symbol: String, level: Float) -> some View {
        VStack(alignment: .leading, spacing: 13) { Label(title, systemImage: symbol).font(.system(size: 12)).foregroundStyle(Palette.muted); GeometryReader { geometry in ZStack(alignment: .leading) { Capsule().fill(Palette.raised); Capsule().fill(Palette.mint).frame(width: max(3, geometry.size.width * CGFloat(level))) } }.frame(height: 5) }.padding(18).frame(maxWidth: .infinity).background(Palette.sidebar, in: RoundedRectangle(cornerRadius: 10))
    }
}
