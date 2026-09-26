import AppKit
let output = URL(fileURLWithPath: CommandLine.arguments[1])
try FileManager.default.createDirectory(at: output, withIntermediateDirectories: true)
for (points, scale) in [(16,1),(16,2),(32,1),(32,2),(128,1),(128,2),(256,1),(256,2),(512,1),(512,2)] {
    let px = points * scale
    let rep = NSBitmapImageRep(bitmapDataPlanes: nil, pixelsWide: px, pixelsHigh: px, bitsPerSample: 8, samplesPerPixel: 4, hasAlpha: true, isPlanar: false, colorSpaceName: .deviceRGB, bytesPerRow: 0, bitsPerPixel: 0)!
    NSGraphicsContext.saveGraphicsState(); NSGraphicsContext.current = NSGraphicsContext(bitmapImageRep: rep)
    let t = NSAffineTransform(); t.scale(by: CGFloat(px) / 1024); t.concat()
    NSColor(calibratedRed: 0.09, green: 0.13, blue: 0.11, alpha: 1).setFill()
    NSBezierPath(roundedRect: NSRect(x: 40,y: 40,width: 944,height: 944), xRadius: 210,yRadius: 210).fill()
    NSColor(calibratedRed: 0.32, green: 0.49, blue: 0.39, alpha: 1).setFill()
    NSBezierPath(roundedRect: NSRect(x: 286,y: 202,width: 480,height: 600), xRadius: 50,yRadius: 50).fill()
    NSColor(calibratedRed: 0.67, green: 0.85, blue: 0.72, alpha: 1).setFill()
    NSBezierPath(roundedRect: NSRect(x: 242,y: 244,width: 480,height: 600), xRadius: 50,yRadius: 50).fill()
    NSColor(calibratedRed: 0.12, green: 0.21, blue: 0.16, alpha: 1).setFill()
    NSBezierPath(roundedRect: NSRect(x: 307,y: 244,width: 12,height: 600), xRadius: 4,yRadius: 4).fill()
    let f = "f" as NSString
    f.draw(at: NSPoint(x: 400,y: 240), withAttributes: [.font: NSFont(name: "Georgia-Italic", size: 530) ?? NSFont.systemFont(ofSize: 530), .foregroundColor: NSColor(calibratedRed: 0.12, green: 0.21, blue: 0.16, alpha: 1)])
    NSGraphicsContext.restoreGraphicsState()
    let filename = "icon_\(points)x\(points)\(scale == 2 ? "@2x" : "").png"
    try rep.representation(using: .png, properties: [:])!.write(to: output.appendingPathComponent(filename))
}
