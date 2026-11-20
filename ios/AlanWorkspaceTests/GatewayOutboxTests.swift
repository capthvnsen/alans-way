import XCTest
@testable import AlanWorkspace

final class GatewayOutboxTests: XCTestCase {
    private var url: URL!
    override func setUp() { url = FileManager.default.temporaryDirectory.appendingPathComponent("outbox-\(UUID().uuidString)/outbox.json") }
    override func tearDown() { try? FileManager.default.removeItem(at: url.deletingLastPathComponent()) }

    func testMessagesGoInOrderAndOnlyTheHeadMayGo() throws {
        var box = GatewayOutbox()
        let a = try box.enqueue(conversationId: "c1", text: "one", now: 0)
        let b = try box.enqueue(conversationId: "c1", text: "two", now: 1)
        let other = try box.enqueue(conversationId: "c2", text: "elsewhere", now: 2)
        XCTAssertEqual(box.items(for: "c1").map(\.text), ["one", "two"])
        XCTAssertEqual(box.head(for: "c1")?.id, a.id)
        XCTAssertEqual(box.head(for: "c2")?.id, other.id)
        box.remove(a.id)
        XCTAssertEqual(box.head(for: "c1")?.id, b.id)
    }

    func testAFailedHeadHoldsTheMessagesBehindIt() throws {
        var box = GatewayOutbox()
        let a = try box.enqueue(conversationId: "c1", text: "one", now: 0)
        _ = try box.enqueue(conversationId: "c1", text: "two", now: 1)
        box.fail(a.id)
        XCTAssertEqual(box.head(for: "c1")?.state, .failed)
        box.retry(a.id, now: 5)
        XCTAssertEqual(box.head(for: "c1")?.state, .queued)
        XCTAssertEqual(box.head(for: "c1")?.createdAt, 5, "a retried message gets a fresh 30 minutes")
    }

    func testAMessageExpiresAfterThirtyMinutesAndIsNotDropped() throws {
        var box = GatewayOutbox()
        let a = try box.enqueue(conversationId: "c1", text: "old", now: 1000)
        XCTAssertEqual(box.nextExpiry(), 1000 + 30 * 60)
        XCTAssertFalse(box.sweep(now: 1000 + 30 * 60), "exactly at the limit it still goes")
        XCTAssertTrue(box.sweep(now: 1000 + 30 * 60 + 1))
        XCTAssertEqual(box.item(a.id)?.state, .failed)
        XCTAssertEqual(box.item(a.id)?.text, "old")
        XCTAssertNil(box.nextExpiry())
    }

    func testTheQueueIsCapped() throws {
        var box = GatewayOutbox()
        for i in 0..<GatewayOutbox.maxItems { _ = try box.enqueue(conversationId: "c", text: "m\(i)", now: 0) }
        XCTAssertThrowsError(try box.enqueue(conversationId: "c", text: "one more", now: 0)) { XCTAssertEqual(($0 as? GatewayError)?.code, "queue_full") }
        var big = GatewayOutbox()
        XCTAssertThrowsError(try big.enqueue(conversationId: "c", text: String(repeating: "x", count: GatewayOutbox.maxBytes + 1), now: 0))
    }

    func testItSurvivesARestartAndAnInterruptedSendIsInDoubt() throws {
        var box = GatewayOutbox(fileURL: url)
        let a = try box.enqueue(id: "id-a", conversationId: "c1", text: "one", now: 10)
        let b = try box.enqueue(id: "id-b", conversationId: "c1", text: "two", now: 11)
        box.markSending(a.id, now: 12, afterId: 7)
        box.fail(b.id)
        let loaded = GatewayOutbox(fileURL: url)
        XCTAssertEqual(loaded.items.map(\.id), ["id-a", "id-b"])
        XCTAssertEqual(loaded.item("id-a")?.state, .queued, "a send in flight at quit is queued again…")
        XCTAssertEqual(loaded.item("id-a")?.attempts, 1, "…but remembers it may have gone")
        XCTAssertEqual(loaded.item("id-a")?.afterId, 7)
        XCTAssertEqual(loaded.item("id-b")?.state, .failed)
    }

    func testTheFileIsWrittenBeforeAnythingIsSentAndRemovedWhenEmpty() throws {
        var box = GatewayOutbox(fileURL: url)
        let a = try box.enqueue(conversationId: "c1", text: "secret text", now: 0)
        XCTAssertTrue(FileManager.default.fileExists(atPath: url.path))
        let values = try url.resourceValues(forKeys: [.isExcludedFromBackupKey])
        XCTAssertEqual(values.isExcludedFromBackup, true)
        box.remove(a.id)
        XCTAssertFalse(FileManager.default.fileExists(atPath: url.path))
    }

    func testAGarbledFileLoadsAsEmpty() throws {
        try FileManager.default.createDirectory(at: url.deletingLastPathComponent(), withIntermediateDirectories: true)
        try Data("{not json".utf8).write(to: url)
        XCTAssertTrue(GatewayOutbox(fileURL: url).items.isEmpty)
    }

    func testUnsendRestoresTheAttemptCountSoItIsNotInDoubt() throws {
        var box = GatewayOutbox()
        let a = try box.enqueue(conversationId: "c1", text: "x", now: 0)
        box.markSending(a.id, now: 5, afterId: 3)
        box.unsend(a.id, attempts: 0, attemptedAt: 0)
        XCTAssertEqual(box.item(a.id)?.attempts, 0); XCTAssertEqual(box.item(a.id)?.state, .queued)
    }
}

final class GatewayDeliveryTests: XCTestCase {
    private func item(text: String = "hello", afterId: Int = 10, attemptedAt: TimeInterval = 1000) -> GatewayOutboxItem {
        GatewayOutboxItem(id: "c", conversationId: "k", text: text, createdAt: 900, state: .queued, attempts: 1, attemptedAt: attemptedAt, afterId: afterId)
    }
    private func row(_ id: Int, _ text: String, role: String = "user", at: TimeInterval = 1001) -> GatewayHistoryRow { .init(rowId: id, role: role, text: text, timestamp: at) }

    func testAUserRowWithTheSameTextAfterTheFirstTryIsTheMessage() {
        XCTAssertEqual(GatewayDelivery.match(item(), in: [row(9, "hello", at: 500), row(11, " hello\n")], claimed: [])?.rowId, 11)
    }
    func testOlderRowsOtherRolesAndOtherTextDoNotMatch() {
        XCTAssertNil(GatewayDelivery.match(item(), in: [row(10, "hello"), row(12, "hello", role: "assistant"), row(13, "different"), row(14, "hello", at: 900)], claimed: []))
    }
    func testARowAnotherMessageAlreadyClaimedIsNotUsedTwice() {
        let rows = [row(11, "hello"), row(15, "hello")]
        XCTAssertEqual(GatewayDelivery.match(item(), in: rows, claimed: [11])?.rowId, 15)
        XCTAssertNil(GatewayDelivery.match(item(), in: rows, claimed: [11, 15]))
    }
    func testTheEarliestMatchWins() {
        XCTAssertEqual(GatewayDelivery.match(item(), in: [row(20, "hello"), row(12, "hello")], claimed: [])?.rowId, 12)
    }
    func testSlackAllowsClockSkewOfAMinute() {
        XCTAssertNotNil(GatewayDelivery.match(item(), in: [row(11, "hello", at: 945)], claimed: []))
        XCTAssertNil(GatewayDelivery.match(item(), in: [row(11, "hello", at: 939)], claimed: []))
    }
}
