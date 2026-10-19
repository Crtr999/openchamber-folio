import fsPromises from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { expandVideoFile } from './video-expansion.js';

const DEFAULT_MAX_VIDEO_BYTES = 2 * 1024 * 1024 * 1024;

const maxVideoBytes = () => {
  const configured = Number(process.env.OPENCHAMBER_VIDEO_MAX_BYTES);
  return Number.isFinite(configured) && configured > 0 ? configured : DEFAULT_MAX_VIDEO_BYTES;
};

const STATUS_BY_REASON = {
  ffmpeg_missing: 503,
  unreadable_video: 422,
  ffmpeg_failed: 422,
  output_too_large: 422,
  too_large: 413,
};

const writeBodyToFile = async (req, filePath, maxBytes) => {
  const handle = await fsPromises.open(filePath, 'wx', 0o600);
  try {
    let received = 0;
    for await (const chunk of req) {
      const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
      received += buffer.length;
      if (received > maxBytes) {
        throw Object.assign(new Error('Video exceeds the maximum attachment size.'), { reasonCode: 'too_large' });
      }
      await handle.write(buffer);
    }
    if (received === 0) throw Object.assign(new Error('Video data is required.'), { reasonCode: 'empty' });
  } finally {
    await handle.close();
  }
};

/**
 * POST /api/media/video/expand — body is the raw video
 * (application/octet-stream). Responds with sampled JPEG frames and a local
 * transcript; see video-expansion.js. The upload lives only in a private temp
 * directory that is removed before the response completes.
 */
export function registerMediaRoutes(app, { expand = expandVideoFile } = {}) {
  app.post('/api/media/video/expand', async (req, res) => {
    if (!String(req.headers?.['content-type'] || '').toLowerCase().startsWith('application/octet-stream')) {
      return res.status(415).json({ error: 'Content-Type must be application/octet-stream' });
    }
    const limit = maxVideoBytes();
    const declaredSize = Number(req.headers?.['content-length']);
    if (Number.isFinite(declaredSize) && declaredSize > limit) {
      req.resume?.();
      return res.status(413).json({ error: 'Video exceeds the maximum attachment size.', reasonCode: 'too_large' });
    }

    // A client that gives up must not leave ffmpeg or a speech worker running.
    const controller = new AbortController();
    res.on('close', () => {
      if (!res.writableFinished) controller.abort();
    });

    let directory;
    try {
      directory = await fsPromises.mkdtemp(path.join(os.tmpdir(), 'openchamber-video-'));
      const file = path.join(directory, 'input');
      await writeBodyToFile(req, file, limit);
      const result = await expand({ file, signal: controller.signal });
      if (!controller.signal.aborted) res.json(result);
    } catch (error) {
      if (controller.signal.aborted || res.headersSent) return;
      const reasonCode = typeof error?.reasonCode === 'string' ? error.reasonCode : 'failed';
      if (reasonCode === 'too_large') req.resume?.();
      const status = reasonCode === 'empty' ? 400 : STATUS_BY_REASON[reasonCode] ?? 500;
      if (status === 500) console.error('[video] Expansion failed:', error);
      res.status(status).json({ error: error?.message || 'Video processing failed.', reasonCode });
    } finally {
      if (directory) await fsPromises.rm(directory, { recursive: true, force: true }).catch(() => {});
    }
  });
}
