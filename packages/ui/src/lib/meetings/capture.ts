import { listenMeetingLifecycle } from '@/lib/desktop';
import { subscribeRuntimeEndpointChanged } from '@/lib/runtime-switch';
import { changeMeetingCapture, getMeeting, interruptMeeting, meetingReadiness, meetingsSupported, sendMeetingChunk, startMeeting, type AudioSource, type CaptureMode, type Meeting } from './contract';
import { meetingWorkletSource } from './worklet-source';

const RATE = 16000;
// Short phrases keep the transcript close to live. A chunk is cut at the first
// natural pause once it holds MIN_PHRASE_SAMPLES, and never grows past the cap.
export const CHUNK_SAMPLES = RATE * 10;
const MIN_PHRASE_SAMPLES = RATE * 3;
const PAUSE_SAMPLES = RATE * 0.5;
const SPEECH_LEVEL = 0.006;
const SILENT_PEAK = 0.009;
export const MAX_PENDING_CHUNKS = 8;
export class PCMBuffer {
    private pcm = new Float32Array(CHUNK_SAMPLES);
    private used = 0;
    constructor(private readonly complete: (pcm: Float32Array) => void) {}
    append(block: Float32Array) {
        let offset = 0;
        while (offset < block.length) {
            const count = Math.min(block.length - offset, this.pcm.length - this.used);
            this.pcm.set(block.subarray(offset, offset + count), this.used);
            offset += count; this.used += count;
            if (this.used === this.pcm.length) this.flush();
        }
        block.fill(0);
    }
    get length() { return this.used; }
    flush() {
        if (!this.used) return;
        const block = this.pcm.slice(0, this.used);
        this.clear();
        this.complete(block);
    }
    clear() { this.pcm.fill(0); this.used = 0; }
}

type CapturePhase = 'idle' | 'starting' | 'recording' | 'paused' | 'pausing' | 'resuming' | 'stopping' | 'error';
type CaptureSnapshot = { phase: CapturePhase; meeting: Meeting | null; mode: CaptureMode; microphone: number; system: number; silentMicrophone: boolean; silentSystem: boolean; error: 'capture' | 'system' | 'interrupted' | null; detail: string | null };
type SourceCapture = { stream: MediaStream; node: AudioWorkletNode; input: MediaStreamAudioSourceNode; buffer: PCMBuffer; nextMs: number; lastSound: number; quiet: number; flushed: (() => void) | null };
type Chunk = { source: AudioSource; startMs: number; endMs: number; pcm: Float32Array };

// Short, content-free reason shown next to the generic capture error so a
// failure can be diagnosed instead of guessed at.
export const describeFailure = (cause: unknown): string | null => {
    const raw = typeof cause === 'string' ? cause : (cause as { message?: unknown } | null)?.message;
    const text = String(raw ?? '').replace(/\s+/g, ' ').trim().slice(0, 160);
    return text || null;
};

export async function withMeetingDeadline<T>(operation: Promise<T>, milliseconds = 120000): Promise<T> {
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
        return await Promise.race([operation, new Promise<never>((_, reject) => { timer = setTimeout(() => reject(new Error('meeting_timeout')), milliseconds); })]);
    } finally { clearTimeout(timer); }
}

type StoppableStream = { getTracks: () => readonly { stop: () => void }[] };
export async function acquireMeetingStream<T extends StoppableStream>(operation: Promise<T>, current: () => boolean, milliseconds = 60000): Promise<T> {
    let accepting = true;
    const guarded = operation.then((stream) => {
        if (!accepting || !current()) {
            stream.getTracks().forEach((track) => track.stop());
            throw new Error('meeting_permission_expired');
        }
        return stream;
    });
    try { return await withMeetingDeadline(guarded, milliseconds); }
    finally { accepting = false; }
}

// One renderer-wide owner. Views subscribe but never own tracks or audio buffers.
class MeetingCapture {
    private snapshot: CaptureSnapshot = { phase: 'idle', meeting: null, mode: 'system-and-microphone', microphone: 0, system: 0, silentMicrophone: false, silentSystem: false, error: null, detail: null };
    private listeners = new Set<() => void>();
    private sources = new Map<AudioSource, SourceCapture>();
    private streams = new Set<MediaStream>();
    private context: AudioContext | null = null;
    private queue: Chunk[] = [];
    private drain: Promise<void> = Promise.resolve();
    private pending = 0;
    private inFlight: number[] | null = null;
    private generation = 0;
    private started = 0;
    private lastMeter = 0;
    private detach: (() => void)[] = [];
    private stopping: Promise<void> | null = null;
    private startPending = false;
    private abortsPending = 0;
    subscribe = (callback: () => void) => { this.listeners.add(callback); return () => { this.listeners.delete(callback); }; };
    getSnapshot = () => this.snapshot;
    private update(change: Partial<CaptureSnapshot>) { this.snapshot = { ...this.snapshot, ...change }; for (const listener of this.listeners) listener(); }

    async start(meeting: Meeting, mode: CaptureMode) {
        if (this.startPending || this.abortsPending || !['idle', 'error'].includes(this.snapshot.phase)) throw new Error('meeting_busy');
        this.startPending = true;
        const version = ++this.generation;
        this.update({ phase: 'starting', meeting, mode, error: null, detail: null, silentMicrophone: false, silentSystem: false });
        const current = () => version === this.generation && meetingsSupported();
        let systemFailure = false;
        try {
            // Independent round trips run together; the listener is always detached on failure.
            const listening = listenMeetingLifecycle((event) => {
                if (event.id === this.snapshot.meeting?.id) this.interrupt();
            });
            let readiness: Awaited<ReturnType<typeof meetingReadiness>>;
            try { readiness = await withMeetingDeadline(meetingReadiness(), 15000); }
            catch (cause) { void listening.then((detach) => detach(), () => {}); throw cause; }
            const unlisten = await listening;
            if (!readiness.available || !current()) { unlisten(); throw new Error(readiness.available ? 'meeting_interrupted' : 'meeting_model_unavailable'); }
            this.detach.push(unlisten);
            this.detach.push(subscribeRuntimeEndpointChanged(() => { this.interrupt(); }));
            // Consent has already been explicitly accepted by the caller. Native
            // start authorizes the capture and verifies model readiness before OS requests.
            const started = await withMeetingDeadline(startMeeting(meeting.id, mode), 15000);
            if (!current()) throw new Error('meeting_interrupted');
            this.update({ meeting: started });
            if (mode === 'system-and-microphone') {
                systemFailure = true;
                if (!started.capture.systemAudioSupported) throw new Error('meeting_system_unavailable');
                const display = await acquireMeetingStream(navigator.mediaDevices.getDisplayMedia({ video: true, audio: true }), current);
                if (!current()) { display.getTracks().forEach((track) => track.stop()); throw new Error('meeting_interrupted'); }
                this.streams.add(display);
                if (!display.getAudioTracks().length) throw new Error('meeting_system_missing');
                // Keep the screen track alive because stopping it can end loopback
                // audio. No video frames are read, rendered, stored or transmitted.
                systemFailure = false;
                this.watchTracks(display);
                this.sources.set('system', await this.attach('system', display, version));
            }
            const microphone = await acquireMeetingStream(navigator.mediaDevices.getUserMedia({ audio: { channelCount: 1, echoCancellation: false, noiseSuppression: false, autoGainControl: false }, video: false }), current);
            if (!current()) { microphone.getTracks().forEach((track) => track.stop()); throw new Error('meeting_interrupted'); }
            this.streams.add(microphone); this.watchTracks(microphone);
            this.sources.set('microphone', await this.attach('microphone', microphone, version));
            if (!current()) throw new Error('meeting_interrupted');
            // A device list change (AirPods connecting, a monitor waking) is not a
            // capture failure. Only an ended track or a processor error is.
            this.started = performance.now();
            await withMeetingDeadline(this.context?.resume() ?? Promise.resolve(), 15000);
            if (!current()) throw new Error('meeting_interrupted');
            this.update({ phase: 'recording' });
        } catch (cause) {
            if (version === this.generation) this.cleanup();
            // A timed-out start may still be running in native main. Revoke its
            // generation even when the renderer never received a start result.
            await this.abortNative(meeting.id);
            if (version === this.generation) this.update({ phase: 'error', error: systemFailure ? 'system' : 'capture', detail: describeFailure(cause) });
        } finally {
            this.startPending = false;
            if (this.snapshot.phase === 'stopping' && version !== this.generation) this.update({ phase: 'error', error: 'interrupted' });
        }
    }

    private watchTracks(stream: MediaStream) {
        for (const track of stream.getTracks()) {
            const ended = () => { void this.fail('capture', 'audio_track_ended'); };
            track.addEventListener('ended', ended);
            this.detach.push(() => track.removeEventListener('ended', ended));
        }
    }
    private async attach(source: AudioSource, stream: MediaStream, version: number): Promise<SourceCapture> {
        if (!this.context) {
            const context = new AudioContext({ sampleRate: RATE });
            this.context = context;
            await context.suspend();
            const url = URL.createObjectURL(new Blob([meetingWorkletSource], { type: 'text/javascript' }));
            try { await context.audioWorklet.addModule(url); } finally { URL.revokeObjectURL(url); }
        }
        if (!this.context || version !== this.generation) throw new Error('meeting_interrupted');
        const node = new AudioWorkletNode(this.context, 'meeting-pcm');
        const input = this.context.createMediaStreamSource(new MediaStream(stream.getAudioTracks()));
        const capture: SourceCapture = { stream, node, input, nextMs: 0, lastSound: performance.now(), quiet: 0, flushed: null, buffer: new PCMBuffer((pcm) => {
            const startMs = capture.nextMs;
            const endMs = startMs + pcm.length / RATE * 1000;
            capture.nextMs = endMs;
            // Silence is never sent: the timeline advances, but nothing is queued or decoded.
            let peak = 0;
            for (const value of pcm) { const magnitude = Math.abs(value); if (magnitude > peak) peak = magnitude; }
            if (peak < SILENT_PEAK) { pcm.fill(0); return; }
            this.enqueue({ source, startMs, endMs, pcm }, version);
        }) };
        node.port.onmessage = (event: MessageEvent<Float32Array | { flushed: true }>) => {
            const pcm = event.data;
            if (!(pcm instanceof Float32Array)) { capture.flushed?.(); return; }
            if (version !== this.generation || (this.snapshot.phase !== 'recording' && !capture.flushed)) { pcm.fill(0); return; }
            let squares = 0;
            for (const value of pcm) squares += value * value;
            const level = Math.sqrt(squares / pcm.length);
            if (level > 0.003) capture.lastSound = performance.now();
            capture.quiet = level > SPEECH_LEVEL ? 0 : capture.quiet + pcm.length;
            const blockLength = pcm.length;
            capture.buffer.append(pcm);
            // Cut at a natural pause so words are not split mid-phrase.
            if (capture.buffer.length >= MIN_PHRASE_SAMPLES && capture.quiet >= PAUSE_SAMPLES && blockLength > 0) capture.buffer.flush();
            // At most two meter renders per second, independent of chunk traffic.
            if (performance.now() - this.lastMeter >= 500) {
                this.lastMeter = performance.now();
                this.update({ [source]: level, silentMicrophone: this.isSilent('microphone'), silentSystem: this.isSilent('system') });
            } else this.snapshot = { ...this.snapshot, [source]: level };
        };
        node.onprocessorerror = () => { void this.fail('capture', 'audio_processor_error'); };
        input.connect(node); node.connect(this.context.destination);
        return capture;
    }
    private isSilent(source: AudioSource) {
        const capture = this.sources.get(source);
        return Boolean(capture && performance.now() - capture.lastSound > 10000);
    }
    private async flushSources() {
        await Promise.all([...this.sources.values()].map(async (source) => {
            try {
                await withMeetingDeadline(new Promise<void>((resolve) => {
                    source.flushed = resolve;
                    source.node.port.postMessage('flush');
                }), 1500);
                source.buffer.flush();
            } finally { source.flushed = null; }
        }));
    }
    private enqueue(chunk: Chunk, version: number) {
        if (version !== this.generation || this.pending >= MAX_PENDING_CHUNKS) {
            chunk.pcm.fill(0);
            if (version === this.generation) void this.fail('capture', 'transcription_backlog');
            return;
        }
        this.queue.push(chunk); this.pending++;
        this.drain = this.drain.then(async () => {
            const next = this.queue.shift();
            if (!next) return;
            let pcm: number[] = [];
            try {
                if (version !== this.generation || !this.snapshot.meeting) return;
                pcm = Array.from(next.pcm); next.pcm.fill(0);
                this.inFlight = pcm;
                const result = await withMeetingDeadline(sendMeetingChunk(this.snapshot.meeting.id, next.source, next.startMs, next.endMs, pcm));
                if (version === this.generation) this.update({ meeting: result });
            } catch (cause) { if (version === this.generation) void this.fail('capture', describeFailure(cause) ?? 'transcription_failed'); }
            finally { next.pcm.fill(0); pcm.fill(0); pcm.length = 0; if (this.inFlight === pcm) this.inFlight = null; this.pending = Math.max(0, this.pending - 1); }
        });
    }

    async pause() {
        if (this.snapshot.phase !== 'recording' || !this.snapshot.meeting) return;
        this.update({ phase: 'pausing' });
        try {
            await this.context?.suspend();
            await this.flushSources();
            await this.drain;
            if (this.getSnapshot().phase !== 'pausing') return;
            const version = this.generation;
            const id = this.snapshot.meeting.id;
            const meeting = await withMeetingDeadline(changeMeetingCapture('pause', id), 45000).catch(async (cause) => {
                const saved = await withMeetingDeadline(getMeeting(id), 10000).catch(() => null);
                if (saved?.status !== 'paused') throw cause;
                return saved;
            });
            if (version === this.generation) this.update({ phase: 'paused', meeting, microphone: 0, system: 0 });
        } catch (cause) { void this.fail('capture', describeFailure(cause) ?? 'pause_failed'); }
    }
    async resume() {
        if (this.snapshot.phase !== 'paused' || !this.snapshot.meeting) return;
        this.update({ phase: 'resuming' });
        const version = this.generation;
        try {
            const meeting = await withMeetingDeadline(changeMeetingCapture('resume', this.snapshot.meeting.id), 15000);
            if (version !== this.generation) return;
            for (const source of this.sources.values()) { source.nextMs = performance.now() - this.started; source.lastSound = performance.now(); source.quiet = 0; }
            this.update({ phase: 'recording', meeting, silentMicrophone: false, silentSystem: false });
            await this.context?.resume();
        } catch (cause) { void this.fail('capture', describeFailure(cause) ?? 'resume_failed'); }
    }
    stop() {
        if (this.stopping) return this.stopping;
        this.stopping = this.finish().finally(() => { this.stopping = null; });
        return this.stopping;
    }
    private async finish() {
        const meeting = this.snapshot.meeting;
        if (this.snapshot.phase === 'starting') {
            ++this.generation; this.cleanup(); this.update({ phase: 'stopping' });
            if (meeting) await this.abortNative(meeting.id);
            return;
        }
        if (!meeting || !['recording', 'paused', 'pausing', 'resuming'].includes(this.snapshot.phase)) return;
        this.update({ phase: 'stopping' });
        try {
            await this.context?.suspend();
            await this.flushSources();
            // Release devices now. Native stop waits until bounded transcription drains.
            this.releaseDevices();
            await this.drain;
            if (this.getSnapshot().phase !== 'stopping') return;
            const version = this.generation;
            let stopped: Meeting;
            try { stopped = await withMeetingDeadline(changeMeetingCapture('stop', meeting.id), 45000); }
            catch (cause) {
                // A slow native shutdown can outlive the deadline after the stop was
                // already saved. If the record says stopped, that is a clean finish.
                const saved = await withMeetingDeadline(getMeeting(meeting.id), 10000).catch(() => null);
                if (saved?.status !== 'stopped') throw cause;
                stopped = saved;
            }
            if (version !== this.generation) return;
            this.cleanup(); this.update({ phase: 'idle', meeting: stopped, microphone: 0, system: 0 });
        } catch (cause) { void this.fail('capture', describeFailure(cause) ?? 'stop_failed'); }
    }
    private async fail(error: 'capture' | 'system', detail: string | null = null) {
        if (['idle', 'error'].includes(this.snapshot.phase)) return;
        const meeting = this.snapshot.meeting;
        ++this.generation;
        this.cleanup(); this.update({ phase: 'error', error, detail, microphone: 0, system: 0 });
        // Drop unsent chunks and clear devices on error; never replay uncertain PCM.
        // Interrupt bypasses native busy controls and cancels the pending worker.
        if (meeting) await this.abortNative(meeting.id);
        await this.drain;
    }
    private async abortNative(id: string) {
        if (!meetingsSupported()) return;
        const version = this.generation;
        this.abortsPending++;
        try {
            const aborted = await withMeetingDeadline(interruptMeeting(id), 15000);
            const saved = aborted ?? await withMeetingDeadline(getMeeting(id), 15000);
            if (version === this.generation && this.snapshot.meeting?.id === id) this.update({ meeting: saved });
        } catch { /* Capture stays visibly failed. Never replay audio or retry automatically. */ }
        finally { this.abortsPending--; }
    }
    private interrupt() {
        ++this.generation;
        this.cleanup(); this.update({ phase: 'error', error: 'interrupted', detail: null, microphone: 0, system: 0 });
    }
    private releaseDevices() {
        for (const detach of this.detach.splice(0)) detach();
        for (const stream of this.streams) stream.getTracks().forEach((track) => track.stop());
        this.streams.clear();
        for (const source of this.sources.values()) { source.node.port.onmessage = null; source.node.disconnect(); source.input.disconnect(); }
        if (this.context) { void this.context.close().catch(() => {}); this.context = null; }
    }
    private cleanup() {
        this.releaseDevices();
        for (const source of this.sources.values()) source.buffer.clear();
        this.sources.clear();
        for (const chunk of this.queue) chunk.pcm.fill(0);
        if (this.inFlight) { this.inFlight.fill(0); this.inFlight.length = 0; this.inFlight = null; }
        this.queue.length = 0;
        this.pending = 0;
    }
}
export const meetingCapture = new MeetingCapture();
