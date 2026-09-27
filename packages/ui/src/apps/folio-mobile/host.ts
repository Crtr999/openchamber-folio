import { z } from 'zod';
import { registerPlugin, type PluginListenerHandle } from '@capacitor/core';
import type { FolioNote } from '@/lib/folio/schema';
import type { FolioHost } from '@/lib/folio/local-engine';
import { isCapacitorApp } from '@/lib/platform';

/** AVSpeechSynthesizer in the iOS app (FolioSpeechPlugin in AppDelegate.swift). It plays even with the ringer switch off. */
interface FolioSpeechPlugin {
  speak(options: { text: string }): Promise<void>;
  /** Plays base64 audio (Bella's WAV from the Mac) and reports "finished" at the end. */
  play(options: { data: string }): Promise<void>;
  stop(): Promise<void>;
  pause(): Promise<void>;
  resume(): Promise<void>;
  addListener(event: 'finished', listener: () => void): Promise<PluginListenerHandle>;
}
const nativeSpeech = registerPlugin<FolioSpeechPlugin>('FolioSpeech');

/** AVAudioEngine recording with on-device SFSpeechRecognizer transcription (FolioRecorderPlugin). */
interface FolioRecorderPlugin {
  start(): Promise<{ startedAt: number }>;
  stop(): Promise<{ url?: string; name?: string }>;
  addListener(event: 'transcript', listener: (passage: { text: string; at: number; final: boolean }) => void): Promise<PluginListenerHandle>;
}
const nativeRecorder = registerPlugin<FolioRecorderPlugin>('FolioRecorder');
let transcriptListener: PluginListenerHandle | undefined;

/** EventKit access to the iPhone's calendars (FolioCalendarPlugin). */
interface FolioCalendarPlugin {
  requestAccess(): Promise<{ granted: boolean }>;
  events(options: { days: number }): Promise<{ events: { id: string; title: string; start: number; end: number; calendar: string; joinURL?: string }[] }>;
}
const nativeCalendar = registerPlugin<FolioCalendarPlugin>('FolioCalendar');

/** Local notifications for meeting reminders (FolioNotificationsPlugin). No push service, nothing leaves the phone. */
interface FolioNotificationsPlugin {
  requestAccess(): Promise<{ granted: boolean }>;
  schedule(options: { items: { id: string; title: string; body: string; at: number }[] }): Promise<void>;
  addListener(event: 'opened', listener: (data: { eventID: string }) => void): Promise<PluginListenerHandle>;
}
export const nativeNotifications = registerPlugin<FolioNotificationsPlugin>('FolioNotifications');

/** The native iPhone page editor (FolioNoteEditor.swift). Pages come and go as Folio page JSON. */
interface FolioEditorPlugin {
  open(options: { note: FolioNote; titles: Record<string, string> }): Promise<void>;
  close(): Promise<void>;
  addListener(event: 'change', listener: (data: { note: unknown }) => void): Promise<PluginListenerHandle>;
  addListener(event: 'closed', listener: (data: { noteID: string }) => void): Promise<PluginListenerHandle>;
  addListener(event: 'openNote', listener: (data: { noteID: string }) => void): Promise<PluginListenerHandle>;
  addListener(event: 'action', listener: (data: { kind: string; noteID: string }) => void): Promise<PluginListenerHandle>;
}
export const nativeEditor = registerPlugin<FolioEditorPlugin>('FolioEditor');
const REMINDERS = 'folio.reminders';

/** Splits text into sentence groups short enough for Bella to answer quickly. */
export function speechChunks(text: string, limit = 300): string[] {
  const out: string[] = [];
  let current = '';
  for (const sentence of text.split(/(?<=[.!?])\s+|\n+/).map((s) => s.trim()).filter(Boolean)) {
    const next = current ? `${current} ${sentence}` : sentence;
    if (next.length > limit && current) { out.push(current); current = sentence; } else current = next;
  }
  if (current) out.push(current);
  return out;
}

let speechListener: PluginListenerHandle | undefined;
let speechToken = 0;
let finishWaiter: (() => void) | undefined;

interface PhoneHostOptions {
  openScreen: (kind: string) => boolean;
  showFile: (file: File) => void;
  /** Bella's audio for one passage from the paired Mac, or undefined to read with the iPhone voice. */
  bella: (text: string) => Promise<string | undefined>;
  downloadAsset: (path: string) => Promise<Blob | undefined>;
}

/** Phone implementations of the things the Mac helper does natively. */
export function createPhoneHost({ openScreen, showFile, bella, downloadAsset }: PhoneHostOptions): FolioHost {
  let recognition: SpeechRecognition | undefined;
  const speech = window.speechSynthesis;
  const pick = (accept: string, multiple: boolean) => new Promise<File[]>((resolve) => {
    const input = document.createElement('input');
    input.type = 'file'; input.accept = accept; input.multiple = multiple;
    input.style.display = 'none';
    input.onchange = () => { resolve(Array.from(input.files ?? [])); input.remove(); };
    input.oncancel = () => { resolve([]); input.remove(); };
    document.body.appendChild(input);
    input.click();
  });
  const share = async (file: File) => {
    if (navigator.canShare?.({ files: [file] })) {
      try { await navigator.share({ files: [file], title: file.name }); } catch { /* closed the share sheet */ }
      return;
    }
    const url = URL.createObjectURL(file);
    const link = document.createElement('a');
    link.href = url; link.download = file.name; link.click();
    setTimeout(() => URL.revokeObjectURL(url), 30_000);
  };
  const listenForFinish = async () => {
    if (speechListener) return;
    speechListener = await nativeSpeech.addListener('finished', () => { const waiter = finishWaiter; finishWaiter = undefined; waiter?.(); });
  };
  const playAudio = async (data: string) => {
    await listenForFinish();
    await new Promise<void>((resolve) => { finishWaiter = resolve; nativeSpeech.play({ data }).catch(() => { finishWaiter = undefined; resolve(); }); });
  };
  const speakWithPhone = (text: string, done: () => void) => {
    if (isCapacitorApp()) {
      void listenForFinish().then(() => { finishWaiter = done; return nativeSpeech.speak({ text }); }).catch(() => { finishWaiter = undefined; done(); });
      return;
    }
    speech.cancel();
    const utterance = new SpeechSynthesisUtterance(text);
    utterance.rate = 1;
    utterance.onend = done; utterance.onerror = done;
    speech.speak(utterance);
  };
  return {
    speak: (text, done) => {
      const token = ++speechToken;
      if (!isCapacitorApp()) { speakWithPhone(text, done); return; }
      void (async () => {
        // Bella reads when the Mac is reachable: it synthesizes each passage and the phone plays it,
        // fetching the next one while the current one plays. Otherwise the iPhone voice reads.
        const pieces = speechChunks(text);
        const timeout = new Promise<undefined>((resolve) => setTimeout(() => resolve(undefined), 8000));
        let next: Promise<string | undefined> | undefined = pieces.length ? Promise.race([bella(pieces[0]).catch(() => undefined), timeout]) : undefined;
        for (let i = 0; i < pieces.length; i += 1) {
          const audio = await next;
          if (token !== speechToken) return;
          if (!audio) { speakWithPhone(pieces.slice(i).join(' '), done); return; }
          next = i + 1 < pieces.length ? bella(pieces[i + 1]).catch(() => undefined) : undefined;
          await playAudio(audio);
          if (token !== speechToken) return;
        }
        done();
      })();
    },
    pauseSpeaking: (paused) => {
      if (isCapacitorApp()) { void (paused ? nativeSpeech.pause() : nativeSpeech.resume()); return; }
      if (paused) speech.pause(); else speech.resume();
    },
    stopSpeaking: () => {
      speechToken += 1;
      const waiter = finishWaiter; finishWaiter = undefined; waiter?.();
      if (isCapacitorApp()) void nativeSpeech.stop(); else speech.cancel();
    },
    listen: (onWords, done) => {
      // Declared as always present (see lib/voice/browserVoiceService.ts), but iOS web views may lack both.
      const Engine: (new () => SpeechRecognition) | undefined = window.SpeechRecognition ?? window.webkitSpeechRecognition;
      if (!Engine) return false;
      recognition?.stop();
      const current = new Engine();
      current.continuous = true; current.interimResults = false; current.lang = navigator.language || 'en-US';
      current.onresult = (event) => {
        for (let i = event.resultIndex; i < event.results.length; i += 1) { const result = event.results[i]; if (result.isFinal) onWords(result[0].transcript); }
      };
      current.onend = () => { if (recognition === current) recognition = undefined; done(); };
      current.onerror = () => current.stop();
      try { current.start(); } catch { return false; }
      recognition = current;
      return true;
    },
    stopListening: () => recognition?.stop(),
    share,
    pickFiles: pick,
    // Loading the file is async, which ends the tap; the app shows a sheet whose button shares it.
    openFile: (file, name) => showFile(new File([file], name, { type: file.type })),
    utility: openScreen,
    startRecording: async (onText) => {
      if (!isCapacitorApp()) throw new Error('Recording works in the iPhone app.');
      await transcriptListener?.remove();
      transcriptListener = await nativeRecorder.addListener('transcript', onText);
      try { await nativeRecorder.start(); } catch (error) { await transcriptListener.remove(); transcriptListener = undefined; throw error; }
    },
    stopRecording: async () => {
      if (!isCapacitorApp()) return undefined;
      const result = await nativeRecorder.stop();
      // Late final passages still arrive for a moment after stopping.
      const listener = transcriptListener; transcriptListener = undefined;
      setTimeout(() => { void listener?.remove(); }, 4000);
      if (!result.url) return undefined;
      const response = await fetch(result.url);
      return new File([await response.blob()], result.name ?? 'Recording.m4a', { type: 'audio/mp4' });
    },
    calendarAccess: async () => (isCapacitorApp() ? (await nativeCalendar.requestAccess()).granted : false),
    calendarEvents: async (days) => (isCapacitorApp() ? (await nativeCalendar.events({ days })).events : []),
    remindersOn: () => { try { return localStorage.getItem(REMINDERS) === '1'; } catch { return false; } },
    scheduleReminders: async (events, on) => {
      if (!isCapacitorApp()) return false;
      let enabled = on;
      if (on) enabled = (await nativeNotifications.requestAccess()).granted;
      // Like the Mac: a reminder as each video call starts. Tapping it opens meeting notes for that call.
      const items = enabled ? events.filter((e) => e.joinURL && e.start > Date.now()).slice(0, 50).map((e) => ({ id: e.id, title: e.title, body: 'Your meeting is starting. Tap to take notes in Folio.', at: e.start - 60_000 })) : [];
      await nativeNotifications.schedule({ items });
      try { localStorage.setItem(REMINDERS, enabled ? '1' : '0'); } catch { /* storage blocked */ }
      return enabled;
    },
    downloadAsset,
  };
}

const textSchema = z.string();

/** Sends a request through iOS instead of the web view, for providers that block in-app browser requests (CORS). */
async function nativeRequest(method: 'GET' | 'POST', url: string, headers: Map<string, string>, body?: string): Promise<{ status: number; data: string }> {
  if (!isCapacitorApp()) throw new Error('Could not reach the AI provider. Check your connection.');
  const { CapacitorHttp } = await import('@capacitor/core');
  const response = await CapacitorHttp.request({ url, method, headers: Object.fromEntries(headers), data: body === undefined ? undefined : JSON.parse(body), responseType: 'text' });
  const data: unknown = response.data;
  const text = textSchema.safeParse(data);
  return { status: response.status, data: text.success ? text.data : JSON.stringify(data) };
}

export const nativePost = (url: string, headers: Map<string, string>, body: string) => nativeRequest('POST', url, headers, body);
export const nativeGet = (url: string, headers: Map<string, string>) => nativeRequest('GET', url, headers);
