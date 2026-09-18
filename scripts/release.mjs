#!/usr/bin/env node
/**
 * Drives the two halves of a release (see docs/RELEASING.md), with the checks
 * that stop the two ways a release silently ships nothing:
 *
 *   node scripts/release.mjs prepare 0.1.2   bump package.json + lockfile on a
 *                                            release branch, push it, open a PR
 *   node scripts/release.mjs tag             tag main at package.json's version
 *                                            and push, which starts the build
 *
 * The workflow publishes to a DRAFT release; review and publish it by hand.
 *
 * Flags:
 *   --yes        skip the confirmation prompt (required when not on a TTY)
 *   --no-verify  skip the "is CI green on main" check in tag mode
 */
import { execFileSync } from 'node:child_process';
import { createInterface } from 'node:readline/promises';
import { readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');

const run = (cmd, args, opts = {}) => execFileSync(cmd, args, { cwd: ROOT, encoding: 'utf8', ...opts }).trim();
const git = (...args) => run('git', args);
const log = (msg) => console.log(`[release] ${msg}`);

function fail(msg, hint) {
  console.error(`[release] ${msg}`);
  if (hint) console.error(`[release] ${hint}`);
  process.exit(1);
}

const pkgVersion = () => JSON.parse(readFileSync(join(ROOT, 'package.json'), 'utf8')).version;

async function confirm(question, yes) {
  if (yes) return;
  if (!process.stdin.isTTY) fail('Refusing to continue without confirmation.', 'Re-run with --yes when there is no terminal to ask at.');
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  const answer = await rl.question(`[release] ${question} [y/N] `);
  rl.close();
  if (!/^y(es)?$/i.test(answer.trim())) fail('Aborted.');
}

/** Clean tree, and the branch we expect, in sync with its remote. */
function requireBranch(branch) {
  if (git('status', '--porcelain')) fail('The working tree has uncommitted changes.', 'Commit or stash them first — the tag has to point at exactly what gets built.');
  const current = git('rev-parse', '--abbrev-ref', 'HEAD');
  if (current !== branch) fail(`On branch ${current}, expected ${branch}.`);
  git('fetch', 'origin', branch, '--tags');
  if (git('rev-parse', 'HEAD') !== git('rev-parse', `origin/${branch}`)) {
    fail(`Local ${branch} and origin/${branch} have diverged.`, `Pull or push so the tag lands on the same commit CI builds.`);
  }
}

function requireTagFree(tag) {
  if (git('tag', '--list', tag)) fail(`Tag ${tag} already exists locally.`);
  if (run('git', ['ls-remote', '--tags', 'origin', tag])) {
    fail(`Tag ${tag} already exists on origin.`, 'A release cannot be re-cut under the same version: bump to the next one.');
  }
}

function compareVersions(a, b) {
  const pa = a.split('.').map(Number);
  const pb = b.split('.').map(Number);
  for (let i = 0; i < 3; i++) if (pa[i] !== pb[i]) return pa[i] - pb[i];
  return 0;
}

async function prepare(version, { yes }) {
  if (!/^\d+\.\d+\.\d+$/.test(version)) fail(`"${version}" is not a x.y.z version.`);
  const current = pkgVersion();
  if (compareVersions(version, current) <= 0) fail(`package.json is already ${current}; ${version} would not move it forward.`);
  requireBranch('main');
  requireTagFree(`v${version}`);

  const branch = `release/v${version}`;
  if (git('branch', '--list', branch)) fail(`Branch ${branch} already exists.`);

  await confirm(`Bump ${current} → ${version} on ${branch} and open a PR?`, yes);

  git('switch', '-c', branch);
  // npm keeps package-lock.json's two version fields in step; hand-editing package.json alone leaves them stale.
  run('npm', ['version', version, '--no-git-tag-version']);
  git('add', 'package.json', 'package-lock.json');
  git('commit', '-m', `chore: release v${version}`);
  git('push', '-u', 'origin', branch);
  log(`pushed ${branch}`);

  const body = `Bumps \`package.json\` to ${version}. Merging this arms the release: once it is on \`main\`, run \`npm run release:tag\` to push the \`v${version}\` tag, which builds the platforms and drafts the GitHub Release.`;
  try {
    const url = run('gh', ['pr', 'create', '--base', 'main', '--head', branch, '--title', `chore: release v${version}`, '--body', body]);
    log(`opened ${url}`);
  } catch {
    log('could not open the PR with gh — open it by hand from the pushed branch.');
  }
  log(`next: merge the PR, switch back to main, pull, then \`npm run release:tag\`.`);
}

/** The workflow only typechecks, so a red Test run on main would otherwise reach a release unnoticed. */
function requireGreenCi() {
  let runs;
  try {
    runs = JSON.parse(run('gh', ['run', 'list', '--branch', 'main', '--workflow', 'Test', '--limit', '1', '--json', 'conclusion,status,headSha,url']));
  } catch {
    log('could not reach gh to check CI — skipping that check.');
    return;
  }
  const [latest] = runs;
  if (!latest) return log('no Test run found for main — skipping that check.');
  const head = git('rev-parse', 'HEAD');
  if (latest.headSha !== head) log(`warning: the latest Test run is for ${latest.headSha.slice(0, 7)}, not HEAD.`);
  if (latest.status !== 'completed') fail(`The Test run on main is still ${latest.status}.`, `${latest.url} — wait for it, or pass --no-verify.`);
  if (latest.conclusion !== 'success') fail(`The Test run on main concluded "${latest.conclusion}".`, `${latest.url} — fix it, or pass --no-verify.`);
}

async function tag({ yes, verify }) {
  requireBranch('main');
  const version = pkgVersion();
  const tagName = `v${version}`;
  requireTagFree(tagName);
  if (verify) requireGreenCi();

  const previous = git('describe', '--tags', '--abbrev=0').trim();
  log(`tagging ${git('rev-parse', '--short', 'HEAD')} as ${tagName} (previous: ${previous})`);
  log(git('log', '--oneline', `${previous}..HEAD`) || '(no commits since the previous tag)');
  await confirm(`Push ${tagName}? This starts the release build.`, yes);

  git('tag', tagName);
  git('push', 'origin', tagName);
  log(`pushed ${tagName} — the build is starting.`);
  try {
    log(`watch: ${run('gh', ['repo', 'view', '--json', 'url', '-q', '.url'])}/actions/workflows/release.yml`);
  } catch {
    /* gh is optional here */
  }
  log('when it finishes, review the DRAFT release, add notes, and publish it from the Releases page.');
  log('do not create the release from the Releases page yourself — that publishes the tag and every asset upload is skipped.');
}

const [mode, ...rest] = process.argv.slice(2);
const flags = { yes: rest.includes('--yes'), verify: !rest.includes('--no-verify') };
const positional = rest.filter((a) => !a.startsWith('--'));

if (mode === 'prepare') await prepare(positional[0] ?? fail('Usage: node scripts/release.mjs prepare <version>'), flags);
else if (mode === 'tag') await tag(flags);
else fail('Usage: node scripts/release.mjs <prepare <version>|tag> [--yes] [--no-verify]');
