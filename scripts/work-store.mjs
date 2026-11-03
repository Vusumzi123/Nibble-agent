#!/usr/bin/env node
// Work-store operations: dump, import, integrity, prune-failed.
//
// Usage:
//   node scripts/work-store.mjs dump          [--state DIR] [--out FILE]
//   node scripts/work-store.mjs import        [--state DIR] [--file FILE]
//   node scripts/work-store.mjs integrity     [--state DIR]
//   node scripts/work-store.mjs prune-failed  [--state DIR] [--days N]
//
// `dump` writes the legacy v2 work-queue.json (running rows become queued) for
// the rollback path. `import` restores a dumped file into the live store
// without touching the one-time migration marker.
//
// Loaded directly by Node's type strip; no dependencies.

import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, isAbsolute, join, resolve } from 'node:path';

import { readStorageConfig } from '../.opencode/plugin/lib/storage-config.ts';
import { parseWorkQueueState } from '../.opencode/plugin/lib/work-queue.ts';
import { openWorkStore } from '../.opencode/plugin/lib/work-store/sqlite.ts';

const argv = process.argv.slice(2);
const command = argv[0];

function arg(name, fallback) {
  const index = argv.indexOf(name);
  return index >= 0 && argv[index + 1] !== undefined ? argv[index + 1] : fallback;
}

function stateDirOf() {
  const dir = resolve(arg('--dir', process.cwd()));
  const state = arg('--state', join(dir, '.opencode', 'state'));
  return { dir, stateDir: isAbsolute(state) ? state : resolve(state) };
}

async function open(dir, stateDir) {
  const storage = await readStorageConfig(dir);
  return openWorkStore({
    stateDir,
    path: storage.path,
    busyTimeoutMs: storage.busy_timeout_ms,
    synchronous: storage.synchronous,
    failedRetryMs: storage.failed_retry_ms,
    failedRetentionDays: storage.failed_retention_days,
  });
}

function usage() {
  console.error(
    'usage: work-store.mjs <dump|import|integrity|prune-failed> [--dir DIR] [--state DIR] [--out FILE] [--file FILE] [--days N]',
  );
}

async function main() {
  const { dir, stateDir } = stateDirOf();
  if (command === 'dump') {
    const store = await open(dir, stateDir);
    try {
      const state = store.dump();
      const out = arg('--out', join(stateDir, 'work-queue.json'));
      mkdirSync(dirname(out), { recursive: true });
      writeFileSync(out, JSON.stringify({ version: 2, ...state }, null, 2) + '\n', 'utf8');
      console.log(`dumped ${state.items.length} items to ${out}`);
    } finally {
      store.close();
    }
    return;
  }

  if (command === 'import') {
    const file = arg('--file', join(stateDir, 'work-queue.json'));
    const state = parseWorkQueueState(readFileSync(file, 'utf8'));
    const store = await open(dir, stateDir);
    try {
      const outcome = store.restore(state);
      console.log(
        `imported ${outcome.accepted.length} items (${outcome.duplicates.length} already present)`,
      );
    } finally {
      store.close();
    }
    return;
  }

  if (command === 'integrity') {
    const store = await open(dir, stateDir);
    try {
      const ok = store.integrityCheck();
      console.log(ok ? 'integrity: ok' : 'integrity: failed');
      if (!ok) process.exitCode = 1;
    } finally {
      store.close();
    }
    return;
  }

  if (command === 'prune-failed') {
    const storage = await readStorageConfig(dir);
    const days = Number(arg('--days', storage.failed_retention_days));
    const retentionMs = (Number.isFinite(days) && days >= 0 ? days : storage.failed_retention_days) * 86_400_000;
    const store = await open(dir, stateDir);
    try {
      console.log(`pruned ${store.pruneFailed(retentionMs)} failed rows`);
    } finally {
      store.close();
    }
    return;
  }

  usage();
  process.exitCode = 2;
}

main().catch((err) => {
  console.error(err instanceof Error ? err.message : String(err));
  process.exitCode = 1;
});
