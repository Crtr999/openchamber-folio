import { z } from 'zod';
import { registerPlugin, type PluginListenerHandle } from '@capacitor/core';
import type { FolioHost } from '@/lib/folio/local-engine';
import { isCapacitorApp } from '@/lib/platform';

/** AVSpeechSynthesizer in the iOS app (FolioSpeechPlugin in AppDelegate.swift). It plays even with the ringer switch off. */
interface FolioSpeechPlugin {
  speak(options: { text: string }): Promise<void>;
  stop(): Promise<void>;
  pause(): Promise<void>;
  resume(): Promise<void>;
  addListener(event: 'finished', listener: () => void): Promise<PluginListenerHandle>;
}
const nativeSpeech = registerPlugin<FolioSpeechPlugin>('FolioSpeech');
let speechListener: PluginListenerHandle | undefined;

/** Phone implementations of the things the Mac helper does natively. */
export function createPhoneHost(openScreen: (kind: string) => boolean, showFile: (file: File) => void): FolioHost {
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
  return {
    speak: (text, done) => {
      if (isCapacitorApp()) {
        void speechListener?.remove();
        void nativeSpeech.addListener('finished', () => { void speechListener?.remove(); speechListener = undefined; done(); }).then((handle) => { speechListener = handle; });
        nativeSpeech.speak({ text }).catch(() => done());
        return;
      }
      speech.cancel();
      const utterance = new SpeechSynthesisUtterance(text);
      utterance.rate = 1;
      utterance.onend = done; utterance.onerror = done;
      speech.speak(utterance);
    },
    pauseSpeaking: (paused) => {
      if (isCapacitorApp()) { void (paused ? nativeSpeech.pause() : nativeSpeech.resume()); return; }
      if (paused) speech.pause(); else speech.resume();
    },
    stopSpeaking: () => { if (isCapacitorApp()) void nativeSpeech.stop(); else speech.cancel(); },
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
