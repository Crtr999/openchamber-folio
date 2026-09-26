import UIKit
import AVFoundation
import EventKit
import Speech
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
        bridge?.registerPluginInstance(FolioCalendarPlugin())
        bridge?.registerPluginInstance(FolioRecorderPlugin())
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

/// The iPhone's calendars, for upcoming meetings and meeting notes.
@objc(FolioCalendarPlugin)
public class FolioCalendarPlugin: CAPPlugin, CAPBridgedPlugin {
    public let identifier = "FolioCalendarPlugin"
    public let jsName = "FolioCalendar"
    public let pluginMethods: [CAPPluginMethod] = [
        CAPPluginMethod(name: "requestAccess", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "events", returnType: CAPPluginReturnPromise),
    ]
    private let store = EKEventStore()

    @objc func requestAccess(_ call: CAPPluginCall) {
        if #available(iOS 17.0, *) {
            store.requestFullAccessToEvents { granted, _ in call.resolve(["granted": granted]) }
        } else {
            store.requestAccess(to: .event) { granted, _ in call.resolve(["granted": granted]) }
        }
    }

    @objc func events(_ call: CAPPluginCall) {
        let days = call.getInt("days") ?? 7
        let start = Date().addingTimeInterval(-3600)
        let end = Calendar.current.date(byAdding: .day, value: days, to: Calendar.current.startOfDay(for: Date())) ?? Date().addingTimeInterval(Double(days) * 86400)
        let predicate = store.predicateForEvents(withStart: start, end: end, calendars: nil)
        let events = store.events(matching: predicate).filter { !$0.isAllDay && $0.endDate > Date() }.sorted { $0.startDate < $1.startDate }.prefix(40)
        let list: [[String: Any]] = events.map { event in
            var item: [String: Any] = [
                "id": event.calendarItemIdentifier,
                "title": event.title ?? "Untitled event",
                "start": event.startDate.timeIntervalSince1970 * 1000,
                "end": event.endDate.timeIntervalSince1970 * 1000,
                "calendar": event.calendar?.title ?? "",
            ]
            if let link = FolioCalendarPlugin.joinLink(event) { item["joinURL"] = link }
            return item
        }
        call.resolve(["events": list])
    }

    /// Zoom, Teams, Meet or Webex links from the event's URL, location or notes.
    static func joinLink(_ event: EKEvent) -> String? {
        let text = [event.url?.absoluteString, event.location, event.notes].compactMap { $0 }.joined(separator: " ")
        let pattern = "https://[^\\s<>\"]*(zoom\\.us|teams\\.microsoft\\.com|teams\\.live\\.com|meet\\.google\\.com|webex\\.com)[^\\s<>\"]*"
        guard let range = text.range(of: pattern, options: .regularExpression) else { return nil }
        return String(text[range])
    }
}

/// Records a meeting and transcribes it on the device. Recognition tasks end after pauses or about
/// a minute, so each finished passage is reported and a new task picks up the next one.
@objc(FolioRecorderPlugin)
public class FolioRecorderPlugin: CAPPlugin, CAPBridgedPlugin {
    public let identifier = "FolioRecorderPlugin"
    public let jsName = "FolioRecorder"
    public let pluginMethods: [CAPPluginMethod] = [
        CAPPluginMethod(name: "start", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "stop", returnType: CAPPluginReturnPromise),
    ]
    private let engine = AVAudioEngine()
    private var recognizer: SFSpeechRecognizer?
    private var request: SFSpeechAudioBufferRecognitionRequest?
    private var task: SFSpeechRecognitionTask?
    private var file: AVAudioFile?
    private var fileURL: URL?
    private var started = Date()
    private var running = false
    private var passageText = ""
    private var passageStart: TimeInterval = 0
    private let lock = NSLock()

    @objc func start(_ call: CAPPluginCall) {
        SFSpeechRecognizer.requestAuthorization { speechStatus in
            AVAudioSession.sharedInstance().requestRecordPermission { granted in
                DispatchQueue.main.async {
                    guard granted else { call.reject("Microphone access is off. Turn it on in Settings → Privacy & Security → Microphone → Folio."); return }
                    do {
                        try self.begin(transcribe: speechStatus == .authorized)
                        call.resolve(["startedAt": self.started.timeIntervalSince1970 * 1000])
                    } catch {
                        self.teardown()
                        call.reject("Could not start recording: \(error.localizedDescription)")
                    }
                }
            }
        }
    }

    private func begin(transcribe: Bool) throws {
        if running { return }
        let session = AVAudioSession.sharedInstance()
        try session.setCategory(.playAndRecord, mode: .spokenAudio, options: [.defaultToSpeaker, .allowBluetooth, .mixWithOthers])
        try session.setActive(true)
        let input = engine.inputNode
        let format = input.outputFormat(forBus: 0)
        let folder = FileManager.default.urls(for: .documentDirectory, in: .userDomainMask)[0].appendingPathComponent("Recordings", isDirectory: true)
        try FileManager.default.createDirectory(at: folder, withIntermediateDirectories: true)
        let stamp = ISO8601DateFormatter().string(from: Date()).replacingOccurrences(of: ":", with: "-")
        let url = folder.appendingPathComponent("Meeting \(stamp).m4a")
        file = try AVAudioFile(forWriting: url, settings: [
            AVFormatIDKey: kAudioFormatMPEG4AAC,
            AVSampleRateKey: format.sampleRate,
            AVNumberOfChannelsKey: format.channelCount,
            AVEncoderAudioQualityKey: AVAudioQuality.medium.rawValue,
        ])
        fileURL = url
        started = Date()
        recognizer = transcribe ? (SFSpeechRecognizer(locale: Locale.current) ?? SFSpeechRecognizer()) : nil
        running = true
        startPassage()
        input.installTap(onBus: 0, bufferSize: 4096, format: format) { [weak self] buffer, _ in
            guard let self else { return }
            try? self.file?.write(from: buffer)
            self.lock.lock(); let current = self.request; self.lock.unlock()
            current?.append(buffer)
        }
        engine.prepare()
        try engine.start()
    }

    private func startPassage() {
        guard running, let recognizer, recognizer.isAvailable else { return }
        let next = SFSpeechAudioBufferRecognitionRequest()
        next.shouldReportPartialResults = true
        if recognizer.supportsOnDeviceRecognition { next.requiresOnDeviceRecognition = true }
        if #available(iOS 16.0, *) { next.addsPunctuation = true }
        lock.lock(); request = next; lock.unlock()
        passageText = ""
        passageStart = Date().timeIntervalSince(started)
        let at = passageStart * 1000
        task = recognizer.recognitionTask(with: next) { [weak self] result, error in
            guard let self else { return }
            if let result {
                self.passageText = result.bestTranscription.formattedString
                self.notifyListeners("transcript", data: ["text": self.passageText, "at": at, "final": result.isFinal])
                if result.isFinal { self.nextPassage(reported: true) }
            } else if error != nil {
                self.nextPassage(reported: false)
            }
        }
    }

    private func nextPassage(reported: Bool) {
        if !reported && !passageText.isEmpty {
            notifyListeners("transcript", data: ["text": passageText, "at": passageStart * 1000, "final": true])
        }
        passageText = ""
        lock.lock(); request?.endAudio(); request = nil; lock.unlock()
        task = nil
        if running { DispatchQueue.main.asyncAfter(deadline: .now() + 0.05) { self.startPassage() } }
    }

    @objc func stop(_ call: CAPPluginCall) {
        DispatchQueue.main.async {
            guard self.running else { call.resolve([:]); return }
            self.running = false
            self.engine.inputNode.removeTap(onBus: 0)
            self.engine.stop()
            self.lock.lock(); self.request?.endAudio(); self.lock.unlock()
            self.task?.finish()
            self.file = nil
            try? AVAudioSession.sharedInstance().setActive(false, options: [.notifyOthersOnDeactivation])
            var result: [String: Any] = [:]
            if let url = self.fileURL, let portable = self.bridge?.portablePath(fromLocalURL: url) {
                result["url"] = portable.absoluteString
                result["name"] = url.lastPathComponent
            }
            call.resolve(result)
        }
    }

    private func teardown() {
        running = false
        if engine.isRunning { engine.inputNode.removeTap(onBus: 0); engine.stop() }
        file = nil
        lock.lock(); request = nil; lock.unlock()
        task?.cancel(); task = nil
    }
}
