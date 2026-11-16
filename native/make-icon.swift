// Renders the app icon (1024x1024 PNG) for EpicClaimsNotifier.app.
//
// Notification banners show the sending bundle's icon, so an unbadged helper
// makes every Epic Claims notification look like an anonymous system alert.
// The mark is deliberately simple: a controller silhouette plus a green check,
// which still reads as "a game, and it is claimed" at 16pt.
//
// Usage: swiftc -O make-icon.swift -o /tmp/make-icon && /tmp/make-icon out.png
import AppKit

let size: CGFloat = 1024

func roundedRect(_ x: CGFloat, _ y: CGFloat, _ w: CGFloat, _ h: CGFloat, _ r: CGFloat) -> NSBezierPath {
    NSBezierPath(roundedRect: NSRect(x: x, y: y, width: w, height: h), xRadius: r, yRadius: r)
}

let image = NSImage(size: NSSize(width: size, height: size))
image.lockFocus()

// Background: dark violet squircle, slightly inset like a macOS app icon.
let background = roundedRect(24, 24, size - 48, size - 48, 210)
NSGradient(
    colors: [
        NSColor(calibratedRed: 0.36, green: 0.16, blue: 0.80, alpha: 1),
        NSColor(calibratedRed: 0.13, green: 0.07, blue: 0.28, alpha: 1),
    ]
)?.draw(in: background, angle: -80)

// Controller: a capsule body with two angled grips, so the silhouette reads as a
// pad even at 16pt (a plain capsule looked like a bar of soap).
func grip(_ cx: CGFloat, _ cy: CGFloat, _ angle: CGFloat) -> NSBezierPath {
    let w = size * 0.135, h = size * 0.30
    let path = NSBezierPath(roundedRect: NSRect(x: -w / 2, y: -h / 2, width: w, height: h), xRadius: w / 2, yRadius: w / 2)
    let transform = NSAffineTransform()
    transform.translateX(by: cx, yBy: cy)
    transform.rotate(byDegrees: angle)
    path.transform(using: transform as AffineTransform)
    return path
}

let controller = NSBezierPath()
controller.append(roundedRect(size * 0.235, size * 0.475, size * 0.53, size * 0.185, size * 0.0925))
controller.append(grip(size * 0.285, size * 0.44, -22))
controller.append(grip(size * 0.715, size * 0.44, 22))
NSColor.white.setFill()
controller.fill()

// D-pad (left) and two face buttons (right), cut out of the body.
let cut = NSColor(calibratedRed: 0.36, green: 0.16, blue: 0.80, alpha: 1)
cut.setFill()
let dpadX = size * 0.395, dpadY = size * 0.5675
NSBezierPath(roundedRect: NSRect(x: dpadX - size * 0.055, y: dpadY - size * 0.017, width: size * 0.11, height: size * 0.034), xRadius: size * 0.008, yRadius: size * 0.008).fill()
NSBezierPath(roundedRect: NSRect(x: dpadX - size * 0.017, y: dpadY - size * 0.055, width: size * 0.034, height: size * 0.11), xRadius: size * 0.008, yRadius: size * 0.008).fill()
for (bx, by) in [(0.588, 0.598), (0.648, 0.537)] {
    NSBezierPath(ovalIn: NSRect(x: size * bx - size * 0.022, y: size * by - size * 0.022, width: size * 0.044, height: size * 0.044)).fill()
}

// Claim badge: green disc with a white tick, top right (clear of the pad).
let badgeCentre = NSPoint(x: size * 0.795, y: size * 0.775)
let badgeRadius = size * 0.125
NSColor(calibratedRed: 0.13, green: 0.72, blue: 0.36, alpha: 1).setFill()
NSBezierPath(ovalIn: NSRect(x: badgeCentre.x - badgeRadius, y: badgeCentre.y - badgeRadius, width: badgeRadius * 2, height: badgeRadius * 2)).fill()
NSColor.white.setStroke()
let tick = NSBezierPath()
tick.lineWidth = size * 0.030
tick.lineCapStyle = .round
tick.lineJoinStyle = .round
tick.move(to: NSPoint(x: badgeCentre.x - badgeRadius * 0.42, y: badgeCentre.y + badgeRadius * 0.03))
tick.line(to: NSPoint(x: badgeCentre.x - badgeRadius * 0.08, y: badgeCentre.y - badgeRadius * 0.32))
tick.line(to: NSPoint(x: badgeCentre.x + badgeRadius * 0.44, y: badgeCentre.y + badgeRadius * 0.36))
tick.stroke()

image.unlockFocus()

guard
    let tiff = image.tiffRepresentation,
    let rep = NSBitmapImageRep(data: tiff),
    let png = rep.representation(using: .png, properties: [:])
else {
    FileHandle.standardError.write(Data("could not render the icon\n".utf8))
    exit(1)
}

let out = CommandLine.arguments.count > 1 ? CommandLine.arguments[1] : "icon.png"
try png.write(to: URL(fileURLWithPath: out))
print("wrote \(out)")
