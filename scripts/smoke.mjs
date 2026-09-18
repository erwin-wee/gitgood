#!/usr/bin/env node
/**
 * Builds GitGood, then launches it headlessly (via the GITGOOD_SMOKE_SCRIPT
 * hook in src/main/index.ts) once per scenario under test/smoke/scenarios/,
 * against a disposable fixture repository. Each run's screenshots and store
 * dumps land under test/smoke/out/<scenario>/ for inspection; the process
 * exits non-zero if any scenario fails its expectations.
 *
 * Env:
 *   GITGOOD_SMOKE_SKIP_BUILD=1   skip the electron-vite build (reuse out/)
 *   GITGOOD_SMOKE_FILTER=name    only run the scenario with this name
 *   GITGOOD_SMOKE_TIMEOUT_MS     per-scenario timeout (default 60000)
 *   GITGOOD_SMOKE_SHOW=1         show the app window during runs (by default it
 *                                renders offscreen and never takes focus)
 */
import { execFileSync, spawn } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { cpSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const OUT_DIR = join(ROOT, 'test', 'smoke', 'out');
const SCENARIOS_DIR = join(ROOT, 'test', 'smoke', 'scenarios');
const STUB_DIR = join(ROOT, 'test', 'helpers', 'gh-stub');
const TIMEOUT_MS = Number(process.env.GITGOOD_SMOKE_TIMEOUT_MS || 60000);

const log = (msg) => console.log(`[smoke] ${msg}`);

// ---------------------------------------------------------------------------
// Fixture repositories (plain JS re-implementation of test/helpers/repo.ts's
// approach, kept independent so this script has no TypeScript to load).
// ---------------------------------------------------------------------------

function isolatedEnv(root, extra = {}) {
  const home = join(root, 'home');
  return {
    ...process.env,
    HOME: home,
    USERPROFILE: home,
    XDG_CONFIG_HOME: join(home, '.config'),
    GIT_CONFIG_GLOBAL: join(root, 'gitconfig-empty'),
    GIT_CONFIG_SYSTEM: join(root, 'gitconfig-empty'),
    GIT_CONFIG_NOSYSTEM: '1',
    GH_CONFIG_DIR: join(root, 'gh-config'),
    ...extra,
  };
}

function makeRepo(workRoot) {
  const root = mkdtempSync(join(workRoot, 'repo-'));
  const repoPath = join(root, 'repo');
  mkdirSync(repoPath, { recursive: true });
  mkdirSync(join(root, 'home'), { recursive: true });
  writeFileSync(join(root, 'gitconfig-empty'), '');
  const env = isolatedEnv(root);
  const run = (args, cwd = repoPath, extraEnv = {}) => execFileSync('git', args, { cwd, env: { ...env, ...extraEnv }, stdio: ['ignore', 'pipe', 'pipe'] }).toString('utf8');
  run(['init', '-q', '-b', 'main', repoPath], root);
  run(['config', 'user.name', 'Test User']);
  run(['config', 'user.email', 'test@example.com']);
  run(['config', 'commit.gpgsign', 'false']);
  let n = 0;
  const commit = (message, files = {}) => {
    for (const [rel, content] of Object.entries(files)) {
      const full = join(repoPath, ...rel.split('/'));
      mkdirSync(dirname(full), { recursive: true });
      writeFileSync(full, content);
    }
    if (Object.keys(files).length) run(['add', '-A']);
    n += 1;
    const date = `2024-01-01T00:${String(n).padStart(2, '0')}:00Z`;
    run(['commit', '-q', '-m', message], repoPath, { GIT_AUTHOR_DATE: date, GIT_COMMITTER_DATE: date });
    return run(['rev-parse', 'HEAD']).trim();
  };
  return { root, path: repoPath, env, run, commit, write: (rel, content) => writeFileSync(join(repoPath, ...rel.split('/')), content) };
}

/** Named fixture shapes the scenarios reference by `repoKind`. */
const REPO_KINDS = {
  none: null,
  basic: (workRoot) => {
    const repo = makeRepo(workRoot);
    repo.commit('Initial commit', { 'README.md': '# Fixture repo\n', 'src/app.ts': 'export const value = 1;\n' });
    repo.commit('Add a second file', { 'src/util.ts': 'export const helper = () => 2;\n' });
    return repo;
  },
  /**
   * For the watched-folders smoke tests: `<repo.path>-projects` holds two
   * repositories at different depths (`a`, `org/b`), a `node_modules` decoy
   * that must never be discovered, and `outside/c` next to (not inside) the
   * watched folder. Paths are derived from `__REPO_PATH__` by the scenario,
   * the same way 09-worktrees derives its worktree path.
   */
  watchedFolders: (workRoot) => {
    const repo = REPO_KINDS.basic(workRoot);
    const projects = `${repo.path}-projects`;
    const initAt = (...segments) => {
      const dir = join(projects, ...segments);
      mkdirSync(dir, { recursive: true });
      execFileSync('git', ['init', '-q', '-b', 'main', dir], { env: repo.env, stdio: 'ignore' });
      return dir;
    };
    initAt('a');
    initAt('org', 'b');
    initAt('node_modules', 'decoy');
    const outside = join(`${repo.path}-outside`, 'c');
    mkdirSync(outside, { recursive: true });
    execFileSync('git', ['init', '-q', '-b', 'main', outside], { env: repo.env, stdio: 'ignore' });
    // A symlink to org/b, for the "one entry per repository" check.
    symlinkSync(join(projects, 'org', 'b'), `${repo.path}-link-b`, 'dir');
    return repo;
  },
  uncommittedChanges: (workRoot) => {
    const repo = REPO_KINDS.basic(workRoot);
    repo.write('src/app.ts', 'export const value = 2; // changed\n');
    repo.write('src/new-file.ts', 'export const brandNew = true;\n');
    return repo;
  },
  /** For the AI pre-commit review smoke test: `src/app.ts` (previously one line) gains a debug `console.log` (new-side line 2) and a hard-coded token (new-side line 3) as uncommitted changes. */
  precommitReviewFixture: (workRoot) => {
    const repo = REPO_KINDS.basic(workRoot);
    repo.write('src/app.ts', "export const value = 1;\nconsole.log('debug');\nconst token = 'sk-live-abcdef1234567890';\n");
    return repo;
  },
  /**
   * For the AI commit-splitting smoke test: a mixed uncommitted change across
   * two files with three hunks total (two well-separated hunks in a.ts, one
   * in b.ts — separated by enough unchanged lines that `git diff`'s default
   * 3-line context keeps them as distinct hunks). The exact line content is
   * load-bearing: the scenario's claude stub response below embeds the hunk
   * ids `computeHunkId` (src/main/ai/splitter-core.ts) derives from this
   * precise diff, precomputed once with the same djb2+fnv hash.
   */
  splitCommitsFixture: (workRoot) => {
    const repo = makeRepo(workRoot);
    const aLines = Array.from({ length: 12 }, (_, i) => `line${i + 1}`).join('\n') + '\n';
    repo.commit('Initial commit', { 'a.ts': aLines, 'b.ts': 'x1\nx2\nx3\n' });
    const aChanged = ['line1 changed', ...Array.from({ length: 10 }, (_, i) => `line${i + 2}`), 'line12 changed'].join('\n') + '\n';
    repo.write('a.ts', aChanged);
    repo.write('b.ts', 'x1\nx2 changed\nx3\n');
    return repo;
  },
  /**
   * For the AI rebase assistant ("Tidy up branch with AI") smoke test: a
   * feature branch off main with one real commit followed by a "wip" fixup
   * and a "fix typo" commit. `repo.shas` exposes the three commit shas
   * (deterministic: fixed author/committer identity and dates) so the
   * scenario's claude stub response can reference them via `__SHA_REAL__`,
   * `__SHA_WIP__` and `__SHA_TYPO__` placeholders (substituted below, the
   * same way `__REPO_PATH__` is substituted into step scripts).
   */
  tidyBranchFixture: (workRoot) => {
    const repo = makeRepo(workRoot);
    repo.commit('Initial commit on main', { 'README.md': '# Fixture repo\n' });
    repo.run(['checkout', '-b', 'feature']);
    const real = repo.commit('Add real feature', { 'src/feature.ts': 'export const value = 1;\n' });
    const wip = repo.commit('wip', { 'src/feature.ts': 'export const value = 1;\n// wip note\n' });
    const typo = repo.commit('fix typo', { 'docs/notes.md': 'helllo\n' });
    return { ...repo, shas: { real, wip, typo } };
  },
  /**
   * A repository already configured (outside the app, as if by another tool
   * or a stale key) to sign commits with a GPG key that does not exist in
   * its (isolated, empty) keyring — for the commit "Signing failure" dialog
   * smoke test. HOME is already isolated per-fixture, so GNUPGHOME defaults
   * under it and never touches a real keyring.
   */
  signingKeyMissing: (workRoot) => {
    const repo = REPO_KINDS.uncommittedChanges(workRoot);
    repo.run(['config', 'gpg.format', 'openpgp']);
    repo.run(['config', 'user.signingkey', 'DEADBEEFDEADBEEF']);
    repo.run(['config', 'commit.gpgsign', 'true']);
    return repo;
  },
  withBranch: (workRoot) => {
    const repo = REPO_KINDS.basic(workRoot);
    repo.run(['branch', 'feature']);
    return repo;
  },
  twoStashes: (workRoot) => {
    const repo = REPO_KINDS.basic(workRoot);
    repo.write('src/app.ts', 'export const value = 3; // first stash\n');
    repo.run(['stash', 'push', '-m', 'first stash']);
    repo.write('src/app.ts', 'export const value = 4; // second stash\n');
    repo.write('src/stash-untracked.ts', 'export const brandNewInStash = true;\n');
    repo.run(['stash', 'push', '-u', '-m', 'second stash with untracked']);
    return repo;
  },
  divergedForConflict: (workRoot) => {
    const repo = makeRepo(workRoot);
    repo.commit('base', { 'shared.txt': 'base\n' });
    repo.run(['branch', 'feature']);
    repo.commit('main change', { 'shared.txt': 'main\n' });
    repo.run(['checkout', 'feature']);
    repo.commit('feature change', { 'shared.txt': 'feature\n' });
    repo.run(['checkout', 'main']);
    return repo;
  },
  renamedFile: (workRoot) => {
    const repo = makeRepo(workRoot);
    repo.commit('Add old-name.ts', { 'src/old-name.ts': 'export const value = 1;\n' });
    repo.run(['mv', 'src/old-name.ts', 'src/new-name.ts']);
    repo.commit('Rename to new-name.ts');
    repo.commit('Update new-name.ts', { 'src/new-name.ts': 'export const value = 2; // updated\n' });
    return repo;
  },
  /** Add/change/remove commits for the word "needle", for the History content/regex search smoke test. */
  needleHistory: (workRoot) => {
    const repo = makeRepo(workRoot);
    repo.commit('add needle', { 'a.txt': 'needle here\nother line\n' });
    repo.commit('change needle line', { 'a.txt': 'needle there\nother line\n' });
    repo.commit('remove needle', { 'a.txt': 'other line\n' });
    return repo;
  },
  conflictInProgress: (workRoot) => {
    const repo = REPO_KINDS.divergedForConflict(workRoot);
    try {
      repo.run(['merge', 'feature']);
    } catch {
      // expected: merging "feature" conflicts on shared.txt and leaves the merge in progress
    }
    return repo;
  },
  /** Two conflicted files (shared.txt, other.txt), for the guided "Resolve remaining like …" AI-resolve smoke test. */
  divergedForConflictTwoFiles: (workRoot) => {
    const repo = makeRepo(workRoot);
    repo.commit('base', { 'shared.txt': 'base\n', 'other.txt': 'obase\n' });
    repo.run(['branch', 'feature']);
    repo.commit('main change', { 'shared.txt': 'main\n', 'other.txt': 'omain\n' });
    repo.run(['checkout', 'feature']);
    repo.commit('feature change', { 'shared.txt': 'feature\n', 'other.txt': 'ofeature\n' });
    repo.run(['checkout', 'main']);
    return repo;
  },
  conflictInProgressTwoFiles: (workRoot) => {
    const repo = REPO_KINDS.divergedForConflictTwoFiles(workRoot);
    try {
      repo.run(['merge', 'feature']);
    } catch {
      // expected: merging "feature" conflicts on shared.txt and other.txt, leaving the merge in progress
    }
    return repo;
  },
  /**
   * A superproject cloned (plainly, no `--recurse-submodules`) from a local
   * bare repo, so its one submodule is left uninitialized on disk — the
   * scenario this app's post-clone banner and Submodules dialog exist for.
   * Built directly with git (like every other kind here) rather than through
   * GitGood's own clone action, which recurses into submodules and would
   * need a real, reachable submodule remote to leave one uninitialized.
   */
  withSubmodule: (workRoot) => {
    const libBare = join(workRoot, 'lib.git');
    execFileSync('git', ['init', '--bare', '-q', '-b', 'main', libBare]);
    const libSeed = makeRepo(workRoot);
    execFileSync('git', ['remote', 'add', 'origin', libBare], { cwd: libSeed.path, env: libSeed.env });
    libSeed.commit('lib init', { 'a.txt': 'hello from the submodule\n' });
    execFileSync('git', ['push', '-q', 'origin', 'main'], { cwd: libSeed.path, env: libSeed.env });

    const superRepo = REPO_KINDS.basic(workRoot);
    execFileSync('git', ['-c', 'protocol.file.allow=always', 'submodule', 'add', libBare, 'vendor/lib'], { cwd: superRepo.path, env: superRepo.env });
    execFileSync('git', ['commit', '-q', '-m', 'add submodule'], { cwd: superRepo.path, env: superRepo.env });

    const clonePath = join(workRoot, 'super-clone');
    execFileSync('git', ['clone', '-q', superRepo.path, clonePath], { cwd: workRoot, env: superRepo.env });
    // GIT_ALLOW_PROTOCOL permits the app's own (never-hardcoded) submodule update to reach the
    // local bare "remote" below; it is fixture-only environment configuration, not app behaviour.
    // Only `path` and `env` are read by the runner below; `run`/`commit`/`write` are not used past fixture construction for this kind.
    return { ...superRepo, path: clonePath, env: { ...superRepo.env, GIT_ALLOW_PROTOCOL: 'file' } };
  },
  /**
   * For the Repository health smoke test: a large blob that was later
   * deleted (a 1 MB random buffer, standing in for the "10 MB blob" scenario
   * in tasks.md to keep the run fast), a branch merged into main, a branch
   * whose only commit is old enough to be inactive (every commit here uses
   * `makeRepo`'s fixed 2024 dates, already well past the default 90-day
   * threshold), and a branch pushed to a bare "origin" and then deleted
   * there, so its local upstream shows as gone after a prune fetch.
   */
  /** A basic repo with a `github.com` origin remote, so `repos.detectGitHub` populates `RepositoryInfo.github` (no network access needed: it only parses the remote URL). Used by scenarios that stub `gh` for the Issues dialog. */
  withGithubRemote: (workRoot) => {
    const repo = REPO_KINDS.basic(workRoot);
    execFileSync('git', ['remote', 'add', 'origin', 'https://github.com/octo/repo.git'], { cwd: repo.path, env: repo.env });
    return repo;
  },
  /**
   * A bare `origin` remote is configured, but the current branch was never
   * pushed (no `-u`), so it has no upstream — for the AI error-explanation
   * smoke test: a raw `git push` fails with the `no-upstream` classification.
   */
  unpublishedWithRemote: (workRoot) => {
    const repo = REPO_KINDS.basic(workRoot);
    const bare = join(workRoot, 'origin.git');
    execFileSync('git', ['init', '--bare', '-q', '-b', 'main', bare]);
    execFileSync('git', ['remote', 'add', 'origin', bare], { cwd: repo.path, env: repo.env });
    return repo;
  },
  /**
   * A repo with a `.github/pull_request_template.md` (headings only, no
   * body), pushed to a bare `origin` on `main`, with a `feature` branch two
   * commits ahead of `main` also pushed to its own upstream — for the AI PR
   * draft smoke test: the Create pull request dialog is reachable through
   * the normal flow (the branch is fully published) and there is a real
   * diff and template for the stubbed model to draft against.
   */
  prDraftReady: (workRoot) => {
    const repo = REPO_KINDS.basic(workRoot);
    const templatePath = join(repo.path, '.github', 'pull_request_template.md');
    mkdirSync(dirname(templatePath), { recursive: true });
    writeFileSync(templatePath, '## Summary\n\nDescribe the change.\n\n## Testing\n\nHow was this tested?\n\n## Checklist\n\n- [ ] Tests added\n');
    repo.run(['add', '-A']);
    repo.run(['commit', '-q', '-m', 'add PR template']);

    const bare = join(workRoot, 'origin.git');
    execFileSync('git', ['init', '--bare', '-q', '-b', 'main', bare]);
    execFileSync('git', ['remote', 'add', 'origin', bare], { cwd: repo.path, env: repo.env });
    execFileSync('git', ['push', '-q', '-u', 'origin', 'main'], { cwd: repo.path, env: repo.env });

    repo.run(['checkout', '-b', 'feature']);
    repo.commit('Add retry logic', { 'src/retry.ts': 'export function retry() {}\n' });
    repo.commit('Add retry tests', { 'src/retry.test.ts': "test('retries', () => {});\n" });
    execFileSync('git', ['push', '-q', '-u', 'origin', 'feature'], { cwd: repo.path, env: repo.env });

    return repo;
  },
  /**
   * For the AI release notes smoke test: tag `v0.1.0` on the initial history,
   * then a squash-merge-looking commit ("... (#12)") and a plain commit after
   * it, so the range has a PR-cited commit and a plain one.
   */
  releaseNotesReady: (workRoot) => {
    const repo = REPO_KINDS.basic(workRoot);
    repo.run(['tag', 'v0.1.0']);
    repo.commit('Fix crash on startup (#12)', { 'src/app.ts': 'export const value = 2; // fixed\n' });
    repo.commit('Improve docs', { 'README.md': '# Fixture repo\n\nUpdated docs.\n' });
    return repo;
  },
  repoHealth: (workRoot) => {
    const repo = makeRepo(workRoot);
    repo.commit('Initial commit', { 'README.md': '# Fixture repo\n' });

    const bigRel = 'assets/big-file.bin';
    const bigFull = join(repo.path, ...bigRel.split('/'));
    mkdirSync(dirname(bigFull), { recursive: true });
    writeFileSync(bigFull, randomBytes(1024 * 1024));
    repo.run(['add', '-A']);
    repo.run(['commit', '-q', '-m', 'add big blob']);
    repo.run(['rm', '-q', bigRel]);
    repo.run(['commit', '-q', '-m', 'remove big blob']);

    repo.run(['checkout', '-b', 'merged-feature']);
    repo.commit('merged feature work', { 'merged.txt': 'hello\n' });
    repo.run(['checkout', 'main']);
    repo.run(['merge', '-q', '--no-ff', '-m', 'Merge merged-feature', 'merged-feature']);

    repo.run(['checkout', '-b', 'inactive-feature', 'main']);
    repo.commit('old work', { 'old.txt': 'stale\n' });
    repo.run(['checkout', 'main']);

    const bare = join(workRoot, 'health-origin.git');
    execFileSync('git', ['init', '--bare', '-q', '-b', 'main', bare]);
    execFileSync('git', ['remote', 'add', 'origin', bare], { cwd: repo.path, env: repo.env });
    execFileSync('git', ['push', '-q', 'origin', 'main'], { cwd: repo.path, env: repo.env });
    repo.run(['checkout', '-b', 'gone-feature', 'main']);
    repo.commit('gone feature work', { 'gone.txt': 'x\n' });
    execFileSync('git', ['push', '-q', '-u', 'origin', 'gone-feature'], { cwd: repo.path, env: repo.env });
    execFileSync('git', ['push', '-q', 'origin', '--delete', 'gone-feature'], { cwd: repo.path, env: repo.env });
    execFileSync('git', ['fetch', '-q', '--prune'], { cwd: repo.path, env: repo.env });
    repo.run(['checkout', 'main']);

    return repo;
  },
};

// ---------------------------------------------------------------------------
// gh/claude stub scenario (for the AI-resolve smoke test only)
// ---------------------------------------------------------------------------

function claudeStubScenario(workRoot, rules) {
  const dir = mkdtempSync(join(workRoot, 'claude-stub-'));
  const scenarioPath = join(dir, 'scenario.json');
  const logPath = join(dir, 'log.ndjson');
  writeFileSync(scenarioPath, JSON.stringify({ rules }, null, 2));
  writeFileSync(logPath, '');
  return { scenarioPath, logPath };
}

const CLAUDE_LAUNCHER = join(STUB_DIR, process.platform === 'win32' ? 'claude.cmd' : 'claude');
const GH_LAUNCHER = join(STUB_DIR, process.platform === 'win32' ? 'gh.cmd' : 'gh');

/** Generic gh stub scenario: a scenario file can set `needsGhStub: true` and `ghStubRules` (the same rule shape as test/helpers/gh-stub) to have `gh` (per app settings.ghPath) replay canned JSON instead of hitting the network — used by the Issues dialog smoke test. */
function ghStubScenario(workRoot, rules) {
  const dir = mkdtempSync(join(workRoot, 'gh-stub-'));
  const scenarioPath = join(dir, 'scenario.json');
  const logPath = join(dir, 'log.ndjson');
  writeFileSync(scenarioPath, JSON.stringify({ rules }, null, 2));
  writeFileSync(logPath, '');
  return { scenarioPath, logPath };
}

// ---------------------------------------------------------------------------
// Runner
// ---------------------------------------------------------------------------

function hasXvfbRun() {
  if (process.platform !== 'linux') return false;
  return (process.env.PATH || '').split(':').some((dir) => dir && existsSync(join(dir, 'xvfb-run')));
}

/**
 * True when Electron has a display server to talk to. The window is created
 * offscreen, but Ozone still initializes a platform backend and aborts (SIGTRAP,
 * one core dump per scenario) when it finds neither an X nor a Wayland display.
 */
function hasDisplay() {
  if (process.platform !== 'linux') return true;
  return !!(process.env.DISPLAY || process.env.WAYLAND_DISPLAY);
}

function getAtPath(obj, path) {
  return path.split('.').reduce((acc, key) => (acc === null || acc === undefined ? undefined : acc[key]), obj);
}

function checkExpectation(exp, dumps) {
  const dumpText = dumps[exp.dump];
  if (dumpText === undefined) return `dump "${exp.dump}" was never written`;
  let value = dumpText;
  if (exp.jsonPath !== undefined) {
    let parsed;
    try {
      parsed = JSON.parse(dumpText);
    } catch (err) {
      return `dump "${exp.dump}" is not valid JSON: ${err.message}`;
    }
    value = getAtPath(parsed, exp.jsonPath);
  }
  if ('equals' in exp && value !== exp.equals) return `expected ${exp.dump}${exp.jsonPath ? `.${exp.jsonPath}` : ''} to equal ${JSON.stringify(exp.equals)}, got ${JSON.stringify(value)}`;
  if ('truthy' in exp && Boolean(value) !== exp.truthy) return `expected ${exp.dump}${exp.jsonPath ? `.${exp.jsonPath}` : ''} truthiness to be ${exp.truthy}, got ${JSON.stringify(value)}`;
  if ('includes' in exp) {
    const has = typeof value === 'string' || Array.isArray(value) ? value.includes(exp.includes) : false;
    if (!has) return `expected ${exp.dump}${exp.jsonPath ? `.${exp.jsonPath}` : ''} to include ${JSON.stringify(exp.includes)}, got ${JSON.stringify(value)}`;
  }
  if ('atLeast' in exp && !(typeof value === 'number' && value >= exp.atLeast)) return `expected ${exp.dump}${exp.jsonPath ? `.${exp.jsonPath}` : ''} to be >= ${exp.atLeast}, got ${JSON.stringify(value)}`;
  return null;
}

function pngDimensions(path) {
  const buf = readFileSync(path);
  if (buf.length < 24 || buf.toString('ascii', 1, 4) !== 'PNG') return { width: 0, height: 0 };
  return { width: buf.readUInt32BE(16), height: buf.readUInt32BE(20) };
}

async function runElectron(electronPath, cwd, env, timeoutMs) {
  return new Promise((resolvePromise) => {
    const useXvfb = hasXvfbRun();
    const cmd = useXvfb ? 'xvfb-run' : electronPath;
    // `--disable-gpu`: the window is rendered offscreen, so the GPU path buys
    // nothing, and initialising the viz compositor against a virtual display
    // fails intermittently ("Unhandled rejection Error: UnknownVizError" on the
    // first scenario of a CI run, passing on a re-run of the same commit).
    const electronArgs = ['.', '--no-sandbox', '--disable-gpu'];
    const args = useXvfb ? ['-a', electronPath, ...electronArgs] : electronArgs;
    const child = spawn(cmd, args, { cwd, env, stdio: ['ignore', 'pipe', 'pipe'] });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (d) => (stdout += d.toString()));
    child.stderr.on('data', (d) => (stderr += d.toString()));
    const timer = setTimeout(() => {
      child.kill('SIGKILL');
      resolvePromise({ timedOut: true, code: null, stdout, stderr });
    }, timeoutMs);
    child.on('close', (code) => {
      clearTimeout(timer);
      resolvePromise({ timedOut: false, code, stdout, stderr });
    });
  });
}

async function runScenario(scenarioFile, electronPath) {
  const scenario = JSON.parse(readFileSync(scenarioFile, 'utf8'));
  const name = scenario.name;
  const outDir = join(OUT_DIR, name);
  rmSync(outDir, { recursive: true, force: true });
  mkdirSync(outDir, { recursive: true });
  // Resolved to its physical path: on macOS `tmpdir()` is `/var/...`, a symlink
  // to `/private/var`, and the app reports repositories by their physical path
  // (`git rev-parse --show-toplevel` resolves symlinks, as does the watched-folder
  // scanner), so an un-resolved fixture root would never match what a scenario
  // reads back. Every fixture path below is derived from this root.
  const workRoot = realpathSync(mkdtempSync(join(tmpdir(), `gg-smoke-${name}-`)));
  const userData = join(workRoot, 'userdata');
  mkdirSync(userData, { recursive: true });

  const build = REPO_KINDS[scenario.repoKind ?? 'none'];
  const repo = build ? build(workRoot) : null;

  let env = { ...(repo ? repo.env : isolatedEnv(workRoot)), GITGOOD_USER_DATA: userData };
  // `__REPO_PATH__` and `__SEP__` are substituted into seeded settings as well
  // as into step scripts, so a scenario can seed a setting that names the
  // fixture (e.g. a watched folder) and exercise what happens at launch. Here
  // they land inside a JSON string, so both are inserted as escaped text rather
  // than as the JS expressions the step scripts below take.
  const seed = (value) => {
    let json = JSON.stringify(value).split('__SEP__').join(JSON.stringify(sep).slice(1, -1));
    if (repo) json = json.split('__REPO_PATH__').join(JSON.stringify(repo.path).slice(1, -1));
    return JSON.parse(json);
  };
  const settings = scenario.settings ? seed(scenario.settings) : {};

  // Generic claude stub scenario: a scenario file sets `needsClaudeStub: true` and `claudeStubRules`
  // (the same rule shape as test/helpers/gh-stub) to have `claude` (per app settings.ai.claudeCliPath)
  // replay canned structured JSON instead of hitting the network. `--version` always replies so
  // ToolLocator can detect the stub as "installed" regardless of which scenario is running.
  if (scenario.needsClaudeStub) {
    // Fixtures that expose deterministic commit shas (see tidyBranchFixture) let a scenario
    // reference them in its stub response via `__SHA_<LABEL>__` placeholders, the same way
    // `__REPO_PATH__` is substituted into step scripts below.
    let claudeStubRulesRaw = scenario.claudeStubRules ?? [];
    if (repo && repo.shas) {
      let json = JSON.stringify(claudeStubRulesRaw);
      for (const [label, sha] of Object.entries(repo.shas)) json = json.split(`__SHA_${label.toUpperCase()}__`).join(sha);
      claudeStubRulesRaw = JSON.parse(json);
    }
    const rules = [{ match: '--version', stdout: 'gitgood-stub-claude 1.0.0\n' }, ...claudeStubRulesRaw];
    const stub = claudeStubScenario(workRoot, rules);
    env = { ...env, CLAUDE_STUB_SCENARIO: stub.scenarioPath, CLAUDE_STUB_LOG: stub.logPath };
    settings.ai = { ...(settings.ai ?? {}), provider: 'claude-cli', claudeCliPath: CLAUDE_LAUNCHER };
  }

  if (scenario.needsGhStub) {
    const stub = ghStubScenario(workRoot, scenario.ghStubRules ?? []);
    env = { ...env, GH_STUB_SCENARIO: stub.scenarioPath, GH_STUB_LOG: stub.logPath };
    settings.ghPath = GH_LAUNCHER;
  }

  if (Object.keys(settings).length) writeFileSync(join(userData, 'settings.json'), JSON.stringify(settings, null, 2));

  const dumps = {};
  const steps = (scenario.steps ?? []).map((step) => {
    const out = { ...step };
    // `__SEP__` becomes the platform's path separator as a JS string literal, so a
    // scenario builds paths to compare against what the app returns ('\\' on Windows)
    // rather than hard-coding '/'. Node accepts '/' in the paths it is *given*, so
    // `rm` targets need no such treatment.
    if (out.js) out.js = out.js.split('__SEP__').join(JSON.stringify(sep));
    if (out.js && repo) out.js = out.js.split('__REPO_PATH__').join(JSON.stringify(repo.path));
    if (out.rm && repo) out.rm = out.rm.split('__REPO_PATH__').join(repo.path);
    if (out.dump) out.dump = join(outDir, out.dump);
    if (out.shot) out.shot = join(outDir, out.shot);
    return out;
  });

  env.GITGOOD_SMOKE_SCRIPT = JSON.stringify(steps);

  const result = await runElectron(electronPath, ROOT, env, Number(scenario.timeoutMs || TIMEOUT_MS));

  const failures = [];
  if (result.timedOut) failures.push(`electron did not exit within ${scenario.timeoutMs || TIMEOUT_MS}ms`);
  else if (result.code !== 0) failures.push(`electron exited with code ${result.code}`);

  for (const step of steps) {
    if (step.dump) {
      if (!existsSync(step.dump)) {
        failures.push(`expected dump not written: ${step.dump}`);
        continue;
      }
      dumps[step.dump.slice(outDir.length + 1)] = readFileSync(step.dump, 'utf8');
    }
    if (step.shot) {
      if (!existsSync(step.shot)) {
        failures.push(`expected screenshot not written: ${step.shot}`);
        continue;
      }
      const { width, height } = pngDimensions(step.shot);
      if (width <= 0 || height <= 0) failures.push(`screenshot ${step.shot} has empty dimensions (${width}x${height})`);
    }
  }

  for (const exp of scenario.expect ?? []) {
    const err = checkExpectation(exp, dumps);
    if (err) failures.push(err);
  }

  if (failures.length) {
    console.log(`[smoke] --- stdout for ${name} ---\n${result.stdout}`);
    console.log(`[smoke] --- stderr for ${name} ---\n${result.stderr}`);
    writeFileSync(join(outDir, 'stdout.log'), result.stdout);
    writeFileSync(join(outDir, 'stderr.log'), result.stderr);
    // Preserve the app's own log file (main process logger output) for CI upload.
    const logsDir = join(userData, 'logs');
    if (existsSync(logsDir)) cpSync(logsDir, join(outDir, 'logs'), { recursive: true });
  }

  rmSync(workRoot, { recursive: true, force: true });
  return { name, ok: failures.length === 0, failures, outDir };
}

async function main() {
  if (!process.env.GITGOOD_SMOKE_SKIP_BUILD) {
    log('building (electron-vite build)…');
    execFileSync(join(ROOT, 'node_modules', '.bin', 'electron-vite'), ['build'], { cwd: ROOT, stdio: 'inherit' });
  } else {
    log('skipping build (GITGOOD_SMOKE_SKIP_BUILD set)');
  }

  const { default: electronPath } = await import('electron');
  log(`electron binary: ${electronPath}`);
  const useXvfbRun = hasXvfbRun();
  // Without xvfb-run, the direct launch needs a display that actually exists.
  // Failing here beats spawning one doomed Electron per scenario, each of which
  // aborts and dumps a ~4MB core, and reports as an unexplained 0/N run.
  if (!useXvfbRun && !hasDisplay()) {
    console.error('[smoke] no display available: DISPLAY and WAYLAND_DISPLAY are both unset, and xvfb-run is not on PATH.');
    console.error('[smoke] electron cannot start a platform backend and every scenario would abort.');
    console.error('[smoke] fix: run under a desktop session, prefix with DISPLAY=:0, or install xvfb (xorg-server-xvfb).');
    process.exit(1);
  }
  log(useXvfbRun ? 'xvfb-run found on PATH; running under it' : 'xvfb-run not found; launching electron directly (real display session)');

  mkdirSync(OUT_DIR, { recursive: true });

  const allFiles = readdirSync(SCENARIOS_DIR).filter((f) => f.endsWith('.json'));
  const filter = process.env.GITGOOD_SMOKE_FILTER;
  const files = filter ? allFiles.filter((f) => f.includes(filter)) : allFiles;
  if (!files.length) {
    console.error(`[smoke] no scenario files matched (filter=${filter ?? '<none>'})`);
    process.exit(1);
  }

  const results = [];
  for (const file of files) {
    const scenarioPath = join(SCENARIOS_DIR, file);
    const raw = JSON.parse(readFileSync(scenarioPath, 'utf8'));
    if (raw.requiresNetwork) {
      log(`skipping ${raw.name} (requires network / a real GitHub account)`);
      continue;
    }
    log(`running ${raw.name}…`);
    const result = await runScenario(scenarioPath, electronPath);
    results.push(result);
    log(`${result.ok ? 'PASS' : 'FAIL'} ${result.name}${result.ok ? '' : `\n  - ${result.failures.join('\n  - ')}`}`);
  }

  const failed = results.filter((r) => !r.ok);
  log(`${results.length - failed.length}/${results.length} scenarios passed. Artifacts under ${OUT_DIR}`);
  if (failed.length) process.exit(1);
}

main().catch((err) => {
  console.error('[smoke] fatal error:', err);
  process.exit(1);
});
