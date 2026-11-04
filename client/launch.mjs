// DFO Overlay - the desktop client's launcher. Each launch:
//
//   1. UPDATE   fetch the game's releases (the app-v* tags - every merge to main cuts one and deploys the live client)
//               and replay the overlay's own commits onto the newest, which works even if the game's history was replaced.
//               The branch only ADDS files (src/devtools/overlay), so a release never conflicts with it; if one ever
//               does, the replay is undone and the last good build plays.
//   2. BUILD    when the code changed since the last build: the game's own build plus the overlay
//               (src/devtools/overlay/vite.overlay.config.js), into dist-next/, swapped in only when it succeeds.
//   3. PLAY     the repo's own desktop shell (app/, run from source, so it loads this dist/): its own data folder
//               (%APPDATA%\DFO Overlay - never the official install's), its self-updater off (it would offer the
//               official build), ARENA2 pointed at the Steam copy on first run.
//   4. SETTINGS the official game's settings files (SETTINGS_FILES - settings, keybinds, UI, hotbar, Overworld and travel
//               prefs, waypoints; never a save, a character, the realm or the login) are shared with it: before play the
//               newer copy of each comes in from the official profile, and when the game closes the newer copy goes
//               back. A hidden helper (--run-game) holds the game and does the second half.
//
//   node launch.mjs [--no-update] [--rebuild] [--no-launch]

import { spawnSync, spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const GAME = path.resolve(HERE, '..', 'game');
const APP = path.join(GAME, 'app');
const BRANCH = 'overlay-dev';
const STATE_FILE = path.join(HERE, 'state.json');
const USER_DATA = path.join(process.env.APPDATA ?? path.join(HERE, 'userData'), 'DFO Overlay');
const ARENA2_DEFAULT = 'C:\\Program Files (x86)\\Steam\\steamapps\\common\\The Elder Scrolls Daggerfall\\DF\\DAGGER\\ARENA2';
const VITE = path.join(GAME, 'node_modules', 'vite', 'bin', 'vite.js');
const OVERLAY_CONFIG = 'src/devtools/overlay/vite.overlay.config.js';
// The official install's data folder (app/main.cjs: <appData>/Daggerfall JavaScript) and the pref files shared with it.
// Settings only - by name, so a save, a character, the realm's records or the login can never ride along.
const OFFICIAL_DATA = path.join(process.env.APPDATA ?? '', 'Daggerfall JavaScript');
const SETTINGS_FILES = [
  'dagger.settings.v1', 'dagger.keybinds', 'dagger.ui.v1', 'dfjs-mod-settings', 'dfdecor-hotbar',
  'dfjs.overworld.filters', 'dfjs.overworld.pathMode', 'dfjs.overworld.who', 'dfjs.travel.pace2', 'dfjs.waypoints',
];

const flags = new Set(process.argv.slice(2));
const logDir = path.join(HERE, 'logs');
fs.mkdirSync(logDir, { recursive: true });
const logFile = path.join(logDir, `launch-${new Date().toISOString().slice(0, 10)}.log`);
let attention = false;   // something the player should read: the console stays open

const say = (msg, warn = false) => {
  if (warn) attention = true;
  const line = `${warn ? '!! ' : ''}${msg}`;
  console.log(line);
  fs.appendFileSync(logFile, `[${new Date().toISOString()}] ${line}\n`);
};
const run = (cmd, args, opts = {}) => {
  const r = spawnSync(cmd, args, { cwd: GAME, encoding: 'utf8', windowsHide: true, ...opts });
  if (r.stdout) fs.appendFileSync(logFile, r.stdout);
  if (r.stderr) fs.appendFileSync(logFile, r.stderr);
  return { ok: r.status === 0, out: (r.stdout ?? '').trim(), err: (r.stderr ?? '').trim() };
};
const git = (...args) => run('git', args, { env: { ...process.env, GIT_EDITOR: 'true', GIT_TERMINAL_PROMPT: '0' } });
const loadState = () => { try { return JSON.parse(fs.readFileSync(STATE_FILE, 'utf8')); } catch { return {}; } };
const saveState = (s) => fs.writeFileSync(STATE_FILE, JSON.stringify(s, null, 2));
const fileHash = (f) => { try { return crypto.createHash('sha1').update(fs.readFileSync(f)).digest('hex'); } catch { return null; } };

/** Uncommitted work in the game tree: tracked edits, and untracked files under src/ (a new overlay file). */
function dirtyState() {
  const tracked = git('status', '--porcelain', '--untracked-files=no').out;
  const fresh = git('ls-files', '--others', '--exclude-standard', '--', 'src').out;
  return { dirty: !!(tracked || fresh), tracked, fresh };
}

/** What a build is OF: the commit, and the uncommitted edits on top of it when there are any. */
function buildKey(d) {
  const head = git('rev-parse', 'HEAD').out;
  if (!d.dirty) return head;
  const h = crypto.createHash('sha1').update(head).update(git('diff', 'HEAD').out);
  for (const f of d.fresh.split('\n').filter(Boolean)) h.update(f).update(fileHash(path.join(GAME, f)) ?? '');
  return `${head}+${h.digest('hex').slice(0, 12)}`;
}

const commitOf = (ref) => git('rev-parse', `${ref}^{commit}`).out;

/** The release the overlay's own commits sit on. state.base is a commit, because a tag can move on GitHub. */
function overlayBase(state, latest) {
  for (const ref of [state.base, state.release]) {
    if (ref && git('merge-base', '--is-ancestor', ref, 'HEAD').ok) return ref;
  }
  return git('merge-base', 'HEAD', latest).out;
}

function update(state) {
  const branch = git('symbolic-ref', '--short', 'HEAD').out;
  if (branch !== BRANCH) { say(`The game folder is on "${branch}", not ${BRANCH} - not updating.`, true); return; }
  const d = dirtyState();
  if (d.dirty) { say('There are uncommitted overlay edits - building them as they are; updating waits until they are committed.', true); return; }
  say('Checking for a game update...');
  // --force: one release tag moved on GitHub must not fail the whole update
  const fetched = git('fetch', '--force', 'origin', '--tags');
  if (!fetched.ok) { say(`Could not fetch the game's releases - playing the build you have. (${fetched.err.split('\n').pop()})`, true); return; }
  // Only tags on the game's current main: a tag left over from a replaced history never counts as the newest
  const latest = git('tag', '-l', 'app-v*', '--merged', 'origin/main', '--sort=-v:refname').out.split('\n')[0];
  if (!latest) { say('No release tags found - not updating.', true); return; }
  if (git('merge-base', '--is-ancestor', latest, 'HEAD').ok) { say(`Up to date (${latest}).`); state.release = latest; state.base = commitOf(latest); return; }
  const base = overlayBase(state, latest);
  if (!base) {
    say(`Cannot tell which commits are the overlay's, so the update to ${latest} was skipped and the last good build plays.`, true);
    state.blocked = latest;
    return;
  }
  const locks = [fileHash(path.join(GAME, 'package-lock.json')), fileHash(path.join(APP, 'package-lock.json'))];
  say(`Updating to ${latest}...`);
  // Only the overlay's own commits move, so this also works when the game's history was replaced
  if (!git('rebase', '--onto', latest, base).ok) {
    git('rebase', '--abort');
    say(`The update to ${latest} conflicts with the overlay's changes - it was undone, and the last good build plays. (Details: ${logFile})`, true);
    state.blocked = latest;
    return;
  }
  delete state.blocked;
  state.release = latest;
  state.base = commitOf(latest);
  say(`Updated to ${latest}.`);
  // A release that changed the dependencies: install them, by the lockfile
  if (fileHash(path.join(GAME, 'package-lock.json')) !== locks[0]) {
    say('Dependencies changed - installing...');
    if (!run('npm', ['ci', '--no-audit', '--no-fund'], { shell: true }).ok) say('npm ci failed in the game folder (see the log).', true);
  }
  if (fileHash(path.join(APP, 'package-lock.json')) !== locks[1]) {
    say('Desktop shell dependencies changed - installing...');
    if (!run('npm', ['ci', '--no-audit', '--no-fund'], { shell: true, cwd: APP }).ok) say('npm ci failed in app/ (see the log).', true);
  }
}

/** Windows refuses a folder rename while a scanner or indexer still reads the fresh build: wait and try again. */
function renameRetry(from, to) {
  for (let i = 0; ; i++) {
    try { return fs.renameSync(from, to); } catch (e) {
      if (!['EPERM', 'EBUSY', 'EACCES'].includes(e.code) || i >= 10) throw e;
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 500);
    }
  }
}

function build(state) {
  const dist = path.join(GAME, 'dist'), next = path.join(GAME, 'dist-next'), prev = path.join(GAME, 'dist-prev');
  const d = dirtyState();
  const key = buildKey(d);
  const have = fs.existsSync(path.join(dist, 'play', 'index.html'));
  if (have && state.built === key && !flags.has('--rebuild')) { say('Build is current.'); return true; }
  say('Building the game with the overlay (about a minute)...');
  // The player's update number (a shallow clone cannot derive it, and the build stamps null)
  const num = state.release ? run('node', ['scripts/updateNumber.mjs', state.release]).out : '';
  const env = { ...process.env, ...(/^\d+\.\d+\.\d+$/.test(num) ? { DFO_UPDATE: num } : {}) };
  let ok = false;
  try {
    if (!run('node', ['scripts/buildTag.mjs'], { env }).ok) throw new Error('buildTag failed');
    const r = run('node', [VITE, 'build', '--config', OVERLAY_CONFIG, '--outDir', 'dist-next', '--emptyOutDir'], { env });
    if (!r.ok || !fs.existsSync(path.join(next, 'play', 'index.html'))) throw new Error((r.err || r.out).split('\n').filter((l) => /error/i.test(l)).slice(0, 4).join('\n') || 'vite build failed');
    ok = true;
  } catch (e) {
    say(`The build failed - ${have ? 'the last good build plays' : 'there is no build to play'}. ${e.message}\n   (Details: ${logFile})`, true);
  } finally {
    git('checkout', '--', 'src/buildTag.js');   // the stamp is the build's, never the tree's (package.json postbuild)
  }
  if (!ok) return have;
  fs.rmSync(prev, { recursive: true, force: true });
  try {
    if (have) renameRetry(dist, prev);
    renameRetry(next, dist);
  } catch (e) {
    if (!fs.existsSync(dist) && fs.existsSync(prev)) fs.renameSync(prev, dist);
    say(`The new build could not replace the old one (${e.code}). Close the game and any window open on game\\dist, then start again.`, true);
    return have;
  }
  fs.rmSync(prev, { recursive: true, force: true });
  state.built = key;
  say('Build ready.');
  return true;
}

/** First run: the client's own data folder, with ARENA2 pointed at the Steam copy (the shell's config.json). */
function prepareUserData() {
  fs.mkdirSync(USER_DATA, { recursive: true });
  const cfgFile = path.join(USER_DATA, 'config.json');
  let cfg = {};
  try { cfg = JSON.parse(fs.readFileSync(cfgFile, 'utf8')); } catch { /* first run */ }
  if (!cfg.arena2Path && fs.existsSync(ARENA2_DEFAULT)) {
    cfg.arena2Path = ARENA2_DEFAULT;
    fs.writeFileSync(cfgFile, JSON.stringify(cfg, null, 2));
    say(`ARENA2: ${ARENA2_DEFAULT}`);
  }
}

/** Each shared settings file, the newer copy over the older (from -> to only). The copy keeps its source's time, so the
 *  next sync finds the two equal and leaves them be. Answers the names copied. */
function syncSettings(fromData, toData) {
  const from = path.join(fromData, 'Prefs'), to = path.join(toData, 'Prefs');
  const copied = [];
  for (const name of SETTINGS_FILES) {
    const src = path.join(from, name), dst = path.join(to, name);
    try {
      const s = fs.statSync(src);
      let d = null;
      try { d = fs.statSync(dst); } catch { /* not there yet */ }
      if (d && s.mtimeMs <= d.mtimeMs + 1000) continue;
      fs.mkdirSync(to, { recursive: true });
      const tmp = `${dst}.sync-tmp`;
      fs.copyFileSync(src, tmp);
      fs.utimesSync(tmp, s.atime, s.mtime);
      fs.renameSync(tmp, dst);
      copied.push(name);
    } catch { /* no such setting there, or a locked file: the next sync tries again */ }
  }
  return copied;
}

const electronExe = () => {
  try { return path.join(APP, 'node_modules', 'electron', 'dist', fs.readFileSync(path.join(APP, 'node_modules', 'electron', 'path.txt'), 'utf8').trim()); } catch { return null; }
};

function launch() {
  const exe = electronExe();
  if (!exe || !fs.existsSync(exe)) { say('Electron is not installed in game/app - run "npm ci" there.', true); return false; }
  if (fs.existsSync(OFFICIAL_DATA)) {
    const got = syncSettings(OFFICIAL_DATA, USER_DATA);
    if (got.length) say(`Settings from the official game: ${got.join(', ')}`);
  }
  // The helper holds the game, hidden, and sends changed settings back when it closes
  spawn(process.execPath, [fileURLToPath(import.meta.url), '--run-game'], { cwd: HERE, detached: true, stdio: 'ignore', windowsHide: true }).unref();
  say('DFO Overlay is starting. Press Insert in game for the overlay.');
  return true;
}

/** --run-game: the hidden helper. The game runs as its child; when it closes, the settings changed in it go back. */
function runGame() {
  const env = { ...process.env, DAGGER_USER_DATA: USER_DATA, DAGGER_NO_UPDATE_CHECK: '1' };
  delete env.DAGGER_DEV_URL;
  const child = spawn(electronExe(), [APP], { cwd: APP, env, stdio: 'ignore', windowsHide: false });
  const back = () => {
    if (!fs.existsSync(OFFICIAL_DATA)) return;
    const sent = syncSettings(USER_DATA, OFFICIAL_DATA);
    if (sent.length) say(`Settings sent back to the official game: ${sent.join(', ')}`);
  };
  child.on('exit', back);
  child.on('error', (e) => say(`The game could not start: ${e.message}`, true));
}

if (flags.has('--run-game')) { runGame(); } else {
const state = loadState();
say(`── DFO Overlay ${new Date().toLocaleString()} ──`);
if (!flags.has('--no-update')) update(state);
const playable = build(state);
saveState(state);
if (playable && !flags.has('--no-launch')) prepareUserData(), launch();
process.exitCode = !playable ? 2 : attention ? 1 : 0;
}
