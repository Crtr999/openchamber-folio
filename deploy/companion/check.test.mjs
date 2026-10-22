import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile, chmod, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { parse } from 'yaml';
import { readFile } from 'node:fs/promises';

test('deployment keeps the app private and makes authentication mandatory', async () => {
  const compose = parse(await readFile(new URL('./compose.yaml', import.meta.url), 'utf8'));
  assert.equal(compose.services.app.ports, undefined);
  assert.deepEqual(compose.services.edge.ports, ['80:80', '443:443']);
  assert.match(compose.services.app.environment.OPENCHAMBER_UI_PASSWORD, /:\?/);
  assert.equal(compose.services.app.restart, 'unless-stopped');
  assert.ok(compose.services.app.command.includes('--foreground'));
  assert.equal(compose.services.app.command[0], 'node');
  assert.ok(compose.services.app.volumes.some((volume) => volume.includes('/.local')));
});
test('preflight validates without starting services or printing private values', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'carter-deploy-test-'));
  const envPath = join(directory, 'private.env');
  const fixture = 'CARTER_HOSTNAME=carter.fixture.invalid\nACME_EMAIL=fixture@example.invalid\nOPENCHAMBER_UI_PASSWORD=disposable-fixture-password-only\n';
  const run = () => spawnSync(process.execPath, [new URL('./check.mjs', import.meta.url).pathname, envPath], { encoding: 'utf8' });
  try {
    await writeFile(envPath, fixture, { mode: 0o600 });
    const success = run();
    assert.equal(success.status, 0, success.stderr);
    assert.match(success.stdout, /No services started/);
    assert.ok(!success.stdout.includes('disposable-fixture'));
    await chmod(envPath, 0o644);
    assert.notEqual(run().status, 0);
    await chmod(envPath, 0o600);
    await writeFile(envPath, fixture.replace('disposable-fixture-password-only', 'short'));
    assert.notEqual(run().status, 0);
  } finally { await rm(directory, { recursive: true }); }
});

test('personal native push requires private P-256 key and never prints it', async () => {
  const { generateKeyPairSync } = await import('node:crypto');
  const directory = await mkdtemp(join(tmpdir(), 'carter-push-test-'));
  const envPath = join(directory, 'private.env');
  const keyPath = join(directory, 'fixture.p8');
  const { privateKey } = generateKeyPairSync('ec', { namedCurve: 'prime256v1' });
  const pem = privateKey.export({ type: 'pkcs8', format: 'pem' });
  const fixture = `CARTER_HOSTNAME=carter.fixture.invalid\nACME_EMAIL=fixture@example.invalid\nOPENCHAMBER_UI_PASSWORD=disposable-fixture-password-only\nCARTER_APNS_KEY_ID=FIXTURE001\nCARTER_APNS_TEAM_ID=FIXTURE002\nCARTER_IOS_BUNDLE_ID=com.fixture.carter\nCARTER_APNS_KEY_FILE=${keyPath}\n`;
  const run = () => spawnSync(process.execPath, [new URL('./check.mjs', import.meta.url).pathname, envPath, '--native-push'], { encoding: 'utf8' });
  try {
    await writeFile(envPath, fixture, { mode: 0o600 });
    await writeFile(keyPath, pem, { mode: 0o600 });
    const valid = run();
    assert.equal(valid.status, 0, valid.stderr);
    assert.ok(!valid.stdout.includes(pem));
    assert.ok(!valid.stderr.includes(pem));
    assert.match(valid.stdout, /No services started/);
    await chmod(keyPath, 0o644);
    assert.notEqual(run().status, 0);
    await chmod(keyPath, 0o600);
    await writeFile(keyPath, 'invalid key');
    assert.notEqual(run().status, 0);
    const override = parse(await readFile(new URL('./native-push.compose.yaml', import.meta.url), 'utf8'));
    assert.equal(override.services.app.environment.OPENCHAMBER_PUSH_RELAY_DISABLED, 'true');
    assert.equal(override.services.app.environment.OPENCHAMBER_APNS_P8, undefined);
    assert.equal(override.services.app.ports, undefined);
    assert.ok(override.secrets.apple_push_key.file.includes(':?'));
  } finally { await rm(directory, { recursive: true }); }
});
