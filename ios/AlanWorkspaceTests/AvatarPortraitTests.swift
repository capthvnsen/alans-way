import XCTest
import UIKit
@testable import AlanWorkspace

final class AvatarPortraitTests: XCTestCase {
    private var repo: URL { URL(fileURLWithPath: #filePath).deletingLastPathComponent().deletingLastPathComponent().deletingLastPathComponent() }
    private var catalog: AvatarCatalog { AvatarCatalog.shared }

    func testBundledManifestParsesAllTenBusts() {
        XCTAssertEqual(catalog.busts.count, 10)
        XCTAssertEqual(Set(catalog.busts.map(\.id)).count, 10)
        for bust in catalog.busts {
            XCTAssertTrue(bust.eyes.enabled, bust.id)
            XCTAssertEqual(bust.eyes.style, "obsidian", bust.id)
            XCTAssertTrue(bust.cutout, bust.id)
            XCTAssertNotNil(UIImage(named: bust.slug), "\(bust.slug) is missing from the asset catalog")
            XCTAssertTrue(WorkspaceSettings.availableAvatars.contains(bust.slug), bust.slug)
        }
        XCTAssertEqual(Set(catalog.busts.map(\.slug)), Set(WorkspaceSettings.availableAvatars))
    }

    func testBadEyeValuesAreBoundedLikeDesktop() throws {
        let json = #"[{"id":"x","name":"X","file":"x.png","eyes":{"enabled":"true","radius":99,"aspect":99,"style":"other","left":{"x":-1,"y":"bad","scaleX":0},"right":{"x":3,"scaleX":10}}}]"#
        let eyes = try XCTUnwrap(AvatarCatalog(data: Data(json.utf8)).busts.first).eyes
        XCTAssertFalse(eyes.enabled)
        XCTAssertEqual(eyes.style, "classic")
        XCTAssertEqual(eyes.radius, 0.12)
        XCTAssertEqual(eyes.aspect, 3)
        XCTAssertEqual(eyes.left, AvatarEyes.Point(x: 0.05, y: 0.43, scaleX: 0.5, scaleY: 1, rotate: 0))
        XCTAssertEqual(eyes.right, AvatarEyes.Point(x: 0.95, y: 0.43, scaleX: 1.5, scaleY: 1, rotate: 0))
        XCTAssertEqual(eyes.travel, AvatarEyes.Travel(left: 0.02, right: 0.02, up: 0.012, down: 0.016))
    }

    /// The app's copies are made by ios/scripts/sync-avatars.sh; this fails when the desktop files change without re-running it.
    func testBundledCopiesMatchTheDesktopFiles() throws {
        let desktop = repo.appendingPathComponent("desktop/assets/avatars")
        let manifest = try Data(contentsOf: desktop.appendingPathComponent("manifest.json"))
        let bundled = try XCTUnwrap(Bundle.main.url(forResource: "avatars-manifest", withExtension: "json"))
        XCTAssertEqual(try Data(contentsOf: bundled), manifest, "run ios/scripts/sync-avatars.sh")
        for bust in catalog.busts {
            let copy = repo.appendingPathComponent("ios/AlanWorkspace/Resources/Assets.xcassets/\(bust.slug).imageset/\(bust.slug).png")
            XCTAssertEqual(try Data(contentsOf: copy), try Data(contentsOf: desktop.appendingPathComponent(bust.file)), bust.slug)
        }
    }

    /// Expected values come from desktop's own code: `resolveAvatar(bot, { avatarLibrary: store.publicLibrary(), avatarPreferences })`
    /// from desktop/src/avatars.js with the library built by desktop/src/avatar-store.cjs, run with node for each preference below.
    func testBustAndTintSelectionMatchDesktop() throws {
        let cases: [(selection: String, tint: String?, expectedTint: AvatarTint?)] = [
            ("marble-zeus", "red", .red),         // bot 7
            ("marble-medusa", "purple", AvatarTint.none), // bot 8: unknown tint is none
            ("marble-hermes", nil, AvatarTint.none),     // bot 9
            ("marble-apollo", "yellow", .yellow), // bot 11
            ("marble-nope", "blue", nil),         // bot 10: desktop falls back to the Telegram picture with no eyes; iOS draws the initial
        ]
        for item in cases {
            let resolved = catalog.resolve(item.selection, tint: item.tint)
            XCTAssertEqual(resolved?.tint, item.expectedTint, item.selection)
            XCTAssertEqual(resolved?.bust.id, item.expectedTint == nil ? nil : item.selection)
            if let resolved { XCTAssertTrue(resolved.eyes.enabled) }
        }
        let zeus = try XCTUnwrap(catalog.resolve("zeus")).eyes
        XCTAssertEqual(zeus, catalog.resolve("marble-zeus")?.eyes, "iOS stores the slug, desktop the id")
        XCTAssertEqual([zeus.radius, zeus.aspect], [0.0222, 1.894])
        XCTAssertEqual(zeus.right, AvatarEyes.Point(x: 0.6076, y: 0.3759, scaleX: 0.7694, scaleY: 0.9655, rotate: 2.6))
        XCTAssertEqual(zeus.travel, AvatarEyes.Travel(left: 0.04, right: 0.018, up: 0.024, down: 0.032))
        XCTAssertNil(catalog.resolve("nobody"))
    }

    func testEyeGeometryForZeusAtTwoSizes() throws {
        let eyes = try XCTUnwrap(catalog.resolve("zeus")).eyes
        let expected: [(Double, AvatarEyes.Side, CGPoint, CGSize)] = [
            (100, .left, CGPoint(x: 47.25, y: 37.34), CGSize(width: 4.44, height: 8.40936)),
            (200, .left, CGPoint(x: 94.5, y: 74.68), CGSize(width: 8.88, height: 16.81872)),
            (100, .right, CGPoint(x: 60.76, y: 37.59), CGSize(width: 3.416136, height: 8.11923708)),
            (200, .right, CGPoint(x: 121.52, y: 75.18), CGSize(width: 6.832272, height: 16.23847416)),
        ]
        for (edge, side, center, size) in expected {
            let shape = eyes.shape(side, in: edge)
            XCTAssertEqual(shape.center.x, center.x, accuracy: 1e-9)
            XCTAssertEqual(shape.center.y, center.y, accuracy: 1e-9)
            XCTAssertEqual(shape.size.width, size.width, accuracy: 1e-9)
            XCTAssertEqual(shape.size.height, size.height, accuracy: 1e-9)
        }
        XCTAssertEqual(eyes.shape(.left, in: 100).rotation, 1.2)
        // Gaze is limited per direction and stays inside the unit disk.
        XCTAssertEqual(eyes.shift(.left, look: CGPoint(x: 1, y: 0), in: 100).width, 1.8, accuracy: 1e-9)
        XCTAssertEqual(eyes.shift(.left, look: CGPoint(x: -3, y: 0), in: 100).width, -4, accuracy: 1e-9)
        XCTAssertEqual(eyes.shift(.left, look: CGPoint(x: 0, y: 1), in: 200).height, 6.4, accuracy: 1e-9)
        XCTAssertEqual(eyes.shift(.left, look: CGPoint(x: 0, y: -1), in: 100).height, -2.4, accuracy: 1e-9)
        XCTAssertEqual(eyes.shift(.right, look: .zero, in: 100), .zero)
        XCTAssertEqual(AvatarEyes.lid(0), 1)
        XCTAssertEqual(AvatarEyes.lid(1), 0.08, accuracy: 1e-9)
        XCTAssertEqual(AvatarEyes.lid(7), 0.08, accuracy: 1e-9)
    }

    func testWanderStartsWithABlinkAndStaysIrregularButBounded() {
        var steady = AvatarWander(random: { 0.5 })
        XCTAssertEqual(steady.next(), AvatarWander.Step(delay: 2.2, event: .blink(closed: true)))
        XCTAssertEqual(steady.next().event, .blink(closed: false))

        var seed: UInt64 = 42
        var wander = AvatarWander(random: { seed = seed &* 6364136223846793005 &+ 1442695040888963407; return Double(seed >> 11) / Double(1 << 53) })
        var glances = 0, blinks = 0, closed = false, delays = Set<Double>()
        for _ in 0..<400 {
            let step = wander.next()
            XCTAssertGreaterThanOrEqual(step.delay, 0)
            delays.insert(step.delay)
            switch step.event {
            case .look(let x, let y):
                glances += 1
                XCTAssertLessThanOrEqual(hypot(x, y), 0.85 * 0.4 + 1e-9)
                if glances > 1 { XCTAssertGreaterThanOrEqual(step.delay, 0) }
            case .blink(let shut):
                XCTAssertNotEqual(shut, closed, "blinks alternate shut and open")
                closed = shut
                if shut { blinks += 1 }
            }
        }
        XCTAssertGreaterThan(glances, 20)
        XCTAssertGreaterThan(blinks, 20)
        XCTAssertGreaterThan(delays.count, 100, "timing is not periodic")
    }

    func testAnimationOnlyRunsForALiveVisibleActiveAvatarWithoutReduceMotion() {
        for live in [false, true] { for reduce in [false, true] { for active in [false, true] { for onScreen in [false, true] {
            XCTAssertEqual(AvatarGaze.animates(live: live, reduceMotion: reduce, appActive: active, onScreen: onScreen),
                           live && !reduce && active && onScreen)
        } } } }
    }

    @MainActor func testDisabledRunSchedulesNothing() async {
        let gaze = AvatarGaze()
        var sleeps = 0
        await gaze.run(enabled: false, sleep: { _ in sleeps += 1 })
        XCTAssertEqual(sleeps, 0)
        XCTAssertEqual(gaze.look, .zero)
        XCTAssertEqual(gaze.blink, 0)
    }

    @MainActor func testEnabledRunAppliesEventsAndLeavesTheEyesAtRestWhenStopped() async {
        let gaze = AvatarGaze()
        var sleeps = 0, sawShut = false
        await gaze.run(enabled: true, wander: AvatarWander(random: { 0.5 }), sleep: { _ in
            sleeps += 1
            if gaze.blink == 1 { sawShut = true }
            if sleeps == 4 { throw CancellationError() }
        })
        XCTAssertEqual(sleeps, 4)
        XCTAssertTrue(sawShut)
        XCTAssertEqual(gaze.blink, 0)
        XCTAssertEqual(gaze.look, .zero)
    }

    @MainActor func testTintChoiceIsPerChatAndPersists() {
        let suite = "workspace-test-\(UUID().uuidString)"
        let defaults = UserDefaults(suiteName: suite)!
        defer { defaults.removePersistentDomain(forName: suite) }
        let settings = WorkspaceSettings(defaults: defaults)
        XCTAssertEqual(settings.tint(for: 1), .none)
        settings.setTint(.blue, for: 1)
        XCTAssertEqual(WorkspaceSettings(defaults: defaults).tint(for: 1), .blue)
        XCTAssertEqual(WorkspaceSettings(defaults: defaults).tint(for: 2), .none)
        defaults.set(["1": "magenta"], forKey: "workspace.avatarTints")
        XCTAssertEqual(WorkspaceSettings(defaults: defaults).tint(for: 1), .none)
    }
}
