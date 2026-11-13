import Foundation
import XCTest
@testable import Poki

@MainActor
final class PokiTaskRegistryTests: XCTestCase {
    private func registry() throws -> (PokiTaskRegistry, URL) {
        let directory = FileManager.default.temporaryDirectory.appendingPathComponent(UUID().uuidString)
        try FileManager.default.createDirectory(at: directory, withIntermediateDirectories: true)
        addTeardownBlock { try? FileManager.default.removeItem(at: directory) }
        let url = directory.appendingPathComponent("tasks.json")
        return (try PokiTaskRegistry(storageURL: url), url)
    }

    func testDuplicateStartRetainsStableResultAndRejectsDifferentTask() async throws {
        let (registry, _) = try registry()
        var starts = 0
        registry.install(busy: { false }) { _, _ in
            PokiTaskRegistry.Execution(run: { starts += 1; return .init(text: "Done", success: true) }, cancel: {}, finish: {})
        }
        let first = try registry.start(task: "Read the test", operationID: "same-operation")
        let duplicate = try registry.start(task: "Read the test", operationID: "same-operation")
        XCTAssertEqual(first.taskID, duplicate.taskID)
        for _ in 0..<50 where try registry.status(taskID: first.taskID).state.isActive { await Task.yield() }
        XCTAssertEqual(starts, 1)
        XCTAssertEqual(try registry.status(taskID: first.taskID).state, .succeeded)
        XCTAssertEqual(try registry.status(taskID: first.taskID).result, "Done")
        XCTAssertThrowsError(try registry.start(task: "Different", operationID: "same-operation"))
    }

    func testExternalOwnerBusyPreventsAnIndependentTask() throws {
        let (registry, _) = try registry()
        var constructed = 0
        registry.install(busy: { true }) { _, _ in
            constructed += 1
            return .init(run: { .init(text: "", success: nil) }, cancel: {}, finish: {})
        }
        XCTAssertThrowsError(try registry.start(task: "Task", operationID: "busy"))
        XCTAssertEqual(constructed, 0)
    }

    func testCancellationSettlesOnlyAfterExecutorReturns() async throws {
        let (registry, _) = try registry()
        var continuation: CheckedContinuation<PokiTaskRegistry.Completion, Never>?
        var cancelled = 0
        registry.install(busy: { false }) { _, _ in
            .init(run: { await withCheckedContinuation { continuation = $0 } }, cancel: { cancelled += 1 }, finish: {})
        }
        let started = try registry.start(task: "Wait", operationID: "cancel")
        for _ in 0..<50 where continuation == nil { await Task.yield() }
        XCTAssertNotNil(continuation)
        XCTAssertEqual(try registry.cancel(taskID: started.taskID).state, .cancelling)
        XCTAssertEqual(cancelled, 1)
        continuation?.resume(returning: .init(text: "Stopped", success: nil))
        for _ in 0..<50 where try registry.status(taskID: started.taskID).state.isActive { await Task.yield() }
        XCTAssertEqual(try registry.status(taskID: started.taskID).state, .cancelled)
        _ = try registry.cancel(taskID: started.taskID)
        XCTAssertEqual(cancelled, 1)
    }

    func testRestartChangesUnfinishedTaskToUnknownWithoutRerunning() async throws {
        let (registry, url) = try registry()
        var continuation: CheckedContinuation<PokiTaskRegistry.Completion, Never>?
        registry.install(busy: { false }) { _, _ in
            .init(run: { await withCheckedContinuation { continuation = $0 } }, cancel: {}, finish: {})
        }
        let first = try registry.start(task: "Wait", operationID: "restart")
        for _ in 0..<50 where continuation == nil { await Task.yield() }
        let restarted = try PokiTaskRegistry(storageURL: url)
        XCTAssertEqual(try restarted.status(taskID: first.taskID).state, .unknown)
        XCTAssertEqual(try restarted.start(task: "Wait", operationID: "restart").taskID, first.taskID)
        continuation?.resume(returning: .init(text: "Stopped", success: nil))
        for _ in 0..<50 where registry.isBusy { await Task.yield() }
    }

    func testSuccessIsNotInferredFromAnAnswerWithoutVerifiedOutcome() async throws {
        let (registry, _) = try registry()
        registry.install(busy: { false }) { _, _ in
            .init(run: { .init(text: "An answer", success: nil) }, cancel: {}, finish: {})
        }
        let first = try registry.start(task: "Task", operationID: "uncertain")
        for _ in 0..<50 where registry.isBusy { await Task.yield() }
        XCTAssertEqual(try registry.status(taskID: first.taskID).state, .unknown)
    }

    func testCancellationStillStopsExecutorWhenJournalWriteFails() async throws {
        let (registry, url) = try registry()
        var continuation: CheckedContinuation<PokiTaskRegistry.Completion, Never>?
        var cancelled = 0
        registry.install(busy: { false }) { _, _ in
            .init(run: { await withCheckedContinuation { continuation = $0 } }, cancel: { cancelled += 1 }, finish: {})
        }
        let started = try registry.start(task: "Wait", operationID: "cancel-on-disk-failure")
        for _ in 0..<50 where continuation == nil { await Task.yield() }
        XCTAssertNotNil(continuation)
        try FileManager.default.removeItem(at: url)
        try FileManager.default.createDirectory(at: url, withIntermediateDirectories: false)
        XCTAssertThrowsError(try registry.cancel(taskID: started.taskID))
        XCTAssertEqual(cancelled, 1)
        continuation?.resume(returning: .init(text: "Stopped", success: nil))
        for _ in 0..<50 where registry.isBusy { await Task.yield() }
        XCTAssertEqual(try registry.status(taskID: started.taskID).state, .unknown)
        XCTAssertThrowsError(try registry.start(task: "New task", operationID: "after-disk-failure"))
    }
}
