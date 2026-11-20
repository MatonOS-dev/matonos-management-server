// SPDX-License-Identifier: GPL-2.0-only
import { after, before, beforeEach, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, rm, stat, writeFile } from 'node:fs/promises';
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
  root = await mkdtemp(resolve(tmpdir(), 'matonos-server-'));
  storage = resolve(root, 'storage'); configPath = resolve(root, 'channels.json');
  process.env.MATON_SERVER_STORAGE_DIR = storage; process.env.MATON_SERVER_DATA_DIR = resolve(root, 'data'); process.env.MATON_SERVER_CONFIG = configPath; process.env.MATON_SERVER_TRUST_PROXY = '1';
  await mkdir(storage);
  const fdroid = resolve(root, 'fdroid'); process.env.MATON_SERVER_FDROID_DIR = fdroid;
  await mkdir(resolve(fdroid, 'repo'), { recursive: true });
  await writeFile(resolve(fdroid, 'repo', 'index-v2.json'), '{}');
  await writeFile(resolve(fdroid, 'repo', 'org.example_3.apk'), 'apk');
  const download = resolve(root, 'download'); process.env.MATON_SERVER_DOWNLOAD_DIR = download;
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
    const response = await request('/api/update/channels', payload({ addon_list: ['games', 'editor'] }));
    assert.equal(response.status, 200);
    assert.equal(response.headers.get('cache-control'), 'no-store');
    assert.deepEqual(await response.json(), { channels: [{ channel: 'testing', update_id: 101, version: '18', android_base: 18 }] });
  });

  it('returns base files and every requested add-on file', async () => {
    const response = await request('/api/update/check', payload({ addon_list: ['games'] }));
    const result = await response.json();
    assert.equal(response.status, 200);
    assert.equal(result.available, true);
    assert.equal(result.files.length, 8);
    assert.deepEqual(Object.keys(result.addons), ['games']);
    assert.deepEqual(result.addons.games.map((item: any) => item.url), ['/storage/101/games/runtime.tar.zst', '/storage/101/games/locale/en.dat']);
  });

  it('refuses an update and names missing add-ons', async () => {
    const response = await request('/api/update/check', payload({ addon_list: ['games', 'not-ported'] }));
    assert.deepEqual(await response.json(), { available: false, reason: 'missing_addons', missing_addons: ['not-ported'] });
  });

  it('does not offer an update below the installed Android base', async () => {
    const response = await request('/api/update/check', payload({ channel: 'main', base_android: 18 }));
    assert.deepEqual(await response.json(), { available: false, reason: 'android_base_too_old' });
  });

  it('always reports that the installed build is not at end of life', async () => {
    const response = await request('/api/update/eol', payload());
    assert.deepEqual(await response.json(), { eol: false });
  });

  it('returns no license when none are implemented', async () => {
    const response = await request('/api/update/license', payload());
    assert.deepEqual(await response.json(), { status: 'none', license: null });
  });

  it('does not keep aliases for unpublished API paths', async () => {
    for (const path of ['/api/channels','/api/update','/api/eol','/api/license','/api/ratings']) {
      assert.equal((await request(path, payload())).status, 404, path);
    }
  });

  it('rejects malformed JSON and invalid request fields without logging machine id', async () => {
    const malformed = await request('/api/update/check', '{');
    assert.equal(malformed.status, 400);
    const invalid = await request('/api/update/check', payload({ machine_id: 42 }));
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

  it('counts X-Real-IP from a loopback proxy as the client address', async () => {
    const body = { packageName: 'org.example.proxied' };
    await request('/api/fdroid/install', body, { 'x-real-ip': '198.51.100.1' });
    await request('/api/fdroid/install', body, { 'x-real-ip': '198.51.100.1' });
    await request('/api/fdroid/install', body, { 'x-real-ip': '198.51.100.2' });
    const stats = await fetch(`${baseUrl}/api/fdroid/stats/org.example.proxied`);
    assert.equal((await stats.json()).downloads, 2);
  });

  it('keeps downloads separate and stores generic ratings by salted client hash', async () => {
    const post = (endpoint: string, value: unknown, ip = '198.51.100.7') => request(endpoint, value, { 'x-real-ip': ip });
    await post('/api/fdroid/install', { packageName: 'org.example.app', versionCode: 4 });
    await post('/api/fdroid/install', { packageName: 'org.example.app' });
    assert.equal((await post('/api/reviews/ratings', { app: 'org.example.app', stars: 2 })).status, 200);
    await post('/api/reviews/ratings', { app: 'org.example.app', stars: 5 });
    await post('/api/reviews/ratings', { app: 'org.example.app', stars: 3 }, '198.51.100.8');
    const one = await fetch(`${baseUrl}/api/reviews/ratings/org.example.app`);
    assert.deepEqual(await one.json(), { count: 2, avg: 4, histogram: [0, 0, 1, 0, 1] });
    const batch = await fetch(`${baseUrl}/api/reviews/ratings?apps=org.example.app,org.example.other`);
    assert.deepEqual(await batch.json(), {
      'org.example.app': { count: 2, avg: 4, histogram: [0, 0, 1, 0, 1] },
      'org.example.other': { count: 0, avg: 0, histogram: [0, 0, 0, 0, 0] }
    });
    const stats = await fetch(`${baseUrl}/api/fdroid/stats/org.example.app`);
    assert.deepEqual(await stats.json(), { downloads: 1 });
    assert.equal((await readFile(resolve(root, 'data', 'maton.db'))).includes(Buffer.from('198.51.100')), false);
    assert.equal((await readFile(resolve(root, 'data', 'fdroid-stats.salt'), 'utf8')).length, 64);
  });

  it('validates generic rating payloads and app keys', async () => {
    assert.equal((await request('/api/reviews/ratings', { app: 'bad key', stars: 4 })).status, 400);
    assert.equal((await request('/api/reviews/ratings', { app: 'org.example.app', stars: 6 })).status, 400);
    assert.equal((await fetch(`${baseUrl}/api/reviews/ratings?apps=bad%20key`)).status, 400);
    assert.equal((await request('/api/fdroid/rating', { packageName: 'org.example.app', stars: 4 })).status, 404);
  });

  it('binds review sessions to their device and cascades account deletion', async () => {
    const machine = 'machine-one', headers = { 'x-maton-machine-id': machine };
    const registered = await request('/api/account/register', { username:'Reviewer_One', email:'reviewer@example.org', password:'a-long-password-1', device_name:'Test PC' }, headers);
    assert.equal(registered.status, 201);
    const registrationBody = await registered.json() as any;
    assert.equal(typeof registrationBody.token, 'string'); assert.equal(typeof registrationBody.refresh_token, 'string'); assert.equal('email' in registrationBody, false);
    assert.equal((await stat(resolve(root, 'data', 'maton.db'))).mode & 0o777, 0o600);
    assert.equal((await stat(resolve(root, 'data', 'jwt.secret'))).mode & 0o777, 0o600);
    const cookie = registered.headers.get('set-cookie')!.split(';')[0];
    const authHeaders = { ...headers, cookie };
    assert.equal((await request('/api/reviews/apps/org.example.app', { stars:5, title:'Great app', body:'Works well on my PC.' }, authHeaders)).status, 200);
    const filtered = await request('/api/reviews/apps/org.example.app', { stars:5, title:'f.u.c.k', body:'A clear review.' }, authHeaders);
    assert.equal(filtered.status, 422);
    assert.equal((await request('/api/reviews/apps/org.example.app', { stars:5, title:'A clear title', body:'This is shit.' }, authHeaders)).status, 422);
    assert.equal((await request('/api/reviews/apps/org.example.app', { stars:5, title:'A classic app', body:'Assessment in Scunthorpe was excellent.' }, authHeaders)).status, 200);
    assert.equal((await request('/api/reviews/apps/org.example.app', { stars:5, title:'See https://example.org', body:'review' }, authHeaders)).status, 422);
    assert.equal((await fetch(`${baseUrl}/api/reviews/apps/org.example.app`)).status, 200);
    const listed = await (await fetch(`${baseUrl}/api/reviews/apps/org.example.app`)).json();
    assert.deepEqual(Object.keys(listed[0]).sort(), ['body','date','display_name','stars','title']);
    const batch = await fetch(`${baseUrl}/api/reviews/ratings?apps=org.example.app`);
    assert.equal((await batch.json())['org.example.app'].avg, 13 / 3);
    assert.equal((await fetch(`${baseUrl}/api/account`, { headers: { cookie, 'x-maton-machine-id':'wrong-machine' } })).status, 401);
    const devices = await fetch(`${baseUrl}/api/account/devices`, { headers:authHeaders });
    const [device] = await devices.json(); assert.equal(device.current, true); assert.equal(device.name, 'Test PC'); assert.equal(typeof device.last_refreshed, 'number');
    assert.equal((await fetch(`${baseUrl}/api/account/devices/${device.id}`, { method:'DELETE', headers:authHeaders })).status, 200);
    assert.equal((await fetch(`${baseUrl}/api/account`, { headers:authHeaders })).status, 401);
    const db = (await import('../src/database.ts')).database;
    const database = await db();
    const accountRow = database.prepare('SELECT id FROM accounts WHERE username=?').get('Reviewer_One') as any;
    const passwordHash = database.prepare('SELECT password_hash FROM accounts WHERE id=?').get(accountRow.id)?.password_hash as string;
    assert.match(passwordHash, /^scrypt\$16384\$8\$1\$[a-f0-9]{128}$/);
    assert.equal(passwordHash.includes('a-long-password-1'), false);
    assert.equal(database.prepare('SELECT count(*) AS n FROM reviews WHERE account_id=?').get(accountRow.id)?.n, 1);
    const relogin = await request('/api/account/login', { username:'reviewer_one', password:'a-long-password-1', device_name:'Test PC' }, headers);
    assert.equal(relogin.status, 200);
    const reloginCookie = relogin.headers.get('set-cookie')!.split(';')[0];
    assert.equal((await fetch(`${baseUrl}/api/account`, { headers:{ cookie:reloginCookie, 'x-maton-machine-id':machine } })).status, 200);
    assert.equal((await fetch(`${baseUrl}/api/account`, { headers:{ cookie:reloginCookie, 'x-maton-machine-id':machine } })).status, 200);
    const loginBody = await relogin.json() as any;
    assert.equal(typeof loginBody.token, 'string'); assert.equal(typeof loginBody.refresh_token, 'string');
    assert.ok(relogin.headers.getSetCookie().some((v) => v.startsWith('maton_refresh=')));
    const deleted = await fetch(`${baseUrl}/api/account`, { method:'DELETE', headers:{ 'content-type':'application/json', cookie:reloginCookie, 'x-maton-machine-id':machine }, body:JSON.stringify({ password:'a-long-password-1' }) });
    assert.equal(deleted.status, 200);
    assert.equal(database.prepare('SELECT count(*) AS n FROM reviews WHERE account_id=?').get(accountRow.id)?.n, 0);
  });

  it('expires JWT sessions and backs off repeated invalid logins', async () => {
    const { database } = await import('../src/database.ts');
    const db = await database();
    const { createHash } = await import('node:crypto');
    const { SignJWT } = await import('jose');
    const { jwtSecret } = await import('../src/database.ts');
    const machineId = 'expiry-machine';
    const created = await request('/api/account/register', { username:'Expiry_User', email:'expiry@example.org', password:'a-long-password-2', device_name:'Expiry PC' }, { 'x-maton-machine-id':machineId });
    const row = db.prepare('SELECT id FROM accounts WHERE username=?').get('Expiry_User') as any;
    const device = db.prepare('SELECT jti FROM devices WHERE account_id=?').get(row.id) as any;
    const mid = createHash('sha256').update(machineId + device.jti).digest('hex');
    const expired = await new SignJWT({mid}).setProtectedHeader({alg:'HS256'}).setSubject(row.id).setJti(device.jti).setIssuedAt(Math.floor(Date.now()/1000)-7200).setExpirationTime(Math.floor(Date.now()/1000)-3600).sign(new Uint8Array(await jwtSecret()));
    const expiredHeaders = {cookie:`maton_session=${expired}`, 'x-maton-machine-id':machineId};
    assert.equal((await fetch(`${baseUrl}/api/account`, {headers:expiredHeaders})).status, 401);
    assert.equal((await fetch(`${baseUrl}/api/reviews/apps/org.example.app?mine=1`, {headers:expiredHeaders})).status, 401);
    assert.equal(created.status, 201);
    const fails = await Promise.all(Array.from({length:5}, () => request('/api/account/login', {username:'nobody',password:'wrong-password'}, {'x-real-ip':'198.51.100.50'})));
    assert.ok(fails.every((response) => response.status === 401));
    assert.equal((await request('/api/account/login', {username:'nobody',password:'wrong-password'}, {'x-real-ip':'198.51.100.50'})).status, 429);
  });

  it('reports unavailable password reset when mail transport is not configured', async () => {
    delete process.env.MATON_SERVER_SMTP_URL; delete process.env.MATON_SERVER_MAIL_FROM;
    const response = await request('/api/account/reset', { email:'nobody@example.org' });
    assert.equal(response.status, 503);
    assert.equal((await response.json()).error, 'mail_not_configured');
  });

  it('rejects links and English profanity while avoiding substring false positives', async () => {
    const { spamText, textRejected } = await import('../src/abuse.ts');
    assert.equal(spamText('See https://example.org'), true);
    assert.equal(spamText('mail me at a@example.org'), true);
    assert.equal(spamText('A useful review without a link.'), false);
    assert.equal(await textRejected('classic'), false);
    assert.equal(await textRejected('Scunthorpe'), false);
    assert.equal(await textRejected('assessment'), false);
    assert.equal(await textRejected('That was fucking awful.'), true);
    assert.equal(await textRejected('you are a bastard'), true);
    assert.equal((await request('/api/account/register', { username:'Fuck_User', email:'filtered@example.org', password:'a-long-password-5' }, {'x-maton-machine-id':'filtered-machine'})).status, 400);
  });

  it('issues one-hour access JWTs and rotates month-long refresh tokens with stable device identity', async () => {
    const { database, jwtSecret } = await import('../src/database.ts');
    const { createHash } = await import('node:crypto');
    const { jwtVerify } = await import('jose');
    const db = await database(), machineId = 'refresh-machine';
    const login = await request('/api/account/register', { username:'Refresh_User', email:'refresh@example.org', password:'a-long-password-3', device_name:'Refresh PC' }, {'x-maton-machine-id':machineId});
    assert.equal(login.status, 201);
    const first = await login.json() as any;
    assert.match(first.refresh_token, /^[A-Za-z0-9_-]{43}$/);
    const cookies = login.headers.getSetCookie();
    assert.ok(cookies.some((v) => v.startsWith('maton_session=') && v.includes('Max-Age=3600')));
    assert.ok(cookies.some((v) => v.startsWith('maton_refresh=') && v.includes('Path=/api/account/refresh') && v.includes('HttpOnly') && v.includes('Secure') && v.includes('SameSite=Strict')));
    const original = (await jwtVerify(first.token, new Uint8Array(await jwtSecret()))).payload;
    assert.ok(Number(original.exp) - Math.floor(Date.now()/1000) <= 3600);
    const row = db.prepare('SELECT * FROM devices WHERE jti=?').get(original.jti) as any;
    assert.equal(row.refresh_hash, createHash('sha256').update(first.refresh_token).digest('hex'));
    assert.equal(row.prev_refresh_hash, null);
    assert.equal(row.refresh_expires - row.last_refreshed, 30 * 86400_000);
    const refreshed = await fetch(`${baseUrl}/api/account/refresh`, {method:'POST', headers:{cookie:`maton_refresh=${first.refresh_token}`, 'x-maton-machine-id':machineId}});
    assert.equal(refreshed.status, 200);
    const second = await refreshed.json() as any;
    assert.notEqual(second.refresh_token, first.refresh_token);
    const rotated = (await jwtVerify(second.token, new Uint8Array(await jwtSecret()))).payload;
    assert.equal(rotated.jti, original.jti); assert.equal(rotated.mid, original.mid);
    const updated = db.prepare('SELECT * FROM devices WHERE jti=?').get(original.jti) as any;
    assert.equal(updated.prev_refresh_hash, createHash('sha256').update(first.refresh_token).digest('hex'));
    assert.equal(updated.refresh_hash, createHash('sha256').update(second.refresh_token).digest('hex'));
    assert.ok(updated.last_refreshed >= row.last_refreshed);
    const reused = await request('/api/account/refresh', {refresh_token:first.refresh_token}, {'x-maton-machine-id':machineId});
    assert.equal(reused.status, 401);
    assert.equal(db.prepare('SELECT count(*) AS n FROM devices WHERE jti=?').get(original.jti)?.n, 0);
  });

  it('rejects refresh tokens for the wrong machine, expired tokens, and removed devices', async () => {
    const { database } = await import('../src/database.ts');
    const db = await database(), machineId = 'refresh-failure-machine';
    const create = async (name:string) => {
      const response = await request('/api/account/register', {username:name, email:`${name.toLowerCase()}@example.org`, password:'a-long-password-4'}, {'x-maton-machine-id':machineId});
      assert.equal(response.status, 201);
      const body = await response.json() as any;
      const row = db.prepare('SELECT jti FROM devices WHERE refresh_hash=?').get((await import('node:crypto')).createHash('sha256').update(body.refresh_token).digest('hex')) as any;
      return { token:body.refresh_token, jti:row.jti };
    };
    const wrongMachine = await create('Wrong_Machine');
    assert.equal((await request('/api/account/refresh', {refresh_token:wrongMachine.token}, {'x-maton-machine-id':'another-machine'})).status, 401);
    const expired = await create('Expired_Refresh');
    db.prepare('UPDATE devices SET refresh_expires=? WHERE jti=?').run(Date.now() - 1, expired.jti);
    assert.equal((await request('/api/account/refresh', {refresh_token:expired.token}, {'x-maton-machine-id':machineId})).status, 401);
    const removed = await create('Removed_Device');
    db.prepare('DELETE FROM devices WHERE jti=?').run(removed.jti);
    assert.equal((await request('/api/account/refresh', {refresh_token:removed.token}, {'x-maton-machine-id':machineId})).status, 401);
  });

  it('refuses promotion to a lower Android base', () => {
    const source = new URL('../src/promote.ts', import.meta.url);
    const result = spawnSync(process.execPath, [source.pathname, 'testing', '102'], {
      env: { ...process.env, MATON_SERVER_CONFIG: configPath, MATON_SERVER_STORAGE_DIR: storage, MATON_SERVER_DATA_DIR: resolve(root, 'data') }, encoding: 'utf8'
    });
    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /refusing Android base downgrade/);
  });

  it('allows promotion in either direction on the same Android base', async () => {
    const source = new URL('../src/promote.ts', import.meta.url);
    const result = spawnSync(process.execPath, [source.pathname, 'main', '101'], {
      env: { ...process.env, MATON_SERVER_CONFIG: configPath, MATON_SERVER_STORAGE_DIR: storage, MATON_SERVER_DATA_DIR: resolve(root, 'data') }, encoding: 'utf8'
    });
    assert.equal(result.status, 0, result.stderr);
    const config = JSON.parse(await readFile(configPath, 'utf8'));
    assert.equal(config.channels.main.update_id, 101);
  });
});
