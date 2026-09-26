import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

if (process.platform === 'darwin') {
  const script = fileURLToPath(new URL('../../../native/Folio/build-bridge.sh', import.meta.url));
  const output = fileURLToPath(new URL('../resources/folio', import.meta.url));
  const result = spawnSync('/bin/zsh', [script, output], { stdio: 'inherit' });
  if (result.error) throw result.error;
  process.exit(result.status ?? 1);
}
