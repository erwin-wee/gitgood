export interface GitGoodBridge {
  platform: string;
  invokeRaw: (method: string, ...args: unknown[]) => Promise<unknown>;
  /** Absolute path of a dropped File; only the local desktop app provides it (not web tabs or desktop client mode). */
  getPathForFile?: (file: File) => string;
  on: (event: string, listener: (payload: unknown) => void) => () => void;
}

declare global {
  interface Window {
    gitgoodBridge: GitGoodBridge;
  }
}
