import { describe, expect, it } from 'vitest';
import { ElectronUpdaterProvider, type ElectronAutoUpdater } from '../src/main/update/electron-updater-provider';

type Listener = (...args: never[]) => void;

/** A fake ElectronAutoUpdater: a minimal in-memory event emitter plus the settable fields/methods the provider touches, so the provider can be unit tested without a real electron-updater instance, network or filesystem. */
class FakeAutoUpdater implements ElectronAutoUpdater {
  autoDownload = true;
  autoInstallOnAppQuit = true;
  allowPrerelease = false;
  allowDowngrade = false;
  channel: string | null = null;
  logger: ElectronAutoUpdater['logger'] = console;

  checkResult: { updateInfo: { version: string; releaseDate: string; releaseNotes?: string | { version: string; note: string | null }[] | null } } | null = null;
  checkError: Error | null = null;
  downloadError: Error | null = null;
  installCalls: Array<{ isSilent?: boolean; isForceRunAfter?: boolean }> = [];

  private listeners = new Map<string, Set<Listener>>();

  async checkForUpdates() {
    if (this.checkError) {
      this.emit('error', this.checkError);
      throw this.checkError;
    }
    return this.checkResult;
  }

  async downloadUpdate(): Promise<unknown> {
    if (this.downloadError) {
      this.emit('error', this.downloadError);
      throw this.downloadError;
    }
    this.emit('download-progress', { percent: 0, bytesPerSecond: 0 });
    this.emit('download-progress', { percent: 100, bytesPerSecond: 12345 });
    this.emit('update-downloaded', {});
    return [];
  }

  quitAndInstall(isSilent?: boolean, isForceRunAfter?: boolean): void {
    this.installCalls.push({ isSilent, isForceRunAfter });
  }

  on(event: string, listener: Listener): unknown {
    (this.listeners.get(event) ?? this.listeners.set(event, new Set()).get(event)!).add(listener);
    return this;
  }

  once(event: string, listener: Listener): unknown {
    const wrapped: Listener = ((...args: never[]) => {
      this.off(event, wrapped);
      listener(...args);
    }) as Listener;
    return this.on(event, wrapped);
  }

  off(event: string, listener: Listener): unknown {
    this.listeners.get(event)?.delete(listener);
    return this;
  }

  listenerCount(event: string): number {
    return this.listeners.get(event)?.size ?? 0;
  }

  private emit(event: string, ...args: unknown[]): void {
    for (const l of [...(this.listeners.get(event) ?? [])]) (l as (...a: unknown[]) => void)(...args);
  }
}

describe('ElectronUpdaterProvider', () => {
  it('registers a permanent error listener so a check/download failure never becomes an uncaught EventEmitter error', () => {
    const fake = new FakeAutoUpdater();
    new ElectronUpdaterProvider(fake, () => 'stable');
    expect(fake.listenerCount('error')).toBeGreaterThan(0);
  });

  it('disables autoDownload/autoInstallOnAppQuit and silences the built-in logger on construction', () => {
    const fake = new FakeAutoUpdater();
    new ElectronUpdaterProvider(fake, () => 'stable');
    expect(fake.autoDownload).toBe(false);
    expect(fake.autoInstallOnAppQuit).toBe(false);
    expect(fake.logger).toBeNull();
  });

  it('maps a found update to ReleaseInfo, deriving prerelease from a version with a "-" suffix', async () => {
    const fake = new FakeAutoUpdater();
    fake.checkResult = { updateInfo: { version: '1.2.0', releaseDate: '2026-01-01T00:00:00Z', releaseNotes: 'Notes' } };
    const provider = new ElectronUpdaterProvider(fake, () => 'stable');
    expect(await provider.fetchLatestRelease()).toEqual({
      version: '1.2.0',
      releaseDate: '2026-01-01T00:00:00Z',
      notes: 'Notes',
      url: 'https://github.com/erwin-wee/gitgood/releases/tag/v1.2.0',
      prerelease: false,
      draft: false,
    });
  });

  it('flattens a full-changelog releaseNotes array into text, and marks a prerelease version accordingly', async () => {
    const fake = new FakeAutoUpdater();
    fake.checkResult = { updateInfo: { version: '1.3.0-beta.1', releaseDate: '2026-01-02T00:00:00Z', releaseNotes: [{ version: '1.3.0-beta.1', note: 'Beta notes' }] } };
    const provider = new ElectronUpdaterProvider(fake, () => 'beta');
    const release = await provider.fetchLatestRelease();
    expect(release).toMatchObject({ version: '1.3.0-beta.1', notes: 'Beta notes', prerelease: true, draft: false });
  });

  it('sets allowPrerelease/channel from the given channel, and always forbids downgrade at the electron-updater level', async () => {
    const fake = new FakeAutoUpdater();
    fake.checkResult = { updateInfo: { version: '1.0.0', releaseDate: '2026-01-01T00:00:00Z' } };
    const provider = new ElectronUpdaterProvider(fake, () => 'beta');
    await provider.fetchLatestRelease();
    expect(fake.allowPrerelease).toBe(true);
    expect(fake.channel).toBe('beta');
    expect(fake.allowDowngrade).toBe(false);
  });

  it('returns null (not an error) when the repository has no matching release yet', async () => {
    const fake = new FakeAutoUpdater();
    const noRelease = new Error('no releases') as Error & { code: string };
    noRelease.code = 'ERR_UPDATER_NO_PUBLISHED_VERSIONS';
    fake.checkError = noRelease;
    const provider = new ElectronUpdaterProvider(fake, () => 'stable');
    expect(await provider.fetchLatestRelease()).toBeNull();
  });

  it('rethrows any other check failure', async () => {
    const fake = new FakeAutoUpdater();
    fake.checkError = new Error('network down');
    const provider = new ElectronUpdaterProvider(fake, () => 'stable');
    await expect(provider.fetchLatestRelease()).rejects.toThrow('network down');
  });

  it('startDownload resolves once update-downloaded fires, reporting each download-progress event', async () => {
    const fake = new FakeAutoUpdater();
    const provider = new ElectronUpdaterProvider(fake, () => 'stable');
    const reports: Array<{ percent: number | null; bytesPerSecond: number | null }> = [];
    await provider.startDownload!((percent, bytesPerSecond) => reports.push({ percent, bytesPerSecond }));
    expect(reports).toEqual([{ percent: 0, bytesPerSecond: 0 }, { percent: 100, bytesPerSecond: 12345 }]);
  });

  it('startDownload rejects on a download error, and cleans up its listeners either way', async () => {
    const fake = new FakeAutoUpdater();
    fake.downloadError = new Error('connection reset');
    const provider = new ElectronUpdaterProvider(fake, () => 'stable');
    const before = fake.listenerCount('error') ?? 0;
    await expect(provider.startDownload!(() => {})).rejects.toThrow('connection reset');
    // only the provider's permanent error listener (registered in the constructor) remains
    expect(fake.listenerCount('error')).toBe(before);
  });

  it('quitAndInstall calls through with the given isSilent and forceRunAfter=true, and never resolves', async () => {
    const fake = new FakeAutoUpdater();
    const provider = new ElectronUpdaterProvider(fake, () => 'stable');
    let settled = false;
    void provider.quitAndInstall!(true).then(() => (settled = true), () => (settled = true));
    await new Promise((r) => setTimeout(r, 0));
    expect(fake.installCalls).toEqual([{ isSilent: true, isForceRunAfter: true }]);
    expect(settled).toBe(false);
  });
});
