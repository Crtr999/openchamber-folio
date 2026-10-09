import { constants } from 'node:fs';
import { lstat, mkdir, open, readdir, rename, unlink } from 'node:fs/promises';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { z } from 'zod';

export function meetingError(code, message) {
  return Object.assign(new Error(message), { code });
}

const idSchema = z.string().uuid();
const timestamp = z.string().datetime();
const segmentSchema = z.object({
  source: z.enum(['microphone', 'system']),
  label: z.enum(['Microphone', 'System audio']),
  startMs: z.number().finite().nonnegative(),
  endMs: z.number().finite().nonnegative(),
  text: z.string().max(100000),
  createdAt: timestamp,
}).strict().refine((s) => s.endMs > s.startMs && s.endMs - s.startMs <= 90000 &&
  s.label === (s.source === 'microphone' ? 'Microphone' : 'System audio'));

const meetingSchema = z.object({
  version: z.literal(1),
  id: idSchema,
  title: z.string().min(1).max(300),
  calendarEventId: z.string().min(1).max(2048).optional(),
  createdAt: timestamp,
  updatedAt: timestamp,
  status: z.enum(['draft', 'recording', 'paused', 'stopped', 'interrupted']),
  interruptionReason: z.string().max(100).nullable(),
  notes: z.string().max(100000),
  segments: z.array(segmentSchema).max(10000),
  summary: z.discriminatedUnion('status', [
    z.object({ status: z.literal('unavailable'), reason: z.string().max(500) }).strict(),
    z.object({
      status: z.literal('available'), text: z.string().min(1).max(100000),
      providerID: z.string().min(1).max(200), modelID: z.string().min(1).max(200),
      transcriptRevision: z.string().regex(/^[0-9a-f]{64}$/), createdAt: timestamp,
    }).strict(),
  ]),
}).strict();

const MAX_RECORD_BYTES = 8 * 1024 * 1024;

// Check every component, not just the final directory. Parents are native-owned.
async function checkDirectory(directory) {
  const parent = path.dirname(directory);
  if (parent !== directory) await checkDirectory(parent);
  const stat = await lstat(directory);
  if (!stat.isDirectory() || stat.isSymbolicLink()) {
    throw meetingError('unsafe_storage', 'Meeting storage must not use symbolic links.');
  }
  return stat;
}

export function createMeetingStorage(directory) {
  if (!directory || !path.isAbsolute(directory) || directory !== path.normalize(directory)) {
    throw meetingError('unsafe_storage', 'Meeting storage requires a normalized absolute directory.');
  }
  let identity;
  const assertDirectory = async () => {
    const stat = await checkDirectory(directory);
    if (identity && (stat.dev !== identity.dev || stat.ino !== identity.ino)) {
      throw meetingError('unsafe_storage', 'Meeting storage directory changed.');
    }
    return stat;
  };
  const filename = (id) => {
    if (!idSchema.safeParse(id).success) throw meetingError('invalid_id', 'Invalid meeting identifier.');
    return path.join(directory, `${id}.json`);
  };
  const validateFile = async (handle) => {
    const stat = await handle.stat();
    if (!stat.isFile() || stat.nlink !== 1 || stat.size > MAX_RECORD_BYTES) {
      throw meetingError('unsafe_storage', 'Invalid meeting storage file.');
    }
    await handle.chmod(0o600);
    return stat;
  };
  const read = async (id) => {
    await assertDirectory();
    let handle;
    try {
      const file = filename(id);
      const before = await lstat(file);
      if (!before.isFile() || before.isSymbolicLink() || before.nlink !== 1) throw meetingError('unsafe_storage', 'Invalid meeting storage file.');
      handle = await open(file, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
      const stat = await validateFile(handle);
      if (stat.dev !== before.dev || stat.ino !== before.ino) throw meetingError('unsafe_storage', 'Meeting storage file changed.');
      // A same-user external writer cannot make readFile allocate unbounded data.
      const contents = Buffer.alloc(stat.size + 1);
      let length = 0;
      while (length < contents.length) {
        const { bytesRead } = await handle.read(contents, length, contents.length - length, length);
        if (bytesRead === 0) break;
        length += bytesRead;
      }
      if (length > stat.size) throw meetingError('invalid_record', 'Meeting storage file changed while reading.');
      const parsed = meetingSchema.safeParse(JSON.parse(contents.subarray(0, length).toString('utf8')));
      if (!parsed.success || parsed.data.id !== id) throw meetingError('invalid_record', 'Meeting record is damaged.');
      return parsed.data;
    } catch (error) {
      if (error.code === 'ENOENT') throw Object.assign(meetingError('not_found', 'Meeting not found.'), { meetingId: id });
      if (error.code === 'ELOOP') throw Object.assign(meetingError('unsafe_storage', 'Meeting files must not use symbolic links.'), { meetingId: id });
      if (error instanceof SyntaxError) throw Object.assign(meetingError('invalid_record', 'Meeting record is damaged.'), { meetingId: id });
      if (['invalid_record', 'unsafe_storage'].includes(error.code)) error.meetingId = id;
      throw error;
    } finally {
      await handle?.close();
    }
  };
  const write = async (record) => {
    const parsed = meetingSchema.safeParse(record);
    if (!parsed.success) throw meetingError('invalid_record', 'Invalid meeting record.');
    const contents = JSON.stringify(parsed.data);
    if (Buffer.byteLength(contents) > MAX_RECORD_BYTES) throw meetingError('storage_limit', 'Meeting transcript is full.');
    await assertDirectory();
    const target = filename(record.id);
    try {
      const stat = await lstat(target);
      if (!stat.isFile() || stat.isSymbolicLink() || stat.nlink !== 1) {
        throw meetingError('unsafe_storage', 'Invalid meeting storage file.');
      }
    } catch (error) {
      if (error.code !== 'ENOENT') throw error;
    }
    const temporary = path.join(directory, `.meeting-${randomUUID()}.tmp`);
    let handle;
    try {
      handle = await open(temporary, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600);
      await handle.chmod(0o600);
      await handle.writeFile(contents, 'utf8');
      await handle.sync();
      await handle.close();
      handle = null;
      await assertDirectory();
      await rename(temporary, target);
    } finally {
      await handle?.close();
      await unlink(temporary).catch((error) => { if (error.code !== 'ENOENT') throw error; });
    }
  };
  const ids = async () => {
    await assertDirectory();
    const entries = await readdir(directory);
    return entries.filter((name) => name.endsWith('.json')).map((name) => {
      const id = name.slice(0, -5);
      filename(id);
      return id;
    });
  };
  const initialize = async () => {
    await checkDirectory(path.dirname(directory));
    await mkdir(directory, { mode: 0o700 }).catch((error) => { if (error.code !== 'EEXIST') throw error; });
    identity = await assertDirectory();
    const handle = await open(directory, constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW);
    try {
      const stat = await handle.stat();
      if (stat.dev !== identity.dev || stat.ino !== identity.ino) throw meetingError('unsafe_storage', 'Meeting storage directory changed.');
      await handle.chmod(0o700);
    } finally { await handle.close(); }
    // An atomic-write crash can leave text-only staging files. Never follow them.
    for (const name of await readdir(directory)) {
      if (/^\.meeting-[0-9a-f-]+\.tmp$/.test(name)) await unlink(path.join(directory, name));
    }
  };
  return { initialize, read, write, ids };
}
