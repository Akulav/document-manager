'use strict';
// Actualizări din versiunile publicate pe GitHub (Akulav/document-manager).
//
// Fiecare versiune are exact un fișier pe sistem, care instalează prima dată și actualizează ulterior,
// plus SHA256SUMS.txt:
//
//   Windows x64          eManagement-setup.exe     rulat în mod silențios, cu /UPDATE, în același folder
//   Linux x64            eManagement-linux-x64     programul este înlocuit pe loc în folderul de instalare
//   macOS Apple Silicon  eManagement-macos-arm64   programul este înlocuit pe loc în aplicație (re-semnată)
//
// Fișierul descărcat este verificat (SHA-256 din SHA256SUMS.txt și antetul de program al sistemului) înainte să se
// schimbe ceva și este păstrat în folderul aplicației (data/update), niciodată în folderul temporar al sistemului.
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { spawn } = require('node:child_process');
const { VERSION, packaged, installRoot } = require('./install');

const REPO = 'Akulav/document-manager';
const LATEST_API = `https://api.github.com/repos/${REPO}/releases/latest`;
const ASSETS = { win32: 'eManagement-setup.exe', linux: 'eManagement-linux-x64', darwin: 'eManagement-macos-arm64' };
const SUMS = 'SHA256SUMS.txt';
const FIRST_CHECK_MS = 60 * 1000;
const CHECK_EVERY_MS = 6 * 3600 * 1000;

const assetName = () => ASSETS[process.platform] || null;

// "1.10.0" > "1.9.3"; un sufix (-beta) nu contează la comparație.
function isNewer(remote, current) {
  const parse = (v) => String(v).replace(/^v/i, '').split(/[-+]/)[0].split('.').map((x) => parseInt(x, 10) || 0);
  const a = parse(remote);
  const b = parse(current);
  for (let i = 0; i < Math.max(a.length, b.length); i++) {
    const x = a[i] || 0;
    const y = b[i] || 0;
    if (x !== y) return x > y;
  }
  return false;
}

// Suma unui fișier din SHA256SUMS.txt (linii „<hex>  <nume>” sau „<hex> *<nume>”).
function findSum(text, name) {
  for (const line of String(text).split(/\r?\n/)) {
    const [hash, file] = line.trim().split(/\s+/);
    if (file && file.replace(/^\*/, '') === name && /^[0-9a-f]{64}$/i.test(hash)) return hash.toLowerCase();
  }
  return null;
}

function looksLikeProgram(head) {
  if (process.platform === 'win32') return head[0] === 0x4d && head[1] === 0x5a; // MZ
  if (process.platform === 'darwin') {
    const m = head.subarray(0, 4).toString('hex');
    return m === 'cffaedfe' || m === 'cafebabe';
  }
  return head.subarray(0, 4).equals(Buffer.from([0x7f, 0x45, 0x4c, 0x46])); // ELF
}

const state = { current: VERSION, latest: null, available: false, checkedAt: null, error: null, busy: false, canApply: packaged };

async function getJson(url) {
  const r = await fetch(url, { headers: { Accept: 'application/vnd.github+json', 'User-Agent': 'eManagement-updater' } });
  if (r.status === 404) throw new Error('nu există încă nicio versiune publicată');
  if (!r.ok) throw new Error(`GitHub a răspuns ${r.status}`);
  return r.json();
}

async function check() {
  const asset = assetName();
  try {
    const rel = await getJson(LATEST_API);
    if (rel.draft || rel.prerelease) return state;
    const version = String(rel.tag_name || '').replace(/^v/i, '');
    const file = (rel.assets || []).find((a) => a.name === asset);
    const sums = (rel.assets || []).find((a) => a.name === SUMS);
    state.latest = version;
    state.available = !!(file && sums && isNewer(version, VERSION));
    state.release = state.available ? { version, url: file.browser_download_url, sums: sums.browser_download_url, page: rel.html_url } : null;
    state.error = null;
  } catch (e) {
    state.error = 'Verificarea actualizărilor a eșuat: ' + e.message;
  }
  state.checkedAt = new Date().toISOString().replace('T', ' ').slice(0, 19); // UTC, ca datele din baza de date
  return state;
}

function schedule() {
  setTimeout(() => {
    check();
    setInterval(check, CHECK_EVERY_MS).unref();
  }, FIRST_CHECK_MS).unref();
}

const publicState = () => {
  const { release, ...s } = state;
  return { ...s, page: release && release.page };
};

// Descarcă și verifică fișierul acestui sistem în data/update. Întoarce calea lui.
async function download(dataDir) {
  const rel = state.release;
  if (!rel) throw new Error('Nu există o versiune mai nouă.');
  const sumsRes = await fetch(rel.sums, { headers: { 'User-Agent': 'eManagement-updater' } });
  if (!sumsRes.ok) throw new Error('Sumele de control nu au putut fi descărcate.');
  const want = findSum(await sumsRes.text(), assetName());
  if (!want) throw new Error('Versiunea nu are sumă de control pentru ' + assetName() + '.');

  const dir = path.join(dataDir, 'update');
  fs.mkdirSync(dir, { recursive: true });
  const file = path.join(dir, assetName());
  const res = await fetch(rel.url, { headers: { 'User-Agent': 'eManagement-updater' } });
  if (!res.ok || !res.body) throw new Error('Descărcarea a eșuat (' + res.status + ').');
  const hash = crypto.createHash('sha256');
  const out = fs.createWriteStream(file);
  let head = Buffer.alloc(0);
  for await (const chunk of res.body) {
    const buf = Buffer.from(chunk);
    if (head.length < 4) head = Buffer.concat([head, buf]).subarray(0, 4);
    hash.update(buf);
    if (!out.write(buf)) await new Promise((r) => out.once('drain', r));
  }
  await new Promise((resolve, reject) => out.end((e) => (e ? reject(e) : resolve())));
  if (hash.digest('hex') !== want || !looksLikeProgram(head)) {
    fs.rmSync(file, { force: true });
    throw new Error('Fișierul descărcat nu corespunde sumei de control publicate; a fost șters, nu s-a schimbat nimic.');
  }
  return file;
}

// Aplică actualizarea descărcată, apoi `stop()` oprește serverul curent (noua versiune repornește singură).
// Windows: setup-ul rulează silențios în același folder și pornește noua versiune.
// Linux/macOS: programul este înlocuit pe loc (cel vechi rămâne „.old” până la pornirea următoare) și repornit;
// sub systemd (INVOCATION_ID), serviciul îl repornește singur.
function apply(file, stop) {
  const exe = process.execPath;
  const root = installRoot();
  if (process.platform === 'win32') {
    const args = ['/VERYSILENT', '/SUPPRESSMSGBOXES', '/NORESTART', '/CLOSEAPPLICATIONS', '/UPDATE', `/FROM=${VERSION}`, `/DIR=${root}`];
    spawn(file, args, { detached: true, stdio: 'ignore', windowsHide: true }).unref();
    return stop('actualizare');
  }
  const old = exe + '.old';
  fs.rmSync(old, { force: true });
  fs.renameSync(exe, old);
  try {
    fs.renameSync(file, exe);
  } catch {
    try {
      fs.copyFileSync(file, exe);
      fs.rmSync(file, { force: true });
    } catch (e) {
      fs.renameSync(old, exe); // nimic nu s-a schimbat
      throw e;
    }
  }
  fs.chmodSync(exe, 0o755);
  if (process.platform === 'darwin') {
    const app = require('./install').bundleOf(exe);
    if (app) spawn('/usr/bin/codesign', ['--force', '--deep', '-s', '-', app], { stdio: 'ignore' });
  }
  if (!process.env.INVOCATION_ID) {
    const args = process.argv.slice(2).filter((a) => a !== '--after-update' && a !== '--no-browser');
    spawn(exe, [...args, '--after-update', '--no-browser'], { detached: true, stdio: 'inherit', cwd: root }).unref();
  }
  return stop('actualizare');
}

module.exports = { REPO, ASSETS, SUMS, assetName, isNewer, findSum, looksLikeProgram, check, schedule, publicState, download, apply, state };
