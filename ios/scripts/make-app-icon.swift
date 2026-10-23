import AppKit

let target = CommandLine.arguments.dropFirst().first ?? "AlanWorkspace/Resources/Assets.xcassets/AppIcon.appiconset/Icon.png"
let canvas = NSSize(width: 1024, height: 1024)
let bitmap = NSBitmapImageRep(bitmapDataPlanes: nil, pixelsWide: 1024, pixelsHigh: 1024, bitsPerSample: 8, samplesPerPixel: 3, hasAlpha: false, isPlanar: false, colorSpaceName: .deviceRGB, bytesPerRow: 0, bitsPerPixel: 0)!
NSGraphicsContext.saveGraphicsState()
NSGraphicsContext.current = NSGraphicsContext(bitmapImageRep: bitmap)
NSColor(calibratedRed: 0.047, green: 0.055, blue: 0.059, alpha: 1).setFill()
NSBezierPath(rect: NSRect(origin: .zero, size: canvas)).fill()
NSColor(calibratedRed: 0.72, green: 0.88, blue: 0.80, alpha: 1).setStroke()
let orbit = NSBezierPath(ovalIn: NSRect(x: 133, y: 133, width: 758, height: 758))
orbit.lineWidth = 2
orbit.stroke()
let font = NSFont(name: "Baskerville", size: 790) ?? NSFont.systemFont(ofSize: 790)
let attributes: [NSAttributedString.Key: Any] = [.font: font, .foregroundColor: NSColor(calibratedRed: 0.72, green: 0.88, blue: 0.80, alpha: 1)]
let glyph = "a" as NSString
let size = glyph.size(withAttributes: attributes)
glyph.draw(at: NSPoint(x: (1024-size.width)/2-12, y: (1024-size.height)/2+36), withAttributes: attributes)
NSGraphicsContext.restoreGraphicsState()
try bitmap.representation(using: .png, properties: [:])!.write(to: URL(fileURLWithPath: target))
