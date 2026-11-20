import { after, before, beforeEach, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';
import { spawnSync } from 'node:child_process';

const names = ['system.erofs', 'system_ext.erofs', 'product.erofs', 'vendor.erofs', 'odm.erofs', 'vbmeta.img', 'matonos-a.efi', 'matonos-b.efi'];
let root: string, storage: string, configPath: string, server: any, baseUrl: string;

function manifest(id: number, androidBase: number, addons: Record<string, unknown> = {}) {
  return {
    format_version: 1,
    build: { id, version: String(androidBase), android_base: androidBase },
    files: names.map((name) => ({ name, size: Buffer.byteLength(name), sha256: 'a'.repeat(64) })),
    addons
  };
}

async function writeUpdate(id: number, base: number, addonFiles: Record<string, string[]> = {}) {
  const dir = resolve(storage, String(id));
  await mkdir(dir, { recursive: true });
  const addons: Record<string, unknown[]> = {};
  for (const [addon, files] of Object.entries(addonFiles)) {
    addons[addon] = [];
    for (const file of files) {
      const path = resolve(dir, addon, file);
      await mkdir(resolve(path, '..'), { recursive: true });
      const content = Buffer.from(`${addon}/${file}`);
      await writeFile(path, content);
      (addons[addon] as unknown[]).push({ name: file, size: content.length, sha256: 'b'.repeat(64) });
    }
  }
  const value = manifest(id, base, addons);
  await writeFile(resolve(dir, 'manifest.json'), `${JSON.stringify(value)}\n`);
  await writeFile(resolve(dir, 'manifest.sig'), Buffer.alloc(64, 1));
  for (const name of names) await writeFile(resolve(dir, name), name);
}

const request = (endpoint: string, body: unknown, headers: Record<string, string> = {}) =>
  fetch(`${baseUrl}${endpoint}`, { method: 'POST', headers: { 'content-type': 'application/json', ...headers }, body: typeof body === 'string' ? body : JSON.stringify(body) });
const payload = (values: Record<string, unknown> = {}) => ({ update_id: 100, channel: 'testing', base_android: 18, machine_id: 'device-abc_123', addon_list: [], ...values });

before(async () => {
  root = await mkdtemp(resolve(tmpdir(), 'matonos-ota-'));
  storage = resolve(root, 'storage'); configPath = resolve(root, 'channels.json');
  process.env.OTA_STORAGE_DIR = storage; process.env.OTA_CONFIG = configPath;
  await mkdir(storage);
  const fdroid = resolve(root, 'fdroid'); process.env.OTA_FDROID_DIR = fdroid;
  await mkdir(resolve(fdroid, 'repo'), { recursive: true });
  await writeFile(resolve(fdroid, 'repo', 'index-v2.json'), '{}');
  await writeFile(resolve(fdroid, 'repo', 'org.example_3.apk'), 'apk');
  const download = resolve(root, 'download'); process.env.OTA_DOWNLOAD_DIR = download;
  await mkdir(resolve(download, 'nested'), { recursive: true });
  await writeFile(resolve(download, 'matonos-100-x86_64.iso'), 'iso');
  await writeFile(resolve(download, 'nested', 'x.iso'), 'no');
  await writeUpdate(100, 18, { games: ['runtime.tar.zst', 'locale/en.dat'], editor: ['editor.pkg'] });
  await writeUpdate(101, 18, { games: ['runtime.tar.zst', 'locale/en.dat'], editor: ['editor.pkg'] });
  await writeUpdate(102, 17);
  await writeUpdate(103, 19);
  await writeFile(configPath, JSON.stringify({
    channels: { testing: { update_id: 101 }, incomplete: { update_id: 103 }, main: { update_id: 102 }, licensed: { update_id: 103, requires_license: true } }
  }));
  const { createOtaServer } = await import('../src/server.ts');
  server = createOtaServer();
  await new Promise<void>((done) => server.listen(0, '127.0.0.1', done));
  baseUrl = `http://127.0.0.1:${server.address().port}`;
});

after(async () => {
  await new Promise<void>((done) => server.close(done));
  await rm(root, { recursive: true, force: true });
});

describe('OTA API', () => {
  it('lists only channels whose base and add-on inventory satisfy the device', async () => {
    const response = await request('/api/channels', payload({ addon_list: ['games', 'editor'] }));
    assert.equal(response.status, 200);
    assert.equal(response.headers.get('cache-control'), 'no-store');
    assert.deepEqual(await response.json(), { channels: [{ channel: 'testing', update_id: 101, version: '18', android_base: 18 }] });
  });

  it('returns base files and every requested add-on file', async () => {
    const response = await request('/api/update', payload({ addon_list: ['games'] }));
    const result = await response.json();
    assert.equal(response.status, 200);
    assert.equal(result.available, true);
    assert.equal(result.files.length, 8);
    assert.deepEqual(Object.keys(result.addons), ['games']);
    assert.deepEqual(result.addons.games.map((item: any) => item.url), ['/storage/101/games/runtime.tar.zst', '/storage/101/games/locale/en.dat']);
  });

  it('refuses an update and names missing add-ons', async () => {
    const response = await request('/api/update', payload({ addon_list: ['games', 'not-ported'] }));
    assert.deepEqual(await response.json(), { available: false, reason: 'missing_addons', missing_addons: ['not-ported'] });
  });

  it('does not offer an update below the installed Android base', async () => {
    const response = await request('/api/update', payload({ channel: 'main', base_android: 18 }));
    assert.deepEqual(await response.json(), { available: false, reason: 'android_base_too_old' });
  });

  it('always reports that the installed build is not at end of life', async () => {
    const response = await request('/api/eol', payload());
    assert.deepEqual(await response.json(), { eol: false });
  });

  it('returns no license when none are implemented', async () => {
    const response = await request('/api/license', payload());
    assert.deepEqual(await response.json(), { status: 'none', license: null });
  });

  it('rejects malformed JSON and invalid request fields without logging machine id', async () => {
    const malformed = await request('/api/update', '{');
    assert.equal(malformed.status, 400);
    const invalid = await request('/api/update', payload({ machine_id: 42 }));
    assert.equal(invalid.status, 400);
    assert.equal((await invalid.text()).includes('42'), false);
  });

  it('serves byte ranges and immutable storage cache headers', async () => {
    const response = await fetch(`${baseUrl}/storage/101/vbmeta.img`, { headers: { range: 'bytes=1-3' } });
    assert.equal(response.status, 206);
    assert.equal(response.headers.get('content-range'), 'bytes 1-3/10');
    assert.equal(response.headers.get('cache-control'), 'public, max-age=31536000, immutable');
    assert.equal(await response.text(), 'bme');
  });

  it('serves the F-Droid repo with short-lived index caching', async () => {
    const index = await fetch(`${baseUrl}/fdroid/repo/index-v2.json`);
    assert.equal(index.status, 200);
    assert.equal(index.headers.get('cache-control'), 'public, max-age=60');
    assert.equal(index.headers.get('cdn-cache-control'), 'max-age=60');
    const apk = await fetch(`${baseUrl}/fdroid/repo/org.example_3.apk`);
    assert.equal(apk.headers.get('cache-control'), 'public, max-age=31536000, immutable');
    assert.equal(await apk.text(), 'apk');
    assert.equal((await fetch(`${baseUrl}/fdroid/repo/..%2Fsecret`)).status, 404);
    assert.equal((await fetch(`${baseUrl}/fdroid/repo/missing.apk`)).status, 404);
  });

  it('serves installer media as immutable flat files', async () => {
    const iso = await fetch(`${baseUrl}/download/matonos-100-x86_64.iso`);
    assert.equal(iso.status, 200);
    assert.equal(iso.headers.get('cache-control'), 'public, max-age=31536000, immutable');
    assert.equal(await iso.text(), 'iso');
    assert.equal((await fetch(`${baseUrl}/download/nested/x.iso`)).status, 404);
    assert.equal((await fetch(`${baseUrl}/download/..%2Fstorage`)).status, 404);
    assert.equal((await fetch(`${baseUrl}/download/missing.iso`)).status, 404);
  });

  it('deduplicates installs and keeps the latest per-IP rating with cache validators', async () => {
    const post = (endpoint: string, value: unknown) => request(endpoint, value);
    assert.equal((await post('/api/fdroid/install', { packageName: 'org.example.app', versionCode: 4 })).status, 200);
    await post('/api/fdroid/install', { packageName: 'org.example.app' });
    await post('/api/fdroid/rating', { packageName: 'org.example.app', stars: 2 });
    await post('/api/fdroid/rating', { packageName: 'org.example.app', stars: 5 });
    const stats = await fetch(`${baseUrl}/api/fdroid/stats/org.example.app`);
    assert.deepEqual(await stats.json(), { downloads: 1, ratingCount: 1, ratingAvg: 5, ratingHistogram: [0, 0, 0, 0, 1] });
    assert.match(stats.headers.get('etag') ?? '', /^"[a-f0-9]+"$/);
    assert.match(stats.headers.get('cache-control') ?? '', /max-age/);
    const cached = await fetch(`${baseUrl}/api/fdroid/stats/org.example.app`, { headers: { 'if-none-match': stats.headers.get('etag')! } });
    assert.equal(cached.status, 304);
    assert.equal((await readFile(resolve(root, 'storage', 'fdroid-stats.salt'), 'utf8')).length, 64);
  });

  it('validates F-Droid event payloads', async () => {
    assert.equal((await request('/api/fdroid/install', { packageName: 'bad' })).status, 400);
    assert.equal((await request('/api/fdroid/rating', { packageName: 'org.example.app', stars: 6 })).status, 400);
  });

  it('refuses promotion to a lower Android base', () => {
    const source = new URL('../src/promote.ts', import.meta.url);
    const result = spawnSync(process.execPath, [source.pathname, 'testing', '102'], {
      env: { ...process.env, OTA_CONFIG: configPath, OTA_STORAGE_DIR: storage }, encoding: 'utf8'
    });
    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /refusing Android base downgrade/);
  });

  it('allows promotion in either direction on the same Android base', async () => {
    const source = new URL('../src/promote.ts', import.meta.url);
    const result = spawnSync(process.execPath, [source.pathname, 'main', '101'], {
      env: { ...process.env, OTA_CONFIG: configPath, OTA_STORAGE_DIR: storage }, encoding: 'utf8'
    });
    assert.equal(result.status, 0, result.stderr);
    const config = JSON.parse(await readFile(configPath, 'utf8'));
    assert.equal(config.channels.main.update_id, 101);
  });
});
