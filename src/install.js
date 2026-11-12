'use strict';
// Unde se află aplicația: instalare, actualizare pe loc și dezinstalare.
//
// Un singur fișier pe sistem instalează și actualizează:
//   * Windows: eManagement-setup.exe (Inno Setup, installer/emanagement.iss). Prima rulare întreabă folderul de
//     instalare; rulările următoare și actualizările din aplicație (/UPDATE) îl refolosesc fără să mai întrebe.
//   * Linux / macOS: programul însuși. Pornit din afara unui folder de instalare (Descărcări), întreabă în terminal
//     unde să se instaleze (sau `--install <folder>` fără întrebări, pentru servere) și se copiază acolo. Un program
//     mai nou pornit ulterior se oferă să actualizeze instalarea găsită.
//
// Folderul ales este singurul în care aplicația scrie: programul, baza de date, fișierele încărcate, actualizările
// descărcate și jurnalul serverului stau toate în el (datele în <folder>/data). În afara lui există doar intrările
// sistemului pentru o aplicație instalată: scurtăturile și intrarea din „Aplicații” (Windows), intrarea din meniu
// (Linux).
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const { spawnSync, spawn } = require('node:child_process');

const NAME = 'e-Management ANSC';
const VERSION = require('../package.json').version;
const EXE = process.platform === 'win32' ? 'eManagement.exe' : 'eManagement';
const APP_ID = 'emanagement';
const MARKER = '.emanagement-install';

let isSea = false;
try {
  isSea = require('node:sea').isSea();
} catch {}
// Programul publicat (un singur executabil). Din surse (`npm start`) nu se instalează și nu se actualizează.
const packaged = isSea;

// `X.app/Contents/MacOS/<program>` → `X.app`
function bundleOf(exe) {
  const macos = path.dirname(exe);
  const contents = path.dirname(macos);
  const app = path.dirname(contents);
  return path.basename(macos) === 'MacOS' && path.basename(contents) === 'Contents' && app.endsWith('.app') ? app : null;
}

// Folderul unui program: al lui, sau pentru unul din `X.app` folderul care conține `X.app`.
function rootOfExe(exe) {
  const app = bundleOf(exe);
  return app ? path.dirname(app) : path.dirname(exe);
}

const bundleIn = (root) => path.join(root, NAME + '.app');
const installedProgram = (root) => (process.platform === 'darwin' ? path.join(bundleIn(root), 'Contents', 'MacOS', EXE) : path.join(root, EXE));
const isInstallRoot = (dir) => fs.existsSync(path.join(dir, MARKER));
// Folderul în care rulează programul publicat (din surse: rădăcina proiectului).
const installRoot = () => (packaged ? rootOfExe(process.execPath) : path.join(__dirname, '..'));

function defaultDir() {
  if (process.platform === 'win32') return path.join(process.env.LOCALAPPDATA || os.homedir(), 'Programs', 'eManagement');
  if (process.platform === 'darwin') return path.join(os.homedir(), 'Applications', 'eManagement');
  return path.join(process.env.XDG_DATA_HOME || path.join(os.homedir(), '.local', 'share'), 'eManagement');
}

const desktopFile = () => path.join(process.env.XDG_DATA_HOME || path.join(os.homedir(), '.local', 'share'), 'applications', APP_ID + '.desktop');

// Folderul unei instalări existente: din intrarea de meniu (Linux) sau folderul implicit.
function existingInstall() {
  const candidates = [];
  if (process.platform === 'linux') {
    try {
      const exec = fs.readFileSync(desktopFile(), 'utf8').match(/^Exec=(.*)$/m);
      if (exec) candidates.push(path.dirname(exec[1].trim().replace(/^"|"$/g, '').replace(/\\(.)/g, '$1')));
    } catch {}
  }
  candidates.push(defaultDir());
  return candidates.find((d) => isInstallRoot(d) && fs.existsSync(installedProgram(d))) || null;
}

function versionOf(program) {
  const r = spawnSync(program, ['--version'], { encoding: 'utf8', timeout: 15000 });
  const m = /(\d+\.\d+\.\d+)/.exec(r.stdout || '');
  return m ? m[1] : null;
}

function expandHome(text) {
  const t = String(text || '').trim();
  return t === '~' || t.startsWith('~/') ? path.join(os.homedir(), t.slice(2)) : t;
}

// Verifică un folder introdus de utilizator.
function parseDir(text) {
  const dir = expandHome(text);
  if (!dir) throw new Error('Alegeți un folder.');
  if (!path.isAbsolute(dir)) throw new Error('Folosiți o cale completă, de exemplu ~/eManagement.');
  if (path.dirname(dir) === dir) throw new Error('Alegeți un folder, nu rădăcina discului.');
  if (fs.existsSync(dir) && !fs.statSync(dir).isDirectory()) throw new Error('Este un fișier, nu un folder.');
  return path.resolve(dir);
}

function iconPng() {
  try {
    return require('node:sea').getAsset('icon.png');
  } catch {
    return fs.readFileSync(path.join(__dirname, '..', 'assets', 'icon.png'));
  }
}

// Linux: intrarea din meniu (cu terminal, ca serverul să poată fi oprit) și pictograma, păstrată în folderul aplicației.
function linuxIntegrate(root, program) {
  const icon = path.join(root, APP_ID + '.png');
  fs.writeFileSync(icon, iconPng());
  const q = (p) => '"' + p.replace(/(["`$\\])/g, '\\$1') + '"';
  const entry =
    '[Desktop Entry]\nType=Application\nName=' + NAME + '\nGenericName=Management documente\n' +
    'Comment=Sistem intern de management al documentelor - made by Akulav\n' +
    `Exec=${q(program)}\nPath=${root}\nIcon=${icon}\nTerminal=true\nCategories=Office;\nStartupWMClass=${APP_ID}\n`;
  fs.mkdirSync(path.dirname(desktopFile()), { recursive: true });
  fs.writeFileSync(desktopFile(), entry, { mode: 0o755 });
  spawnSync('update-desktop-database', [path.dirname(desktopFile())], { stdio: 'ignore' });
}

// macOS: aplicația (fără fereastră proprie: serverul rulează în fundal și deschide browserul).
function macBundle(root) {
  const app = bundleIn(root);
  fs.mkdirSync(path.join(app, 'Contents', 'Resources'), { recursive: true });
  // .icns cu imaginea PNG de 256 px (ic08)
  const png = iconPng();
  const head = Buffer.alloc(16);
  head.write('icns', 0);
  head.writeUInt32BE(16 + png.length, 4);
  head.write('ic08', 8);
  head.writeUInt32BE(8 + png.length, 12);
  fs.writeFileSync(path.join(app, 'Contents', 'Resources', 'icon.icns'), Buffer.concat([head, png]));
  fs.writeFileSync(
    path.join(app, 'Contents', 'Info.plist'),
    `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>CFBundleName</key><string>${NAME}</string>
  <key>CFBundleDisplayName</key><string>${NAME}</string>
  <key>CFBundleIdentifier</key><string>com.akulav.emanagement</string>
  <key>CFBundleExecutable</key><string>${EXE}</string>
  <key>CFBundleIconFile</key><string>icon</string>
  <key>CFBundlePackageType</key><string>APPL</string>
  <key>CFBundleShortVersionString</key><string>${VERSION}</string>
  <key>CFBundleVersion</key><string>${VERSION}</string>
  <key>NSHumanReadableCopyright</key><string>Made by Akulav</string>
  <key>LSMinimumSystemVersion</key><string>12.0</string>
  <key>LSBackgroundOnly</key><true/>
</dict>
</plist>
`
  );
  spawnSync('/usr/bin/codesign', ['--force', '--deep', '-s', '-', app], { stdio: 'ignore' });
}

// Copiază acest program în `root` (sau actualizează copia de acolo) și îl marchează ca folder de instalare.
function installTo(root) {
  fs.mkdirSync(root, { recursive: true });
  const program = installedProgram(root);
  fs.mkdirSync(path.dirname(program), { recursive: true });
  if (path.resolve(program) !== path.resolve(process.execPath)) {
    const staged = program + '.new';
    fs.copyFileSync(process.execPath, staged);
    fs.chmodSync(staged, 0o755);
    if (fs.existsSync(program)) {
      fs.rmSync(program + '.old', { force: true });
      fs.renameSync(program, program + '.old'); // un program care rulează poate fi redenumit
    }
    fs.renameSync(staged, program);
  }
  if (process.platform === 'linux') linuxIntegrate(root, program);
  if (process.platform === 'darwin') macBundle(root);
  fs.writeFileSync(path.join(root, MARKER), VERSION);
  return program;
}

function startInstalled(root, args) {
  const program = installedProgram(root);
  if (process.platform === 'darwin') {
    spawn('/usr/bin/open', ['-n', bundleIn(root), ...(args.length ? ['--args', ...args] : [])], { detached: true, stdio: 'ignore' }).unref();
  } else {
    spawn(program, args, { detached: true, stdio: 'inherit', cwd: root }).unref();
  }
}

// Întrebare în terminal (fără dependențe): citește o linie de la tastatură.
function prompt(question) {
  process.stdout.write(question);
  const buf = Buffer.alloc(1024);
  let line = '';
  for (;;) {
    let n = 0;
    try {
      n = fs.readSync(0, buf, 0, buf.length, null);
    } catch (e) {
      if (e.code === 'EAGAIN') continue;
      return '';
    }
    if (!n) return line;
    line += buf.subarray(0, n).toString('utf8');
    if (line.includes('\n')) return line.split(/\r?\n/)[0];
  }
}

// La pornirea programului publicat (Linux/macOS): instalare sau actualizare. Întoarce true dacă procesul trebuie
// să se încheie (rulează copia instalată), false pentru a porni serverul de aici.
function onStartup(flags) {
  if (!packaged || process.platform === 'win32') return false;
  const here = rootOfExe(process.execPath);
  const args = flags.passThrough;
  if (flags.install) {
    const root = parseDir(flags.install);
    installTo(root);
    console.log(`${NAME} ${VERSION} a fost instalat în ${root}`);
    return true;
  }
  if (flags.here || flags.afterUpdate || isInstallRoot(here) || fs.existsSync(path.join(here, 'portable.txt'))) {
    if (isInstallRoot(here)) {
      fs.rmSync(installedProgram(here) + '.old', { force: true });
      if (fs.readFileSync(path.join(here, MARKER), 'utf8').trim() !== VERSION) fs.writeFileSync(path.join(here, MARKER), VERSION);
    }
    return false;
  }
  const found = existingInstall();
  if (found) {
    const installed = versionOf(installedProgram(found));
    if (installed && !require('./update').isNewer(VERSION, installed)) {
      startInstalled(found, args);
      return true;
    }
    if (!process.stdin.isTTY) return false;
    const a = prompt(`${NAME} ${installed || '(o versiune mai veche)'} este instalat în ${found}.\nActualizați la ${VERSION}? Datele rămân neschimbate. [D/n] `);
    if (/^n/i.test(a.trim())) return false;
    installTo(found);
    console.log(`Actualizat la ${VERSION} în ${found}.`);
    startInstalled(found, args);
    return true;
  }
  if (!process.stdin.isTTY) return false;
  console.log(`${NAME} ${VERSION} - made by Akulav\n`);
  console.log('Programul, baza de date și fișierele încărcate vor fi păstrate doar în folderul ales.');
  for (;;) {
    const a = prompt(`Folder de instalare [${defaultDir()}] (sau „r” pentru a rula fără instalare): `).trim();
    if (/^r$/i.test(a)) return false;
    try {
      const root = parseDir(a || defaultDir());
      installTo(root);
      console.log(`Instalat în ${root}.`);
      startInstalled(root, args);
      return true;
    } catch (e) {
      console.log('  ' + e.message);
    }
  }
}

// Dezinstalare. Windows: dezinstalatorul setup-ului (întreabă singur de date). Linux/macOS: întreabă în terminal.
function uninstall() {
  const root = installRoot();
  if (process.platform === 'win32') {
    const unins = path.join(root, 'unins000.exe');
    if (fs.existsSync(unins)) spawn(unins, [], { detached: true, stdio: 'ignore' }).unref();
    else console.log(`${NAME} nu este instalat aici. Eliminați-l din Setări → Aplicații.`);
    return;
  }
  if (!isInstallRoot(root)) return console.log(`${NAME} nu este instalat în ${root}.`);
  if (!/^d/i.test(prompt(`Dezinstalați ${NAME} din ${root}? [d/N] `).trim())) return;
  const wipe = /^d/i.test(prompt('Ștergeți și datele (baza de date, fișierele încărcate)? [d/N] ').trim());
  if (process.platform === 'linux') {
    fs.rmSync(desktopFile(), { force: true });
    fs.rmSync(path.join(root, APP_ID + '.png'), { force: true });
    for (const p of [installedProgram(root), installedProgram(root) + '.old']) fs.rmSync(p, { force: true });
  }
  if (process.platform === 'darwin') fs.rmSync(bundleIn(root), { recursive: true, force: true });
  fs.rmSync(path.join(root, MARKER), { force: true });
  if (wipe) fs.rmSync(path.join(root, 'data'), { recursive: true, force: true });
  try {
    fs.rmdirSync(root);
  } catch {}
  console.log(`${NAME} a fost dezinstalat.`);
}

module.exports = { NAME, VERSION, EXE, MARKER, packaged, bundleOf, rootOfExe, installRoot, installedProgram, defaultDir, parseDir, onStartup, uninstall };
