import SwiftUI
import FolioCore
struct SidebarView: View {
    @EnvironmentObject var model: AppModel
    @EnvironmentObject var calendar: CalendarController
    @EnvironmentObject var chat: ChatModel
    @FocusState private var searchFocused: Bool
    @State private var collapsed: Set<UUID> = []
    var body: some View {
        VStack(alignment: .leading, spacing: 0) {
            HStack(spacing: 10) {
                Image(systemName: "leaf.fill").font(.system(size: 22)).foregroundStyle(Palette.mint)
                Text("folio").font(.system(size: 28, weight: .medium, design: .serif)).tracking(-1)
                Spacer(); Text("PERSONAL").font(.system(size: 8, weight: .bold)).tracking(1.2).foregroundStyle(Palette.muted)
            }.padding(.horizontal, 22).padding(.top, 30).padding(.bottom, 16)
            HStack(spacing: 8) {
                Image(systemName: "magnifyingglass").foregroundStyle(Palette.muted)
                TextField("Find a note…", text: $model.query).textFieldStyle(.plain).font(.system(size: 12)).focused($searchFocused)
                Text("⌘K").font(.system(size: 10)).foregroundStyle(Palette.muted)
            }.padding(10).background(Palette.raised.opacity(0.5), in: RoundedRectangle(cornerRadius: 8)).padding(.horizontal, 16)
                .onChange(of: model.query) { _, _ in model.search() }
            HStack(spacing: 7) {
                Button { model.create() } label: { HStack { Image(systemName: "plus"); Text("New note"); Spacer(); Text("⌘N").opacity(0.55) } }.buttonStyle(QuietButton(accent: true))
                Menu { Button("Library database", systemImage: "books.vertical") { model.createLibraryTable() }; Button("Blank table", systemImage: "tablecells") { model.createTable() } } label: { Image(systemName: "tablecells").frame(width: 34, height: 34).background(Palette.raised, in: RoundedRectangle(cornerRadius: 7)) }.menuStyle(.borderlessButton).help("New database")
            }.padding(.horizontal, 16).padding(.top, 12).padding(.bottom, 12)
            VStack(spacing: 4) {
                Button { model.home = true; model.query = "" } label: { Label("Home & Calendar", systemImage: "house").frame(maxWidth: .infinity, alignment: .leading).padding(10) }.buttonStyle(.plain).font(.system(size: 12)).background(model.home ? Palette.raised : .clear, in: RoundedRectangle(cornerRadius: 7))
                nav("Pages", icon: "doc.text", filter: "pages", count: model.notes.filter { !$0.trashed && !$0.isMeeting && $0.isChat != true }.count)
                nav("AI chats", icon: "bubble.left.and.bubble.right", filter: "chats", count: model.notes.filter { !$0.trashed && ($0.isChat == true || model.chatIDs.contains($0.id)) }.count)
                nav("Favorites", icon: "star", filter: "favorites", count: model.notes.filter { $0.favorite && !$0.trashed }.count)
                nav("Meetings", icon: "waveform", filter: "meetings", count: model.notes.filter { $0.isMeeting && !$0.trashed }.count)
            }.padding(.horizontal, 12)
            if calendar.connected && !calendar.events.isEmpty {
                SectionEyebrow(text: "Upcoming").padding(.horizontal, 23).padding(.top, 18).padding(.bottom, 8)
                ForEach(calendar.events.prefix(2)) { event in Button { model.home = true } label: { HStack { Image(systemName: event.joinURL == nil ? "calendar" : "video"); Text(event.title).lineLimit(1); Spacer(); Text(event.start.formatted(.dateTime.hour().minute())).font(.system(size: 10)) }.font(.system(size: 11)).foregroundStyle(Palette.muted).padding(.horizontal, 22).padding(.vertical, 6) }.buttonStyle(.plain) }
            }
            HStack { SectionEyebrow(text: model.query.isEmpty ? (model.filter == "chats" ? "AI chats" : model.filter == "meetings" ? "Meetings" : "Your pages") : "Search results"); Spacer(); Button { if model.filter == "chats" { model.createChat() } else { model.create() } } label: { Image(systemName: "plus").font(.system(size: 11)) }.buttonStyle(.plain).foregroundStyle(Palette.muted).help("New note") }.padding(.horizontal, 23).padding(.top, 18).padding(.bottom, 10)
            ScrollView {
                LazyVStack(alignment: .leading, spacing: 3) {
                    ForEach(displayRows, id: \.note.id) { row in noteRow(row.note, depth: row.depth) }
                    if model.visibleNotes.isEmpty { Text(model.query.isEmpty ? "No notes here yet." : "No matching notes.").font(.system(size: 12)).foregroundStyle(Palette.muted).padding(12) }
                    if !model.tags.filter({ !$0.hasPrefix("calendar:") }).isEmpty {
                        SectionEyebrow(text: "Tags").padding(.top, 28).padding(.leading, 11).padding(.bottom, 8)
                        ForEach(model.tags.filter { !$0.hasPrefix("calendar:") }, id: \.self) { tag in
                            Button { model.filter = "tag:" + tag; model.query = "" } label: { HStack { Text("#").foregroundStyle(Palette.mint.opacity(0.6)); Text(tag).lineLimit(1); Spacer() }.font(.system(size: 12)).padding(.horizontal, 11).padding(.vertical, 7).background(model.filter == "tag:" + tag ? Palette.raised : .clear, in: RoundedRectangle(cornerRadius: 6)) }.buttonStyle(.plain).foregroundStyle(Palette.muted)
                        }
                    }
                }.padding(.horizontal, 12)
            }
            Menu { Button("Read documents / OCR…") { model.readFiles() }; Button("OCR every PDF page…") { model.readFiles(forceOCR: true) }; Button("Import Markdown / Folio archive…") { model.importNotes() } } label: { Label("Import files", systemImage: "doc.badge.plus") }.menuStyle(.borderlessButton).padding(.horizontal, 22).padding(.vertical, 12)
            Rectangle().fill(Palette.line).frame(height: 1).padding(.horizontal, 18)
            HStack {
                Button { model.filter = "trash"; model.query = "" } label: { Label("Trash", systemImage: "trash").font(.system(size: 12)) }.buttonStyle(.plain).foregroundStyle(Palette.muted)
                Spacer()
                Button { model.showSettings = true } label: { Image(systemName: "slider.horizontal.3").font(.system(size: 14)) }.buttonStyle(.plain).foregroundStyle(Palette.muted).help("Settings · ⌘,")
            }.padding(22)
            HStack(spacing: 6) { Circle().fill(Palette.mint).frame(width: 5, height: 5); Text("On your Mac. Always yours.").font(.system(size: 10)) }.foregroundStyle(Palette.muted).padding(.horizontal, 22).padding(.bottom, 18)
        }.background(Palette.sidebar)
        .onReceive(NotificationCenter.default.publisher(for: .folioSearch)) { _ in searchFocused = true }
    }
    func nav(_ title: String, icon: String, filter: String, count: Int) -> some View {
        Button { model.filter = filter; model.query = ""; model.home = false; if filter == "chats" { chat.scope = .library; model.showAI = true }; if let first = model.visibleNotes.first { model.select(first.id) } } label: { HStack(spacing: 11) { Image(systemName: icon).frame(width: 15); Text(title); Spacer(); Text("\(count)").font(.system(size: 10, design: .monospaced)).foregroundStyle(Palette.muted) }.font(.system(size: 12, weight: model.filter == filter ? .medium : .regular)).padding(.horizontal, 12).padding(.vertical, 10).background(model.filter == filter ? Palette.raised.opacity(0.6) : .clear, in: RoundedRectangle(cornerRadius: 7)) }.buttonStyle(.plain).foregroundStyle(model.filter == filter ? Palette.text : Palette.muted)
    }
    var displayRows: [(note: Note, depth: Int)] {
        let notes = model.visibleNotes
        guard ["all", "pages"].contains(model.filter), model.query.isEmpty else { return notes.map { ($0, 0) } }
        let ids = Set(notes.map(\.id)); var rows: [(Note, Int)] = []; var visited: Set<UUID> = []
        func add(_ note: Note, depth: Int) {
            guard visited.insert(note.id).inserted else { return }; rows.append((note, min(depth, 4)))
            if !collapsed.contains(note.id) { for child in notes where child.parentID == note.id { add(child, depth: depth + 1) } }
        }
        for note in notes where note.parentID == nil || !ids.contains(note.parentID!) { add(note, depth: 0) }
        return rows
    }
    func noteRow(_ note: Note, depth: Int) -> some View {
        HStack(spacing: 6) {
            if model.notes.contains(where: { $0.parentID == note.id && !$0.trashed }) {
                Button { if collapsed.contains(note.id) { collapsed.remove(note.id) } else { collapsed.insert(note.id) } } label: { Image(systemName: collapsed.contains(note.id) ? "chevron.right" : "chevron.down").font(.system(size: 8)).frame(width: 9) }.buttonStyle(.plain)
            } else { Color.clear.frame(width: 9) }
            NoteIconView(value: note.icon, size: 13, tint: model.selectedID == note.id ? Palette.mint : Palette.muted)
            Text(note.displayTitle).font(.system(size: 12)).lineLimit(1); Spacer(minLength: 0)
            if note.excludedFromAI { Image(systemName: "lock").font(.system(size: 9)).foregroundStyle(Palette.muted) }
        }.padding(.leading, 6 + CGFloat(depth * 12)).padding(.trailing, 10).padding(.vertical, 10)
            .background(model.selectedID == note.id ? Palette.mint.opacity(0.09) : .clear, in: RoundedRectangle(cornerRadius: 7))
            .contentShape(Rectangle()).onTapGesture { model.select(note.id) }
            .contextMenu {
                Button("New subpage") { model.create(parent: note.id) }
                Button(note.favorite ? "Remove favorite" : "Favorite") { model.edit(note.id) { $0.favorite.toggle() } }
                Button("Duplicate") { model.duplicate(note) }
                Button(note.trashed ? "Restore note" : "Move to Trash") { model.trash(note.id, restore: note.trashed) }
            }
    }
}
