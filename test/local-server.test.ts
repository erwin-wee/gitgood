import { describe, expect, it } from 'vitest';
import { managedUnit } from '../src/main/local-server';

describe('managedUnit', () => {
  it('starts the bundled server in Node mode, immune to the AppImage adding --no-sandbox', () => {
    const unit = managedUnit('/opt/GitGood/gitgood');
    expect(unit).toContain('# Managed by the GitGood desktop app; rewritten on launch.');
    expect(unit).toContain('Environment=ELECTRON_RUN_AS_NODE=1');
    expect(unit).toMatch(/^ExecStart="\/opt\/GitGood\/gitgood" -e ".*process\.resourcesPath.*index\.mjs.*" -- --no-sandbox$/m);
  });

  it('quotes an executable path with spaces and escapes systemd specifiers', () => {
    const unit = managedUnit('/home/me/Apps/GitGood 100%.AppImage');
    expect(unit).toContain('ExecStart="/home/me/Apps/GitGood 100%%.AppImage" -e ');
  });
});
