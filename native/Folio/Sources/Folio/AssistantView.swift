import SwiftUI
import AppKit
import FolioCore

struct AssistantView: View {
    @EnvironmentObject var model: AppModel
    @EnvironmentObject var preferences: Preferences
    @EnvironmentObject var chat: ChatModel
    @State private var prompt = ""
    @State private var choosingSources = false
    @State private var showingContext = false
    @State private var draft: ChatMessage?
    @State private var clearConfirmation = false
    var messages: [ChatMessage] { model.selectedID.flatMap { chat.messages[$0] } ?? [] }
    var busy: Bool { chat.busyNote != nil }
    var body: some View {
        VStack(spacing: 0) {
            HStack(spacing: 8) { Image(systemName: "sparkles").foregroundStyle(Palette.mint); Text(model.selectedNote?.isChat == true ? (model.selectedNote?.displayTitle ?? "AI chat") : "Thinking space").font(.system(size: 13, weight: .medium)).lineLimit(1); Spacer(); Menu { Button("New AI chat") { model.createChat(); chat.scope = .library }; Button("Export Markdown…") { model.exportSelected(plain: false) }; Button("Export TXT…") { model.exportSelected(plain: true) }; Button("Export PDF…") { model.exportPDF() }; Divider(); Button("Clear conversation") { clearConfirmation = true }; Button("AI settings…") { model.showSettings = true } } label: { Image(systemName: "ellipsis") }.menuStyle(.borderlessButton).fixedSize() }.padding(.horizontal, 22).frame(height: 44).padding(.top, 10)
            Rectangle().fill(Palette.line).frame(height: 1)
            HStack(spacing: 6) {
                Image(systemName: "scope").font(.system(size: 11)).foregroundStyle(Palette.mint)
                Picker("Context", selection: $chat.scope) { ForEach(ContextScope.allCases, id: \.self) { Text($0.rawValue).tag($0) } }.labelsHidden().pickerStyle(.menu).font(.system(size: 11))
                Spacer(minLength: 0)
                Button { if chat.scope == .selected { choosingSources = true } else { showingContext = true } } label: { Image(systemName: chat.scope == .selected ? "plus.circle" : "info.circle") }.buttonStyle(.plain).foregroundStyle(Palette.muted).help("Inspect note context")
            }.padding(.horizontal, 18).padding(.vertical, 12)
            if chat.scope == .selected { Button("\(chat.selectedSources.count) notes selected") { choosingSources = true }.buttonStyle(.plain).font(.system(size: 10)).foregroundStyle(Palette.mint).padding(.bottom, 8) }
            ScrollViewReader { proxy in
                ScrollView {
                    VStack(alignment: .leading, spacing: 22) {
                        if messages.isEmpty { welcome }
                        ForEach(messages) { message in messageView(message) }
                        if let id = model.selectedID, let error = chat.errors[id] { Text(error).font(.system(size: 11)).foregroundStyle(.orange).padding(12).frame(maxWidth: .infinity, alignment: .leading).background(Color.orange.opacity(0.08), in: RoundedRectangle(cornerRadius: 8)) }
                        Color.clear.frame(height: 1).id("bottom")
                    }.padding(.horizontal, 20).padding(.vertical, 20)
                }.onChange(of: messages.last?.content) { _, _ in proxy.scrollTo("bottom", anchor: .bottom) }
            }
            Spacer(minLength: 0)
            VStack(alignment: .leading, spacing: 10) {
                if model.selectedNote?.excludedFromAI == true { Label("This note is excluded from AI", systemImage: "lock").font(.system(size: 11)).foregroundStyle(Palette.muted) }
                VStack(alignment: .leading, spacing: 10) {
                    TextField("Ask, connect, or create…", text: $prompt, axis: .vertical).textFieldStyle(.plain).font(.system(size: 13)).lineLimit(2...6).onSubmit { send() }.accessibilityLabel("Message the assistant")
                    HStack {
                        Text(preferences.model.isEmpty ? "Add your API key →" : preferences.model).font(.system(size: 9, design: .monospaced)).foregroundStyle(Palette.muted).lineLimit(1).onTapGesture { model.showSettings = true }
                        Spacer()
                        if busy { Button { chat.stop() } label: { Image(systemName: "stop.fill").font(.system(size: 11)).frame(width: 28, height: 26).background(Palette.raised, in: RoundedRectangle(cornerRadius: 5)) }.buttonStyle(.plain).help("Stop generating") }
                        else { Button { send() } label: { Image(systemName: "arrow.up").font(.system(size: 13, weight: .semibold)).frame(width: 28, height: 26).foregroundStyle(Palette.sidebar).background(Palette.mint, in: RoundedRectangle(cornerRadius: 5)) }.buttonStyle(.plain).disabled(prompt.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty || model.selectedID == nil || model.selectedNote?.excludedFromAI == true).help("Send") }
                    }
                }.padding(13).background(Palette.canvas, in: RoundedRectangle(cornerRadius: 10)).overlay(RoundedRectangle(cornerRadius: 10).stroke(Palette.line))
                HStack { Text("Your key. Your choice of model."); Spacer(); Button { showingContext = true } label: { Text("Context").underline() }.buttonStyle(.plain) }.font(.system(size: 9)).foregroundStyle(Palette.muted)
            }.padding(16)
        }.background(Palette.panel)
        .onChange(of: model.aiSelection) { _, text in if !text.isEmpty { prompt = "About this selected text:\n\n" + text + "\n\n"; model.aiSelection = "" } }
        .onAppear { if model.selectedNote?.isChat == true && messages.isEmpty { chat.scope = .library }; if !model.aiSelection.isEmpty { prompt = "About this selected text:\n\n" + model.aiSelection + "\n\n"; model.aiSelection = "" }; if let id = model.selectedID { chat.load(id, model: model) } }
        .onChange(of: model.selectedID) { _, id in if let id { chat.load(id, model: model) } }
        .sheet(isPresented: $choosingSources) { sourcePicker }
        .sheet(isPresented: $showingContext) { contextPreview }
        .sheet(item: $draft) { message in DraftReview(message: message) }
        .confirmationDialog("Clear this conversation?", isPresented: $clearConfirmation) { Button("Clear conversation", role: .destructive) { if let id = model.selectedID { chat.clear(id, model: model) } } } message: { Text("Your notes will stay unchanged.") }
    }
    var welcome: some View {
        VStack(alignment: .leading, spacing: 15) {
            Image(systemName: "sparkle").font(.system(size: 32, weight: .ultraLight)).foregroundStyle(Palette.mint).padding(.top, 20)
            Text("A second mind.\nIn the margins.").font(.system(size: 25, weight: .regular, design: .serif)).lineSpacing(2)
            Text("Ask about your notes, find a connection, or give an unfinished thought a little room to grow.").font(.system(size: 12)).lineSpacing(5).foregroundStyle(Palette.muted)
            VStack(spacing: 8) {
                suggestion("Summarize this note", symbol: "text.alignleft", prompt: "Summarize this note clearly and concisely. Link to the note you used.")
                suggestion("Find the next steps", symbol: "checklist", prompt: "Identify the next steps in this note. Separate explicit commitments from your suggestions.")
                suggestion("Help me develop this", symbol: "arrow.triangle.branch", prompt: "Help me develop the ideas in this note. Point out useful connections and open questions.")
            }.padding(.top, 11)
            Text("Only the context you choose is sent to your AI provider.").font(.system(size: 10)).lineSpacing(3).foregroundStyle(Palette.muted.opacity(0.75)).padding(.top, 7)
        }
    }
    func suggestion(_ title: String, symbol: String, prompt: String) -> some View {
        Button { self.prompt = prompt; send() } label: { HStack { Image(systemName: symbol).font(.system(size: 11)).foregroundStyle(Palette.mint); Text(title).font(.system(size: 11)); Spacer(); Image(systemName: "arrow.up.right").font(.system(size: 9)).foregroundStyle(Palette.muted) }.padding(12).background(Palette.raised.opacity(0.5), in: RoundedRectangle(cornerRadius: 7)) }.buttonStyle(.plain).disabled(busy)
    }
    func messageView(_ message: ChatMessage) -> some View {
        VStack(alignment: .leading, spacing: 10) {
            HStack(spacing: 6) { Image(systemName: message.role == "user" ? "person.crop.circle" : "sparkles"); Text(message.role == "user" ? "YOU" : "FOLIO").tracking(1.2); Spacer() }.font(.system(size: 9, weight: .semibold)).foregroundStyle(message.role == "user" ? Palette.muted : Palette.mint)
            if message.content.isEmpty { if chat.busyNote == model.selectedID { ProgressView().controlSize(.small).padding(.vertical, 8) } else { Text("No response received.").font(.caption).foregroundStyle(Palette.muted) } }
            else { Text(.init(message.content)).font(.system(size: 12)).lineSpacing(5).textSelection(.enabled).tint(Palette.mint) }
            if message.role == "assistant", !message.content.isEmpty, chat.busyNote != model.selectedID {
                if !message.sourceIDs.isEmpty {
                    VStack(alignment: .leading, spacing: 5) { SectionEyebrow(text: "Context used"); ForEach(message.sourceIDs, id: \.self) { id in if let note = model.notes.first(where: { $0.id == id && !$0.trashed }) { Button { model.select(id) } label: { Label(note.displayTitle, systemImage: "doc.text").font(.system(size: 10)).lineLimit(1) }.buttonStyle(.plain).foregroundStyle(Palette.mint) } } }
                }
                HStack(spacing: 12) {
                    Button("Add to note") { if let id = model.selectedID { model.appendAI(message.content, noteID: id) } }
                    Button("New note") { let parsed = Markdown.parse(message.content, title: "From the assistant"); model.create(title: parsed.title, blocks: parsed.blocks) }
                    Menu {
                        Button("Copy response") { NSPasteboard.general.clearContents(); NSPasteboard.general.setString(message.content, forType: .string) }
                        Button("Review as replacement…") { draft = message }
                    } label: { Image(systemName: "ellipsis") }.menuStyle(.borderlessButton).fixedSize()
                }.buttonStyle(.plain).font(.system(size: 10)).foregroundStyle(Palette.muted)
            }
        }.padding(message.role == "user" ? 12 : 0).background(message.role == "user" ? Palette.raised.opacity(0.45) : .clear, in: RoundedRectangle(cornerRadius: 8))
    }
    func send() { let value = prompt; guard !busy else { return }; chat.send(value, model: model); if chat.busyNote != nil { prompt = "" } }
    var sourcePicker: some View {
        VStack(alignment: .leading, spacing: 18) { Text("Choose context").font(.title2); Text("Only selected notes are included. Notes excluded from AI are hidden.").font(.caption).foregroundStyle(Palette.muted); ScrollView { VStack(alignment: .leading, spacing: 12) { ForEach(model.notes.filter { !$0.trashed && !$0.excludedFromAI }) { note in Toggle(note.displayTitle, isOn: Binding(get: { chat.selectedSources.contains(note.id) }, set: { if $0 { chat.selectedSources.insert(note.id) } else { chat.selectedSources.remove(note.id) } })) } } }; Button("Done") { choosingSources = false }.buttonStyle(QuietButton(accent: true)) }.padding(28).frame(width: 440, height: 460).background(Palette.canvas)
    }
    var contextPreview: some View {
        let context = ContextBuilder.build(notes: chat.sources(model: model, query: prompt))
        return VStack(alignment: .leading, spacing: 16) {
            Text("What the assistant can see").font(.title2)
            Text("This preview shows note excerpts for your next message. The request also includes your message and up to 12 recent conversation messages. Search library retrieves matching notes; it does not send the entire library. Note excerpts are capped at 48,000 characters.").font(.system(size: 12)).foregroundStyle(Palette.muted)
            ScrollView { Text(context.text.isEmpty ? "No note content selected." : context.text).font(.system(size: 11, design: .monospaced)).textSelection(.enabled).frame(maxWidth: .infinity, alignment: .leading) }.padding(14).background(Palette.sidebar, in: RoundedRectangle(cornerRadius: 8))
            HStack { Text("\(context.ids.count) notes · \(context.text.count) characters").font(.caption).foregroundStyle(Palette.muted); Spacer(); Button("Done") { showingContext = false }.buttonStyle(QuietButton(accent: true)) }
        }.padding(28).frame(width: 650, height: 560).background(Palette.canvas)
    }
}
struct DraftReview: View {
    @EnvironmentObject var model: AppModel
    @Environment(\.dismiss) var dismiss
    var message: ChatMessage
    var body: some View {
        VStack(alignment: .leading, spacing: 18) {
            Text("Review your new draft").font(.system(size: 24, design: .serif))
            Text("Applying this draft replaces the current note’s body. Its title stays the same, and a version is saved in Note history.").font(.system(size: 12)).foregroundStyle(Palette.muted)
            HStack(alignment: .top, spacing: 20) {
                VStack(alignment: .leading) { SectionEyebrow(text: "Current note"); ScrollView { Text(model.selectedNote.map { Markdown.render($0) } ?? "").font(.system(size: 12)).textSelection(.enabled).frame(maxWidth: .infinity, alignment: .leading) } }
                VStack(alignment: .leading) { SectionEyebrow(text: "Proposed draft"); ScrollView { Text(message.content).font(.system(size: 12)).textSelection(.enabled).frame(maxWidth: .infinity, alignment: .leading) } }
            }.padding(16).background(Palette.sidebar, in: RoundedRectangle(cornerRadius: 8))
            HStack { Button("Cancel") { dismiss() }.buttonStyle(QuietButton()); Spacer(); Button("Apply draft") { if let id = model.selectedID { model.appendAI(message.content, noteID: id, replace: true) }; dismiss() }.buttonStyle(QuietButton(accent: true)) }
        }.padding(28).frame(width: 800, height: 580).background(Palette.canvas)
    }
}
