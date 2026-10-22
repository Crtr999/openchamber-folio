import { readFile, stat } from 'node:fs/promises';
import { resolve, isAbsolute } from 'node:path';
import { createPrivateKey } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { parseDocument } from 'yaml';

const envPath = process.argv[2];
if (!envPath) throw new Error('Pass the absolute path to a private environment file. This command validates only; it does not deploy.');
if (!envPath.startsWith('/')) throw new Error('Use an absolute path to the private environment file.');
const info = await stat(envPath);
if ((info.mode & 0o077) !== 0) throw new Error('The environment file must be readable only by its owner (chmod 600).');
const text = await readFile(envPath, 'utf8');
const values = new Map(text.split(/\r?\n/).filter((line) => line && !line.startsWith('#')).map((line) => {
  const split = line.indexOf('=');
  return [line.slice(0, split), line.slice(split + 1)];
}));
const hostname = values.get('CARTER_HOSTNAME') || '';
if (!/^(?:[a-z0-9](?:[a-z0-9-]*[a-z0-9])?\.)+[a-z]{2,}$/i.test(hostname) || hostname.endsWith('.example.com')) throw new Error('Set a real DNS hostname.');
const password = values.get('OPENCHAMBER_UI_PASSWORD') || '';
if (password.length < 24 || password.includes('replace-with')) throw new Error('Set a unique password of at least 24 characters.');
if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(values.get('ACME_EMAIL') || '')) throw new Error('Set the certificate contact email.');
const composePath = resolve(import.meta.dirname, 'compose.yaml');
// --quiet validates interpolation without printing secrets from resolved config.
const compose = parseDocument(await readFile(composePath, 'utf8'));
if (compose.errors.length) throw new Error('Compose YAML is invalid.');
const composeFiles = ['-f', composePath];
if (process.argv.includes('--native-push')) {
  for (const key of ['CARTER_APNS_KEY_ID', 'CARTER_APNS_TEAM_ID']) {
    if (!/^[A-Z0-9]{10}$/.test(values.get(key) || '')) throw new Error(`Set a valid ${key}.`);
  }
  if (!/^[A-Za-z0-9-]+(?:\.[A-Za-z0-9-]+)+$/.test(values.get('CARTER_IOS_BUNDLE_ID') || '')) throw new Error('Set the signed iPhone bundle ID.');
  const keyPath = values.get('CARTER_APNS_KEY_FILE') || '';
  if (!isAbsolute(keyPath)) throw new Error('Use an absolute Apple push key path.');
  const keyInfo = await stat(keyPath);
  if (!keyInfo.isFile() || (keyInfo.mode & 0o077) !== 0) throw new Error('The Apple push key must be a private owner-only file.');
  if (process.platform === 'linux' && process.argv.includes('--docker') && keyInfo.uid !== 1000) throw new Error('The Apple push key must be owned by container UID 1000 on the Linux deployment host.');
  try {
    const key = createPrivateKey(await readFile(keyPath));
    if (key.asymmetricKeyType !== 'ec' || key.asymmetricKeyDetails?.namedCurve !== 'prime256v1') throw new Error('curve');
  } catch { throw new Error('The Apple push key must be a valid P-256 private key.'); }
  const nativePath = resolve(import.meta.dirname, 'native-push.compose.yaml');
  if (parseDocument(await readFile(nativePath, 'utf8')).errors.length) throw new Error('Native push YAML is invalid.');
  composeFiles.push('-f', nativePath);
}
if (!process.argv.includes('--docker')) {
  console.log('Environment and Compose YAML valid. Run again with --docker on the deployment host to validate Compose interpolation. No services started.');
  process.exit(0);
}
const result = spawnSync('docker', ['compose', '--env-file', envPath, ...composeFiles, 'config', '--quiet'], { stdio: 'inherit' });
if (result.error) throw result.error;
if (result.status !== 0) process.exit(result.status ?? 1);
console.log('Configuration valid. No services started. No data or model credentials migrated.');
