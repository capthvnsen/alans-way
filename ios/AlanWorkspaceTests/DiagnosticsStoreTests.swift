import XCTest
@testable import AlanWorkspace

final class DiagnosticsStoreTests: XCTestCase {
    func testKeepsNewestReportsAndExportsThemUnmodified() throws {
        let folder = FileManager.default.temporaryDirectory.appending(path: "diagnostics-test-\(UUID().uuidString)")
        defer { try? FileManager.default.removeItem(at: folder) }
        let store = DiagnosticsStore(directory: folder)
        XCTAssertTrue(store.reportFiles().isEmpty)
        let total = DiagnosticsStore.retainedReports + 5
        for index in 0..<total {
            try store.save(Data(#"{"hangDiagnostics":[{"index":\#(index)}]}"#.utf8))
        }
        XCTAssertEqual(store.reportFiles().count, DiagnosticsStore.retainedReports)

        let report = try JSONSerialization.jsonObject(with: Data(contentsOf: store.exportReport())) as? [String: Any]
        let diagnostics = try XCTUnwrap(report?["diagnostics"] as? [[String: [[String: Int]]]])
        XCTAssertEqual(diagnostics.compactMap { $0["hangDiagnostics"]?.first?["index"] }, Array(5..<total))
        XCTAssertNotNil(report?["version"] as? String)

        store.clear()
        XCTAssertTrue(store.reportFiles().isEmpty)
    }
}
