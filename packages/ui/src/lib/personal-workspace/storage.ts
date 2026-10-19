import type { FilesAPI } from '@/lib/api/types';
import { getRuntimeKey } from '@/lib/runtime-switch';
import { artifactStem } from './exports';

/** Never overwrites a source or export. Writes stay with their captured host. */
export async function saveWorkspaceCopy(files: Pick<FilesAPI, 'createDirectory' | 'uploadFile'>, directory: string, name: string, blob: Blob, runtime = getRuntimeKey()): Promise<string> {
  if (!files.uploadFile || getRuntimeKey() !== runtime) throw new Error('save_unavailable');
  const folder = `${directory.replace(/\/$/, '')}/artifacts`;
  const made = await files.createDirectory(folder);
  if (!made.success || getRuntimeKey() !== runtime) throw new Error('create_failed');
  const dot = name.lastIndexOf('.');
  const stem = artifactStem(dot > 0 ? name.slice(0, dot) : name);
  const extension = dot > 0 ? name.slice(dot).replace(/[^a-z0-9.]/gi, '') : '';
  const path = `${folder}/${stem}-${crypto.randomUUID()}${extension}`;
  const result = await files.uploadFile(path, blob, { overwrite: false, directory });
  if (!result.success) throw new Error('save_failed');
  return path;
}
