import AppIntents
import Foundation
import UniformTypeIdentifiers

/// Installs the existing ChatModel and the same one-writer guard used by AskPoki.
/// App Intents never call a separate automation client or change approval policy.
@MainActor
enum PokiTaskBridge {
    private static let retained: Result<PokiTaskRegistry, Error> = Result {
        guard let directory = FileManager.default.urls(for: .applicationSupportDirectory, in: .userDomainMask).first
        else { throw PokiTaskIntentError.journalUnavailable }
        return try PokiTaskRegistry(storageURL: directory.appendingPathComponent("PokiTaskIntents", isDirectory: true)
            .appendingPathComponent("tasks.json"))
    }

    static var isBusy: Bool { (try? retained.get().isBusy) ?? false }

    static func registry() throws -> PokiTaskRegistry {
        do { return try retained.get() } catch { throw PokiTaskIntentError.journalUnavailable }
    }

    static func install(app: AppModel, chat: ChatModel) {
        guard let registry = try? registry() else { return }
        registry.install(busy: { [weak chat] in
            chat?.running == true || AskPoki.hasActiveTask || ChatModel.delegatedBusy != nil
        }) { [weak app] text, taskID in
            guard let app,
                  ModelKeys.hasUsableKey || ModelKeys.selectedProvider == .custom && !ModelKeys.customURL.isEmpty
            else { throw PokiTaskIntentError.notReady }
            let handoff = ChatModel(app: app, kind: .handoff, requester: "Shortcuts",
                                    sessionID: "shortcuts-" + taskID)
            // Reserve ownership synchronously, before the async ChatModel turn can run.
            ChatModel.delegatedBusy = "Shortcuts"
            return PokiTaskRegistry.Execution(run: {
                let answer = await handoff.runDelegated(text)
                return .init(text: answer.text, success: answer.success)
            }, cancel: {
                handoff.stop()
            }, finish: {
                if ChatModel.delegatedBusy == "Shortcuts" { ChatModel.delegatedBusy = nil }
            })
        }
    }
}

struct StartPokiTaskIntent: AppIntent {
    static let title: LocalizedStringResource = "Start Poki task"
    static let description = IntentDescription("Starts one task with Poki's configured model on this iPhone and returns its retained task ID and state. Existing action approvals still apply.")
    static let authenticationPolicy: IntentAuthenticationPolicy = .requiresLocalDeviceAuthentication
    static let openAppWhenRun = true

    @Parameter(title: "Task") var task: String?
    @Parameter(title: "Task file", supportedContentTypes: [.plainText]) var taskFile: IntentFile?
    @Parameter(title: "Operation ID", description: "Optional stable ID for an automated workflow. Reusing it returns the original task without starting again.")
    var operationID: String?

    @MainActor
    func perform() async throws -> some IntentResult & ReturnsValue<String> {
        let text = try Self.taskText(task, file: taskFile)
        let id = operationID ?? UUID().uuidString.lowercased()
        let result = try PokiTaskBridge.registry().start(task: text, operationID: id)
        return .result(value: try result.publicJSON())
    }

    static func taskText(_ text: String?, file: IntentFile?) throws -> String {
        let hasText = text?.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty == false
        guard hasText != (file != nil) else { throw PokiTaskIntentError.invalidInput }
        if hasText {
            guard let text, text.utf8.count <= 8192 else { throw PokiTaskIntentError.invalidInput }
            return text
        }
        guard let file, file.type?.conforms(to: .plainText) == true else { throw PokiTaskIntentError.invalidInput }
        var scoped: URL?
        defer { scoped?.stopAccessingSecurityScopedResource() }
        if let url = file.fileURL {
            guard url.isFileURL else { throw PokiTaskIntentError.invalidInput }
            if url.startAccessingSecurityScopedResource() { scoped = url }
            let info = try url.resourceValues(forKeys: [.fileSizeKey, .isRegularFileKey])
            guard info.isRegularFile == true, let size = info.fileSize, size <= 8192
            else { throw PokiTaskIntentError.invalidInput }
        }
        let data = file.data
        guard data.count <= 8192, let value = String(data: data, encoding: .utf8),
              !value.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty
        else { throw PokiTaskIntentError.invalidInput }
        return value
    }
}

struct GetPokiTaskStatusIntent: AppIntent {
    static let title: LocalizedStringResource = "Get Poki task status"
    static let description = IntentDescription("Returns the retained state and result without starting a task or consuming its result.")
    static let authenticationPolicy: IntentAuthenticationPolicy = .requiresLocalDeviceAuthentication
    static let openAppWhenRun = false
    @Parameter(title: "Task ID") var taskID: String

    @MainActor
    func perform() async throws -> some IntentResult & ReturnsValue<String> {
        let result = try PokiTaskBridge.registry().status(taskID: taskID)
        return .result(value: try result.publicJSON())
    }
}

struct CancelPokiTaskIntent: AppIntent {
    static let title: LocalizedStringResource = "Cancel Poki task"
    static let description = IntentDescription("Requests cancellation through Poki's existing task runner. The step already in flight settles first; previous effects are not reversed.")
    static let authenticationPolicy: IntentAuthenticationPolicy = .requiresLocalDeviceAuthentication
    static let openAppWhenRun = false
    @Parameter(title: "Task ID") var taskID: String

    @MainActor
    func perform() async throws -> some IntentResult & ReturnsValue<String> {
        let result = try PokiTaskBridge.registry().cancel(taskID: taskID)
        return .result(value: try result.publicJSON())
    }
}

struct PokiTaskShortcuts: AppShortcutsProvider {
    static var appShortcuts: [AppShortcut] {
        AppShortcut(intent: StartPokiTaskIntent(),
                    phrases: ["Start a task with \(.applicationName)"],
                    shortTitle: "Start task", systemImageName: "play.circle")
        AppShortcut(intent: GetPokiTaskStatusIntent(),
                    phrases: ["Check my task in \(.applicationName)"],
                    shortTitle: "Task status", systemImageName: "checklist")
        AppShortcut(intent: CancelPokiTaskIntent(),
                    phrases: ["Cancel my task in \(.applicationName)"],
                    shortTitle: "Cancel task", systemImageName: "stop.circle")
    }
}
