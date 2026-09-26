import SwiftUI
import AppKit
import FolioCore

private enum BlockVisibility {
    static func hiddenIDs(_ blocks: [Block]) -> Set<UUID> {
        var hidden: Set<UUID> = []; var collapsedLevel: Int?; var collapsedToggle = false
        for block in blocks {
            if let level = collapsedLevel {
                if block.kind.headingLevel > 0 && block.kind.headingLevel <= level { collapsedLevel = nil }
                else { hidden.insert(block.id); continue }
            }
            if collapsedToggle {
                if block.kind == .toggle || block.kind.headingLevel > 0 { collapsedToggle = false }
                else { hidden.insert(block.id); continue }
            }
            if block.kind.isToggleHeading && block.checked { collapsedLevel = block.kind.headingLevel }
            if block.kind == .toggle && block.checked { collapsedToggle = true }
        }
        return hidden
    }
    static func visible(_ blocks: [Block]) -> [Block] { let hidden = hiddenIDs(blocks); return blocks.filter { !hidden.contains($0.id) } }
    static func merge(_ updated: [Block], into original: [Block]) -> [Block] {
        let hidden = hiddenIDs(original); var index = 0; var result: [Block] = []
        for old in original {
            if hidden.contains(old.id) { result.append(old) }
            else if index < updated.count { result.append(updated[index]); index += 1 }
        }
        if index < updated.count { result.append(contentsOf: updated.dropFirst(index)) }
        return result.isEmpty ? [Block()] : result
    }
}

struct NoteEditorView: View {
    @EnvironmentObject var model: AppModel
    @EnvironmentObject var preferences: Preferences
    var noteID: UUID
    @EnvironmentObject var voice: VoiceController
    @State private var editorHeight: CGFloat = 400
    @State private var tagDraft = ""
    @State private var showTags = false
    @State private var showIconPicker = false
    var note: Note? { model.notes.first { $0.id == noteID } }
    var body: some View {
        if let note {
            VStack(spacing: 0) {
                header(note)
                Rectangle().fill(Palette.line).frame(height: 1)
                if note.trashed {
                    HStack { Text("This note is in Trash."); Spacer(); Button("Restore") { model.trash(noteID, restore: true) }.buttonStyle(QuietButton(accent: true)) }.font(.system(size: 12)).padding().background(Palette.raised)
                }
                if voice.listening || !voice.partial.isEmpty {
                    HStack { Image(systemName: "mic.fill").foregroundStyle(.orange); Text(voice.partial.isEmpty ? "Listening… Stop to insert the text at your cursor." : voice.partial).lineLimit(3); Spacer(); Button("Stop & insert") { voice.stopListening() } }.font(.system(size: 12)).padding(12).background(Palette.raised)
                }
                if voice.speaking {
                    HStack { Label("Reading aloud", systemImage: "speaker.wave.2"); Spacer(); Button(voice.paused ? "Resume" : "Pause") { voice.pauseResume() }; Button("Stop") { voice.stopReading() } }.font(.system(size: 12)).padding(12).background(Palette.raised)
                }
                if let error = voice.error { HStack { Image(systemName: "info.circle"); Text(error).lineLimit(3); Spacer(); Button { voice.error = nil } label: { Image(systemName: "xmark") }.buttonStyle(.plain) }.font(.system(size: 11)).foregroundStyle(Palette.muted).padding(10).background(Palette.raised) }
                ScrollView {
                    VStack(alignment: .leading, spacing: 0) {
                        HStack {
                            Button { showIconPicker = true } label: { NoteIconView(value: note.icon, size: 23, tint: Palette.mint).frame(width: 42, height: 42).background(Palette.mint.opacity(0.08), in: RoundedRectangle(cornerRadius: 13)) }.buttonStyle(.plain).help("Customize page icon").accessibilityLabel("Customize page icon")
                                .popover(isPresented: $showIconPicker, arrowEdge: .bottom) { NoteIconPicker(selected: note.icon) { icon in model.edit(noteID) { $0.icon = icon }; showIconPicker = false } }
                            Spacer()
                            if note.excludedFromAI { Label("Private · excluded from AI", systemImage: "lock").font(.system(size: 10)).foregroundStyle(Palette.muted) }
                        }.padding(.bottom, 12)
                        TextField("Untitled", text: Binding(get: { self.note?.title ?? "" }, set: { text in model.edit(noteID) { $0.title = text } }), axis: .vertical)
                            .textFieldStyle(.plain).font(.system(size: 32, weight: .medium, design: .serif)).foregroundStyle(Palette.text).lineSpacing(2)
                            .accessibilityLabel("Note title")
                        HStack(spacing: 8) {
                            Text(note.modified.formatted(date: .abbreviated, time: .omitted)); Text("·"); Text("\(note.wordCount) words")
                            ForEach(note.tags.filter { !$0.hasPrefix("calendar:") }, id: \.self) { tag in Text("#" + tag).foregroundStyle(Palette.mint.opacity(0.85)).padding(.horizontal, 6).padding(.vertical, 3).background(Palette.mint.opacity(0.07), in: Capsule()) }
                            Button { showTags.toggle() } label: { Image(systemName: "plus").font(.system(size: 9)) }.buttonStyle(.plain).help("Edit tags")
                                .popover(isPresented: $showTags) { VStack(alignment: .leading, spacing: 12) { Text("Tags").font(.headline); TextField("ideas, personal, project", text: $tagDraft).textFieldStyle(.roundedBorder); Text("Separate tags with commas.").font(.caption).foregroundStyle(.secondary); Button("Save tags") { model.edit(noteID) { $0.tags = Array(Set(tagDraft.split(separator: ",").map { $0.trimmingCharacters(in: .whitespaces).replacingOccurrences(of: "#", with: "") }.filter { !$0.isEmpty })).sorted() }; showTags = false }.buttonStyle(QuietButton(accent: true)) }.padding(20).frame(width: 270).onAppear { tagDraft = note.tags.joined(separator: ", ") } }
                        }.font(.system(size: 10)).foregroundStyle(Palette.muted).padding(.top, 10).padding(.bottom, 14)
                        if let table = note.table {
                            DatabaseTableView(table: table, onChange: { value in model.edit(noteID) { $0.table = value } }, onImport: { model.importTableCSV(into: noteID) }, onExport: { if let current = model.notes.first(where: { $0.id == noteID }) { model.exportTableCSV(current) } })
                                .padding(.top, 8).frame(minHeight: 330)
                        } else {
                            let visibleBlocks = BlockVisibility.visible(note.blocks)
                            GeometryReader { geometry in
                                DocumentEditor(blocks: visibleBlocks, size: preferences.fontSize, strength: preferences.highlightStrength, width: geometry.size.width, library: model.library, voice: voice, onChange: { blocks in model.edit(noteID) { $0.blocks = BlockVisibility.merge(blocks, into: $0.blocks) } }, onDictationFallback: { text in model.edit(noteID) { $0.blocks.append(Block(text: text, marks: [])) } }, onCreatePage: { title, nested in
                                    let parent = nested ? noteID : (note.parentID ?? noteID)
                                    return model.createLinkedSubpage(title: title, parent: parent)
                                }, onToggleBlock: { id in model.edit(noteID) { note in if let index = note.blocks.firstIndex(where: { $0.id == id }) { note.blocks[index].checked.toggle() } } }, height: $editorHeight)
                                    .frame(width: geometry.size.width, height: editorHeight)
                            }.frame(height: editorHeight)
                        }
                        let children = model.notes.filter { $0.parentID == note.id && !$0.trashed }
                        if !children.isEmpty {
                            SectionEyebrow(text: "Subpages").padding(.top, 36).padding(.bottom, 12)
                            ForEach(children) { child in Button { model.select(child.id) } label: { HStack { NoteIconView(value: child.icon, size: 14, tint: Palette.mint); Text(child.displayTitle); Spacer(); Image(systemName: "arrow.up.right") }.font(.system(size: 13)).padding(14).background(Palette.raised.opacity(0.4), in: RoundedRectangle(cornerRadius: 8)) }.buttonStyle(.plain).padding(.bottom, 6) }
                        }
                        let backlinks = model.notes.filter { $0.id != note.id && !$0.trashed && ($0.plainBody.localizedCaseInsensitiveContains("[[\(note.displayTitle)]]") || $0.plainBody.contains("folio://note/\(note.id.uuidString)")) }
                        if !backlinks.isEmpty {
                            SectionEyebrow(text: "Linked from").padding(.top, 30).padding(.bottom, 12)
                            ForEach(backlinks) { linked in Button(linked.displayTitle) { model.select(linked.id) }.buttonStyle(.plain).foregroundStyle(Palette.mint).font(.system(size: 12)).padding(.bottom, 8) }
                        }
                    }.padding(.horizontal, 28).padding(.top, 22).padding(.bottom, 30).frame(maxWidth: .infinity)
                }
                HStack(spacing: 6) { Image(systemName: model.pending.isEmpty ? "checkmark.circle" : "circle.dotted"); Text(model.status); Spacer(); Text("MARKDOWN FRIENDLY").font(.system(size: 8, weight: .medium)).tracking(1.3) }.font(.system(size: 10)).foregroundStyle(Palette.muted.opacity(0.75)).padding(.horizontal, 27).padding(.vertical, 12).background(Palette.canvas)
            }
        }
    }
    func header(_ note: Note) -> some View {
        HStack(spacing: 10) {
            Text("Notebook").foregroundStyle(Palette.muted); Text("/").foregroundStyle(Palette.muted.opacity(0.4))
            if let parent = model.notes.first(where: { $0.id == note.parentID }) { Button(parent.displayTitle) { model.select(parent.id) }.buttonStyle(.plain).lineLimit(1); Text("/").foregroundStyle(Palette.muted.opacity(0.4)) }
            Text(note.displayTitle).lineLimit(1); Spacer(minLength: 5)
            Menu { Button("Markdown (.md)…") { model.exportSelected(plain: false) }; Button("Plain text (.txt)…") { model.exportSelected(plain: true) }; Button("PDF (.pdf)…") { model.exportPDF() } } label: { Label("Export", systemImage: "square.and.arrow.up") }.menuStyle(.borderlessButton).fixedSize()
            Button { NotificationCenter.default.post(name: .folioDictate, object: nil) } label: { Label(voice.listening ? "Stop" : "Listen", systemImage: voice.listening ? "stop.circle.fill" : "mic") }.buttonStyle(.plain).foregroundStyle(voice.listening ? Color.orange : Palette.muted).help("Dictate into this page")
            Button { NotificationCenter.default.post(name: .folioRead, object: nil) } label: { Image(systemName: "speaker.wave.2") }.buttonStyle(.plain).help("Read selection or page aloud")
            Menu { ForEach(BlockKind.allCases.filter { $0 != .attachment }, id: \.self) { kind in Button(kind.title) { NotificationCenter.default.post(name: .folioFormat, object: kind.rawValue) } } } label: { Image(systemName: "textformat") }.menuStyle(.borderlessButton).fixedSize().help("Paragraph style")
            Button { model.edit(noteID) { $0.favorite.toggle() } } label: { Image(systemName: note.favorite ? "star.fill" : "star").foregroundStyle(note.favorite ? Palette.mint : Palette.muted) }.buttonStyle(.plain).help("Favorite")
            Button { model.showMeeting = true } label: { Image(systemName: "waveform") }.buttonStyle(.plain).padding(.horizontal, 6).help("Meeting recorder")
            Menu {
                Button("Export Markdown…") { model.exportSelected(plain: false) }; Button("Export plain text…") { model.exportSelected(plain: true) }
                if note.table != nil { Button("Export database CSV…") { model.exportTableCSV(note) }; Button("Import Notion CSV…") { model.importTableCSV(into: note.id) } }
                Button("Read local files / OCR…") { model.readFiles() }; Divider(); Button("Add subpage") { model.create(parent: note.id) }; Button("Attach a file…") { model.attachFile() }
                Menu("Move into") { Button("Notebook root") { model.setParent(nil, for: note.id) }; ForEach(model.notes.filter { $0.id != note.id && !$0.trashed }) { candidate in Button(candidate.displayTitle) { model.setParent(candidate.id, for: note.id) } } }
                Button("Duplicate note") { model.duplicate(note) }
                Button("Note history…") { model.showHistory = true }
                Button(note.excludedFromAI ? "Allow AI to use this note" : "Exclude this note from AI") { model.edit(note.id) { $0.excludedFromAI.toggle() } }
                Button("Copy note link") { NSPasteboard.general.clearContents(); NSPasteboard.general.setString("[\(note.displayTitle)](folio://note/\(note.id.uuidString))", forType: .string) }
                Button("Add library table") { model.createLibraryTable(parent: note.id) }
                Divider(); Button(note.trashed ? "Restore note" : "Move to Trash") { model.trash(note.id, restore: note.trashed) }
            } label: { Image(systemName: "ellipsis").frame(width: 22) }.menuStyle(.borderlessButton).fixedSize().help("Note options")
            Button { withAnimation(.easeInOut(duration: 0.15)) { model.showAI.toggle() } } label: { Image(systemName: "sparkles").foregroundStyle(model.showAI ? Palette.mint : Palette.muted) }.buttonStyle(.plain).help("Toggle assistant · ⌘J")
        }.font(.system(size: 11)).padding(.horizontal, 25).frame(height: 44).padding(.top, 10)
    }
}
