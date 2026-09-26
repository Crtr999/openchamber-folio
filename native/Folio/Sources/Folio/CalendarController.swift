import SwiftUI
import EventKit
import UserNotifications
import FolioCore

struct CalendarMeeting: Identifiable, Equatable, Codable {
    var id: String
    var title: String
    var start: Date
    var end: Date
    var calendar: String
    var joinURL: URL?
}
enum CalendarRules {
    static func meetingURL(_ text: String) -> URL? {
        guard let detector = try? NSDataDetector(types: NSTextCheckingResult.CheckingType.link.rawValue) else { return nil }
        for match in detector.matches(in: text, range: NSRange(text.startIndex..., in: text)) {
            guard let url = match.url, ["https", "http"].contains(url.scheme ?? ""), let host = url.host?.lowercased() else { continue }
            if ["zoom.us", "teams.microsoft.com", "teams.live.com", "teams.cloud.microsoft", "meet.google.com"].contains(where: { host == $0 || host.hasSuffix("." + $0) }) { return url }
        }
        return nil
    }
    static func shouldPrompt(_ event: CalendarMeeting, now: Date, seen: Set<String>) -> Bool {
        event.joinURL != nil && !seen.contains(event.id) && event.start <= now.addingTimeInterval(60) && event.start > now.addingTimeInterval(-300) && event.end > now
    }
}
@MainActor final class CalendarController: NSObject, ObservableObject, UNUserNotificationCenterDelegate {
    @Published var connected = false
    @Published var events: [CalendarMeeting] = []
    @Published var prompt: CalendarMeeting?
    @Published var error: String?
    @Published var reminders = UserDefaults.standard.object(forKey: "calendarReminders") as? Bool ?? true
    private let store = EKEventStore()
    private var timer: Timer?
    private var seen = Set(UserDefaults.standard.stringArray(forKey: "calendarSeen") ?? [])
    private var observer: NSObjectProtocol?
    override init() {
        super.init()
        connected = EKEventStore.authorizationStatus(for: .event) == .fullAccess
        UNUserNotificationCenter.current().delegate = self
        if connected { refresh() }
        timer = Timer.scheduledTimer(withTimeInterval: 30, repeats: true) { [weak self] _ in Task { @MainActor in self?.refresh() } }
        observer = NotificationCenter.default.addObserver(forName: .EKEventStoreChanged, object: nil, queue: .main) { [weak self] _ in Task { @MainActor in self?.refresh() } }
    }
    deinit { timer?.invalidate(); if let observer { NotificationCenter.default.removeObserver(observer) } }
    func connect() {
        Task {
            do {
                connected = try await store.requestFullAccessToEvents()
                if connected { refresh(); _ = try? await UNUserNotificationCenter.current().requestAuthorization(options: [.alert, .sound]) }
                else { error = "Calendar access was not granted. You can enable it in System Settings → Privacy & Security → Calendars." }
            } catch { self.error = error.localizedDescription }
        }
    }
    func refresh(now: Date = Date()) {
        connected = EKEventStore.authorizationStatus(for: .event) == .fullAccess
        guard connected else { events = []; return }
        let predicate = store.predicateForEvents(withStart: now.addingTimeInterval(-300), end: now.addingTimeInterval(7 * 86400), calendars: nil)
        events = store.events(matching: predicate).filter { !$0.isAllDay && $0.endDate > now }.map { event in
            CalendarMeeting(id: (event.eventIdentifier ?? event.calendarItemIdentifier) + "@" + String(event.startDate.timeIntervalSince1970), title: event.title ?? "Meeting", start: event.startDate, end: event.endDate, calendar: event.calendar.title, joinURL: CalendarRules.meetingURL([event.url?.absoluteString, event.location, event.notes].compactMap { $0 }.joined(separator: "\n")))
        }.sorted { $0.start < $1.start }
        guard reminders, prompt == nil, let next = events.first(where: { CalendarRules.shouldPrompt($0, now: now, seen: seen) }) else { return }
        prompt = next; seen.insert(next.id)
        if seen.count > 1000 { seen = seen.intersection(Set(events.map(\.id))) }
        UserDefaults.standard.set(Array(seen), forKey: "calendarSeen")
        let content = UNMutableNotificationContent(); content.title = next.title; content.body = "Your meeting is starting. Open Folio to prepare a recording."; content.sound = .default
        UNUserNotificationCenter.current().add(UNNotificationRequest(identifier: next.id, content: content, trigger: nil))
    }
    func dismissPrompt() { if let prompt { UNUserNotificationCenter.current().removeDeliveredNotifications(withIdentifiers: [prompt.id]) }; prompt = nil }
    func setReminders(_ value: Bool) { reminders = value; UserDefaults.standard.set(value, forKey: "calendarReminders"); if !value { prompt = nil }; refresh() }
    nonisolated func userNotificationCenter(_ center: UNUserNotificationCenter, didReceive response: UNNotificationResponse) async {
        await MainActor.run { NSApp.activate(ignoringOtherApps: true); NSApp.windows.first(where: { $0.canBecomeMain })?.makeKeyAndOrderFront(nil) }
    }
}
extension AppModel {
    func createChat() { let id = create(title: "New conversation"); edit(id) { $0.isChat = true; $0.icon = "bubble.left.and.bubble.right" }; filter = "chats" }
    func prepareMeeting(_ event: CalendarMeeting) {
        let marker = "calendar:" + event.id
        if let existing = notes.first(where: { !$0.trashed && $0.tags.contains(marker) }) { select(existing.id) }
        else {
            let id = create(title: event.title, meeting: true, blocks: [Block(text: event.start.formatted(date: .abbreviated, time: .shortened)), Block(text: event.joinURL.map { "[Join meeting](\($0.absoluteString))" } ?? ""), Block(kind: .heading2, text: "Agenda"), Block()])
            edit(id) { $0.tags.append(marker) }
        }
        showMeeting = true
    }
}
struct HomeView: View {
    @EnvironmentObject var model: AppModel
    @EnvironmentObject var calendar: CalendarController
    var body: some View {
        ScrollView {
            VStack(alignment: .leading, spacing: 20) {
                Text("Your space").font(.system(size: 32, weight: .medium, design: .serif))
                HStack { Button("New page", systemImage: "square.and.pencil") { model.create() }; Button("New AI chat", systemImage: "sparkles") { model.createChat() }; Button("Read files / OCR", systemImage: "doc.viewfinder") { model.readFiles() } }.buttonStyle(QuietButton())
                SectionEyebrow(text: "Upcoming events")
                if !calendar.connected { Button("Connect Apple Calendar") { calendar.connect() }.buttonStyle(QuietButton(accent: true)); Text("Folio reads calendars already on your Mac. Keep Folio running for meeting reminders.").font(.system(size: 12)).foregroundStyle(Palette.muted) }
                else if calendar.events.isEmpty { Text("No events in the next seven days.").foregroundStyle(Palette.muted) }
                ForEach(calendar.events.prefix(20)) { event in
                    HStack(spacing: 14) { Image(systemName: event.joinURL == nil ? "calendar" : "video").foregroundStyle(Palette.mint); VStack(alignment: .leading, spacing: 5) { Text(event.title); Text(event.start.formatted(date: .abbreviated, time: .shortened) + " · " + event.calendar).font(.system(size: 11)).foregroundStyle(Palette.muted) }; Spacer(); if let url = event.joinURL { Link("Join", destination: url); Button("Meeting notes") { model.prepareMeeting(event) } } }.padding(14).background(Palette.raised.opacity(0.4), in: RoundedRectangle(cornerRadius: 8))
                }
                if calendar.connected { Toggle("Remind me when a scheduled video call starts", isOn: Binding(get: { calendar.reminders }, set: { calendar.setReminders($0) })).font(.system(size: 12)) }
                SectionEyebrow(text: "Recent pages").padding(.top, 12)
                ForEach(model.notes.filter { !$0.trashed && $0.isChat != true }.sorted { $0.modified > $1.modified }.prefix(12)) { note in Button { model.select(note.id) } label: { HStack { NoteIconView(value: note.icon, size: 15, tint: Palette.mint); Text(note.displayTitle); Spacer(); Text(note.modified.formatted(date: .abbreviated, time: .omitted)).font(.system(size: 11)).foregroundStyle(Palette.muted) }.padding(12) }.buttonStyle(.plain) }
            }.padding(28).padding(.top, 18)
        }
    }
}
