import { it } from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { applyMigrations, migrations } from '../src/database.ts';

it('creates the fresh schema at step 1 and upgrades a pre-step-1 database', () => {
  for (const startAt of [0]) {
    const db = new DatabaseSync(':memory:');
    db.exec(`PRAGMA user_version=${startAt}`);
    applyMigrations(db);
    assert.equal(Number(db.prepare('PRAGMA user_version').get()?.user_version), migrations.length);
    assert.ok(db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='accounts'").get());
    db.close();
  }
});

it('rolls back schema and version when a migration step fails', () => {
  const db = new DatabaseSync(':memory:');
  assert.throws(() => applyMigrations(db, ['CREATE TABLE first_step(id INTEGER);', 'THIS IS NOT SQL;']));
  assert.equal(Number(db.prepare('PRAGMA user_version').get()?.user_version), 0);
  assert.equal(db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='first_step'").get(), undefined);
  db.close();
});
