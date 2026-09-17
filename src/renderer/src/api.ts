import type { ApiMethodName, ApiMethods, EventName, EventPayloads } from '@shared/ipc';
import type { GitErrorInfo, IpcResult } from '@shared/types';

export class ApiError extends Error {
  readonly info: GitErrorInfo;
  constructor(info: GitErrorInfo) {
    super(info.message);
    this.name = 'ApiError';
    this.info = info;
  }
  get code(): GitErrorInfo['code'] {
    return this.info.code;
  }
}

export function invoke<K extends ApiMethodName>(method: K, ...args: Parameters<ApiMethods[K]>): ReturnType<ApiMethods[K]> {
  return window.gitgoodBridge.invokeRaw(method, ...args).then((res) => {
    const r = res as IpcResult<unknown>;
    if (r.ok) return r.value;
    throw new ApiError(r.error);
  }) as ReturnType<ApiMethods[K]>;
}

export function on<K extends EventName>(event: K, listener: (payload: EventPayloads[K]) => void): () => void {
  return window.gitgoodBridge.on(event, listener as (payload: unknown) => void);
}

export const platform: string = window.gitgoodBridge.platform;
export const isMac = platform === 'darwin';
export const isWindows = platform === 'win32';
export const modKey = isMac ? '⌘' : 'Ctrl';

export function errorMessage(err: unknown): string {
  if (err instanceof ApiError) return err.info.message;
  if (err instanceof Error) return err.message;
  return String(err);
}

export function errorInfo(err: unknown): GitErrorInfo {
  if (err instanceof ApiError) return err.info;
  return { message: errorMessage(err), command: '', exitCode: null, stderr: '', stdout: '', code: 'unknown' };
}
