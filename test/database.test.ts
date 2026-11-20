// SPDX-License-Identifier: GPL-2.0-only
import { it } from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { applyMigrations, migrations } from '../src/database.ts';

it('creates a fresh schema and adds refresh state to existing device rows', () => {
  const db = new DatabaseSync(':memory:');
  applyMigrations(db, migrations.slice(0, 1));
  const now = Date.now();
  db.prepare('INSERT INTO accounts(id,username,email,password_hash,created) VALUES(?,?,?,?,?)').run('account', 'user', 'user@example.org', 'hash', now);
  db.prepare('INSERT INTO devices(jti,account_id,mid,name,created,last_seen) VALUES(?,?,?,?,?,?)').run('device-jti', 'account', 'mid', 'PC', now - 1000, now);
  applyMigrations(db);
  assert.equal(Number(db.prepare('PRAGMA user_version').get()?.user_version), migrations.length);
  assert.ok(db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='accounts'").get());
  const device = db.prepare('SELECT refresh_hash,prev_refresh_hash,refresh_expires,last_refreshed FROM devices WHERE jti=?').get('device-jti') as any;
  assert.deepEqual({...device}, {refresh_hash:null, prev_refresh_hash:null, refresh_expires:null, last_refreshed:now});
  db.close();
});

it('rolls back schema and version when a migration step fails', () => {
  const db = new DatabaseSync(':memory:');
  assert.throws(() => applyMigrations(db, ['CREATE TABLE first_step(id INTEGER);', 'THIS IS NOT SQL;']));
  assert.equal(Number(db.prepare('PRAGMA user_version').get()?.user_version), 0);
  assert.equal(db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='first_step'").get(), undefined);
  db.close();
});
