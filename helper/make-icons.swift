// Draws the Orbit app icons (ink square, amber orbit with a glowing moon).
// Usage: swift helper/make-icons.swift web/public/icons
import AppKit

let outDir = CommandLine.arguments.dropFirst().first ?? "web/public/icons"
try? FileManager.default.createDirectory(atPath: outDir, withIntermediateDirectories: true)

func color(_ r: CGFloat, _ g: CGFloat, _ b: CGFloat, _ a: CGFloat = 1) -> NSColor {
    NSColor(srgbRed: r / 255, green: g / 255, blue: b / 255, alpha: a)
}

func render(size: Int, inset: CGFloat, file: String) {
    guard let rep = NSBitmapImageRep(bitmapDataPlanes: nil, pixelsWide: size, pixelsHigh: size,
                                     bitsPerSample: 8, samplesPerPixel: 4, hasAlpha: true, isPlanar: false,
                                     colorSpaceName: .deviceRGB, bytesPerRow: 0, bitsPerPixel: 0) else { return }
    let s = CGFloat(size)
    NSGraphicsContext.saveGraphicsState()
    NSGraphicsContext.current = NSGraphicsContext(bitmapImageRep: rep)

    NSGradient(colors: [color(26, 32, 42), color(10, 13, 18)])?.draw(in: NSRect(x: 0, y: 0, width: s, height: s), angle: -90)
    NSGradient(colors: [color(255, 164, 54, 0.22), color(255, 164, 54, 0)])?
        .draw(fromCenter: NSPoint(x: s * 0.28, y: s * 0.86), radius: 0,
              toCenter: NSPoint(x: s * 0.28, y: s * 0.86), radius: s * 0.7, options: [])

    let center = NSPoint(x: s / 2, y: s / 2)
    let radius = (s / 2 - inset) * 0.58

    let faint = NSBezierPath(ovalIn: NSRect(x: center.x - radius * 1.42, y: center.y - radius * 1.42,
                                            width: radius * 2.84, height: radius * 2.84))
    faint.lineWidth = s * 0.008
    color(255, 255, 255, 0.10).setStroke()
    faint.stroke()

    let glow = NSShadow()
    glow.shadowColor = color(255, 150, 40, 0.75)
    glow.shadowBlurRadius = s * 0.05
    glow.shadowOffset = .zero

    NSGraphicsContext.saveGraphicsState()
    glow.set()
    let ring = NSBezierPath(ovalIn: NSRect(x: center.x - radius, y: center.y - radius, width: radius * 2, height: radius * 2))
    ring.lineWidth = s * 0.04
    color(255, 181, 71).setStroke()
    ring.stroke()
    let angle = CGFloat.pi / 4
    let moon = NSPoint(x: center.x + radius * cos(angle), y: center.y + radius * sin(angle))
    let moonRadius = s * 0.07
    color(255, 216, 152).setFill()
    NSBezierPath(ovalIn: NSRect(x: moon.x - moonRadius, y: moon.y - moonRadius, width: moonRadius * 2, height: moonRadius * 2)).fill()
    NSGraphicsContext.restoreGraphicsState()

    let core = s * 0.085
    color(236, 231, 222).setFill()
    NSBezierPath(ovalIn: NSRect(x: center.x - core, y: center.y - core, width: core * 2, height: core * 2)).fill()

    NSGraphicsContext.restoreGraphicsState()
    guard let png = rep.representation(using: .png, properties: [:]) else { return }
    try? png.write(to: URL(fileURLWithPath: outDir).appendingPathComponent(file))
    print("wrote \(file)")
}

render(size: 180, inset: 0, file: "apple-touch-icon.png")
render(size: 192, inset: 0, file: "icon-192.png")
render(size: 512, inset: 0, file: "icon-512.png")
render(size: 512, inset: 60, file: "icon-512-maskable.png")
render(size: 64, inset: 0, file: "favicon.png")
