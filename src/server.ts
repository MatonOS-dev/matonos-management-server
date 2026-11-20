import { createReadStream, promises as fs } from 'node:fs';
import { createServer } from 'node:http';
import { createHash, randomBytes } from 'node:crypto';
import { basename, extname, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

const PORT = Number(process.env.OTA_PORT ?? '8080');
const HOST = process.env.OTA_HOST ?? '127.0.0.1';
const STORAGE_DIR = process.env.OTA_STORAGE_DIR;
const CONFIG_PATH = process.env.OTA_CONFIG;
const FDROID_DIR = process.env.OTA_FDROID_DIR;
// Installer media (ISO, raw live image, checksums). Names carry the update id, so they never change.
const DOWNLOAD_DIR = process.env.OTA_DOWNLOAD_DIR;
// Set to 1 when a local reverse proxy (nginx) sets X-Real-IP to the resolved client address.
const TRUST_PROXY = process.env.OTA_TRUST_PROXY === '1';
const IMMUTABLE = 'public, max-age=31536000, immutable';
// F-Droid index files change on every publish; everything else in the repo is versioned by name.
const FDROID_INDEX_RE = /^(entry\.(jar|json)|index(-v1|-v2)?\.(jar|json|xml|html)|diff\/.*)$/;
const FDROID_INDEX_CACHE = 'public, max-age=60';
const MAX_BODY = 64 * 1024;
const CHANNEL_RE = /^[a-z0-9_]+$/;
const UPDATE_ID_RE = /^[1-9][0-9]{0,19}$/;
const PACKAGE_RE = /^[A-Za-z_][A-Za-z0-9_]*(\.[A-Za-z_][A-Za-z0-9_]*)+$/;
const FSTATS_FILE = 'fdroid-stats.json';
const FSTATS_SALT_FILE = 'fdroid-stats.salt';
const RATINGS_FILE = 'ratings.json';
const APP_KEY_RE = /^[A-Za-z0-9][A-Za-z0-9._+-]{0,254}$/;
const statsRate = new Map<string, { start: number; count: number }>();
let statsQueue = Promise.resolve();

function log(level: string, event: string, fields: Record<string, unknown> = {}) {
  process.stderr.write(`${JSON.stringify({ time: new Date().toISOString(), level, event, ...fields })}\n`);
}

function fail(status: number, code: string, message: string): HttpError {
  return new HttpError(status, code, message);
}

class HttpError extends Error {
  status: number;
  code: string;
  constructor(status: number, code: string, message: string) {
    super(message);
    this.status = status;
    this.code = code;
  }
}

function validUpdateId(value: unknown): value is string | number {
  return (typeof value === 'string' && UPDATE_ID_RE.test(value)) ||
    (Number.isSafeInteger(value) && Number(value) > 0);
}

function idString(value: string | number): string {
  return String(value);
}

function validateBody(body: any) {
  if (!body || typeof body !== 'object' || Array.isArray(body)) throw fail(400, 'invalid_body', 'Expected a JSON object');
  const required = ['update_id', 'channel', 'base_android', 'addon_list'];
  for (const key of required) if (!(key in body)) throw fail(400, 'missing_field', `Missing field: ${key}`);
  if (!validUpdateId(body.update_id)) throw fail(400, 'invalid_update_id', 'update_id must be a positive integer');
  if (!Number.isSafeInteger(body.base_android) || body.base_android <= 0) throw fail(400, 'invalid_base_android', 'base_android must be a positive integer');
  if (typeof body.channel !== 'string' || !CHANNEL_RE.test(body.channel)) throw fail(400, 'invalid_channel', 'channel has an invalid format');
  if (body.machine_id !== undefined && typeof body.machine_id !== 'string') throw fail(400, 'invalid_machine_id', 'machine_id must be a string');
  if (body.license_hash !== undefined && typeof body.license_hash !== 'string') {
    throw fail(400, 'invalid_license_hash', 'license_hash must be a string');
  }
  if (!Array.isArray(body.addon_list) || body.addon_list.some((id: unknown) => typeof id !== 'string')) {
    throw fail(400, 'invalid_addon_list', 'addon_list must contain add-on id strings');
  }
  return body as { update_id: string | number; channel: string; base_android: number; machine_id?: string; license_hash?: string; addon_list: string[] };
}

async function readConfig() {
  if (!CONFIG_PATH) throw new Error('OTA_CONFIG is not set');
  const config = JSON.parse(await fs.readFile(CONFIG_PATH, 'utf8'));
  if (!config || typeof config.channels !== 'object' || !config.channels) {
    throw new Error('config must contain a channels object');
  }
  for (const [name, channel] of Object.entries(config.channels) as [string, any][]) {
    if (!CHANNEL_RE.test(name) || !channel || !validUpdateId(channel.update_id) ||
      (channel.requires_license !== undefined && typeof channel.requires_license !== 'boolean')) {
      throw new Error(`invalid channel configuration: ${name}`);
    }
  }
  return config as { channels: Record<string, { update_id: string | number; requires_license?: boolean }> };
}

async function readManifest(id: string) {
  if (!STORAGE_DIR) throw new Error('OTA_STORAGE_DIR is not set');
  const path = resolve(STORAGE_DIR, id, 'manifest.json');
  try {
    const manifest = JSON.parse(await fs.readFile(path, 'utf8'));
    if (idString(manifest?.build?.id) !== id || !Number.isSafeInteger(manifest?.build?.android_base) ||
        manifest.build.android_base <= 0 || !Array.isArray(manifest.files) || !manifest.addons || typeof manifest.addons !== 'object') {
      throw new Error(`invalid manifest metadata for update ${id}`);
    }
    return manifest;
  } catch (error: any) {
    if (error?.code === 'ENOENT') throw fail(404, 'update_not_found', `Update ${id} was not found`);
    if (error instanceof HttpError) throw error;
    throw error;
  }
}

function fileRecord(id: string, entry: any, addonId?: string) {
  if (!entry || typeof entry.name !== 'string' || entry.name.length === 0 || entry.name.startsWith('/') ||
      entry.name.split(/[\\/]/).some((part: string) => !part || part === '.' || part === '..') ||
      !Number.isSafeInteger(entry.size) || entry.size < 0 || !/^[a-f0-9]{64}$/.test(entry.sha256)) {
    throw new Error(`invalid file entry in update ${id}`);
  }
  const pathName = addonId ? `${addonId}/${entry.name}` : entry.name;
  const name = pathName.split(/[\\/]/).map(encodeURIComponent).join('/');
  return { name: entry.name, url: `/storage/${encodeURIComponent(id)}/${name}`, size: entry.size, sha256: entry.sha256 };
}

function json(res: any, status: number, value: unknown) {
  const data = Buffer.from(`${JSON.stringify(value)}\n`);
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Content-Length': data.length, 'Cache-Control': 'no-store' });
  res.end(data);
}

async function requestBody(req: any): Promise<unknown> {
  const type = String(req.headers['content-type'] ?? '').split(';', 1)[0].trim().toLowerCase();
  if (type !== 'application/json') throw fail(415, 'unsupported_media_type', 'Content-Type must be application/json');
  let chunks: Buffer[] = [], length = 0;
  for await (const chunk of req) {
    length += chunk.length;
    if (length > MAX_BODY) throw fail(413, 'body_too_large', 'Request body exceeds 64 KiB');
    chunks.push(chunk);
  }
  try { return JSON.parse(Buffer.concat(chunks).toString('utf8')); }
  catch { throw fail(400, 'malformed_json', 'Request body is not valid JSON'); }
}

function clientHash(req: any, salt: string) {
  const peer = String(req.socket?.remoteAddress ?? 'unknown');
  const loopback = peer === '127.0.0.1' || peer === '::1' || peer === '::ffff:127.0.0.1';
  const forwarded = req.headers?.['x-real-ip'];
  // X-Real-IP is trusted only from a loopback proxy with OTA_TRUST_PROXY=1; otherwise the socket peer counts.
  const address = TRUST_PROXY && loopback && typeof forwarded === 'string' && forwarded ? forwarded : peer;
  return createHash('sha256').update(salt).update('\0').update(address).digest('hex');
}

async function statsSecrets() {
  if (!STORAGE_DIR) throw new Error('OTA_STORAGE_DIR is not set');
  await fs.mkdir(STORAGE_DIR, { recursive: true });
  const path = resolve(STORAGE_DIR, FSTATS_SALT_FILE);
  try { return await fs.readFile(path, 'utf8'); }
  catch (error: any) {
    if (error?.code !== 'ENOENT') throw error;
    const salt = randomBytes(32).toString('hex');
    try { await fs.writeFile(path, salt, { flag: 'wx', mode: 0o600 }); return salt; }
    catch (writeError: any) { if (writeError?.code === 'EEXIST') return await fs.readFile(path, 'utf8'); throw writeError; }
  }
}

async function readStats() {
  try { const stored = JSON.parse(await fs.readFile(resolve(STORAGE_DIR!, FSTATS_FILE), 'utf8')); return { downloads: stored.downloads ?? {} }; }
  catch (error: any) { if (error?.code === 'ENOENT') return { downloads: {} }; throw error; }
}

async function writeStats(stats: any) {
  const path = resolve(STORAGE_DIR!, FSTATS_FILE), temp = `${path}.${process.pid}.tmp`;
  await fs.writeFile(temp, `${JSON.stringify(stats)}\n`, { mode: 0o600 });
  await fs.rename(temp, path);
}

function packageName(value: unknown) {
  if (typeof value !== 'string' || value.length > 255 || !PACKAGE_RE.test(value)) throw fail(400, 'invalid_package_name', 'packageName must be a valid Android package name');
  return value;
}

function rateStats(hash: string) {
  const now = Date.now(), old = statsRate.get(hash);
  if (statsRate.size > 10_000) for (const [key, value] of statsRate) { if (now - value.start >= 60_000) statsRate.delete(key); if (statsRate.size <= 10_000) break; }
  if (!old || now - old.start >= 60_000) { statsRate.set(hash, { start: now, count: 1 }); return; }
  if (old.count >= 60) throw fail(429, 'rate_limited', 'Too many stats requests');
  old.count++;
}

async function handleFdroidApi(req: any, res: any) {
  const pathname = new URL(req.url ?? '/', 'http://localhost').pathname;
  if (pathname === '/api/fdroid/stats' || pathname.startsWith('/api/fdroid/stats/')) {
    if (req.method !== 'GET') throw fail(405, 'method_not_allowed', 'Stats endpoint requires GET');
    let requested: string | null = null;
    if (pathname !== '/api/fdroid/stats') {
      try { requested = decodeURIComponent(pathname.slice('/api/fdroid/stats/'.length)); }
      catch { throw fail(400, 'invalid_package_name', 'packageName is not valid URL encoding'); }
    }
    if (requested !== null) packageName(requested);
    const stats = await readStats(), apps = new Set(Object.keys(stats.downloads));
    const output: any = {};
    for (const name of apps) {
      output[name] = { downloads: Object.keys(stats.downloads[name] ?? {}).length };
    }
    const result = requested === null ? output : (output[requested] ?? { downloads: 0 });
    const body = Buffer.from(`${JSON.stringify(result)}\n`), etag = `"${createHash('sha256').update(body).digest('hex')}"`;
    res.writeHead(req.headers['if-none-match'] === etag ? 304 : 200, { 'Content-Type': 'application/json; charset=utf-8', 'Content-Length': req.headers['if-none-match'] === etag ? 0 : body.length, ETag: etag, 'Cache-Control': 'public, max-age=3600' });
    return res.end(req.headers['if-none-match'] === etag ? undefined : body);
  }
  if (pathname !== '/api/fdroid/install') throw fail(404, 'not_found', 'F-Droid API endpoint not found');
  if (req.method !== 'POST') throw fail(405, 'method_not_allowed', 'F-Droid event endpoints require POST');
  const body = await requestBody(req), app = packageName((body as any)?.packageName);
  if (pathname.endsWith('/install') && (body as any)?.versionCode !== undefined && (!Number.isSafeInteger((body as any).versionCode) || (body as any).versionCode < 0)) throw fail(400, 'invalid_version_code', 'versionCode must be a nonnegative integer');
  const salt = await statsSecrets(), hash = clientHash(req, salt); rateStats(hash);
  const update = statsQueue.catch(() => {}).then(async () => {
    const stats = await readStats();
    if (pathname.endsWith('/install')) { stats.downloads[app] ??= {}; stats.downloads[app][hash] = true; }

    await writeStats(stats);
  });
  statsQueue = update;
  await update;
  return json(res, 200, { ok: true });
}

function appKey(value: unknown): string {
  if (typeof value !== 'string' || value.length > 255 || !APP_KEY_RE.test(value)) throw fail(400, 'invalid_app', 'app must be a 1–255 character app key');
  return value;
}

async function readRatings() {
  try { return JSON.parse(await fs.readFile(resolve(STORAGE_DIR!, RATINGS_FILE), 'utf8')); }
  catch (error: any) { if (error?.code === 'ENOENT') return {}; throw error; }
}

async function writeRatings(ratings: any) {
  const path = resolve(STORAGE_DIR!, RATINGS_FILE), temp = `${path}.${process.pid}.tmp`;
  await fs.writeFile(temp, `${JSON.stringify(ratings)}\n`, { mode: 0o600 });
  await fs.rename(temp, path);
}

function ratingSummary(values: number[]) {
  const histogram = [1, 2, 3, 4, 5].map((stars) => values.filter((value) => value === stars).length);
  return { count: values.length, avg: values.length ? values.reduce((sum, value) => sum + value, 0) / values.length : 0, histogram };
}

async function handleRatingsApi(req: any, res: any) {
  const url = new URL(req.url ?? '/', 'http://localhost');
  const pathname = url.pathname;
  if (pathname === '/api/ratings' && req.method === 'GET') {
    const query = url.searchParams.get('apps');
    if (query === null) throw fail(400, 'missing_apps', 'apps query parameter is required');
    const keys = query === '' ? [] : query.split(',').map(appKey);
    if (keys.length > 100) throw fail(400, 'too_many_apps', 'At most 100 app keys may be requested');
    const ratings = await readRatings(), result: Record<string, ReturnType<typeof ratingSummary>> = {};
    for (const key of keys) result[key] = ratingSummary(Object.values(ratings[key] ?? {}) as number[]);
    return json(res, 200, result);
  }
  if (pathname.startsWith('/api/ratings/')) {
    let key: string;
    try { key = appKey(decodeURIComponent(pathname.slice('/api/ratings/'.length))); }
    catch (error) { if (error instanceof URIError) throw fail(400, 'invalid_app', 'app key is not valid URL encoding'); throw error; }
    if (req.method !== 'GET') throw fail(405, 'method_not_allowed', 'Rating lookup requires GET');
    const ratings = await readRatings();
    return json(res, 200, ratingSummary(Object.values(ratings[key] ?? {}) as number[]));
  }
  if (pathname !== '/api/ratings' || req.method !== 'POST') throw fail(404, 'not_found', 'Ratings API endpoint not found');
  const body = await requestBody(req), key = appKey((body as any)?.app), stars = (body as any)?.stars;
  if (!Number.isInteger(stars) || stars < 1 || stars > 5) throw fail(400, 'invalid_stars', 'stars must be an integer from 1 to 5');
  const hash = clientHash(req, await statsSecrets()); rateStats(hash);
  const update = statsQueue.catch(() => {}).then(async () => {
    const ratings = await readRatings();
    ratings[key] ??= {}; ratings[key][hash] = stars;
    await writeRatings(ratings);
  });
  statsQueue = update;
  await update;
  return json(res, 200, { ok: true });
}

async function handleApi(req: any, res: any) {
  const path = new URL(req.url ?? '/', 'http://localhost').pathname;
  if (!['/api/channels', '/api/update', '/api/eol', '/api/license'].includes(path)) throw fail(404, 'not_found', 'API endpoint not found');
  if (req.method !== 'POST') throw fail(405, 'method_not_allowed', 'API endpoints require POST');
  const body = validateBody(await requestBody(req));
  const config = await readConfig();
  if (path === '/api/license') return json(res, 200, { status: 'none', license: null });
  if (path === '/api/channels') {
    const channels = [];
    for (const [name, entry] of Object.entries(config.channels)) {
      if (entry.requires_license) continue;
      const manifest = await readManifest(idString(entry.update_id));
      const missing = body.addon_list.filter((addonId: string) => !Array.isArray(manifest.addons[addonId]));
      if (manifest.build.android_base >= body.base_android && missing.length === 0) channels.push({ channel: name, update_id: entry.update_id, version: manifest.build.version, android_base: manifest.build.android_base });
    }
    return json(res, 200, { channels });
  }
  if (path === '/api/eol') {
    return json(res, 200, { eol: false });
  }
  const selected = config.channels[body.channel];
  if (!selected) throw fail(404, 'channel_not_found', `Channel ${body.channel} was not found`);
  if (selected.requires_license) throw fail(403, 'license_required', 'This channel requires a license');
  const updateId = idString(selected.update_id);
  const manifest = await readManifest(updateId);
  if (manifest.build.android_base < body.base_android) {
    return json(res, 200, { available: false, reason: 'android_base_too_old' });
  }
  const missing = [...new Set(body.addon_list)].filter((addonId) => !Array.isArray(manifest.addons[addonId]));
  if (missing.length > 0) return json(res, 200, { available: false, reason: 'missing_addons', missing_addons: missing });
  if (updateId === idString(body.update_id)) return json(res, 200, { available: false });
  const addons: Record<string, unknown[]> = {};
  for (const addonId of [...new Set(body.addon_list)]) {
    const entries = manifest.addons[addonId];
    addons[addonId] = entries.map((entry: any) => fileRecord(updateId, entry, addonId));
  }
  const files = manifest.files.map((entry: any) => fileRecord(updateId, entry));
  return json(res, 200, {
    available: true,
    update_id: selected.update_id,
    version: manifest.build.version,
    android_base: manifest.build.android_base,
    manifest_url: `/storage/${encodeURIComponent(updateId)}/manifest.json`,
    signature_url: `/storage/${encodeURIComponent(updateId)}/manifest.sig`,
    files,
    addons
  });
}

function contentType(path: string) {
  return extname(path) === '.json' ? 'application/json; charset=utf-8' : 'application/octet-stream';
}

function pathParts(req: any, prefix: string) {
  if (req.method !== 'GET' && req.method !== 'HEAD') throw fail(405, 'method_not_allowed', 'File endpoints require GET or HEAD');
  const raw = new URL(req.url ?? '/', 'http://localhost').pathname.slice(prefix.length);
  let decoded: string;
  try { decoded = decodeURIComponent(raw); } catch { throw fail(400, 'invalid_path', 'Malformed file path'); }
  const parts = decoded.split('/');
  if (parts.some((part) => !part || part === '.' || part === '..' || part.includes('\\'))) throw fail(404, 'not_found', 'File not found');
  return parts;
}

async function handleStorage(req: any, res: any) {
  if (!STORAGE_DIR) throw new Error('OTA_STORAGE_DIR is not set');
  const parts = pathParts(req, '/storage/');
  if (parts.length < 2 || !UPDATE_ID_RE.test(parts[0])) throw fail(404, 'not_found', 'File not found');
  return serveFile(req, res, STORAGE_DIR, parts, IMMUTABLE);
}

async function handleFdroid(req: any, res: any) {
  if (!FDROID_DIR) throw fail(404, 'not_found', 'No F-Droid repository is configured');
  const parts = pathParts(req, '/fdroid/');
  const inRepo = parts[0] === 'repo' ? parts.slice(1).join('/') : '';
  return serveFile(req, res, FDROID_DIR, parts, FDROID_INDEX_RE.test(inRepo) ? FDROID_INDEX_CACHE : IMMUTABLE);
}

async function handleDownload(req: any, res: any) {
  if (!DOWNLOAD_DIR) throw fail(404, 'not_found', 'No download directory is configured');
  const parts = pathParts(req, '/download/');
  if (parts.length !== 1) throw fail(404, 'not_found', 'File not found');
  return serveFile(req, res, DOWNLOAD_DIR, parts, IMMUTABLE);
}

async function serveFile(req: any, res: any, rootDir: string, parts: string[], cacheControl: string) {
  const path = resolve(rootDir, ...parts);
  const root = await fs.realpath(rootDir);
  let canonical: string, stat;
  try {
    canonical = await fs.realpath(path);
    stat = await fs.stat(canonical);
  }
  catch (error: any) { if (error?.code === 'ENOENT') throw fail(404, 'not_found', 'File not found'); throw error; }
  if (!canonical.startsWith(root + sep)) throw fail(404, 'not_found', 'File not found');
  if (!stat.isFile()) throw fail(404, 'not_found', 'File not found');
  let start = 0, end = stat.size - 1, status = 200;
  const range = req.headers.range;
  if (range !== undefined) {
    const match = /^bytes=(\d*)-(\d*)$/.exec(String(range));
    if (!match || (!match[1] && !match[2]) || stat.size === 0) {
      res.writeHead(416, { 'Content-Range': `bytes */${stat.size}`, 'Cache-Control': cacheControl }); return res.end();
    }
    if (!match[1]) { const suffix = Number(match[2]); start = Math.max(0, stat.size - suffix); }
    else start = Number(match[1]);
    if (match[2] && match[1]) end = Math.min(Number(match[2]), stat.size - 1);
    if (start >= stat.size || end < start) {
      res.writeHead(416, { 'Content-Range': `bytes */${stat.size}`, 'Cache-Control': cacheControl }); return res.end();
    }
    status = 206;
  }
  const headers: Record<string, string | number> = {
    'Content-Type': contentType(path), 'Accept-Ranges': 'bytes', 'Content-Length': end - start + 1,
    'Cache-Control': cacheControl
  };
  // Cloudflare's edge honours CDN-Cache-Control; without it a zone Browser Cache TTL can stretch short index caches.
  if (cacheControl === FDROID_INDEX_CACHE) headers['CDN-Cache-Control'] = 'max-age=60';
  if (status === 206) headers['Content-Range'] = `bytes ${start}-${end}/${stat.size}`;
  res.writeHead(status, headers);
  if (req.method === 'HEAD' || stat.size === 0) return res.end();
  const stream = createReadStream(canonical, { start, end });
  stream.on('error', (error) => {
    log('error', 'storage_stream_failed', { path: basename(path), error: String(error) });
    if (!res.headersSent) res.writeHead(500, { 'Cache-Control': 'no-store' });
    res.destroy(error);
  });
  stream.pipe(res);
}

export function createOtaServer() {
  return createServer(async (req, res) => {
    try {
      const path = new URL(req.url ?? '/', 'http://localhost').pathname;
      if (path.startsWith('/api/fdroid/')) await handleFdroidApi(req, res);
      else if (path === '/api/ratings' || path.startsWith('/api/ratings/')) await handleRatingsApi(req, res);
      else if (path.startsWith('/api/')) await handleApi(req, res);
      else if (path.startsWith('/storage/')) await handleStorage(req, res);
      else if (path.startsWith('/fdroid/')) await handleFdroid(req, res);
      else if (path.startsWith('/download/')) await handleDownload(req, res);
      else throw fail(404, 'not_found', 'Not found');
    } catch (error: any) {
      if (error instanceof HttpError) {
        log('warn', 'request_rejected', { method: req.method, path: new URL(req.url ?? '/', 'http://localhost').pathname, status: error.status, code: error.code });
        if (!res.headersSent) json(res, error.status, { error: error.code, message: error.message });
        else res.destroy();
      } else {
        log('error', 'request_failed', { method: req.method, path: new URL(req.url ?? '/', 'http://localhost').pathname, error: String(error) });
        if (!res.headersSent) json(res, 500, { error: 'internal_error', message: 'Request failed' });
        else res.destroy();
      }
    }
  });
}

const invoked = process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (invoked) {
  if (!Number.isInteger(PORT) || PORT < 1 || PORT > 65535) throw new Error('OTA_PORT must be a valid TCP port');
  if (!STORAGE_DIR || !CONFIG_PATH) throw new Error('OTA_STORAGE_DIR and OTA_CONFIG are required');
  createOtaServer().listen(PORT, HOST, () => log('info', 'server_listening', { host: HOST, port: PORT }));
}
