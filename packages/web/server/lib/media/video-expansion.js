import { spawn as nodeSpawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { DEFAULT_LOCAL_STT_MODEL } from '../dictation/local/model-catalog.js';
import { isLocalSttModelInstalled } from '../dictation/local/model-downloader.js';
import { createMeetingTranscriber } from '../meetings/local-transcriber.js';

/**
 * Turns a video file into what a chat model can actually read: a bounded set
 * of evenly spaced still frames and an on-device transcript of its audio.
 *
 * Neither OpenAI nor Anthropic chat APIs accept a video container, and the
 * Claude and ChatGPT apps do the same expansion before the model sees it.
 * Audio never leaves this machine: it is decoded by ffmpeg and transcribed by
 * the local speech model the meetings feature already uses.
 */

export const MAX_VIDEO_FRAMES = 64;
const FRAME_MAX_EDGE = 768;
const SAMPLE_RATE = 16000;
const MAX_TRANSCRIBED_SECONDS = 60 * 60;
const CHUNK_SECONDS = 60;
const SILENCE_PEAK = 300;
const CHUNK_TIMEOUT_MS = 120000;
const MAX_FRAME_BYTES = 4 * 1024 * 1024;

const BINARY_CANDIDATES = (name) => [
  process.env[`OPENCHAMBER_${name.toUpperCase()}`],
  `/opt/homebrew/bin/${name}`,
  `/usr/local/bin/${name}`,
  `/usr/bin/${name}`,
].filter(Boolean);

export const videoError = (reasonCode, message) => Object.assign(new Error(message), { reasonCode });

// Electron launched from Finder does not inherit the shell PATH, so look in
// the usual Homebrew locations before falling back to a PATH lookup.
export const resolveMediaBinary = (name, exists = fs.existsSync) =>
  BINARY_CANDIDATES(name).find((candidate) => exists(candidate)) ?? name;

const runBinary = (spawn, binary, args, { signal, maxBytes }) => new Promise((resolve, reject) => {
  let child;
  try {
    child = spawn(binary, args, { stdio: ['ignore', 'pipe', 'pipe'], signal });
  } catch (error) {
    reject(error);
    return;
  }
  const chunks = [];
  let size = 0;
  let stderr = '';
  let settled = false;
  const fail = (error) => {
    if (settled) return;
    settled = true;
    child.kill('SIGKILL');
    reject(error);
  };
  child.stdout.on('data', (chunk) => {
    size += chunk.length;
    if (size > maxBytes) {
      fail(videoError('output_too_large', 'ffmpeg produced more data than expected.'));
      return;
    }
    chunks.push(chunk);
  });
  child.stderr.on('data', (chunk) => {
    if (stderr.length < 4000) stderr += chunk.toString();
  });
  child.on('error', (error) => {
    if (error?.code === 'ENOENT') {
      fail(videoError('ffmpeg_missing', 'ffmpeg is not installed. Install it with `brew install ffmpeg` to attach videos.'));
      return;
    }
    fail(error);
  });
  child.on('close', (code) => {
    if (settled) return;
    settled = true;
    if (code === 0) resolve(Buffer.concat(chunks));
    else reject(videoError('ffmpeg_failed', stderr.trim().split('\n').pop() || `ffmpeg exited with code ${code}`));
  });
});

const probeVideo = async ({ spawn, ffprobe, file, signal }) => {
  const output = await runBinary(spawn, ffprobe, [
    '-v', 'error',
    '-show_entries', 'format=duration:stream=codec_type',
    '-of', 'json',
    file,
  ], { signal, maxBytes: 1024 * 1024 });
  let parsed;
  try {
    parsed = JSON.parse(output.toString('utf8'));
  } catch {
    throw videoError('unreadable_video', 'This video could not be read.');
  }
  const streams = Array.isArray(parsed?.streams) ? parsed.streams : [];
  const durationSeconds = Number(parsed?.format?.duration);
  const hasVideo = streams.some((stream) => stream?.codec_type === 'video');
  if (!hasVideo) throw videoError('unreadable_video', 'This file has no video track.');
  return {
    durationSeconds: Number.isFinite(durationSeconds) && durationSeconds > 0 ? durationSeconds : 0,
    hasAudio: streams.some((stream) => stream?.codec_type === 'audio'),
  };
};

/** One frame per second for short clips, evenly spread across longer ones. */
export const frameTimestamps = (durationSeconds, maxFrames = MAX_VIDEO_FRAMES) => {
  if (!(durationSeconds > 0)) return [0];
  const count = Math.max(1, Math.min(maxFrames, Math.ceil(durationSeconds)));
  return Array.from({ length: count }, (_, index) => (durationSeconds * (index + 0.5)) / count);
};

const extractFrame = ({ spawn, ffmpeg, file, seconds, signal }) => runBinary(spawn, ffmpeg, [
  '-v', 'error',
  '-ss', seconds.toFixed(3),
  '-i', file,
  '-frames:v', '1',
  '-vf', `scale=w='min(${FRAME_MAX_EDGE},iw)':h='min(${FRAME_MAX_EDGE},ih)':force_original_aspect_ratio=decrease`,
  '-q:v', '5',
  '-f', 'image2pipe',
  '-vcodec', 'mjpeg',
  'pipe:1',
], { signal, maxBytes: MAX_FRAME_BYTES });

const extractAudio = ({ spawn, ffmpeg, file, signal }) => runBinary(spawn, ffmpeg, [
  '-v', 'error',
  '-i', file,
  '-vn',
  '-t', String(MAX_TRANSCRIBED_SECONDS),
  '-ac', '1',
  '-ar', String(SAMPLE_RATE),
  '-f', 's16le',
  'pipe:1',
], { signal, maxBytes: SAMPLE_RATE * 2 * (MAX_TRANSCRIBED_SECONDS + 1) });

const chunkPeak = (pcm) => {
  let peak = 0;
  for (let offset = 0; offset + 1 < pcm.length; offset += 2) {
    peak = Math.max(peak, Math.abs(pcm.readInt16LE(offset)));
  }
  return peak;
};

const transcribePcm = async ({ pcm, transcriber, signal }) => {
  const chunkBytes = SAMPLE_RATE * 2 * CHUNK_SECONDS;
  const segments = [];
  try {
    for (let offset = 0; offset < pcm.length; offset += chunkBytes) {
      if (signal.aborted) throw videoError('aborted', 'Video processing was cancelled.');
      // Copy: the transcriber may hold the buffer until its worker exits.
      const chunk = Buffer.from(pcm.subarray(offset, Math.min(pcm.length, offset + chunkBytes)));
      if (chunkPeak(chunk) < SILENCE_PEAK) continue;
      const controller = new AbortController();
      const abort = () => controller.abort();
      signal.addEventListener('abort', abort, { once: true });
      const timer = setTimeout(abort, CHUNK_TIMEOUT_MS);
      try {
        const text = String(await transcriber.transcribe(chunk, controller.signal) ?? '').trim();
        if (text) {
          segments.push({
            startMs: Math.round((offset / 2 / SAMPLE_RATE) * 1000),
            endMs: Math.round(((offset + chunk.length) / 2 / SAMPLE_RATE) * 1000),
            text,
          });
        }
      } finally {
        clearTimeout(timer);
        signal.removeEventListener('abort', abort);
        chunk.fill(0);
      }
    }
  } finally {
    await transcriber.release();
  }
  return segments;
};

const transcribeAudio = async ({ spawn, ffmpeg, file, hasAudio, signal, modelsDir, modelId, createTranscriber }) => {
  if (!hasAudio) return { status: 'no-audio', segments: [] };
  if (!(await isLocalSttModelInstalled(modelsDir, modelId))) return { status: 'model-missing', segments: [] };
  let pcm;
  try {
    pcm = await extractAudio({ spawn, ffmpeg, file, signal });
    const transcriber = createTranscriber({ modelsDir, modelId });
    const segments = await transcribePcm({ pcm, transcriber, signal });
    return { status: segments.length > 0 ? 'transcribed' : 'silent', segments };
  } catch (error) {
    if (signal.aborted) throw error;
    console.warn('[video] Audio transcription failed:', error?.message || error);
    return { status: 'failed', segments: [] };
  } finally {
    pcm?.fill(0);
  }
};

/**
 * Expands a video already written to disk. Frames always come back for a
 * readable video; a missing speech model or failed transcription is reported
 * in `audio.status` rather than failing the whole attachment.
 */
export async function expandVideoFile({
  file,
  signal,
  spawn = nodeSpawn,
  ffmpeg = resolveMediaBinary('ffmpeg'),
  ffprobe = resolveMediaBinary('ffprobe'),
  modelsDir = path.join(os.homedir(), '.config', 'openchamber', 'speech-models'),
  modelId = DEFAULT_LOCAL_STT_MODEL,
  createTranscriber = createMeetingTranscriber,
}) {
  const { durationSeconds, hasAudio } = await probeVideo({ spawn, ffprobe, file, signal });

  const frames = [];
  for (const seconds of frameTimestamps(durationSeconds)) {
    const image = await extractFrame({ spawn, ffmpeg, file, seconds, signal });
    if (image.length > 0) frames.push({ timeMs: Math.round(seconds * 1000), data: image.toString('base64') });
  }
  if (frames.length === 0) throw videoError('unreadable_video', 'No frames could be read from this video.');

  const audio = await transcribeAudio({ spawn, ffmpeg, file, hasAudio, signal, modelsDir, modelId, createTranscriber });
  return {
    durationMs: Math.round(durationSeconds * 1000),
    frames,
    audio,
  };
}
