import Foundation
import Capacitor
import HealthKit

@objc(HealthDataPlugin)
public class HealthDataPlugin: CAPPlugin, CAPBridgedPlugin {
    public let identifier = "HealthDataPlugin"
    public let jsName = "HealthData"
    public let pluginMethods: [CAPPluginMethod] = [
        CAPPluginMethod(name: "status", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "read", returnType: CAPPluginReturnPromise)
    ]
    private let health = HKHealthStore()

    private func localPage() -> Bool {
        guard let url = bridge?.webView?.url else { return false }
        return url.scheme == "capacitor" && url.host == "localhost"
    }
    private func entitlements() -> [String: Any] {
        #if targetEnvironment(simulator)
        return ["com.apple.developer.healthkit": true, "com.apple.developer.healthkit.access": ["health-records"]]
        #else
        guard let url = Bundle.main.url(forResource: "embedded", withExtension: "mobileprovision"),
              let data = try? Data(contentsOf: url),
              let text = String(data: data, encoding: .isoLatin1),
              let start = text.range(of: "<?xml"), let end = text.range(of: "</plist>", range: start.lowerBound..<text.endIndex),
              let xml = String(text[start.lowerBound..<end.upperBound]).data(using: .utf8),
              let plist = try? PropertyListSerialization.propertyList(from: xml, format: nil) as? [String: Any],
              let values = plist["Entitlements"] as? [String: Any] else { return [:] }
        return values
        #endif
    }
    @objc func status(_ call: CAPPluginCall) {
        guard localPage() else { call.reject("Health data is available only to the local Open Carter app"); return }
        let values = entitlements()
        call.resolve(["available": HKHealthStore.isHealthDataAvailable() && values["com.apple.developer.healthkit"] as? Bool == true,
                      "clinical": (values["com.apple.developer.healthkit.access"] as? [String])?.contains("health-records") == true])
    }
    @objc func read(_ call: CAPPluginCall) {
        guard localPage() else { call.reject("Health data is available only to the local Open Carter app"); return }
        let rights = entitlements()
        guard HKHealthStore.isHealthDataAvailable(), rights["com.apple.developer.healthkit"] as? Bool == true else {
            call.reject("This build is not signed for Apple Health. A HealthKit-enabled provisioning profile is required."); return
        }
        let days = min(90, max(1, call.getInt("days") ?? 30))
        let clinical = call.getBool("clinical") == true
        if clinical && !((rights["com.apple.developer.healthkit.access"] as? [String])?.contains("health-records") == true) {
            call.reject("This build is not signed for clinical health records"); return
        }
        let quantities: [(HKQuantityTypeIdentifier, String, HKUnit, HKStatisticsOptions)] = [
            (.stepCount, "steps", .count(), .cumulativeSum),
            (.activeEnergyBurned, "active-energy", .kilocalorie(), .cumulativeSum),
            (.basalEnergyBurned, "resting-energy", .kilocalorie(), .cumulativeSum),
            (.dietaryEnergyConsumed, "dietary-energy", .kilocalorie(), .cumulativeSum),
            (.heartRateVariabilitySDNN, "hrv-sdnn", .secondUnit(with: .milli), .discreteAverage),
            (.restingHeartRate, "resting-heart-rate", HKUnit.count().unitDivided(by: .minute()), .discreteAverage),
            (.bodyMass, "body-mass", .gramUnit(with: .kilo), .discreteAverage)
        ]
        let types = quantities.compactMap { HKObjectType.quantityType(forIdentifier: $0.0) }
        let sleep = HKObjectType.categoryType(forIdentifier: .sleepAnalysis)!
        var requested = Set<HKObjectType>(types + [sleep])
        let clinicalIDs: [HKClinicalTypeIdentifier] = [.allergyRecord, .conditionRecord, .immunizationRecord, .labResultRecord, .medicationRecord, .procedureRecord, .vitalSignRecord]
        if clinical { for id in clinicalIDs { if let type = HKObjectType.clinicalType(forIdentifier: id) { requested.insert(type) } } }
        health.requestAuthorization(toShare: [], read: requested) { [weak self] success, error in
            guard let self else { return }
            guard success && error == nil else { call.reject("Apple Health authorization did not complete"); return }
            let end = Date()
            let calendar = Calendar.current
            let start = calendar.startOfDay(for: calendar.date(byAdding: .day, value: -days, to: end)!)
            let predicate = HKQuery.predicateForSamples(withStart: start, end: end)
            let formatter = ISO8601DateFormatter()
            let group = DispatchGroup(), lock = NSLock()
            var records = [[String: Any]](), errors = [String]()
            func append(_ rows: [[String: Any]], _ issue: String? = nil) {
                lock.lock(); defer { lock.unlock() }
                records.append(contentsOf: rows)
                if let issue { errors.append(issue) }
            }
            for (identifier, metric, unit, options) in quantities {
                guard let type = HKObjectType.quantityType(forIdentifier: identifier) else { continue }
                group.enter()
                let query = HKStatisticsCollectionQuery(quantityType: type, quantitySamplePredicate: predicate, options: options, anchorDate: start, intervalComponents: DateComponents(day: 1))
                query.initialResultsHandler = { _, collection, error in
                    defer { group.leave() }
                    guard let collection, error == nil else { append([], metric); return }
                    var rows = [[String: Any]]()
                    collection.enumerateStatistics(from: start, to: end) { stats, _ in
                        guard let quantity = options == .cumulativeSum ? stats.sumQuantity() : stats.averageQuantity() else { return }
                        rows.append(["kind": "metric", "source": "apple-health", "sourceId": "\(metric):\(formatter.string(from: stats.startDate)):\(calendar.timeZone.identifier)",
                                     "start": formatter.string(from: stats.startDate), "end": formatter.string(from: min(stats.endDate, end)), "updated": formatter.string(from: end),
                                     "label": "Apple Health daily \(calendar.timeZone.identifier)", "metric": metric, "value": quantity.doubleValue(for: unit), "unit": unit.unitString])
                    }
                    append(rows)
                }
                self.health.execute(query)
            }
            group.enter()
            self.health.execute(HKSampleQuery(sampleType: sleep, predicate: predicate, limit: 5001, sortDescriptors: nil) { _, samples, error in
                defer { group.leave() }
                guard error == nil, let samples, samples.count <= 5000 else { append([], "sleep"); return }
                append(samples.compactMap { sample in
                    guard let value = sample as? HKCategorySample, value.value != HKCategoryValueSleepAnalysis.inBed.rawValue, value.value != HKCategoryValueSleepAnalysis.awake.rawValue else { return nil }
                    return ["kind": "metric", "source": "apple-health", "sourceId": value.uuid.uuidString, "start": formatter.string(from: value.startDate), "end": formatter.string(from: value.endDate), "label": value.sourceRevision.source.name, "metric": "sleep-stage-\(value.value)", "unit": "min", "value": value.endDate.timeIntervalSince(value.startDate) / 60]
                })
            })
            if clinical { for identifier in clinicalIDs {
                guard let type = HKObjectType.clinicalType(forIdentifier: identifier) else { continue }
                group.enter()
                self.health.execute(HKSampleQuery(sampleType: type, predicate: nil, limit: 501, sortDescriptors: nil) { _, samples, error in
                    defer { group.leave() }
                    guard error == nil, let samples, samples.count <= 500 else { append([], identifier.rawValue); return }
                    append(samples.compactMap { sample in
                        guard let record = sample as? HKClinicalRecord, let fhir = record.fhirResource, let text = String(data: fhir.data, encoding: .utf8), text.utf8.count <= 500000 else { return nil }
                        return ["kind": "document", "source": "record", "sourceId": record.uuid.uuidString, "start": formatter.string(from: record.startDate), "end": formatter.string(from: record.endDate), "label": record.sourceRevision.source.name, "title": record.displayName, "text": text]
                    })
                })
            } }
            group.notify(queue: .main) {
                call.resolve(["records": records, "errors": errors, "emptyMeansUnknown": true, "readAt": formatter.string(from: end)])
            }
        }
    }
}
