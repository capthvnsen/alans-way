import SwiftUI

/// Idle glances and blinks at irregular intervals, ported from desktop `createWander` with its idle settings
/// (`reach` 0.4, `hold` 2.2): the first glance comes after about 1-3.5 s, the next after 2-6 s, often back to centre.
/// Each `next()` is the next thing to do and how long to wait for it, so nothing needs a per-frame clock.
struct AvatarWander {
    enum Event: Equatable {
        case look(x: Double, y: Double)
        case blink(closed: Bool)
    }
    struct Step: Equatable {
        var delay: TimeInterval
        var event: Event
    }

    private let random: () -> Double
    private let reach: Double
    private let hold: Double
    private var clock = 0.0
    private var glanceAt: Double
    private var blinkAt: Double
    private var openAt: Double?
    private var blinkFor = 0.15

    init(reach: Double = 0.4, hold: Double = 2.2, random: @escaping () -> Double = { Double.random(in: 0..<1) }) {
        self.random = random
        self.reach = reach
        self.hold = hold
        glanceAt = 0
        blinkAt = 0
        glanceAt = between(0.5, 1.6) * hold
        blinkAt = between(1.2, 3.2)
    }

    private func between(_ low: Double, _ high: Double) -> Double { low + (high - low) * random() }

    mutating func next() -> Step {
        let due = [glanceAt, blinkAt, openAt ?? .infinity].min()!
        let delay = max(0, due - clock)
        clock = max(clock, due)
        if let open = openAt, open <= glanceAt, open <= blinkAt {
            openAt = nil
            return Step(delay: delay, event: .blink(closed: false))
        }
        if glanceAt <= blinkAt {
            let angle = between(0, 2 * .pi), distance = between(0.35, 0.85) * reach
            let centre = random() < 0.3
            glanceAt = clock + between(0.9, 2.8) * hold
            return Step(delay: delay, event: centre ? .look(x: 0, y: 0) : .look(x: cos(angle) * distance, y: sin(angle) * distance * 0.7))
        }
        blinkFor = between(0.12, 0.19)
        openAt = clock + blinkFor / 2
        // Now and then a double blink.
        blinkAt = clock + (random() < 0.18 ? blinkFor + between(0.06, 0.14) : between(2.4, 6.5))
        return Step(delay: delay, event: .blink(closed: true))
    }
}

/// Where the eyes are looking and how shut they are, driven by `run` only while the avatar is live and visible.
@MainActor @Observable final class AvatarGaze {
    private(set) var look = CGPoint.zero
    private(set) var blink = 0.0

    /// Whether the eyes should move at all: only a live avatar that is on screen, in an active app, without Reduce Motion.
    nonisolated static func animates(live: Bool, reduceMotion: Bool, appActive: Bool, onScreen: Bool) -> Bool {
        live && !reduceMotion && appActive && onScreen
    }

    /// Runs until cancelled, then leaves the eyes at rest. With `enabled` false it returns at once and schedules nothing.
    func run(enabled: Bool, wander: AvatarWander = AvatarWander(), sleep: (Duration) async throws -> Void = { try await Task.sleep(for: $0) }) async {
        rest()
        guard enabled else { return }
        var wander = wander
        while !Task.isCancelled {
            let step = wander.next()
            do { try await sleep(.seconds(step.delay)) } catch { break }
            switch step.event {
            case .look(let x, let y): look = CGPoint(x: x, y: y)
            case .blink(let closed): blink = closed ? 1 : 0
            }
        }
        rest()
    }

    private func rest() {
        if look != .zero { look = .zero }
        if blink != 0 { blink = 0 }
    }
}

/// A bot's marble bust with flat eyes drawn from the desktop manifest. Static unless `live`; decorative either way.
/// A bust the app does not know falls back to the title's initial in a circle.
struct AgentPortrait: View {
    var name: String = "hermes"
    var size: CGFloat = 52
    var tint: String = "none"
    var title: String = ""
    var live = false

    @ScaledMetric private var scaled: CGFloat
    @Environment(\.accessibilityReduceMotion) private var reduceMotion
    @Environment(\.scenePhase) private var scenePhase
    @State private var gaze = AvatarGaze()
    @State private var onScreen = false

    init(name: String = "hermes", size: CGFloat = 52, tint: String = "none", title: String = "", live: Bool = false) {
        self.name = name
        self.size = size
        self.tint = tint
        self.title = title
        self.live = live
        _scaled = ScaledMetric(wrappedValue: size, relativeTo: .body)
    }

    private var animates: Bool {
        AvatarGaze.animates(live: live, reduceMotion: reduceMotion, appActive: scenePhase == .active, onScreen: onScreen)
    }

    var body: some View {
        let side = min(scaled, size * 1.5)
        Group {
            if let avatar = AvatarCatalog.shared.resolve(name, tint: tint) { bust(avatar, side: side) } else { fallback(side: side) }
        }
        .accessibilityHidden(true)
        .onAppear { onScreen = true }
        .onDisappear { onScreen = false }
        .task(id: animates) { await gaze.run(enabled: animates) }
    }

    private func bust(_ avatar: ResolvedAvatar, side: CGFloat) -> some View {
        // The image sits low in the tile with a tenth of headroom, as before eyes existed.
        let edge = Double(side) * 0.9, eyes = avatar.eyes
        return ZStack {
            Image(avatar.bust.slug).resizable()
                .hueRotation(.degrees(avatar.tint.hueDegrees)).saturation(avatar.tint.saturation)
            ForEach([AvatarEyes.Side.left, .right], id: \.self) { eye($0, eyes: eyes, edge: edge) }
        }
        .frame(width: edge, height: edge)
        .frame(width: side, height: side, alignment: .bottom)
        .background(WorkspaceTheme.raised)
        .clipShape(RoundedRectangle(cornerRadius: side * 0.30, style: .continuous))
    }

    private func eye(_ side: AvatarEyes.Side, eyes: AvatarEyes, edge: Double) -> some View {
        let shape = eyes.shape(side, in: edge), shift = eyes.shift(side, look: gaze.look, in: edge)
        return Ellipse().fill(.black)
            .frame(width: shape.size.width, height: shape.size.height)
            .scaleEffect(y: AvatarEyes.lid(gaze.blink))
            .animation(.easeInOut(duration: 0.07), value: gaze.blink)
            .rotationEffect(.degrees(shape.rotation))
            .offset(shift)
            .animation(.easeInOut(duration: 0.3), value: gaze.look)
            .position(x: shape.center.x, y: shape.center.y)
    }

    private func fallback(side: CGFloat) -> some View {
        Text(String(title.trimmingCharacters(in: .whitespaces).first ?? "·").uppercased())
            .font(.system(size: side * 0.42, weight: .semibold, design: .rounded)).foregroundStyle(WorkspaceTheme.mint)
            .frame(width: side, height: side).background(WorkspaceTheme.raised, in: Circle())
    }
}
