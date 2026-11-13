import CryptoKit
import Darwin
import Foundation

enum PokiTaskState: String, Codable {
    case queued, running, succeeded, failed, cancelling, cancelled, unknown
    var isActive: Bool { self == .queued || self == .running || self == .cancelling }
}

struct PokiTaskReceipt: Codable, Equatable {
    let taskID: String
    let operationID: String
    let inputDigest: String
    let createdAt: Date
    var updatedAt: Date
    var state: PokiTaskState
    var result: String?

    func publicJSON() throws -> String {
        let date = ISO8601DateFormatter()
        var value: [String: Any] = [
            "task_id": taskID, "operation_id": operationID, "state": state.rawValue,
            "created_at": date.string(from: createdAt), "updated_at": date.string(from: updatedAt),
            "source": "poki_chat_model", "replayed": false,
            "cancellation_semantics": "Stops future steps after the in-flight step settles; previous effects are not reversed."
        ]
        if let result { value["result"] = result }
        return String(decoding: try JSONSerialization.data(withJSONObject: value, options: [.sortedKeys]), as: UTF8.self)
    }
}

enum PokiTaskIntentError: LocalizedError {
    case invalidInput, busy, notReady, capacity, unknownTask, operationConflict, journalUnavailable
    var errorDescription: String? {
        switch self {
        case .invalidInput: "Provide a nonempty UTF-8 task of at most 8192 bytes and a valid operation ID."
        case .busy: "Poki is already working on this iPhone. Finish or cancel that task first."
        case .notReady: "Open Poki and configure its model before starting a task."
        case .capacity: "The retained task journal is full. Its existing operation IDs are preserved to prevent duplicate work."
        case .unknownTask: "There is no retained task with that ID."
        case .operationConflict: "That operation ID already belongs to a different task."
        case .journalUnavailable: "The task journal could not be saved. No new task was started."
        }
    }
}

/// The existing ChatModel is the executor. This registry only owns idempotency,
/// retained receipts and cancellation, and never creates a second phone client.
@MainActor
final class PokiTaskRegistry {
    struct Completion { let text: String; let success: Bool? }
    struct Execution {
        let run: @MainActor () async -> Completion
        let cancel: @MainActor () -> Void
        let finish: @MainActor () -> Void
    }
    typealias Factory = @MainActor (String, String) throws -> Execution
    private var records: [String: PokiTaskReceipt] = [:]
    private var executions: [String: Execution] = [:]
    private var busy: @MainActor () -> Bool = { true }
    private var makeExecution: Factory?
    private let storageURL: URL?
    private let maxRecords: Int
    private let now: () -> Date
    private var journalFailed = false

    init(storageURL: URL? = nil, maxRecords: Int = 128, now: @escaping () -> Date = Date.init) throws {
        self.storageURL = storageURL
        self.maxRecords = maxRecords
        self.now = now
        if let storageURL, FileManager.default.fileExists(atPath: storageURL.path) {
            let size = try storageURL.resourceValues(forKeys: [.fileSizeKey]).fileSize ?? 0
            guard size <= 8 * 1024 * 1024 else { throw PokiTaskIntentError.journalUnavailable }
            let saved = try JSONDecoder().decode([PokiTaskReceipt].self, from: Data(contentsOf: storageURL))
            guard saved.count <= maxRecords else { throw PokiTaskIntentError.capacity }
            for var record in saved {
                guard records[record.taskID] == nil, !record.operationID.isEmpty,
                      !records.values.contains(where: { $0.operationID == record.operationID })
                else { throw PokiTaskIntentError.journalUnavailable }
                if record.state.isActive {
                    record.state = .unknown
                    record.updatedAt = now()
                    record.result = "Poki restarted before the task outcome was confirmed. The same operation will not run again."
                }
                records[record.taskID] = record
            }
            try persist()
        }
    }

    func install(busy: @escaping @MainActor () -> Bool, makeExecution: @escaping Factory) {
        self.busy = busy
        self.makeExecution = makeExecution
    }

    var isBusy: Bool { records.values.contains { $0.state.isActive } }

    func start(task: String, operationID: String) throws -> PokiTaskReceipt {
        let text = task.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !text.isEmpty, text.utf8.count <= 8192,
              operationID.range(of: "^[A-Za-z0-9_-]{1,100}$", options: .regularExpression) != nil
        else { throw PokiTaskIntentError.invalidInput }
        let hash = SHA256.hash(data: Data(text.utf8)).map { String(format: "%02x", $0) }.joined()
        if let previous = records.values.first(where: { $0.operationID == operationID }) {
            guard previous.inputDigest == hash else { throw PokiTaskIntentError.operationConflict }
            return previous
        }
        guard !journalFailed else { throw PokiTaskIntentError.journalUnavailable }
        guard let makeExecution else { throw PokiTaskIntentError.notReady }
        guard !isBusy, !busy() else { throw PokiTaskIntentError.busy }
        guard records.count < maxRecords else { throw PokiTaskIntentError.capacity }
        let at = now()
        let record = PokiTaskReceipt(taskID: UUID().uuidString.lowercased(), operationID: operationID,
                                    inputDigest: hash, createdAt: at, updatedAt: at, state: .queued)
        records[record.taskID] = record
        do { try persist() } catch { journalFailed = true; throw PokiTaskIntentError.journalUnavailable }
        let execution: Execution
        do { execution = try makeExecution(text, record.taskID) }
        catch {
            try settle(record.taskID, state: .failed, result: "Poki was not ready; no task started.")
            throw error
        }
        executions[record.taskID] = execution
        Task { @MainActor [weak self] in
            guard let self else { execution.finish(); return }
            defer { self.executions[record.taskID] = nil; execution.finish() }
            do {
                if self.records[record.taskID]?.state == .cancelling {
                    try self.settle(record.taskID, state: .cancelled, result: "Cancelled before the task started.")
                    return
                }
                try self.settle(record.taskID, state: .running, result: nil)
                let completion = await execution.run()
                let state: PokiTaskState
                if completion.success == true { state = .succeeded }
                else if completion.success == false { state = .failed }
                else if self.records[record.taskID]?.state == .cancelling { state = .cancelled }
                else { state = .unknown }
                try self.settle(record.taskID, state: state, result: completion.text)
            } catch {
                self.journalFailed = true
                self.records[record.taskID]?.state = .unknown
                self.records[record.taskID]?.result = "The task receipt could not be saved. Inspect before starting another operation."
            }
        }
        return record
    }

    func status(taskID: String) throws -> PokiTaskReceipt {
        guard let record = records[taskID] else { throw PokiTaskIntentError.unknownTask }
        return record
    }

    func cancel(taskID: String) throws -> PokiTaskReceipt {
        let record = try status(taskID: taskID)
        guard record.state.isActive, record.state != .cancelling else { return record }
        // A disk failure must not prevent the requested stop from reaching ChatModel.
        defer { executions[taskID]?.cancel() }
        do { try settle(taskID, state: .cancelling, result: nil) }
        catch { journalFailed = true; throw PokiTaskIntentError.journalUnavailable }
        return try status(taskID: taskID)
    }

    private func settle(_ id: String, state: PokiTaskState, result: String?) throws {
        guard var record = records[id] else { throw PokiTaskIntentError.unknownTask }
        record.state = state
        record.updatedAt = now()
        if let result {
            // Bound bytes without splitting a UTF-8 code point.
            var bytes = Data(result.utf8.prefix(8192))
            while String(data: bytes, encoding: .utf8) == nil { bytes.removeLast() }
            record.result = String(data: bytes, encoding: .utf8)
        }
        records[id] = record
        try persist()
    }

    private func persist() throws {
        guard let storageURL else { return }
        let directory = storageURL.deletingLastPathComponent()
        try FileManager.default.createDirectory(at: directory, withIntermediateDirectories: true,
                                                attributes: [.posixPermissions: 0o700])
        let data = try JSONEncoder().encode(records.values.sorted { $0.taskID < $1.taskID })
        try data.write(to: storageURL, options: .atomic)
        try FileManager.default.setAttributes([.posixPermissions: 0o600], ofItemAtPath: storageURL.path)
        #if os(iOS)
        try FileManager.default.setAttributes([.protectionKey: FileProtectionType.completeUntilFirstUserAuthentication],
                                             ofItemAtPath: storageURL.path)
        #endif
        let file = try FileHandle(forWritingTo: storageURL)
        try file.synchronize()
        try file.close()
        let descriptor = Darwin.open(directory.path, O_RDONLY)
        guard descriptor >= 0 else { throw PokiTaskIntentError.journalUnavailable }
        defer { Darwin.close(descriptor) }
        guard Darwin.fsync(descriptor) == 0 else { throw PokiTaskIntentError.journalUnavailable }
    }
}
