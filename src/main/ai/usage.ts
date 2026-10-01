import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import type { AiFeature, AiUsage, AiUsageMonth, AiUsageTotals } from '@shared/types';
import { log } from '../logger';

/** Month (`YYYY-MM`, local time) → feature → totals. Stored in a machine-local file next to the other app data; never part of settings export/sync. */
export type UsageLog = Record<string, Partial<Record<AiFeature, AiUsageTotals>>>;

export function monthKey(date: Date): string {
  return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}`;
}

/** Returns `usageLog` with one request added to `month`/`feature`. Cost stays null until a backend reports one. */
export function addUsage(usageLog: UsageLog, month: string, feature: AiFeature, u: AiUsage): UsageLog {
  const prev = usageLog[month]?.[feature];
  const next: AiUsageTotals = {
    requests: (prev?.requests ?? 0) + 1,
    inputTokens: (prev?.inputTokens ?? 0) + u.inputTokens,
    outputTokens: (prev?.outputTokens ?? 0) + u.outputTokens,
    cacheReadTokens: (prev?.cacheReadTokens ?? 0) + u.cacheReadTokens,
    cacheWriteTokens: (prev?.cacheWriteTokens ?? 0) + u.cacheWriteTokens,
    costUsd: u.costUsd === null ? (prev?.costUsd ?? null) : (prev?.costUsd ?? 0) + u.costUsd,
  };
  return { ...usageLog, [month]: { ...usageLog[month], [feature]: next } };
}

let file: string | null = null;
let queue: Promise<unknown> = Promise.resolve();

/** Points the usage log at `dir` (the app data directory). Until called, usage is not recorded. */
export function configureUsage(dir: string): void {
  file = join(dir, 'ai-usage.json');
}

async function load(path: string): Promise<UsageLog> {
  try {
    return JSON.parse(await readFile(path, 'utf8')) as UsageLog;
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== 'ENOENT') log.warn(`AI usage log unreadable, starting over: ${(err as Error).message}`);
    return {};
  }
}

/** Adds one request to this month's totals. Writes are serialized; failures are logged, never thrown (usage is best-effort). */
export function recordUsage(feature: AiFeature, usage: AiUsage | undefined, now = new Date()): Promise<void> {
  const path = file;
  if (!path || !usage) return Promise.resolve();
  const run = queue.then(async () => {
    const next = addUsage(await load(path), monthKey(now), feature, usage);
    await mkdir(dirname(path), { recursive: true });
    const tmp = `${path}.tmp`;
    await writeFile(tmp, JSON.stringify(next), { mode: 0o600 });
    await rename(tmp, path);
  });
  queue = run.catch((err) => log.warn(`Could not record AI usage: ${(err as Error).message}`));
  return queue as Promise<void>;
}

/** This month and last month, in that order (months with no usage have empty `features`). */
export async function readUsage(now = new Date()): Promise<AiUsageMonth[]> {
  const data = file ? await load(file) : {};
  const last = new Date(now.getFullYear(), now.getMonth() - 1, 1);
  return [now, last].map((d) => ({ month: monthKey(d), features: data[monthKey(d)] ?? {} }));
}
