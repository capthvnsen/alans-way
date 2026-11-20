import SwiftUI

enum AvatarTint: String, CaseIterable {
    case none, red, blue, yellow

    init(normalizing value: String?) { self = value.flatMap(Self.init(rawValue:)) ?? .none }

    // The desktop CSS filters are hue-rotate then saturate; its yellow also has sepia(.1), which SwiftUI has no modifier for.
    var hueDegrees: Double {
        switch self { case .none: 0; case .red: -34; case .blue: 172; case .yellow: 8 }
    }
    var swatch: Color {
        switch self {
        case .none: Color(red: 0.90, green: 0.87, blue: 0.81)
        case .red: Color(red: 0.86, green: 0.76, blue: 0.76)
        case .blue: Color(red: 0.76, green: 0.82, blue: 0.87)
        case .yellow: Color(red: 0.88, green: 0.83, blue: 0.66)
        }
    }
    var saturation: Double {
        switch self { case .none: 1; case .red: 0.8; case .blue: 0.7; case .yellow: 1.3 }
    }
}

/// Eye geometry as fractions of the bust image, the same numbers and bounds as desktop/src/avatars.js `normalizeEyes`.
/// An eye is an ellipse `radius * scaleX` wide and `radius * aspect * scaleY` tall (radii), tilted `rotate` degrees.
struct AvatarEyes: Equatable, Decodable {
    struct Point: Equatable {
        var x: Double, y: Double, scaleX: Double, scaleY: Double, rotate: Double
    }
    struct Travel: Equatable {
        var left: Double, right: Double, up: Double, down: Double
    }
    enum Side { case left, right }

    var enabled: Bool
    var style: String
    var radius: Double
    var aspect: Double
    var left: Point
    var right: Point
    var travel: Travel

    private enum CodingKeys: String, CodingKey { case enabled, style, radius, aspect, left, right, travel }
    // One wrong-typed number falls back on its own, as in desktop's per-field `bounded`.
    private struct RawPoint: Decodable {
        var x, y, scaleX, scaleY, rotate: Double?
        enum Keys: String, CodingKey { case x, y, scaleX, scaleY, rotate }
        init(from decoder: Decoder) throws {
            let c = try decoder.container(keyedBy: Keys.self)
            x = try? c.decode(Double.self, forKey: .x); y = try? c.decode(Double.self, forKey: .y)
            scaleX = try? c.decode(Double.self, forKey: .scaleX); scaleY = try? c.decode(Double.self, forKey: .scaleY)
            rotate = try? c.decode(Double.self, forKey: .rotate)
        }
    }
    private struct RawTravel: Decodable {
        var left, right, up, down: Double?
        enum Keys: String, CodingKey { case left, right, up, down }
        init(from decoder: Decoder) throws {
            let c = try decoder.container(keyedBy: Keys.self)
            left = try? c.decode(Double.self, forKey: .left); right = try? c.decode(Double.self, forKey: .right)
            up = try? c.decode(Double.self, forKey: .up); down = try? c.decode(Double.self, forKey: .down)
        }
    }

    private static func bounded(_ value: Double?, _ low: Double, _ high: Double, _ fallback: Double) -> Double {
        guard let value, value.isFinite else { return fallback }
        return min(high, max(low, value))
    }

    init(from decoder: Decoder) throws {
        let container = try decoder.container(keyedBy: CodingKeys.self)
        func lenient<T: Decodable>(_ key: CodingKeys) -> T? { try? container.decode(T.self, forKey: key) }
        func point(_ raw: RawPoint?, x: Double) -> Point {
            Point(x: Self.bounded(raw?.x, 0.05, 0.95, x), y: Self.bounded(raw?.y, 0.05, 0.95, 0.43),
                  scaleX: Self.bounded(raw?.scaleX, 0.5, 1.5, 1), scaleY: Self.bounded(raw?.scaleY, 0.5, 1.5, 1),
                  rotate: Self.bounded(raw?.rotate, -45, 45, 0))
        }
        let travel: RawTravel? = lenient(.travel)
        enabled = lenient(.enabled) ?? false
        style = lenient(.style) == "obsidian" ? "obsidian" : "classic"
        radius = Self.bounded(lenient(.radius), 0.008, 0.12, 0.045)
        aspect = Self.bounded(lenient(.aspect), 0.5, 3, 1)
        left = point(lenient(.left), x: 0.37)
        right = point(lenient(.right), x: 0.63)
        self.travel = Travel(left: Self.bounded(travel?.left, 0, 0.05, 0.02), right: Self.bounded(travel?.right, 0, 0.05, 0.02),
                             up: Self.bounded(travel?.up, 0, 0.05, 0.012), down: Self.bounded(travel?.down, 0, 0.05, 0.016))
    }

    func point(_ side: Side) -> Point { side == .left ? left : right }

    /// Centre and size of one eye, in points, inside a square image of edge `edge`.
    func shape(_ side: Side, in edge: Double) -> (center: CGPoint, size: CGSize, rotation: Double) {
        let eye = point(side)
        return (CGPoint(x: eye.x * edge, y: eye.y * edge),
                CGSize(width: radius * 2 * eye.scaleX * edge, height: radius * 2 * aspect * eye.scaleY * edge), eye.rotate)
    }

    /// How far an eye moves from rest for a gaze `look` in the unit disk, in points; travel is limited per direction so the eyes stay on the face.
    func shift(_ side: Side, look: CGPoint, in edge: Double) -> CGSize {
        let length = hypot(look.x, look.y), k = length > 1 ? 1 / length : 1
        let x = look.x * k, y = look.y * k
        return CGSize(width: x * (x > 0 ? travel.right : travel.left) * edge, height: y * (y > 0 ? travel.down : travel.up) * edge)
    }

    /// Vertical scale of the lid for a blink of 0 (open) to 1 (shut).
    static func lid(_ blink: Double) -> Double { 1 - 0.92 * min(1, max(0, blink)) }
}

struct AvatarBust: Equatable, Decodable {
    var id: String
    var name: String
    var file: String
    var cutout: Bool
    var eyes: AvatarEyes

    /// The asset-catalog name and the key the app stores per chat ("athena"); desktop stores the id ("marble-athena").
    var slug: String { (file as NSString).deletingPathExtension }

    private enum CodingKeys: String, CodingKey { case id, name, file, cutout, eyes }

    init(from decoder: Decoder) throws {
        let container = try decoder.container(keyedBy: CodingKeys.self)
        id = try container.decode(String.self, forKey: .id)
        name = try container.decode(String.self, forKey: .name)
        file = try container.decode(String.self, forKey: .file)
        cutout = (try? container.decode(Bool.self, forKey: .cutout)) == true
        eyes = try container.decode(AvatarEyes.self, forKey: .eyes)
    }
}

struct ResolvedAvatar: Equatable {
    var bust: AvatarBust
    var tint: AvatarTint
    /// The marble busts have no eyes of their own, so the manifest eyes are always on.
    var eyes: AvatarEyes { var eyes = bust.eyes; eyes.enabled = true; return eyes }
}

struct AvatarCatalog {
    let busts: [AvatarBust]

    init(data: Data) throws { busts = try JSONDecoder().decode([AvatarBust].self, from: data) }

    /// The manifest is copied from the desktop app by `ios/scripts/sync-avatars.sh`.
    static let shared: AvatarCatalog = {
        let url = Bundle(for: AvatarBundleToken.self).url(forResource: "avatars-manifest", withExtension: "json")
        return (try? url.map { try AvatarCatalog(data: Data(contentsOf: $0)) }) ?? AvatarCatalog(busts: [])
    }()

    private init(busts: [AvatarBust]) { self.busts = busts }

    /// Same rule as desktop `resolveAvatar` for a built-in pick: a known id (or iOS slug) gets its manifest eyes; a tint only
    /// applies to a cutout bust and an unknown tint means none. An unknown pick has no bust, so the caller draws the fallback.
    func resolve(_ selection: String, tint: String? = nil) -> ResolvedAvatar? {
        guard let bust = busts.first(where: { $0.id == selection || $0.slug == selection }) else { return nil }
        return ResolvedAvatar(bust: bust, tint: bust.cutout ? AvatarTint(normalizing: tint) : .none)
    }
}

private final class AvatarBundleToken {}
