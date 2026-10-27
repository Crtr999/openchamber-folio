import { mkdir, writeFile } from 'node:fs/promises';
import { spawnSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const resources = path.join(root, 'resources/personal-home');
await mkdir(resources, { recursive: true });
if (process.platform === 'darwin') {
  const contents = path.join(resources, 'CalendarBridge.app/Contents');
  await mkdir(path.join(contents, 'MacOS'), { recursive: true });
  const info = `<?xml version="1.0" encoding="UTF-8"?><!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd"><plist version="1.0"><dict><key>CFBundleIdentifier</key><string>com.carterlaborde.openchamber.calendar</string><key>CFBundleName</key><string>Open Carter</string><key>CFBundleExecutable</key><string>CalendarBridge</string><key>CFBundlePackageType</key><string>APPL</string><key>CFBundleVersion</key><string>1</string><key>NSCalendarsFullAccessUsageDescription</key><string>Show your agenda and save events you choose from your personal homepage.</string><key>NSCalendarsUsageDescription</key><string>Show your agenda and save events you choose from your personal homepage.</string><key>NSRemindersFullAccessUsageDescription</key><string>Show reminders due this week and complete or add the ones you choose.</string><key>NSRemindersUsageDescription</key><string>Show reminders due this week and complete or add the ones you choose.</string></dict></plist>`;
  await writeFile(path.join(contents, 'Info.plist'), info);
  const binary = path.join(contents, 'MacOS/CalendarBridge');
  const run = (command, args) => { const result = spawnSync(command, args, { stdio: 'inherit' }); if (result.status !== 0) throw new Error(`${command} failed`); };
  run('xcrun', ['swiftc', '-O', '-framework', 'EventKit', path.join(root, 'native/CalendarBridge.swift'), '-o', binary]);
  run('codesign', ['--force', '--sign', '-', path.join(resources, 'CalendarBridge.app')]);
}
