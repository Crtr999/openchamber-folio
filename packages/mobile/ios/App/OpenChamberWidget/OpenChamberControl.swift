import AppIntents
import SwiftUI
import WidgetKit

private let carterControlScheme = Bundle.main.object(forInfoDictionaryKey: "CarterURLScheme") as? String ?? "openchamber"

// Control Center control (iOS 18+): tap the OpenChamber logo to start a new session.
//
// IMPORTANT: this file is a member of BOTH the app target and the widget extension target.
// iOS requires the control's AppIntent to exist in the app target too, otherwise tapping the
// control can't open the app (the tap does nothing). It's kept self-contained (inline URL, no
// dependency on the widget's shared code) so it compiles cleanly in the app target.
@available(iOS 18.0, *)
struct OpenChamberNewSessionControl: ControlWidget {
    var body: some ControlWidgetConfiguration {
        StaticControlConfiguration(kind: "OpenChamberNewSessionControl") {
            ControlWidgetButton(action: OpenNewSessionIntent()) {
                // Custom symbol is referenced via `image:` (the asset-catalog symbol path;
                // `systemImage:` only finds Apple's system SF Symbols → shows a "?"). The glyph
                // uses bold strokes so it stays visible at the control's small, tinted size —
                // thin strokes rendered blank.
                Label("New Session", image: "OCLogoSymbol")
            }
        }
        .displayName("New Session")
        .description("Start a new OpenChamber session.")
    }
}

@available(iOS 18.0, *)
struct OpenNewSessionIntent: AppIntent {
    static let title: LocalizedStringResource = "New OpenChamber Session"
    static let openAppWhenRun: Bool = true
    static let isDiscoverable: Bool = true

    @MainActor
    func perform() async throws -> some IntentResult & OpensIntent {
        return .result(opensIntent: OpenURLIntent(URL(string: "\(carterControlScheme)://new")!))
    }
}


// Uses the existing deep-link route and normal recording/send controls.
// Opening the app never starts capture in the background.
@available(iOS 18.0, *)
struct OpenCarterDictationControl: ControlWidget {
    var body: some ControlWidgetConfiguration {
        StaticControlConfiguration(kind: "OpenCarterDictationControl") {
            ControlWidgetButton(action: OpenCarterDictationIntent()) {
                Label("Dictate to Carter", systemImage: "mic")
            }
        }
        .displayName("Dictate to Carter")
        .description("Open Carter's recording controls.")
    }
}

@available(iOS 18.0, *)
struct OpenCarterDictationIntent: AppIntent {
    static let title: LocalizedStringResource = "Dictate to Carter"
    static let openAppWhenRun: Bool = true
    static let isDiscoverable: Bool = true

    @MainActor
    func perform() async throws -> some IntentResult & OpensIntent {
        return .result(opensIntent: OpenURLIntent(URL(string: "\(carterControlScheme)://dictate")!))
    }
}
