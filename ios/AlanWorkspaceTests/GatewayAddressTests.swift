import XCTest
@testable import AlanWorkspace

/// The vectors are the ones in `desktop/test/tailnet.test.cjs`, for the same rule.
final class GatewayAddressTests: XCTestCase {
    func testAcceptsTailscaleServeNames() {
        for url in ["https://vm.tail1234.ts.net", "https://vm.tail1234.ts.net/p/work", "https://vm.tail1234.ts.net:8443", "HTTPS://VM.tail1234.TS.NET", " https://vm.tail1234.ts.net/ "] {
            XCTAssertNotNil(GatewayAddress.parse(url), url)
        }
    }

    func testRefusesEverythingElse() {
        let refused = ["http://vm.tail1234.ts.net", "ws://vm.tail1234.ts.net/api/ws", "wss://vm.tail1234.ts.net/api/ws", "https://ts.net", "https://.ts.net", "https://a..ts.net",
                       "https://vm.tail1234.ts.net.", "https://ts.net.evil.com", "https://vm.ts.net.evil.com", "https://evil-ts.net", "https://evilts.net",
                       "https://vm.ts.net@evil.example", "https://evil.example@vm.tail1234.ts.net", "https://user:pw@vm.tail1234.ts.net",
                       "https://vm.tail1234.ts.net%2eevil.com", "https://xn--vm-6ma.tail1234.ts.net", "https://vm.tѕ.net", "https://vm.ts。net.evil.com",
                       "https://203.0.113.7", "https://100.64.0.1", "http://100.64.0.1:9119", "https://localhost", "http://127.0.0.1:9119", "http://localhost:9119",
                       "ftp://vm.tail1234.ts.net", "javascript:alert(1)", "", "   ", "not a url", "vm.tail1234.ts.net", "https://-vm.tail1234.ts.net", "https://vm_x.tail1234.ts.net"]
        for url in refused { XCTAssertNil(GatewayAddress.parse(url), url) }
    }

    func testKeepsPrefixAndDropsQueryAndFragment() throws {
        let base = try XCTUnwrap(GatewayAddress.parse("https://vm.tail1234.ts.net/p/work/?token=x#frag"))
        XCTAssertEqual(base.origin, "https://vm.tail1234.ts.net")
        XCTAssertEqual(base.prefix, "/p/work")
        XCTAssertEqual(base.url("/api/status")?.absoluteString, "https://vm.tail1234.ts.net/p/work/api/status")
        XCTAssertEqual(GatewayAddress.parse("https://vm.tail1234.ts.net:8443")?.origin, "https://vm.tail1234.ts.net:8443")
    }

    func testLoopbackOnlyWhenTheCallerOptsIn() {
        XCTAssertNil(GatewayAddress.parse("http://127.0.0.1:9119"))
        XCTAssertNotNil(GatewayAddress.parse("http://127.0.0.1:9119", allowLoopback: true))
        XCTAssertNil(GatewayAddress.parse("http://example.com", allowLoopback: true))
        XCTAssertNil(GatewayAddress.parse("https://127.0.0.1:9119", allowLoopback: true))
    }
}
