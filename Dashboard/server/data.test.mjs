import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdir, mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';

import { readQueue, readWorkStore } from './data.mjs';
import { openWorkStore } from '../../.opencode/plugin/lib/work-store/sqlite.ts';
import { emptyScheduler } from '../../.opencode/plugin/lib/work-queue.ts';

async function seededDir() {
  const dir = await mkdtemp(join(tmpdir(), 'dashboard-store-'));
  const stateDir = join(dir, '.opencode', 'state');
  await mkdir(stateDir, { recursive: true });
  const now = Date.now();
  const store = await openWorkStore({ stateDir, now: () => now });
  store.leaseAcquire('owner-test', now);
  store.enqueue(
    [
      {
        id: 'mission:a',
        kind: 'mission',
        producer: 'chron:missions',
        enqueued_ms: now,
        requeue_count: 0,
      },
      {
        id: 'drain-pass',
        kind: 'drain-pass',
        producer: 'chron:drain',
        enqueued_ms: now,
        requeue_count: 0,
      },
    ],
    now,
  );
  assert.ok(store.claim('mission:a', emptyScheduler(), 'owner-test', now));
  store.close();

  const db = new DatabaseSync(join(stateDir, 'work.db'));
  try {
    db.prepare(
      "UPDATE work_items SET state = 'failed', attempts = 3, failed_ms = ?, last_error = ? WHERE id = 'drain-pass'",
    ).run(now, 'boom');
  } finally {
    db.close();
  }

  await mkdir(join(stateDir, 'inbox', 'chron:missions'), { recursive: true });
  await writeFile(
    join(stateDir, 'inbox', 'chron:missions', 'old.json'),
    JSON.stringify({ version: 1, id: 'mission:old', kind: 'mission', producer: 'p', enqueued_ms: now }),
    'utf8',
  );
  return { dir, stateDir, paths: { state: stateDir, workDb: join(stateDir, 'work.db') } };
}

test('readWorkStore reports items, dead-letter rows, counts, lease, marker, and legacy inbox', async () => {
  const { dir, stateDir, paths } = await seededDir();
  const report = readWorkStore(dir, paths);

  assert.equal(report.available, true);
  assert.ok(report.db_bytes > 0);
  assert.equal(report.user_version, 1);
  assert.notEqual(report.marker, null);
  assert.deepEqual(report.state_counts, { queued: 0, running: 1, failed: 1 });
  assert.deepEqual(report.items.map((row) => row.id), ['mission:a']);
  assert.equal(report.items[0].state, 'running');
  assert.equal(report.items[0].attempts, 1);
  assert.equal(report.failed.length, 1);
  assert.equal(report.failed[0].id, 'drain-pass');
  assert.equal(report.failed[0].last_error, 'boom');
  assert.equal(typeof report.failed[0].failed_age_ms, 'number');
  assert.ok(
    report.producer_counts.some(
      (row) => row.producer === 'chron:drain' && row.state === 'failed' && row.count === 1,
    ),
  );
  assert.equal(report.lease.owner, 'owner-test');
  assert.equal(report.lease.expired, false);
  assert.equal(report.inbox.pending, 1);
  assert.equal(report.inbox.migrated, true);
  assert.equal(report.inbox.dir, join(stateDir, 'inbox'));

  const queue = readQueue(dir, paths, []);
  assert.equal(queue.available, true);
  assert.deepEqual(queue.state_counts, report.state_counts);
  assert.equal(queue.failed[0].id, 'drain-pass');
  assert.equal(queue.lease.owner, 'owner-test');
  assert.equal(queue.inbox.pending, 1);
  assert.equal(queue.db.user_version, 1);
});

test('a missing store still exposes the pre-migration inbox and an explicit empty state', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'dashboard-store-empty-'));
  const stateDir = join(dir, '.opencode', 'state');
  await mkdir(join(stateDir, 'inbox', 'p'), { recursive: true });
  await writeFile(
    join(stateDir, 'inbox', 'p', 'old.json'),
    JSON.stringify({ version: 1, id: 'mission:old', kind: 'mission', producer: 'p', enqueued_ms: 1 }),
    'utf8',
  );
  const paths = { state: stateDir, workDb: join(stateDir, 'work.db') };
  const report = readWorkStore(dir, paths);
  assert.equal(report.available, false);
  assert.deepEqual(report.state_counts, { queued: 0, running: 0, failed: 0 });
  assert.equal(report.lease, null);
  assert.equal(report.inbox.pending, 1);
  assert.equal(report.inbox.migrated, false);
});
