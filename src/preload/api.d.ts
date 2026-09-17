export interface GitGoodBridge {
  platform: string;
  invokeRaw: (method: string, ...args: unknown[]) => Promise<unknown>;
  on: (event: string, listener: (payload: unknown) => void) => () => void;
}

declare global {
  interface Window {
    gitgoodBridge: GitGoodBridge;
  }
}
