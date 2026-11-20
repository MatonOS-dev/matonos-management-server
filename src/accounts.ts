import { createHash, randomUUID, randomBytes, scrypt as scryptCb, timingSafeEqual } from 'node:crypto';
import { promisify } from 'node:util';
import { SignJWT, jwtVerify } from 'jose';
import { database, jwtSecret } from './database.ts';
import { textRejected, spamText } from './abuse.ts';

const scrypt = promisify(scryptCb);
const SCRYPT = { N:16384, r:8, p:1, maxmem:64 * 1024 * 1024 };
const SESSION_MS = 30 * 86400_000;
const USERNAME = /^[A-Za-z0-9_.-]{3,32}$/;
const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const hash = (v: string) => createHash('sha256').update(v).digest('hex');
const cookie = (token: string, maxAge = 30 * 86400) => `maton_session=${token}; Path=/api; HttpOnly; Secure; SameSite=Strict; Max-Age=${maxAge}`;

function fail(status: number, code: string, message: string): never { throw Object.assign(new Error(message), { status, code }); }
function bodyObject(v: any) { if (!v || typeof v !== 'object' || Array.isArray(v)) fail(400, 'invalid_body', 'Expected a JSON object'); return v; }
function decoded(value:string) { try { return decodeURIComponent(value); } catch { fail(400, 'invalid_path', 'Path component is not valid URL encoding'); } }
async function send(req: any, res: any, status: number, data: unknown, token?: string | null) {
  const payload = Buffer.from(`${JSON.stringify(data)}\n`);
  const headers: Record<string, string | number> = { 'Content-Type':'application/json; charset=utf-8', 'Content-Length':payload.length, 'Cache-Control':'no-store' };
  if (token !== undefined) headers['Set-Cookie'] = token ? cookie(token) : cookie('', 0);
  res.writeHead(status, headers); res.end(payload);
}
async function readBody(req: any) {
  let chunks: Buffer[] = [], size = 0;
  for await (const chunk of req) { size += chunk.length; if (size > 64 * 1024) fail(413, 'body_too_large', 'Request body exceeds 64 KiB'); chunks.push(chunk); }
  try { return bodyObject(JSON.parse(Buffer.concat(chunks).toString('utf8'))); } catch (e: any) { if (e?.status) throw e; fail(400, 'malformed_json', 'Request body is not valid JSON'); }
}
function machineId(req: any) { const id = req.headers['x-maton-machine-id']; if (typeof id !== 'string' || id.length < 1 || id.length > 512) fail(401, 'unauthorized', 'Authentication required'); return id; }
function deviceName(body: any) { return String(body.device_name ?? 'This device').slice(0, 120); }
async function createSession(accountId: string, req: any, name: string) {
  const db = await database(), jti = randomUUID(), mid = hash(`${machineId(req)}${jti}`), now = Date.now();
  db.prepare('INSERT INTO devices(jti,account_id,mid,name,created,last_seen) VALUES(?,?,?,?,?,?)').run(jti, accountId, mid, name, now, now);
  const secret = await jwtSecret();
  const token = await new SignJWT({ mid }).setProtectedHeader({ alg:'HS256' }).setSubject(accountId).setJti(jti).setIssuedAt().setExpirationTime('30d').sign(new Uint8Array(secret));
  return token;
}
async function mailToken(email: string, kind: string, accountId: string) {
  const token = randomBytes(32).toString('base64url'), now = Date.now();
  const db = await database();
  db.prepare('INSERT INTO reset_tokens(token_hash,account_id,kind,expires,created) VALUES(?,?,?,?,?)').run(hash(token), accountId, kind, now + 3600_000, now);
  if (!process.env.OTA_SMTP_URL || !process.env.OTA_MAIL_FROM) return;
  const nodemailer = (await import('nodemailer')).default;
  const transport = nodemailer.createTransport(process.env.OTA_SMTP_URL);
  await transport.sendMail({ from:process.env.OTA_MAIL_FROM, to:email, subject:kind === 'verify' ? 'Verify your MatonOS account' : 'Reset your MatonOS password', text:`Use this one-time token within one hour: ${token}` });
}
async function passwordRecord(password:string, salt:string) {
  const derived = await scrypt(password, salt, 64, SCRYPT) as Buffer;
  return `scrypt$${SCRYPT.N}$${SCRYPT.r}$${SCRYPT.p}$${derived.toString('hex')}`;
}
async function passwordMatches(password:string, salt:string, record:string) {
  const [scheme, n, r, p, hex] = record.split('$');
  if (scheme !== 'scrypt' || !/^\d+$/.test(n) || !/^\d+$/.test(r) || !/^\d+$/.test(p) || !/^[a-f0-9]{128}$/i.test(hex)) return false;
  const expected = Buffer.from(hex, 'hex');
  const actual = await scrypt(password, salt, expected.length, { N:Number(n), r:Number(r), p:Number(p), maxmem:64 * 1024 * 1024 }) as Buffer;
  return timingSafeEqual(expected, actual);
}
async function account(req: any) {
  const raw = String(req.headers.cookie ?? '').split(';').map((v: string) => v.trim()).find((v: string) => v.startsWith('maton_session='))?.slice('maton_session='.length);
  if (!raw) fail(401, 'unauthorized', 'Authentication required');
  let claims: any;
  try { claims = (await jwtVerify(raw, new Uint8Array(await jwtSecret()), { algorithms:['HS256'] })).payload; } catch { fail(401, 'unauthorized', 'Session expired or invalid'); }
  const mid = hash(`${machineId(req)}${claims.jti}`), db = await database();
  const device = db.prepare('SELECT d.*, a.id, a.username, a.email, a.verified FROM devices d JOIN accounts a ON a.id=d.account_id WHERE d.jti=? AND d.account_id=?').get(claims.jti, claims.sub) as any;
  if (!device || device.mid !== mid || claims.mid !== mid) fail(401, 'unauthorized', 'Session expired or invalid');
  if (Date.now() - device.last_seen > 3600_000) db.prepare('UPDATE devices SET last_seen=? WHERE jti=?').run(Date.now(), claims.jti);
  return { ...device, token: raw };
}
async function rateLogin(req: any, username: string, success: boolean) {
  const db = await database(), salt = await (async () => (await import('./server.ts')).statsSecrets())();
  const ip = (await (async () => (await import('./server.ts')).clientHash(req, salt))());
  for (const key of [`ip:${ip}`, `user:${username.toLowerCase()}`]) {
    const row = db.prepare('SELECT failures,blocked_until FROM login_limits WHERE key=?').get(key) as any;
    if (row && row.blocked_until > Date.now()) fail(429, 'rate_limited', 'Too many login attempts');
    if (success) db.prepare('DELETE FROM login_limits WHERE key=?').run(key);
    else {
      const n = (row?.failures ?? 0) + 1, delay = n < 5 ? 0 : Math.min(3600_000, 1000 * 2 ** Math.min(12, n - 5));
      db.prepare('INSERT INTO login_limits(key,failures,blocked_until) VALUES(?,?,?) ON CONFLICT(key) DO UPDATE SET failures=excluded.failures, blocked_until=excluded.blocked_until').run(key, n, Date.now() + delay);
    }
  }
}

export async function handleAccountReviewApi(req: any, res: any, path: string, url: URL) {
  const db = await database();
  if (path.startsWith('/api/account')) {
    if (path === '/api/account/register' && req.method === 'POST') {
      const b = await readBody(req);
      if (typeof b.username !== 'string' || typeof b.email !== 'string' || typeof b.password !== 'string') fail(400, 'invalid_account', 'Username, e-mail and password are required');
      const username = b.username, email = b.email.trim(), password = b.password;
      if (!USERNAME.test(username) || await textRejected(username)) fail(400, 'invalid_username', 'Username must be 3–32 allowed characters');
      if (!EMAIL.test(email) || email.length > 254) fail(400, 'invalid_email', 'E-mail address is invalid');
      if (password.length < 10 || password.length > 1024) fail(400, 'invalid_password', 'Password must be at least 10 characters');
      const id = randomUUID(), record = await passwordRecord(password, id);
      try { db.prepare('INSERT INTO accounts(id,username,email,password_hash,created) VALUES(?,?,?,?,?)').run(id, username, email, record, Date.now()); }
      catch { fail(409, 'account_exists', 'Username or e-mail is already registered'); }
      if (process.env.OTA_SMTP_URL && process.env.OTA_MAIL_FROM) await mailToken(email, 'verify', id);
      const token = await createSession(id, req, deviceName(b));
      return send(req, res, 201, { username, verified:false, token }, token);
    }
    if (path === '/api/account/login' && req.method === 'POST') {
      const b = await readBody(req), username = typeof b.username === 'string' ? b.username : '', password = typeof b.password === 'string' ? b.password : '', row = db.prepare('SELECT * FROM accounts WHERE username=? COLLATE NOCASE').get(username) as any;
      let ok = false;
      if (row && password.length <= 1024) ok = await passwordMatches(password, row.id, row.password_hash);
      await rateLogin(req, username, ok);
      if (!ok) fail(401, 'invalid_credentials', 'Wrong username or password');
      const token = await createSession(row.id, req, deviceName(b));
      return send(req, res, 200, { username:row.username, verified:Boolean(row.verified), token }, token);
    }
    if (path === '/api/account/logout' && req.method === 'POST') {
      const me = await account(req); db.prepare('DELETE FROM devices WHERE jti=?').run(me.jti);
      return send(req, res, 200, { ok:true }, null);
    }
    if (path === '/api/account' && req.method === 'GET') {
      const me = await account(req); return send(req, res, 200, { username:me.username, email:me.email, verified:Boolean(me.verified) });
    }
    if (path === '/api/account' && req.method === 'DELETE') {
      const me = await account(req), b = await readBody(req), stored = db.prepare('SELECT password_hash FROM accounts WHERE id=?').get(me.id)?.password_hash as string;
      if (!await passwordMatches(String(b.password ?? ''), me.id, stored)) fail(401, 'invalid_credentials', 'Wrong username or password');
      db.exec('BEGIN IMMEDIATE'); try { db.prepare('DELETE FROM accounts WHERE id=?').run(me.id); db.exec('COMMIT'); } catch (e) { db.exec('ROLLBACK'); throw e; }
      return send(req, res, 200, { ok:true }, null);
    }
    if (path === '/api/account/devices' && req.method === 'GET') {
      const me = await account(req), rows = db.prepare('SELECT jti AS id,name,created,last_seen FROM devices WHERE account_id=? ORDER BY created DESC').all(me.id);
      return send(req, res, 200, rows.map((v: any) => ({ ...v, current:v.id === me.jti })));
    }
    const deviceMatch = /^\/api\/account\/devices\/([^/]+)$/.exec(path);
    if (deviceMatch && req.method === 'DELETE') { const me = await account(req); db.prepare('DELETE FROM devices WHERE account_id=? AND jti=?').run(me.id, decoded(deviceMatch[1])); return send(req, res, 200, { ok:true }); }
    if (path === '/api/account/verify' && req.method === 'POST') {
      const b = await readBody(req), token = String(b.token ?? ''), row = db.prepare("SELECT account_id FROM reset_tokens WHERE token_hash=? AND kind='verify' AND expires>?").get(hash(token), Date.now()) as any;
      if (!row) fail(400, 'invalid_token', 'Verification token is invalid or expired');
      db.prepare('UPDATE accounts SET verified=1 WHERE id=?').run(row.account_id); db.prepare('DELETE FROM reset_tokens WHERE token_hash=?').run(hash(token)); return send(req, res, 200, { ok:true });
    }
    if (path === '/api/account/reset' && req.method === 'POST') {
      if (!process.env.OTA_SMTP_URL || !process.env.OTA_MAIL_FROM) fail(503, 'mail_not_configured', 'mail not configured');
      const b = await readBody(req), email = String(b.email ?? ''), row = db.prepare('SELECT id,email FROM accounts WHERE email=? COLLATE NOCASE').get(email) as any;
      if (row) await mailToken(row.email, 'reset', row.id);
      return send(req, res, 200, { ok:true });
    }
    if (path === '/api/account/reset/confirm' && req.method === 'POST') {
      const b = await readBody(req), token = String(b.token ?? ''), password = String(b.password ?? '');
      if (password.length < 10 || password.length > 1024) fail(400, 'invalid_password', 'Password must be at least 10 characters');
      const row = db.prepare("SELECT account_id FROM reset_tokens WHERE token_hash=? AND kind='reset' AND expires>?").get(hash(token), Date.now()) as any;
      if (!row) fail(400, 'invalid_token', 'Reset token is invalid or expired');
      const record = await passwordRecord(password, row.account_id);
      db.exec('BEGIN IMMEDIATE'); try { db.prepare('UPDATE accounts SET password_hash=? WHERE id=?').run(record, row.account_id); db.prepare('DELETE FROM devices WHERE account_id=?').run(row.account_id); db.prepare('DELETE FROM reset_tokens WHERE token_hash=?').run(hash(token)); db.exec('COMMIT'); } catch (e) { db.exec('ROLLBACK'); throw e; }
      return send(req, res, 200, { ok:true });
    }
    fail(404, 'not_found', 'Account endpoint not found');
  }
  if (path === '/api/reviews/ratings' && req.method === 'GET') {
    const apps = url.searchParams.get('apps'); if (apps === null) fail(400, 'missing_apps', 'apps query parameter is required');
    const keys = apps ? apps.split(',') : []; if (keys.length > 100) fail(400, 'too_many_apps', 'At most 100 apps may be requested');
    const output: any = {};
    for (const app of keys) { if (!/^[A-Za-z0-9][A-Za-z0-9._+-]{0,254}$/.test(app)) fail(400, 'invalid_app', 'Invalid app key'); output[app] = summary(db, app); }
    return send(req, res, 200, output);
  }
  if (path === '/api/reviews/ratings' && req.method === 'POST') {
    const b = await readBody(req), app = String(b.app ?? ''), stars = b.stars;
    if (!/^[A-Za-z0-9][A-Za-z0-9._+-]{0,254}$/.test(app)) fail(400, 'invalid_app', 'Invalid app key');
    if (!Number.isInteger(stars) || stars < 1 || stars > 5) fail(400, 'invalid_stars', 'stars must be an integer from 1 to 5');
    const { clientHash, statsSecrets } = await import('./server.ts');
    const identity = clientHash(req, await statsSecrets());
    db.prepare('INSERT INTO ratings(app,identity,stars) VALUES(?,?,?) ON CONFLICT(app,identity) DO UPDATE SET stars=excluded.stars').run(app, identity, stars);
    return send(req, res, 200, { ok:true });
  }
  if (path.startsWith('/api/reviews/ratings/')) {
    const app = decoded(path.slice('/api/reviews/ratings/'.length)); if (req.method !== 'GET') fail(405, 'method_not_allowed', 'Rating lookup requires GET');
    if (!/^[A-Za-z0-9][A-Za-z0-9._+-]{0,254}$/.test(app)) fail(400, 'invalid_app', 'Invalid app key');
    return send(req, res, 200, summary(db, app));
  }
  const match = /^\/api\/reviews\/apps\/([^/]+)$/.exec(path);
  if (match) {
    const app = decoded(match[1]); if (!/^[A-Za-z0-9][A-Za-z0-9._+-]{0,254}$/.test(app)) fail(400, 'invalid_app', 'Invalid app key');
    if (req.method === 'GET') {
      if (url.searchParams.get('mine') === '1') {
        const me = await account(req), own = db.prepare('SELECT stars,title,body FROM reviews WHERE app=? AND account_id=?').get(app, me.id) ?? null;
        return send(req, res, 200, { review:own });
      }
      const offset = Math.max(0, Number(url.searchParams.get('offset') ?? 0) || 0), limit = Math.min(100, Math.max(1, Number(url.searchParams.get('limit') ?? 20) || 20));
      const rows = db.prepare('SELECT a.username AS display_name,r.stars,r.title,r.body,r.updated AS date FROM reviews r JOIN accounts a ON a.id=r.account_id WHERE r.app=? ORDER BY r.updated DESC LIMIT ? OFFSET ?').all(app, limit, offset);
      return send(req, res, 200, rows);
    }
    const me = await account(req);
    if (req.method === 'DELETE') { db.prepare('DELETE FROM reviews WHERE app=? AND account_id=?').run(app, me.id); return send(req, res, 200, { ok:true }); }
    if (req.method === 'POST') {
      const b = await readBody(req), stars = b.stars;
      if (typeof b.title !== 'string' || typeof b.body !== 'string') fail(400, 'invalid_review', 'Review title and body must be text');
      const title = b.title, body = b.body;
      if (!Number.isInteger(stars) || stars < 1 || stars > 5) fail(400, 'invalid_stars', 'stars must be an integer from 1 to 5');
      if (title.length > 80 || body.length > 2000 || (!title.trim() && !body.trim())) fail(400, 'invalid_review', 'Review title or body is invalid');
      if (spamText(title) || spamText(body)) fail(422, 'text_rejected', 'Review text is not allowed');
      if (await textRejected(`${title}\n${body}`)) fail(422, 'text_rejected', 'Review text is not allowed');
      const now = Date.now(); db.prepare('INSERT INTO reviews(app,account_id,stars,title,body,created,updated) VALUES(?,?,?,?,?,?,?) ON CONFLICT(app,account_id) DO UPDATE SET stars=excluded.stars,title=excluded.title,body=excluded.body,updated=excluded.updated').run(app, me.id, stars, title.trim(), body.trim(), now, now);
      return send(req, res, 200, { ok:true });
    }
    fail(405, 'method_not_allowed', 'Review endpoint requires GET, POST or DELETE');
  }
  return false;
}

function summary(db: any, app: string) {
  const anonymous = db.prepare('SELECT stars FROM ratings WHERE app=?').all(app) as any[], reviews = db.prepare('SELECT stars FROM reviews WHERE app=?').all(app) as any[];
  const values = [...anonymous, ...reviews].map((v) => Number(v.stars)), histogram = [1,2,3,4,5].map((star) => values.filter((n) => n === star).length);
  return { count:values.length, avg:values.length ? values.reduce((a,n) => a+n,0)/values.length : 0, histogram };
}
