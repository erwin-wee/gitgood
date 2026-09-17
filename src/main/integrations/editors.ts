import { existsSync } from 'node:fs';
import { readdir } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';
import type { FoundEditor } from '@shared/types';
import { cmdQuote, launchDetached, startOnWindows } from '../exec';
import { findExecutable } from '../tools';

interface EditorCandidate {
  id: string;
  name: string;
  win: string[];
  mac: string[];
  linux: string[];
  /** Arguments to open a path; %p is replaced. */
  args: string[];
}

const home = homedir();
const local = process.env.LOCALAPPDATA ?? join(home, 'AppData', 'Local');
const pf = process.env.ProgramFiles ?? 'C:\\Program Files';
const pf86 = process.env['ProgramFiles(x86)'] ?? 'C:\\Program Files (x86)';

const CANDIDATES: EditorCandidate[] = [
  { id: 'vscode', name: 'Visual Studio Code', win: [join(local, 'Programs', 'Microsoft VS Code', 'Code.exe'), join(pf, 'Microsoft VS Code', 'Code.exe')], mac: ['/Applications/Visual Studio Code.app/Contents/Resources/app/bin/code'], linux: ['code'], args: ['%p'] },
  { id: 'vscode-insiders', name: 'Visual Studio Code Insiders', win: [join(local, 'Programs', 'Microsoft VS Code Insiders', 'Code - Insiders.exe')], mac: ['/Applications/Visual Studio Code - Insiders.app/Contents/Resources/app/bin/code'], linux: ['code-insiders'], args: ['%p'] },
  { id: 'vscodium', name: 'VSCodium', win: [join(local, 'Programs', 'VSCodium', 'VSCodium.exe'), join(pf, 'VSCodium', 'VSCodium.exe')], mac: ['/Applications/VSCodium.app/Contents/Resources/app/bin/codium'], linux: ['codium'], args: ['%p'] },
  { id: 'cursor', name: 'Cursor', win: [join(local, 'Programs', 'cursor', 'Cursor.exe')], mac: ['/Applications/Cursor.app/Contents/Resources/app/bin/cursor'], linux: ['cursor'], args: ['%p'] },
  { id: 'windsurf', name: 'Windsurf', win: [join(local, 'Programs', 'Windsurf', 'Windsurf.exe')], mac: ['/Applications/Windsurf.app/Contents/Resources/app/bin/windsurf'], linux: ['windsurf'], args: ['%p'] },
  { id: 'zed', name: 'Zed', win: [join(local, 'Programs', 'Zed', 'Zed.exe'), join(local, 'Zed', 'Zed.exe')], mac: ['/Applications/Zed.app/Contents/MacOS/cli'], linux: ['zed', 'zeditor'], args: ['%p'] },
  { id: 'sublime', name: 'Sublime Text', win: [join(pf, 'Sublime Text', 'subl.exe'), join(pf, 'Sublime Text 3', 'subl.exe')], mac: ['/Applications/Sublime Text.app/Contents/SharedSupport/bin/subl'], linux: ['subl'], args: ['%p'] },
  { id: 'notepadpp', name: 'Notepad++', win: [join(pf, 'Notepad++', 'notepad++.exe'), join(pf86, 'Notepad++', 'notepad++.exe')], mac: [], linux: [], args: ['%p'] },
  { id: 'visualstudio', name: 'Visual Studio', win: [join(pf, 'Microsoft Visual Studio', '2022', 'Community', 'Common7', 'IDE', 'devenv.exe'), join(pf, 'Microsoft Visual Studio', '2022', 'Professional', 'Common7', 'IDE', 'devenv.exe'), join(pf, 'Microsoft Visual Studio', '2022', 'Enterprise', 'Common7', 'IDE', 'devenv.exe')], mac: [], linux: [], args: ['%p'] },
  { id: 'idea', name: 'IntelliJ IDEA', win: [join(local, 'JetBrains', 'Toolbox', 'scripts', 'idea.cmd')], mac: ['/Applications/IntelliJ IDEA.app/Contents/MacOS/idea', '/Applications/IntelliJ IDEA CE.app/Contents/MacOS/idea'], linux: ['idea'], args: ['%p'] },
  { id: 'webstorm', name: 'WebStorm', win: [join(local, 'JetBrains', 'Toolbox', 'scripts', 'webstorm.cmd')], mac: ['/Applications/WebStorm.app/Contents/MacOS/webstorm'], linux: ['webstorm'], args: ['%p'] },
  { id: 'pycharm', name: 'PyCharm', win: [join(local, 'JetBrains', 'Toolbox', 'scripts', 'pycharm.cmd')], mac: ['/Applications/PyCharm.app/Contents/MacOS/pycharm', '/Applications/PyCharm CE.app/Contents/MacOS/pycharm'], linux: ['pycharm'], args: ['%p'] },
  { id: 'rider', name: 'Rider', win: [join(local, 'JetBrains', 'Toolbox', 'scripts', 'rider.cmd')], mac: ['/Applications/Rider.app/Contents/MacOS/rider'], linux: ['rider'], args: ['%p'] },
  { id: 'goland', name: 'GoLand', win: [join(local, 'JetBrains', 'Toolbox', 'scripts', 'goland.cmd')], mac: ['/Applications/GoLand.app/Contents/MacOS/goland'], linux: ['goland'], args: ['%p'] },
  { id: 'fleet', name: 'JetBrains Fleet', win: [join(local, 'JetBrains', 'Toolbox', 'scripts', 'fleet.cmd')], mac: ['/Applications/Fleet.app/Contents/MacOS/Fleet'], linux: ['fleet'], args: ['%p'] },
  { id: 'atom', name: 'Pulsar', win: [join(local, 'Programs', 'Pulsar', 'Pulsar.exe')], mac: ['/Applications/Pulsar.app/Contents/MacOS/Pulsar'], linux: ['pulsar'], args: ['%p'] },
  { id: 'nvim-qt', name: 'Neovim (nvim-qt)', win: [], mac: [], linux: ['nvim-qt'], args: ['%p'] },
  { id: 'gedit', name: 'GNOME Text Editor', win: [], mac: [], linux: ['gnome-text-editor', 'gedit'], args: ['%p'] },
  { id: 'kate', name: 'Kate', win: [], mac: [], linux: ['kate'], args: ['%p'] },
];

async function jetbrainsToolboxWindows(): Promise<FoundEditor[]> {
  if (process.platform !== 'win32') return [];
  const dir = join(local, 'JetBrains', 'Toolbox', 'scripts');
  try {
    const entries = await readdir(dir);
    const known = new Set(CANDIDATES.map((c) => c.win.map((p) => p.toLowerCase())).flat());
    return entries
      .filter((e) => e.endsWith('.cmd'))
      .map((e) => join(dir, e))
      .filter((p) => !known.has(p.toLowerCase()))
      .map((p) => ({ id: `jb-${p}`, name: `JetBrains ${p.split('\\').pop()!.replace(/\.cmd$/, '')}`, path: p }));
  } catch {
    return [];
  }
}

let cache: FoundEditor[] | null = null;

export async function findEditors(pathEnv: string | undefined, force = false): Promise<FoundEditor[]> {
  if (cache && !force) return cache;
  const found: FoundEditor[] = [];
  for (const c of CANDIDATES) {
    const candidates = process.platform === 'win32' ? c.win : process.platform === 'darwin' ? c.mac : c.linux;
    let path: string | null = null;
    for (const cand of candidates) {
      if (cand.includes('/') || cand.includes('\\')) {
        if (existsSync(cand)) {
          path = cand;
          break;
        }
      } else {
        path = await findExecutable(cand, [], pathEnv);
        if (path) break;
      }
    }
    if (path) found.push({ id: c.id, name: c.name, path });
  }
  found.push(...(await jetbrainsToolboxWindows()));
  cache = found;
  return found;
}

export async function openInEditor(editorPath: string, target: string): Promise<void> {
  const isCmd = /\.(cmd|bat)$/i.test(editorPath);
  if (isCmd) {
    // Batch files must be run through cmd.exe; `start` keeps the launcher window hidden.
    await startOnWindows([cmdQuote(editorPath), cmdQuote(target)]);
    return;
  }
  await launchDetached(editorPath, [target]);
}
