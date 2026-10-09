import Foundation
import EventKit

struct Request: Decodable {
    let op: String
    let id: String?
    let title: String?
    let start: String?
    let end: String?
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

struct Result: Encodable {
    let access: String
    var calendars: [CalendarInfo] = []
    var events: [EventInfo] = []
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

do {
    let input = FileHandle.standardInput.readDataToEndOfFile()
    let request = try JSONDecoder().decode(Request.self, from: input)
    if request.op == "connect" && !canRead() {
        let completion = DispatchSemaphore(value: 0)
        if #available(macOS 14.0, *) {
            store.requestFullAccessToEvents { _, _ in completion.signal() }
        } else {
            store.requestAccess(to: .event) { _, _ in completion.signal() }
        }
        let deadline = Date().addingTimeInterval(90)
        while completion.wait(timeout: .now()) != .success && Date() < deadline {
            RunLoop.current.run(until: Date().addingTimeInterval(0.1))
        }
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
