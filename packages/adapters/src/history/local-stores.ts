import {
  appendFileSync,
  chmodSync,
  existsSync,
  mkdirSync,
  readFileSync,
  renameSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";
import type { HistoryPort, MemoryEventV1, MemoryPort, ReviewHistoryEntry } from "@ikigai/core";
import { resolveIkigaiDataDir } from "../credentials/env-and-store.ts";

const MAX_HISTORY_BYTES = 5 * 1024 * 1024;

export interface FeedbackRecord {
  readonly timestamp: string;
  readonly turnId: string;
  readonly ruleId: string;
  readonly decision: "RIGHT" | "WRONG";
}

export interface FeedbackStore {
  record(entry: FeedbackRecord): Promise<void>;
  readAll(): Promise<readonly FeedbackRecord[]>;
}

export function createLocalHistoryStore(dataDir: string = resolveIkigaiDataDir()): HistoryPort {
  const filePath = join(dataDir, "reviews.jsonl");

  return {
    async appendReview(entry: ReviewHistoryEntry): Promise<void> {
      ensurePrivateDir(dataDir);
      appendFileSync(filePath, `${JSON.stringify(entry)}\n`, { encoding: "utf8", mode: 0o600 });
      enforceOwnerMode(filePath);
      compactIfOversized(filePath, MAX_HISTORY_BYTES);
    },

    async readReviews(): Promise<readonly ReviewHistoryEntry[]> {
      if (!existsSync(filePath)) {
        return [];
      }
      const lines = readFileSync(filePath, "utf8")
        .split(/\r?\n/)
        .map((l) => l.trim())
        .filter(Boolean);

      const entries: ReviewHistoryEntry[] = [];
      for (const line of lines) {
        try {
          entries.push(JSON.parse(line) as ReviewHistoryEntry);
        } catch {
          // Skip malformed lines cleanly.
        }
      }
      return entries;
    },
  };
}

export function createLocalFeedbackStore(dataDir: string = resolveIkigaiDataDir()): FeedbackStore {
  const filePath = join(dataDir, "feedback.jsonl");

  return {
    async record(entry: FeedbackRecord): Promise<void> {
      ensurePrivateDir(dataDir);
      appendFileSync(filePath, `${JSON.stringify(entry)}\n`, { encoding: "utf8", mode: 0o600 });
      enforceOwnerMode(filePath);
    },

    async readAll(): Promise<readonly FeedbackRecord[]> {
      if (!existsSync(filePath)) {
        return [];
      }
      const lines = readFileSync(filePath, "utf8")
        .split(/\r?\n/)
        .map((l) => l.trim())
        .filter(Boolean);
      const out: FeedbackRecord[] = [];
      for (const line of lines) {
        try {
          out.push(JSON.parse(line) as FeedbackRecord);
        } catch {
          // Ignore malformed lines.
        }
      }
      return out;
    },
  };
}

/**
 * Bounded JSONL outbox storing redacted MemoryEventV1 records for Phase-2 Memory ingestion.
 */
export function createMemoryOutbox(dataDir: string = resolveIkigaiDataDir()): MemoryPort {
  const filePath = join(dataDir, "memory-events.jsonl");

  return {
    async emit(events: readonly MemoryEventV1[]): Promise<void> {
      if (events.length === 0) {
        return;
      }
      ensurePrivateDir(dataDir);
      const payload = `${events.map((e) => JSON.stringify(e)).join("\n")}\n`;
      appendFileSync(filePath, payload, { encoding: "utf8", mode: 0o600 });
      enforceOwnerMode(filePath);
      compactIfOversized(filePath, MAX_HISTORY_BYTES);
    },
  };
}

function ensurePrivateDir(dir: string): void {
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  try {
    chmodSync(dir, 0o700);
  } catch {
    // Windows ACLs handle user profile privacy.
  }
}

function enforceOwnerMode(filePath: string): void {
  try {
    chmodSync(filePath, 0o600);
  } catch {
    // Ignore on filesystems without POSIX mode bits.
  }
}

function compactIfOversized(filePath: string, maxBytes: number): void {
  if (!existsSync(filePath) || statSync(filePath).size <= maxBytes) {
    return;
  }
  const lines = readFileSync(filePath, "utf8").split(/\r?\n/).filter(Boolean);
  const keep = lines.slice(Math.floor(lines.length / 2));
  const tmpPath = `${filePath}.tmp`;
  writeFileSync(tmpPath, `${keep.join("\n")}\n`, { encoding: "utf8", mode: 0o600 });
  renameSync(tmpPath, filePath);
}
