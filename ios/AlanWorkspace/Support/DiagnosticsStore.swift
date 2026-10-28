import Foundation
import MetricKit

/// Keeps Apple's MetricKit crash and hang reports on this device. Nothing is uploaded;
/// the person chooses whether to share an exported report from Settings.
final class DiagnosticsStore: NSObject, MXMetricManagerSubscriber {
    static let shared = DiagnosticsStore()
    static let retainedReports = 20
    let directory: URL

    init(directory: URL = URL.applicationSupportDirectory.appending(path: "Diagnostics", directoryHint: .isDirectory)) {
        self.directory = directory
    }

    func didReceive(_ payloads: [MXDiagnosticPayload]) {
        for payload in payloads { try? save(payload.jsonRepresentation()) }
    }

    func save(_ payload: Data) throws {
        try FileManager.default.createDirectory(at: directory, withIntermediateDirectories: true)
        // Names sort chronologically, so pruning never reads file timestamps (a required-reason API).
        let name = String(format: "%020llu-%@.json", clock_gettime_nsec_np(CLOCK_REALTIME), UUID().uuidString)
        try payload.write(to: directory.appending(path: name), options: .atomic)
        for stale in reportFiles().dropLast(Self.retainedReports) { try? FileManager.default.removeItem(at: stale) }
    }

    func reportFiles() -> [URL] {
        let files = (try? FileManager.default.contentsOfDirectory(at: directory, includingPropertiesForKeys: nil)) ?? []
        return files.filter { $0.pathExtension == "json" }.sorted { $0.lastPathComponent < $1.lastPathComponent }
    }

    /// One shareable JSON file: the app version plus each retained MetricKit payload, unmodified.
    func exportReport() throws -> URL {
        let info = Bundle.main.infoDictionary ?? [:]
        let report: [String: Any] = [
            "app": "Alan's Workspace",
            "version": info["CFBundleShortVersionString"] as? String ?? "",
            "build": info["CFBundleVersion"] as? String ?? "",
            "diagnostics": reportFiles().compactMap { try? JSONSerialization.jsonObject(with: Data(contentsOf: $0)) }
        ]
        let url = FileManager.default.temporaryDirectory.appending(path: "AlanWorkspace-diagnostics.json")
        try JSONSerialization.data(withJSONObject: report, options: [.prettyPrinted, .sortedKeys]).write(to: url, options: .atomic)
        return url
    }

    func clear() {
        try? FileManager.default.removeItem(at: directory)
        try? FileManager.default.removeItem(at: FileManager.default.temporaryDirectory.appending(path: "AlanWorkspace-diagnostics.json"))
    }
}
