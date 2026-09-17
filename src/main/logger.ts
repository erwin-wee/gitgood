import { appendFileSync, existsSync, mkdirSync, renameSync, statSync } from 'node:fs';
import { join } from 'node:path';

let logDir: string | null = null;
let logFile: string | null = null;
const MAX_BYTES = 5 * 1024 * 1024;

export function initLogger(dir: string): void {
  logDir = dir;
  logFile = join(dir, 'gitgood.log');
  try {
    if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
  } catch {
    /* ignore */
  }
}

export function getLogPath(): string {
  return logFile ?? '';
}

function write(level: string, message: string): void {
  const line = `${new Date().toISOString()} [${level}] ${message}\n`;
  if (process.env.NODE_ENV !== 'production' || level !== 'info') {
    if (level === 'error') console.error(line.trimEnd());
    else if (level === 'warn') console.warn(line.trimEnd());
    else console.log(line.trimEnd());
  }
  if (!logFile || !logDir) return;
  try {
    if (existsSync(logFile) && statSync(logFile).size > MAX_BYTES) {
      renameSync(logFile, join(logDir, 'gitgood.old.log'));
    }
    appendFileSync(logFile, line);
  } catch {
    /* ignore */
  }
}

export const log = {
  info: (message: string) => write('info', message),
  warn: (message: string) => write('warn', message),
  error: (message: string, err?: unknown) => {
    const detail = err instanceof Error ? ` ${err.stack ?? err.message}` : err !== undefined ? ` ${String(err)}` : '';
    write('error', message + detail);
  },
};
