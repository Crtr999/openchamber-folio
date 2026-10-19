/**
 * Dev-only harness for scripts/fixtures/personal-workspace-smoke.mjs.
 *
 * The smoke test drives a real offscreen Electron against the personal-workspace
 * fixture (canvas pointers, the creation menu, attach, and the real exports).
 * It needs two things nothing else provides: a Vite dev server that can serve a
 * TSX entry from the repo root, and Electron. Neither had a wired-up command,
 * so this starts the server, waits for it, runs the smoke script, and always
 * tears the server down.
 *
 * Usage: bun run workspace:smoke
 * Evidence (PNGs, exported DOCX/XLSX/PPTX/SVG/PNG, report.json) lands in the
 * directory named by OC_WORKSPACE_TEST_OUTPUT, or oc-work/workspace-smoke.
 */
import { spawn } from 'node:child_process';
import { existsSync, mkdirSync, rmSync } from 'node:fs';
import path from 'node:path';

const root = path.resolve(import.meta.dirname, '..');
const output = process.env.OC_WORKSPACE_TEST_OUTPUT ?? path.join(root, 'oc-work', 'workspace-smoke');
const port = Number(process.env.OC_WORKSPACE_TEST_PORT ?? 5191);
const fixtureHtml = `/${path.relative(root, path.join(root, 'scripts/fixtures/personal-workspace.html'))}`;

const viteBin = path.join(root, 'node_modules/.bin/vite');
const electronDir = path.join(root, 'node_modules/.bun/electron@43.7.0/node_modules/electron/dist/Electron.app/Contents/MacOS/Electron');
const smokeScript = path.join(root, 'scripts/fixtures/personal-workspace-smoke.mjs');

for (const [label, target] of [['vite', viteBin], ['electron', electronDir], ['smoke script', smokeScript]]) {
  if (!existsSync(target)) throw new Error(`Missing ${label} at ${target}`);
}

if (existsSync(output)) rmSync(output, { recursive: true, force: true });
mkdirSync(output, { recursive: true });

// The fixture imports TSX straight out of packages/ui and packages/web, so it needs
// the fixture config (which aliases `@` to packages/ui/src) and the repo root as the
// server root rather than the default vite.config.ts.
const server = spawn(viteBin, ['--port', String(port), '--strictPort', '--host', '127.0.0.1', '--config', path.join(root, 'scripts/fixtures/vite.config.ts'), root], {
  cwd: root,
  stdio: ['ignore', 'pipe', 'pipe'],
});
server.stdout.on('data', (chunk) => process.stdout.write(`[vite] ${chunk}`));
server.stderr.on('data', (chunk) => process.stderr.write(`[vite] ${chunk}`));

let serverLog = '';
server.stdout.on('data', (chunk) => { serverLog += chunk; });
server.stderr.on('data', (chunk) => { serverLog += chunk; });

const stop = () => { if (!server.killed) server.kill('SIGTERM'); };
process.on('exit', stop);
process.on('SIGINT', () => { stop(); process.exit(130); });

const deadline = Date.now() + 60_000;
let ready = false;
while (Date.now() < deadline) {
  if (/Local:.*http/.test(serverLog)) { ready = true; break; }
  if (server.exitCode !== null) throw new Error(`Vite exited early (${server.exitCode}).`);
  await new Promise((resolve) => setTimeout(resolve, 250));
}
if (!ready) {
  stop();
  throw new Error(`Vite did not report ready within 60s.\n${serverLog}`);
}

console.log(`Fixture will be served at http://127.0.0.1:${port}${fixtureHtml}`);

const smoke = spawn(electronDir, [smokeScript], {
  cwd: root,
  stdio: 'inherit',
  env: { ...process.env, OC_WORKSPACE_TEST_OUTPUT: output, ELECTRON_DISABLE_SECURITY_WARNINGS: '1' },
});
const code = await new Promise((resolve) => smoke.on('close', resolve));
stop();
console.log(`\nSmoke exit code: ${code}. Evidence in ${output}`);
process.exit(code ?? 1);