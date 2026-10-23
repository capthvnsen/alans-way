import WebKit
import XCTest
@testable import AlanWorkspace

@MainActor
final class CallWebContentTests: XCTestCase {
    func testWebContentTerminationReportsFailureAndReleasesItsPage() throws {
        let url = URL(string: "https://voice.example.test/call?ticket=single-use")!
        var errors = [CallPageFailure]()
        var loading = true
        let host = HostedWebView(
            url: url, origin: try XCTUnwrap(CallOrigin(url: url)),
            botName: "Test agent", avatarName: "hermes", reloadToken: UUID(),
            onLoadingChanged: { loading = $0 }, onError: { errors.append($0) },
            onClose: {}, onOpenComputer: nil, onOpenExternalURL: { _ in }
        )
        let coordinator = host.makeCoordinator()
        let page = ScriptRecordingWebView()
        coordinator.hostedWebView = page
        let delegate: WKNavigationDelegate = coordinator
        delegate.webViewWebContentProcessDidTerminate?(page)

        XCTAssertEqual(errors.count, 1, "A terminated call must show a native recovery message instead of a blank page.")
        XCTAssertEqual(errors.first, .contentProcessTerminated)
        XCTAssertFalse(try XCTUnwrap(errors.first).canReload, "A crashed page must obtain a fresh call launch rather than replay a consumed ticket.")
        XCTAssertFalse(loading)
        XCTAssertNil(coordinator.hostedWebView, "Do not keep sending lifecycle messages to the terminated page.")
        XCTAssertTrue(page.isLoading == false)
        HostedWebView.dismantleUIView(page, coordinator: coordinator)
        XCTAssertTrue(page.scripts.isEmpty, "Teardown must not execute JavaScript and restart a terminated content process.")
    }

    func testSimulatorWebKitExecutesCallAudioAnalysis() async throws {
        // Exercise the real iOS WebKit/Web Audio engine and its hot sample loop.
        // No microphone, Telegram credentials, or cloud requests are involved.
        let page = WKWebView()
        page.loadHTMLString("<html><body>Audio engine smoke test</body></html>", baseURL: nil)
        let deadline = Date().addingTimeInterval(15)
        while page.isLoading && Date() < deadline {
            try await Task.sleep(nanoseconds: 50_000_000)
        }
        let result = try await page.callAsyncJavaScript("""
            const context = new OfflineAudioContext(1, 2048, 48000);
            const oscillator = context.createOscillator();
            const analyser = context.createAnalyser();
            analyser.fftSize = 512;
            oscillator.connect(analyser);
            analyser.connect(context.destination);
            oscillator.start();
            const rendered = await context.startRendering();
            const values = rendered.getChannelData(0).slice(0, 512);
            let level = 0;
            for (let frame = 0; frame < 30000; frame++) {
                let energy = 0;
                for (const value of values) {
                    const centered = true ? value : (value - 128) / 128;
                    energy += centered * centered;
                }
                level = Math.sqrt(energy / values.length);
            }
            return Number.isFinite(level) && level > 0;
            """, arguments: [:], in: nil, contentWorld: .page)
        XCTAssertEqual(result as? Bool, true)
    }
}

@MainActor
private final class ScriptRecordingWebView: WKWebView {
    var scripts = [String]()

    override func evaluateJavaScript(_ javaScriptString: String, completionHandler: ((Any?, Error?) -> Void)? = nil) {
        scripts.append(javaScriptString)
        completionHandler?(nil, nil)
    }
}
