import { describe, expect, it } from 'bun:test';
import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import { expandVideoFile, frameTimestamps, MAX_VIDEO_FRAMES } from './video-expansion.js';

// A stand-in for ffmpeg/ffprobe: answers by the binary name and output format.
const fakeSpawn = ({ probe, frame = Buffer.from([0xff, 0xd8, 0xff]), calls = [] }) => (binary, args) => {
  calls.push({ binary, args });
  const child = new EventEmitter();
  child.stdout = new PassThrough();
  child.stderr = new PassThrough();
  child.kill = () => {};
  queueMicrotask(() => {
    if (binary === 'ffprobe') child.stdout.end(JSON.stringify(probe));
    else if (args.includes('mjpeg')) child.stdout.end(frame);
    else child.stdout.end(Buffer.alloc(0));
    child.stdout.on('end', () => child.emit('close', 0));
  });
  return child;
};

describe('video frame sampling', () => {
  it('takes one frame per second for short clips', () => {
    expect(frameTimestamps(4)).toEqual([0.5, 1.5, 2.5, 3.5]);
  });

  it('caps long videos and spreads frames evenly', () => {
    const times = frameTimestamps(600);
    expect(times).toHaveLength(MAX_VIDEO_FRAMES);
    expect(times[0]).toBeCloseTo(600 / MAX_VIDEO_FRAMES / 2);
    expect(times.at(-1)).toBeLessThan(600);
  });

  it('still samples a frame when the duration is unknown', () => {
    expect(frameTimestamps(0)).toEqual([0]);
  });
});

describe('video expansion', () => {
  it('returns frames and reports a video with no audio track', async () => {
    const calls = [];
    const result = await expandVideoFile({
      file: '/synthetic/input',
      signal: new AbortController().signal,
      spawn: fakeSpawn({ probe: { format: { duration: '2.0' }, streams: [{ codec_type: 'video' }] }, calls }),
      ffmpeg: 'ffmpeg',
      ffprobe: 'ffprobe',
    });

    expect(result.durationMs).toBe(2000);
    expect(result.frames.map((frame) => frame.timeMs)).toEqual([500, 1500]);
    expect(result.frames[0].data).toBe(Buffer.from([0xff, 0xd8, 0xff]).toString('base64'));
    expect(result.audio).toEqual({ status: 'no-audio', segments: [] });
    expect(calls.filter((call) => call.binary === 'ffmpeg')).toHaveLength(2);
  });

  it('reports a missing speech model instead of failing the attachment', async () => {
    const result = await expandVideoFile({
      file: '/synthetic/input',
      signal: new AbortController().signal,
      spawn: fakeSpawn({ probe: { format: { duration: '1.0' }, streams: [{ codec_type: 'video' }, { codec_type: 'audio' }] } }),
      ffmpeg: 'ffmpeg',
      ffprobe: 'ffprobe',
      modelsDir: '/nonexistent/speech-models',
    });

    expect(result.frames).toHaveLength(1);
    expect(result.audio.status).toBe('model-missing');
  });

  it('rejects a file without a video track', async () => {
    await expect(expandVideoFile({
      file: '/synthetic/input',
      signal: new AbortController().signal,
      spawn: fakeSpawn({ probe: { format: { duration: '1.0' }, streams: [{ codec_type: 'audio' }] } }),
      ffmpeg: 'ffmpeg',
      ffprobe: 'ffprobe',
    })).rejects.toMatchObject({ reasonCode: 'unreadable_video' });
  });
});
