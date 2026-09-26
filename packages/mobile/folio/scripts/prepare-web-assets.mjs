import { cp, readFile, rm, writeFile, mkdir } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

// Copies the web build and makes folio.html the app's start page.
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const webDist = path.resolve(root, '../../web/dist');
const dist = path.resolve(root, 'dist');

await rm(dist, { recursive: true, force: true });
await mkdir(dist, { recursive: true });
await cp(webDist, dist, { recursive: true });
await writeFile(path.join(dist, 'index.html'), await readFile(path.join(dist, 'folio.html'), 'utf8'));
console.log('[folio-mobile] web assets ready');
