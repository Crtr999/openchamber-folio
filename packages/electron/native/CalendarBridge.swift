import Foundation
import EventKit

struct Request: Decodable {
    let op: String
    let id: String?
    let title: String?
    let start: String?
    let end: String?
    let due: String?
    let calendarId: String?
}

struct CalendarInfo: Encodable {
    let id: String
    let title: String
    let writable: Bool
}

struct EventInfo: Encodable {
    let id: String
    let title: String
    let start: String
    let end: String
    let allDay: Bool
    let calendarId: String
    let calendarTitle: String
    let writable: Bool
}

struct ReminderInfo: Encodable {
    let id: String
    let title: String
    let due: String?
    let overdue: Bool
    let priority: String
    let list: String
}

struct Result: Encodable {
    let access: String
    var calendars: [CalendarInfo] = []
    var events: [EventInfo] = []
    var reminders: [ReminderInfo] = []
    var savedId: String?
    var error: String?
}

let store = EKEventStore()
let iso = ISO8601DateFormatter()
iso.formatOptions = [.withInternetDateTime, .withFractionalSeconds]
let isoWithoutFraction = ISO8601DateFormatter()
func parseTime(_ value: String) -> Date? {
    iso.date(from: value) ?? isoWithoutFraction.date(from: value)
}
func emit(_ result: Result) {
    if let data = try? JSONEncoder().encode(result) {
        FileHandle.standardOutput.write(data)
    }
}
func canRead() -> Bool {
    if #available(macOS 14.0, *) { return EKEventStore.authorizationStatus(for: .event) == .fullAccess }
    return EKEventStore.authorizationStatus(for: .event) == .authorized
}
func canReadReminders() -> Bool {
    if #available(macOS 14.0, *) { return EKEventStore.authorizationStatus(for: .reminder) == .fullAccess }
    return EKEventStore.authorizationStatus(for: .reminder) == .authorized
}
func waitForAccess(_ kind: EKEntityType) {
    let completion = DispatchSemaphore(value: 0)
    if #available(macOS 14.0, *) {
        let done: (Bool, Error?) -> Void = { _, _ in completion.signal() }
        if kind == .reminder { store.requestFullAccessToReminders(completion: done) }
        else { store.requestFullAccessToEvents(completion: done) }
    } else {
        store.requestAccess(to: kind) { _, _ in completion.signal() }
    }
    let deadline = Date().addingTimeInterval(90)
    while completion.wait(timeout: .now()) != .success && Date() < deadline {
        RunLoop.current.run(until: Date().addingTimeInterval(0.1))
    }
}
func priorityName(_ value: Int) -> String {
    if value == 0 { return "none" }
    if value <= 4 { return "high" }
    if value <= 8 { return "medium" }
    return "low"
}
func reminderDue(_ reminder: EKReminder) -> Date? {
    guard let components = reminder.dueDateComponents else { return nil }
    return Calendar.current.date(from: components)
}
func fetchReminders(_ predicate: NSPredicate) -> [EKReminder] {
    let completion = DispatchSemaphore(value: 0)
    var found: [EKReminder] = []
    store.fetchReminders(matching: predicate) { reminders in
        found = reminders ?? []
        completion.signal()
    }
    let deadline = Date().addingTimeInterval(15)
    while completion.wait(timeout: .now()) != .success && Date() < deadline {
        RunLoop.current.run(until: Date().addingTimeInterval(0.05))
    }
    return found
}

do {
    let input = FileHandle.standardInput.readDataToEndOfFile()
    let request = try JSONDecoder().decode(Request.self, from: input)
    if request.op == "connect" && !canRead() { waitForAccess(.event) }
    if request.op == "reminders-connect" && !canReadReminders() { waitForAccess(.reminder) }
    if request.op == "reminders-read" || request.op == "reminders-connect" || request.op == "reminder-complete" || request.op == "reminder-save" {
        guard canReadReminders() else {
            emit(Result(access: "not-connected"))
            exit(0)
        }
        if request.op == "reminder-complete" {
            guard let id = request.id, let item = store.calendarItem(withIdentifier: id) as? EKReminder else {
                emit(Result(access: "connected", error: "This reminder no longer exists. Refresh the list."))
                exit(0)
            }
            item.isCompleted = true
            try store.save(item, commit: true)
            emit(Result(access: "connected", savedId: item.calendarItemIdentifier))
            exit(0)
        }
        if request.op == "reminder-save" {
            guard let title = request.title, !title.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty else {
                emit(Result(access: "connected", error: "Enter a title."))
                exit(0)
            }
            guard let list = store.defaultCalendarForNewReminders() else {
                emit(Result(access: "connected", error: "Choose a reminders list in Reminders first."))
                exit(0)
            }
            let reminder = EKReminder(eventStore: store)
            reminder.calendar = list
            reminder.title = title
            if let dueText = request.due, let due = parseTime(dueText) {
                reminder.dueDateComponents = Calendar.current.dateComponents([.year, .month, .day, .hour, .minute], from: due)
            }
            try store.save(reminder, commit: true)
            emit(Result(access: "connected", savedId: reminder.calendarItemIdentifier))
            exit(0)
        }
        let begin = Calendar.current.startOfDay(for: Date())
        let finish = Calendar.current.date(byAdding: .day, value: 7, to: begin)!
        let predicate = store.predicateForIncompleteReminders(withDueDateStarting: nil, ending: finish, calendars: nil)
        let reminders = fetchReminders(predicate)
            .filter { reminderDue($0) != nil }
            .sorted { (reminderDue($0) ?? .distantFuture) < (reminderDue($1) ?? .distantFuture) }
            .prefix(80)
            .compactMap { reminder -> ReminderInfo? in
                guard let due = reminderDue(reminder) else { return nil }
                return ReminderInfo(id: reminder.calendarItemIdentifier, title: reminder.title ?? "",
                    due: iso.string(from: due), overdue: Calendar.current.startOfDay(for: due) < begin,
                    priority: priorityName(reminder.priority), list: reminder.calendar.title)
            }
        emit(Result(access: "connected", reminders: Array(reminders)))
        exit(0)
    }
    guard canRead() else {
        emit(Result(access: "not-connected"))
        exit(0)
    }
    if request.op == "save" {
        guard let title = request.title, !title.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty,
              let startText = request.start, let endText = request.end,
              let start = parseTime(startText), let end = parseTime(endText), end > start else {
            emit(Result(access: "connected", error: "Enter a title and a valid start and end time."))
            exit(0)
        }
        let event: EKEvent
        if let id = request.id {
            guard let existing = store.event(withIdentifier: id) else {
                emit(Result(access: "connected", error: "This event no longer exists. Refresh the calendar."))
                exit(0)
            }
            guard existing.calendar.allowsContentModifications && !existing.isAllDay && existing.recurrenceRules?.isEmpty != false else {
                emit(Result(access: "connected", error: "Edit recurring events in Calendar."))
                exit(0)
            }
            event = existing
        } else {
            event = EKEvent(eventStore: store)
        }
        if let calendarId = request.calendarId, store.calendar(withIdentifier: calendarId) == nil {
            emit(Result(access: "connected", error: "This calendar no longer exists. Choose another calendar."))
            exit(0)
        }
        let targetCalendar = request.calendarId.flatMap { store.calendar(withIdentifier: $0) }
            ?? event.calendar ?? store.defaultCalendarForNewEvents
        guard let targetCalendar, targetCalendar.allowsContentModifications else {
            emit(Result(access: "connected", error: "Choose a writable calendar."))
            exit(0)
        }
        event.calendar = targetCalendar
        event.title = title
        event.isAllDay = false
        event.startDate = start
        event.endDate = end
        try store.save(event, span: .thisEvent, commit: true)
        emit(Result(access: "connected", savedId: event.eventIdentifier))
    } else {
        let begin = Calendar.current.startOfDay(for: Date())
        let finish = Calendar.current.date(byAdding: .day, value: 7, to: begin)!
        let events = store.events(matching: store.predicateForEvents(withStart: begin, end: finish, calendars: nil))
            .sorted { $0.startDate < $1.startDate }
            .prefix(150)
            .compactMap { event -> EventInfo? in
                guard let id = event.eventIdentifier else { return nil }
                return EventInfo(id: id, title: event.title ?? "", start: iso.string(from: event.startDate),
                    end: iso.string(from: event.endDate), allDay: event.isAllDay,
                    calendarId: event.calendar.calendarIdentifier, calendarTitle: event.calendar.title,
                    writable: event.calendar.allowsContentModifications && !event.isAllDay && event.recurrenceRules?.isEmpty != false)
            }
        let calendars = store.calendars(for: .event).map {
            CalendarInfo(id: $0.calendarIdentifier, title: $0.title, writable: $0.allowsContentModifications)
        }
        emit(Result(access: "connected", calendars: calendars, events: Array(events)))
    }
} catch {
    emit(Result(access: canRead() ? "connected" : "not-connected", error: error.localizedDescription))
}
