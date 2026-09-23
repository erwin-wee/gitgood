import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

// The server bundle mounts src/main/core directly, so an `electron` import
// anywhere in it (even transitively via a sibling in core/) would drag the
// desktop runtime into a headless Node process. Guard the boundary here rather
// than only discovering it when the server build fails.
const CORE_FILES = ['src/main/core/handlers.ts', 'src/main/core/bus.ts', 'src/main/core/host.ts', 'src/main/core/store-platform.ts', 'src/main/store.ts'];
describe('Electron-free core', () => {
  for (const file of CORE_FILES) {
    it(`${file} does not import electron`, () => {
      const source = readFileSync(resolve(file), 'utf8');
      expect(source).not.toMatch(/from ['"]electron['"]/);
      expect(source).not.toMatch(/require\(['"]electron['"]\)/);
    });
  }
});
