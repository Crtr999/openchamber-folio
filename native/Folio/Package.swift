// swift-tools-version: 6.0
import PackageDescription
let package = Package(
    name: "Folio",
    platforms: [.macOS(.v15)],
    products: [.executable(name: "Folio", targets: ["Folio"])],
    dependencies: [.package(url: "https://github.com/k2-fsa/sherpa-onnx.git", from: "1.13.8")],
    targets: [
        .systemLibrary(name: "CSQLite"),
        .target(name: "FolioCore", dependencies: ["CSQLite"]),
        .executableTarget(name: "Folio", dependencies: ["FolioCore", .product(name: "sherpa-onnx", package: "sherpa-onnx")],
                          swiftSettings: [.swiftLanguageMode(.v5)]),
        .testTarget(name: "FolioCoreTests", dependencies: ["FolioCore"]),
        .testTarget(name: "FolioIntegrationTests", dependencies: ["Folio"], swiftSettings: [.swiftLanguageMode(.v5)])
    ]
)
