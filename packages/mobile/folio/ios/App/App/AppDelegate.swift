import UIKit
import AVFoundation
import Capacitor

@UIApplicationMain
class AppDelegate: UIResponder, UIApplicationDelegate {

    var window: UIWindow?

    func application(_ application: UIApplication, didFinishLaunchingWithOptions launchOptions: [UIApplication.LaunchOptionsKey: Any]?) -> Bool {
        // Override point for customization after application launch.
        return true
    }

    func applicationWillResignActive(_ application: UIApplication) {
        // Sent when the application is about to move from active to inactive state. This can occur for certain types of temporary interruptions (such as an incoming phone call or SMS message) or when the user quits the application and it begins the transition to the background state.
        // Use this method to pause ongoing tasks, disable timers, and invalidate graphics rendering callbacks. Games should use this method to pause the game.
    }

    func applicationDidEnterBackground(_ application: UIApplication) {
        // Use this method to release shared resources, save user data, invalidate timers, and store enough application state information to restore your application to its current state in case it is terminated later.
        // If your application supports background execution, this method is called instead of applicationWillTerminate: when the user quits.
    }

    func applicationWillEnterForeground(_ application: UIApplication) {
        // Called as part of the transition from the background to the active state; here you can undo many of the changes made on entering the background.
    }

    func applicationDidBecomeActive(_ application: UIApplication) {
        // Restart any tasks that were paused (or not yet started) while the application was inactive. If the application was previously in the background, optionally refresh the user interface.
    }

    func applicationWillTerminate(_ application: UIApplication) {
        // Called when the application is about to terminate. Save data if appropriate. See also applicationDidEnterBackground:.
    }

    func application(_ app: UIApplication, open url: URL, options: [UIApplication.OpenURLOptionsKey: Any] = [:]) -> Bool {
        // Called when the app was launched with a url. Feel free to add additional processing here,
        // but if you want the App API to support tracking app url opens, make sure to keep this call
        return ApplicationDelegateProxy.shared.application(app, open: url, options: options)
    }

    func application(_ application: UIApplication, continue userActivity: NSUserActivity, restorationHandler: @escaping ([UIUserActivityRestoring]?) -> Void) -> Bool {
        // Called when the app was launched with an activity, including Universal Links.
        // Feel free to add additional processing here, but if you want the App API to support
        // tracking app url opens, make sure to keep this call
        return ApplicationDelegateProxy.shared.application(application, continue: userActivity, restorationHandler: restorationHandler)
    }

}

// iOS 27 requires the UIScene lifecycle; the window comes from Main.storyboard via Info.plist.
// Pairing links (folio-sync://) arrive here and are handed to Capacitor's App plugin.
class SceneDelegate: UIResponder, UIWindowSceneDelegate {
    var window: UIWindow?

    func scene(_ scene: UIScene, willConnectTo session: UISceneSession, options connectionOptions: UIScene.ConnectionOptions) {
        if let url = connectionOptions.urlContexts.first?.url {
            _ = ApplicationDelegateProxy.shared.application(UIApplication.shared, open: url, options: [:])
        }
    }

    func scene(_ scene: UIScene, openURLContexts URLContexts: Set<UIOpenURLContext>) {
        if let url = URLContexts.first?.url {
            _ = ApplicationDelegateProxy.shared.application(UIApplication.shared, open: url, options: [:])
        }
    }
}

/// Registers the app's own plugins with the Capacitor bridge (Main.storyboard uses this class).
class FolioViewController: CAPBridgeViewController {
    override open func capacitorDidLoad() {
        bridge?.registerPluginInstance(FolioSpeechPlugin())
    }
}

/// Read aloud with the system voice. Uses the playback audio session so it works with the ringer switch off.
@objc(FolioSpeechPlugin)
public class FolioSpeechPlugin: CAPPlugin, CAPBridgedPlugin, AVSpeechSynthesizerDelegate {
    public let identifier = "FolioSpeechPlugin"
    public let jsName = "FolioSpeech"
    public let pluginMethods: [CAPPluginMethod] = [
        CAPPluginMethod(name: "speak", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "stop", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "pause", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "resume", returnType: CAPPluginReturnPromise),
    ]
    private let synthesizer = AVSpeechSynthesizer()
    /// Only the latest utterance reports "finished"; cancelling an older one to start a new one stays quiet.
    private var current: AVSpeechUtterance?

    override public func load() {
        synthesizer.delegate = self
    }

    @objc func speak(_ call: CAPPluginCall) {
        let text = call.getString("text") ?? ""
        DispatchQueue.main.async {
            let session = AVAudioSession.sharedInstance()
            try? session.setCategory(.playback, mode: .spokenAudio, options: [.duckOthers])
            try? session.setActive(true)
            let utterance = AVSpeechUtterance(string: text)
            self.current = utterance
            self.synthesizer.stopSpeaking(at: .immediate)
            utterance.voice = AVSpeechSynthesisVoice(language: AVSpeechSynthesisVoice.currentLanguageCode())
            utterance.rate = AVSpeechUtteranceDefaultSpeechRate
            self.synthesizer.speak(utterance)
            call.resolve()
        }
    }

    @objc func stop(_ call: CAPPluginCall) {
        DispatchQueue.main.async { self.synthesizer.stopSpeaking(at: .immediate); call.resolve() }
    }

    @objc func pause(_ call: CAPPluginCall) {
        DispatchQueue.main.async { self.synthesizer.pauseSpeaking(at: .word); call.resolve() }
    }

    @objc func resume(_ call: CAPPluginCall) {
        DispatchQueue.main.async { self.synthesizer.continueSpeaking(); call.resolve() }
    }

    public func speechSynthesizer(_ synthesizer: AVSpeechSynthesizer, didFinish utterance: AVSpeechUtterance) { if utterance === current { finished() } }
    public func speechSynthesizer(_ synthesizer: AVSpeechSynthesizer, didCancel utterance: AVSpeechUtterance) { if utterance === current { finished() } }

    private func finished() {
        try? AVAudioSession.sharedInstance().setActive(false, options: [.notifyOthersOnDeactivation])
        notifyListeners("finished", data: [:])
    }
}
