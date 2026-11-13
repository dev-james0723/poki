import AppIntents
import Foundation
import UniformTypeIdentifiers
import XCTest
@testable import Poki

final class PokiTaskIntentInputTests: XCTestCase {
    func testTaskAcceptsOnlyOneBoundedTextSource() throws {
        XCTAssertEqual(try StartPokiTaskIntent.taskText("Read the page", file: nil), "Read the page")
        let file = IntentFile(data: Data("Read the file".utf8), filename: "task.txt", type: .plainText)
        XCTAssertEqual(try StartPokiTaskIntent.taskText(nil, file: file), "Read the file")
        XCTAssertThrowsError(try StartPokiTaskIntent.taskText("Other task", file: file))
        XCTAssertThrowsError(try StartPokiTaskIntent.taskText(nil, file: nil))
        XCTAssertThrowsError(try StartPokiTaskIntent.taskText(String(repeating: "x", count: 8193), file: nil))
    }

    func testFileRejectsUnsupportedTypeInvalidEncodingAndExcessSize() {
        for file in [
            IntentFile(data: Data([0xff, 0xff]), filename: "bad.txt", type: .plainText),
            IntentFile(data: Data("hello".utf8), filename: "document.pdf", type: .pdf),
            IntentFile(data: Data(repeating: 120, count: 8193), filename: "large.txt", type: .plainText)
        ] {
            XCTAssertThrowsError(try StartPokiTaskIntent.taskText(nil, file: file))
        }
    }
}
