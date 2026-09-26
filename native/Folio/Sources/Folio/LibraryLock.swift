import Foundation
import Darwin

/// An OS-owned lock is released automatically if the process crashes.
final class LibraryLock {
    private let descriptor: Int32
    init(directory: URL) throws {
        try FileManager.default.createDirectory(at: directory, withIntermediateDirectories: true)
        let fd = Darwin.open(directory.appendingPathComponent(".folio-lock").path, O_CREAT | O_RDWR, S_IRUSR | S_IWUSR)
        guard fd >= 0 else { throw AppError(message: "Folio could not lock the library for editing. Check the folder’s permissions.") }
        guard flock(fd, LOCK_EX | LOCK_NB) == 0 else {
            Darwin.close(fd)
            throw AppError(message: "Another copy of Folio is using this library. Quit the other copy, then reopen this one. Your notes have not been changed.")
        }
        descriptor = fd
    }
    deinit { Darwin.close(descriptor) }
}
