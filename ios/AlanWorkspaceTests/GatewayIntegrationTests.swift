import XCTest
@testable import AlanWorkspace

/// The real client (HTTP sign-in, ticket, `URLSessionWebSocketTask`, link, store) against the desktop's fake Hermes
/// backend. The backend is a node process, which a simulator test cannot start, so `ios/scripts/test-gateway-integration.sh`
/// starts it and passes its address in `GATEWAY_FAKE_URL` / `GATEWAY_FAKE_CONTROL`. Without them these tests skip.
@MainActor final class GatewayIntegrationTests: XCTestCase {
    private var url: String!, control: String!
    private var store: GatewayStore!
    private var credentials: MemoryGatewaySessionStore!
    private var outboxURL: URL!

    override func setUpWithError() throws {
        let env = ProcessInfo.processInfo.environment
        guard let u = env["GATEWAY_FAKE_URL"], let c = env["GATEWAY_FAKE_CONTROL"] else { throw XCTSkip("Run ios/scripts/test-gateway-integration.sh to start the fake backend.") }
        url = u; control = c
        credentials = MemoryGatewaySessionStore()
        outboxURL = FileManager.default.temporaryDirectory.appendingPathComponent("integration-\(UUID().uuidString)/outbox.json")
        store = GatewayStore(sessionStore: credentials, outboxURL: outboxURL, allowLoopback: true, monitorNetwork: false)
    }
    override func tearDown() async throws { store?.signOut(keepUnsent: false) }

    private func hit(_ path: String) async { _ = try? await URLSession.shared.data(from: URL(string: control + path)!) }
    private func until(_ what: String, timeout: TimeInterval = 20, _ condition: () -> Bool) async throws {
        let deadline = Date().addingTimeInterval(timeout)
        while !condition() { if Date() > deadline { XCTFail("Timed out waiting for \(what)"); throw CancellationError() }; try await Task.sleep(nanoseconds: 50_000_000) }
    }

    func testSignInStoresOnlyTheSessionAndNeverThePassword() async throws {
        try await store.signIn(address: url, username: "alex", password: "correct horse battery staple")
        let session = try XCTUnwrap(credentials.load())
        XCTAssertTrue(session.accessToken.hasPrefix("at-ios-")); XCTAssertTrue(session.refreshToken.hasPrefix("rt-ios-"))
        let blob = String(data: try JSONEncoder().encode(session), encoding: .utf8)!
        XCTAssertFalse(blob.contains("correct horse"), "the password must not be in what is stored")
        try await until("live") { store.linkState == .live }
    }

    func testListOpenSendAndReceiveAStreamedReplyThenResumeAfterADropMidReply() async throws {
        try await store.signIn(address: url, username: "alex", password: "pw")
        try await until("live") { store.linkState == .live }
        await store.refreshConversations()
        XCTAssertEqual(Set(store.conversations.map(\.title)), ["Planning the week", "Release notes"])
        store.open("key-1")
        try await until("history") { store.thread("key-1").hasLoaded }
        XCTAssertEqual(store.messages(for: "key-1").first?.text, "What is on for Monday?")
        let before = store.messages(for: "key-1").count

        try store.send("Hello Alan", to: "key-1")
        try await until("the reply") { store.messages(for: "key-1").count == before + 2 && !store.thread("key-1").busy }
        XCTAssertEqual(store.messages(for: "key-1").suffix(2).map(\.text), ["Hello Alan", "You said: Hello Alan"])

        // A reply that is streaming when the connection drops arrives whole, once.
        try store.send("show me example code", to: "key-1")
        try await until("the reply to start") { store.messages(for: "key-1").last?.isStreaming == true || store.thread("key-1").busy || store.messages(for: "key-1").count > before + 2 }
        await hit("/drop")
        try await until("the whole reply", timeout: 30) { store.messages(for: "key-1").last?.text.hasSuffix("returns the text.") == true && !store.thread("key-1").busy }
        let reply = try XCTUnwrap(store.messages(for: "key-1").last?.text)
        XCTAssertEqual(reply.components(separatedBy: "def greet").count, 2, "the code block appears once")
        XCTAssertTrue(reply.contains("```python"))
        XCTAssertEqual(store.messages(for: "key-1").filter { $0.text == "show me example code" }.count, 1)
        XCTAssertEqual(store.linkState, .live)
    }

    func testAHermesRestartIsRecoveredFromHistory() async throws {
        try await store.signIn(address: url, username: "alex", password: "pw")
        try await until("live") { store.linkState == .live }
        store.open("key-2")
        try await until("history") { store.thread("key-2").hasLoaded }
        await hit("/restart")
        try await Task.sleep(nanoseconds: 500_000_000)      // let the link notice the drop first
        try await until("the link to recover", timeout: 30) { store.linkState == .live && store.thread("key-2").hasLoaded && !store.thread("key-2").isLoading }
        XCTAssertEqual(store.messages(for: "key-2").first?.text, "Draft the release notes headline")
        try store.send("after the restart", to: "key-2")
        try await until("the reply") { store.messages(for: "key-2").last?.text == "You said: after the restart" }
    }

    func testAWrongAddressIsRefusedBeforeAnythingIsSent() async throws {
        let strict = GatewayStore(sessionStore: MemoryGatewaySessionStore(), outboxURL: nil, monitorNetwork: false)
        do { try await strict.signIn(address: url, username: "a", password: "b"); XCTFail("plain http to loopback must be refused") }
        catch let e as GatewayError { XCTAssertEqual(e.code, "bad_url") }
    }
}
