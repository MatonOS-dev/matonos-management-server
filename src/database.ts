import { DatabaseSync } from 'node:sqlite';
import { mkdir, chmod, readFile } from 'node:fs/promises';
import { resolve } from 'node:path';

export const migrations = [
  `CREATE TABLE accounts (id TEXT PRIMARY KEY, username TEXT NOT NULL, email TEXT NOT NULL, password_hash TEXT NOT NULL, verified INTEGER NOT NULL DEFAULT 0, created INTEGER NOT NULL);
   CREATE UNIQUE INDEX accounts_username_nocase ON accounts(username COLLATE NOCASE);
   CREATE UNIQUE INDEX accounts_email_nocase ON accounts(email COLLATE NOCASE);
   CREATE TABLE devices (jti TEXT PRIMARY KEY, account_id TEXT NOT NULL REFERENCES accounts(id) ON DELETE CASCADE, mid TEXT NOT NULL, name TEXT NOT NULL, created INTEGER NOT NULL, last_seen INTEGER NOT NULL);
   CREATE INDEX devices_account ON devices(account_id);
   CREATE TABLE reset_tokens (token_hash TEXT PRIMARY KEY, account_id TEXT NOT NULL REFERENCES accounts(id) ON DELETE CASCADE, kind TEXT NOT NULL, expires INTEGER NOT NULL, created INTEGER NOT NULL);
   CREATE TABLE login_limits (key TEXT PRIMARY KEY, failures INTEGER NOT NULL, blocked_until INTEGER NOT NULL);
   CREATE TABLE reviews (app TEXT NOT NULL, account_id TEXT NOT NULL REFERENCES accounts(id) ON DELETE CASCADE, stars INTEGER NOT NULL CHECK(stars BETWEEN 1 AND 5), title TEXT NOT NULL, body TEXT NOT NULL, created INTEGER NOT NULL, updated INTEGER NOT NULL, PRIMARY KEY(app, account_id));
   CREATE INDEX reviews_newest ON reviews(app, updated DESC);
   CREATE TABLE ratings (app TEXT NOT NULL, identity TEXT NOT NULL, stars INTEGER NOT NULL CHECK(stars BETWEEN 1 AND 5), PRIMARY KEY(app, identity));
   CREATE TABLE downloads (package TEXT NOT NULL, identity TEXT NOT NULL, PRIMARY KEY(package, identity));`
];

export function applyMigrations(connection:DatabaseSync, steps:string[] = migrations) {
  const version = Number(connection.prepare('PRAGMA user_version').get()?.user_version ?? 0);
  if (version > steps.length) throw new Error(`database schema ${version} is newer than this server`);
  if (version === steps.length) return;
  connection.exec('BEGIN IMMEDIATE');
  try {
    for (let i = version; i < steps.length; i++) {
      connection.exec(steps[i]);
      connection.exec(`PRAGMA user_version=${i + 1}`);
    }
    connection.exec('COMMIT');
  } catch (error) {
    connection.exec('ROLLBACK');
    throw error;
  }
}

let db: DatabaseSync | undefined;
export async function database() {
  if (db) return db;
  const dir = process.env.OTA_STORAGE_DIR;
  if (!dir) throw new Error('OTA_STORAGE_DIR is not set');
  process.umask(0o077);
  await mkdir(dir, { recursive: true, mode: 0o700 });
  const path = resolve(dir, 'maton.db');
  db = new DatabaseSync(path);
  await chmod(path, 0o600);
  db.exec('PRAGMA journal_mode=WAL; PRAGMA foreign_keys=ON; PRAGMA busy_timeout=5000;');
  try { applyMigrations(db); }
  catch (error) { db.close(); db = undefined; throw error; }
  for (const suffix of ['-wal', '-shm']) {
    try { await chmod(`${path}${suffix}`, 0o600); } catch {}
  }
  return db;
}

export async function jwtSecret() {
  const dir = process.env.OTA_STORAGE_DIR;
  if (!dir) throw new Error('OTA_STORAGE_DIR is not set');
  const path = resolve(dir, 'jwt.secret');
  try {
    await chmod(path, 0o600);
    const value = await readFile(path);
    if (value.length !== 32) throw new Error('jwt.secret must contain exactly 32 bytes');
    return value;
  }
  catch (error: any) {
    if (error?.code !== 'ENOENT') throw error;
    const { randomBytes } = await import('node:crypto');
    const secret = randomBytes(32);
    try { const { writeFile } = await import('node:fs/promises'); await writeFile(path, secret, { flag: 'wx', mode: 0o600 }); return secret; }
    catch (writeError: any) {
      if (writeError?.code !== 'EEXIST') throw writeError;
      await chmod(path, 0o600);
      const value = await readFile(path);
      if (value.length !== 32) throw new Error('jwt.secret must contain exactly 32 bytes');
      return value;
    }
  }
}
