import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { z } from 'zod';

const serviceFileSchema = z.object({ password: z.string().min(1) }).passthrough();

// On this Mac, OpenCode's background service (`opencode serve --service`) is already warm:
// projects, providers and agents are loaded. Attaching to it avoids starting a second engine,
// and a second engine can stall forever reading a project config that iCloud never downloads.
// When no service is running, nothing is set and OpenChamber starts its own managed OpenCode.
export function attachToBackgroundOpenCodeService({ env = process.env, homedir, log = () => {} }) {
  if (process.platform !== 'darwin') return null;
  if (env.OPENCODE_HOST || env.OPENCODE_PORT || env.OPENCODE_SKIP_START || env.OPENCHAMBER_FOLIO_OWN_OPENCODE === '1') return null;
  try {
    const service = serviceFileSchema.parse(JSON.parse(readFileSync(path.join(homedir, '.config', 'opencode', 'service.json'), 'utf8')));
    const pids = execFileSync('/usr/bin/pgrep', ['-f', 'opencode serve --service'], { encoding: 'utf8', timeout: 1500 })
      .split('\n').map((line) => line.trim()).filter((line) => /^\d+$/.test(line));
    for (const pid of pids) {
      const listing = execFileSync('/usr/sbin/lsof', ['-nP', '-a', '-p', pid, '-iTCP', '-sTCP:LISTEN', '-Fn'], { encoding: 'utf8', timeout: 1500 });
      const match = listing.match(/^n127\.0\.0\.1:(\d+)$/m);
      if (!match) continue;
      env.OPENCODE_PORT = match[1];
      env.OPENCODE_SERVER_PASSWORD = service.password;
      log(`[opencode-service] attaching to background OpenCode service on port ${match[1]}`);
      return Number(match[1]);
    }
  } catch {
    // No service, unreadable service file, or tools unavailable: start our own OpenCode as usual.
  }
  return null;
}
