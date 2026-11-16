import Foundation
import EventKit

// This executable has no permission-request, app-launch or mutation operation.
struct ReadQuery: Decodable {
    let op: String
    let app: String
    let containerId: String?
    let start: String?
    let end: String?
    let limit: Int?
}
struct ReadContainer: Encodable { let id: String; let title: String }
struct ReadItem: Encodable {
    let id: String
    let title: String
    let start: String?
    let end: String?
    let allDay: Bool
    enum CodingKeys: String, CodingKey { case id, title, start, end, allDay }
    func encode(to encoder: Encoder) throws {
        var values = encoder.container(keyedBy: CodingKeys.self)
        try values.encode(id, forKey: .id)
        try values.encode(title, forKey: .title)
        try values.encode(start, forKey: .start)
        try values.encode(end, forKey: .end)
        try values.encode(allDay, forKey: .allDay)
    }
}
struct ReadResult: Encodable {
    let status: String
    var reason: String? = nil
    var items: [ReadItem]? = nil
    var truncated: Bool? = nil
    var containers: [ReadContainer]? = nil
}
func emitRead(_ result: ReadResult) {
    if let data = try? JSONEncoder().encode(result) { FileHandle.standardOutput.write(data) }
}
let formatter = ISO8601DateFormatter()
formatter.formatOptions = [.withInternetDateTime, .withFractionalSeconds]
let plainFormatter = ISO8601DateFormatter()
func readTime(_ value: String) -> Date? { formatter.date(from: value) ?? plainFormatter.date(from: value) }
func permissionResult(_ type: EKEntityType) -> ReadResult? {
    let status = EKEventStore.authorizationStatus(for: type)
    if status == .notDetermined { return ReadResult(status: "permission-required", reason: "Connect this app in the local desktop first. Background reads never request access.") }
    if #available(macOS 14.0, *) {
        if status == .fullAccess { return nil }
    } else if status == .authorized { return nil }
    return ReadResult(status: "permission-denied", reason: "Existing OS permission does not allow reading this app.")
}
do {
    let query = try JSONDecoder().decode(ReadQuery.self, from: FileHandle.standardInput.readDataToEndOfFile())
    guard (query.app == "calendar" || query.app == "reminders"), (query.op == "read" || query.op == "containers") else {
        emitRead(ReadResult(status: "error", reason: "Invalid native read operation.")); exit(0)
    }
    let entity: EKEntityType = query.app == "calendar" ? .event : .reminder
    if let denied = permissionResult(entity) { emitRead(denied); exit(0) }
    let store = EKEventStore()
    if query.op == "containers" {
        let calendars = store.calendars(for: entity)
        let containers = calendars.prefix(100).map { ReadContainer(id: $0.calendarIdentifier, title: String($0.title.prefix(4096))) }
        emitRead(ReadResult(status: "containers", truncated: calendars.count > 100, containers: containers)); exit(0)
    }
    guard let containerId = query.containerId, !containerId.isEmpty,
          let limit = query.limit, limit >= 1 && limit <= 100,
          let startText = query.start, let endText = query.end,
          let start = readTime(startText), let end = readTime(endText),
          end > start && end.timeIntervalSince(start) <= 31 * 86400 else {
        emitRead(ReadResult(status: "error", reason: "Invalid scoped read request.")); exit(0)
    }
    guard let calendar = store.calendar(withIdentifier: containerId), calendar.allowedEntityTypes.contains(entity == .event ? .event : .reminder) else {
        emitRead(ReadResult(status: "container-unavailable", reason: "The requested calendar or reminder list is unavailable.")); exit(0)
    }
    if entity == .event {
        let events = store.events(matching: store.predicateForEvents(withStart: start, end: end, calendars: [calendar]))
            .filter { $0.calendar.calendarIdentifier == containerId && $0.endDate > start && $0.startDate < end }
            .sorted { $0.startDate < $1.startDate }
        let items = events.prefix(limit).compactMap { event -> ReadItem? in
            guard let id = event.eventIdentifier else { return nil }
            return ReadItem(id: id, title: String((event.title ?? "").prefix(4096)), start: formatter.string(from: event.startDate), end: formatter.string(from: event.endDate), allDay: event.isAllDay)
        }
        emitRead(ReadResult(status: "ok", items: items, truncated: events.count > limit))
    } else {
        let semaphore = DispatchSemaphore(value: 0)
        var found: [EKReminder]? = nil
        let predicate = store.predicateForIncompleteReminders(withDueDateStarting: start, ending: end, calendars: [calendar])
        let token = store.fetchReminders(matching: predicate) { reminders in found = reminders; semaphore.signal() }
        let deadline = Date().addingTimeInterval(15)
        var completed = false
        while Date() < deadline {
            if semaphore.wait(timeout: .now()) == .success { completed = true; break }
            RunLoop.current.run(until: Date().addingTimeInterval(0.05))
        }
        guard completed, let reminders = found else {
            store.cancelFetchRequest(token)
            emitRead(ReadResult(status: "error", reason: "Reminder fetch failed or timed out.")); exit(0)
        }
        let scoped = reminders.compactMap { reminder -> (EKReminder, Date)? in
            guard reminder.calendar.calendarIdentifier == containerId, !reminder.isCompleted,
                  let components = reminder.dueDateComponents, let due = Calendar.current.date(from: components), due >= start && due < end else { return nil }
            return (reminder, due)
        }.sorted { $0.1 < $1.1 }
        let items = scoped.prefix(limit).map { reminder, due in
            ReadItem(id: reminder.calendarItemIdentifier, title: String((reminder.title ?? "").prefix(4096)), start: formatter.string(from: due), end: nil, allDay: reminder.dueDateComponents?.hour == nil)
        }
        emitRead(ReadResult(status: "ok", items: items, truncated: scoped.count > limit))
    }
} catch {
    emitRead(ReadResult(status: "error", reason: "Native scoped read failed."))
}
