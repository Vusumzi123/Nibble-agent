// `storage:` configuration for the SQLite work store.
//
// Shape:
//   storage:
//     path: work.db
//     busy_timeout_ms: 5000
//     synchronous: NORMAL
//     failed_retry_ms: 3600000
//     failed_retention_days: 30
//
// Missing/malformed values fall back to the defaults; never throws.
// Loaded via relative import only.
import { parseFlatBlock, readSection, schemaFromDefaults } from "./config.ts"
import {
  DEFAULT_FAILED_RETENTION_DAYS,
  DEFAULT_FAILED_RETRY_MS,
  WORK_DB_FILE,
} from "./work-store.ts"

export type StorageConfig = {
  path: string
  busy_timeout_ms: number
  synchronous: "NORMAL" | "FULL"
  failed_retry_ms: number
  failed_retention_days: number
}

export const DEFAULT_STORAGE: StorageConfig = {
  path: WORK_DB_FILE,
  busy_timeout_ms: 5_000,
  synchronous: "NORMAL",
  failed_retry_ms: DEFAULT_FAILED_RETRY_MS,
  failed_retention_days: DEFAULT_FAILED_RETENTION_DAYS,
}

const STORAGE_KEYS = new Set(Object.keys(DEFAULT_STORAGE))

export function normalizeStorageConfig(cfg: StorageConfig): StorageConfig {
  const nonNegative = (value: number, fallback: number): number =>
    Number.isFinite(value) && value >= 0 ? value : fallback
  return {
    path: typeof cfg.path === "string" && cfg.path.trim() !== "" ? cfg.path.trim() : WORK_DB_FILE,
    busy_timeout_ms: nonNegative(cfg.busy_timeout_ms, DEFAULT_STORAGE.busy_timeout_ms),
    synchronous: cfg.synchronous === "FULL" ? "FULL" : "NORMAL",
    failed_retry_ms: nonNegative(cfg.failed_retry_ms, DEFAULT_STORAGE.failed_retry_ms),
    failed_retention_days: nonNegative(
      cfg.failed_retention_days,
      DEFAULT_STORAGE.failed_retention_days,
    ),
  }
}

export function parseStorageConfig(yamlText: string): StorageConfig {
  const parsed = parseFlatBlock(yamlText, "storage", {
    schema: schemaFromDefaults(DEFAULT_STORAGE),
    knownKeys: STORAGE_KEYS,
  })
  return normalizeStorageConfig({ ...DEFAULT_STORAGE, ...(parsed as Partial<StorageConfig>) })
}

export async function readStorageConfig(directory: string): Promise<StorageConfig> {
  return normalizeStorageConfig(await readSection(directory, "storage", DEFAULT_STORAGE))
}
