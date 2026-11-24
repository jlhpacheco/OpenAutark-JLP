// swift-tools-version:5.9
// Autarks macOS-Steuerhelfer (Protokoll 4, wie windows-helper.ps1 / linux-helper.py): ein Kommandozeilen-Prozess,
// der JSON-Zeilen auf stdin liest und auf stdout beantwortet. Siehe README.md.
import PackageDescription

let package = Package(
    name: "AutarkMacHelper",
    platforms: [.macOS(.v13)],
    products: [
        .executable(name: "autark-mac-helper", targets: ["autark-mac-helper"]),
        .executable(name: "ax-testapp", targets: ["ax-testapp"]),
    ],
    targets: [
        .target(name: "MacHelperCore", path: "Sources/MacHelperCore"),
        .executableTarget(name: "autark-mac-helper", dependencies: ["MacHelperCore"], path: "Sources/autark-mac-helper"),
        .executableTarget(name: "ax-testapp", path: "Sources/ax-testapp"),
        .testTarget(name: "MacHelperCoreTests", dependencies: ["MacHelperCore"], path: "Tests/MacHelperCoreTests"),
    ]
)
