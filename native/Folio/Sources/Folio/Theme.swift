import SwiftUI

enum Palette {
    static let canvas = Color(red: 0.094, green: 0.106, blue: 0.102)
    static let sidebar = Color(red: 0.068, green: 0.080, blue: 0.075)
    static let panel = Color(red: 0.106, green: 0.122, blue: 0.114)
    static let raised = Color(red: 0.15, green: 0.17, blue: 0.16)
    static let mint = Color(red: 0.66, green: 0.85, blue: 0.71)
    static let text = Color(red: 0.90, green: 0.91, blue: 0.87)
    static let muted = Color(red: 0.55, green: 0.60, blue: 0.56)
    static let line = Color.white.opacity(0.075)
}
struct QuietButton: ButtonStyle {
    var accent = false
    func makeBody(configuration: Configuration) -> some View {
        configuration.label.font(.system(size: 12, weight: .medium))
            .padding(.horizontal, 11).padding(.vertical, 8)
            .foregroundStyle(accent ? Palette.sidebar : Palette.text)
            .background(accent ? Palette.mint.opacity(configuration.isPressed ? 0.7 : 1) : Palette.raised.opacity(configuration.isPressed ? 1 : 0.5), in: RoundedRectangle(cornerRadius: 7))
    }
}
struct SectionEyebrow: View {
    var text: String
    var body: some View { Text(text.uppercased()).font(.system(size: 10, weight: .semibold)).tracking(1.8).foregroundStyle(Palette.muted) }
}
struct EmptyState: View {
    var icon: String; var title: String; var detail: String
    var body: some View { VStack(spacing: 14) { Image(systemName: icon).font(.system(size: 30, weight: .light)).foregroundStyle(Palette.mint); Text(title).font(.system(size: 21, weight: .medium, design: .serif)); Text(detail).font(.system(size: 13)).foregroundStyle(Palette.muted).multilineTextAlignment(.center).frame(maxWidth: 320) }.padding(30).frame(maxWidth: .infinity, maxHeight: .infinity) }
}

struct NoteIconView: View {
    var value: String
    var size: CGFloat = 16
    var tint: Color = Palette.muted
    private var emoji: Bool {
        value.unicodeScalars.contains { $0.properties.isEmojiPresentation || ($0.properties.isEmoji && $0.value > 0x238C) }
    }
    var body: some View {
        Group {
            if emoji { Text(value).font(.system(size: size)) }
            else { Image(systemName: value).font(.system(size: size, weight: .regular)).foregroundStyle(tint) }
        }.frame(width: size + 8, height: size + 8).accessibilityLabel(emoji ? value : value.replacingOccurrences(of: ".", with: " "))
    }
}

struct NoteIconPicker: View {
    var selected: String
    var onSelect: (String) -> Void
    @State private var query = ""
    private let emojiGroups: [(String, [String])] = [
        ("Favorites", ["⭐️", "❤️", "✨", "🔥", "💡", "🎯", "🌱", "📌", "✅", "📚", "🎨", "💼", "🏠", "💬"]),
        ("People & feelings", ["😀", "😊", "🥳", "🤔", "😎", "🙏", "💪", "🧠", "🫶", "👋"]),
        ("Nature", ["🌱", "🌿", "🌳", "🌻", "🌸", "🌈", "☀️", "🌙", "🌊", "🍀"]),
        ("Objects", ["📝", "📖", "📕", "📎", "📁", "🗂️", "💻", "📷", "🎧", "🔑", "🕰️", "🧭"]),
        ("Travel & places", ["🏠", "🏢", "🏫", "🏥", "⚖️", "✈️", "🚗", "🌍", "🏖️", "⛰️"]),
        ("Food & activities", ["☕️", "🍎", "🍋", "🥑", "🍜", "🍰", "⚽️", "🏀", "🏋️", "🎸"])
    ]
    private let symbols = ["doc.text", "doc.richtext", "book", "books.vertical", "folder", "folder.fill", "tray.full", "bookmark", "bookmark.fill", "star", "heart", "lightbulb", "sparkles", "brain.head.profile", "bubble.left", "bubble.left.and.bubble.right", "quote.opening", "pencil", "highlighter", "paperclip", "link", "calendar", "calendar.day.timeline.left", "clock", "checkmark.circle", "checklist", "list.bullet", "graduationcap", "briefcase", "building.2", "house", "cross.case", "stethoscope", "scales", "banknote", "chart.bar", "leaf", "globe.americas", "map", "location", "airplane", "car", "figure.run", "dumbbell", "music.note", "camera", "paintpalette", "wand.and.stars", "shippingbox", "wrench.and.screwdriver", "gearshape", "lock", "key", "flag", "tag", "archivebox", "waveform", "mic", "captions.bubble", "video", "person", "person.2", "graduationcap.fill", "house.fill"]
    private let emojiNames: [String: String] = ["⭐️": "star favorite", "❤️": "heart love", "✨": "sparkles magic", "🔥": "fire hot", "💡": "lightbulb idea", "🎯": "target goal", "🌱": "seedling plant", "📌": "pin", "✅": "check mark done", "📚": "books reading study", "🎨": "art paint", "💼": "briefcase work", "🏠": "house home", "💬": "chat conversation", "😀": "smile happy", "😊": "smile blush", "🥳": "party celebration", "🤔": "thinking", "😎": "cool", "🙏": "prayer thanks", "💪": "strength exercise", "🧠": "brain mind", "🫶": "care hands", "👋": "wave hello", "🌿": "herb leaf", "🌳": "tree", "🌻": "sunflower", "🌸": "flower blossom", "🌈": "rainbow", "☀️": "sun", "🌙": "moon night", "🌊": "ocean water", "🍀": "clover luck", "📝": "memo writing notes", "📖": "open book", "📕": "red book", "📎": "paperclip attachment", "📁": "folder file", "💻": "computer", "📷": "camera photo", "🎧": "headphones audio", "🔑": "key", "🕰️": "clock time", "🧭": "compass", "🏢": "office building", "🏫": "school", "🏥": "hospital", "⚖️": "scales justice law", "✈️": "airplane travel", "🚗": "car", "🌍": "earth world", "🏖️": "beach", "⛰️": "mountain", "☕️": "coffee", "🍎": "apple fruit", "🍋": "lemon", "🥑": "avocado", "🍜": "noodles food", "🍰": "cake dessert", "⚽️": "soccer ball", "🏀": "basketball", "🏋️": "lifting fitness gym", "🎸": "guitar music"]
    private var filteredGroups: [(String, [String])] {
        guard !query.isEmpty else { return emojiGroups }
        let matching = emojiGroups.map { ($0.0, $0.1.filter { $0.localizedCaseInsensitiveContains(query) || (emojiNames[$0]?.localizedCaseInsensitiveContains(query) ?? false) }) }.filter { !$0.1.isEmpty }
        return matching
    }
    private var filteredSymbols: [String] { query.isEmpty ? symbols : symbols.filter { $0.localizedCaseInsensitiveContains(query) } }
    var body: some View {
        VStack(alignment: .leading, spacing: 10) {
            HStack { Text("Page icon").font(.system(size: 14, weight: .semibold)); Spacer(); if !selected.isEmpty { Button("Reset") { onSelect("doc.text") }.font(.system(size: 11)) } }
            TextField("Search icons or symbols", text: $query).textFieldStyle(.roundedBorder)
            ScrollView {
                VStack(alignment: .leading, spacing: 12) {
                    ForEach(filteredGroups, id: \.0) { title, icons in
                        VStack(alignment: .leading, spacing: 5) {
                            Text(title).font(.system(size: 10, weight: .medium)).foregroundStyle(Palette.muted)
                            LazyVGrid(columns: Array(repeating: GridItem(.flexible(), spacing: 2), count: 8), spacing: 3) {
                                ForEach(Array(icons.enumerated()), id: \.offset) { _, icon in iconButton(icon) }
                            }
                        }
                    }
                    VStack(alignment: .leading, spacing: 5) {
                        Text("Symbols").font(.system(size: 10, weight: .medium)).foregroundStyle(Palette.muted)
                        LazyVGrid(columns: Array(repeating: GridItem(.flexible(), spacing: 2), count: 8), spacing: 3) {
                            ForEach(filteredSymbols, id: \.self) { icon in iconButton(icon) }
                        }
                    }
                    if filteredGroups.isEmpty && filteredSymbols.isEmpty { Text("No matching icons.").font(.system(size: 12)).foregroundStyle(Palette.muted).padding(12) }
                }.padding(.vertical, 4)
            }
        }.padding(14).frame(width: 310, height: 390).background(Palette.panel).preferredColorScheme(.dark)
    }
    func iconButton(_ icon: String) -> some View {
        Button { onSelect(icon) } label: { NoteIconView(value: icon, size: 19, tint: icon == selected ? Palette.mint : Palette.text).frame(maxWidth: .infinity).frame(height: 31).background(icon == selected ? Palette.mint.opacity(0.13) : .clear, in: RoundedRectangle(cornerRadius: 5)) }
            .buttonStyle(.plain).help(icon).accessibilityLabel(icon).accessibilityAddTraits(icon == selected ? .isSelected : [])
    }
}
