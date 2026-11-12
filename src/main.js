'use strict';
// Punctul de intrare: opțiunile din linia de comandă, instalarea / actualizarea (programul publicat), apoi serverul.
//
//   eManagement                  pornește serverul și deschide aplicația în browser
//   eManagement --no-browser     pornește doar serverul (ex. ca serviciu)
//   eManagement --here           Linux/macOS: rulează de aici, fără să se ofere să se instaleze
//   eManagement --install <dir>  Linux/macOS: instalează în <dir> fără întrebări (servere)
//   eManagement --uninstall      dezinstalează (Windows: pornește dezinstalatorul)
//   eManagement --version        afișează versiunea
const fs = require('node:fs');
const path = require('node:path');
const { spawn } = require('node:child_process');
const install = require('./install');

function parseArgs(argv) {
  const f = { passThrough: [] };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--version' || a === '-v') f.version = true;
    else if (a === '--no-browser') f.noBrowser = true;
    else if (a === '--here' || a === '--portable') f.here = true;
    else if (a === '--install') f.install = argv[++i] || '';
    else if (a === '--uninstall') f.uninstall = true;
    else if (a === '--after-update') f.afterUpdate = true;
    else {
      console.error(`Opțiune necunoscută: ${a} (vedeți --version, --no-browser, --here, --install <folder>, --uninstall)`);
      process.exit(2);
    }
    if (a === '--no-browser') f.passThrough.push(a);
  }
  return f;
}

const flags = parseArgs(process.argv.slice(2));
if (flags.version) {
  console.log(`eManagement ${install.VERSION}`);
  process.exit(0);
}
if (flags.uninstall) {
  install.uninstall();
  process.exit(0);
}
try {
  if (install.onStartup(flags)) process.exit(0);
} catch (e) {
  console.error('Instalarea a eșuat: ' + e.message);
  process.exit(1);
}

process.title = install.NAME;
const root = install.installRoot();
// Datele stau în folderul aplicației (DATA_DIR le poate muta în altă parte).
if (!process.env.DATA_DIR) process.env.DATA_DIR = path.join(root, 'data');
fs.mkdirSync(process.env.DATA_DIR, { recursive: true });

// Fără terminal (aplicația de pe macOS, serviciu), ce afișează serverul ajunge în data/server.log.
if (install.packaged && !process.stdout.isTTY) {
  const log = fs.createWriteStream(path.join(process.env.DATA_DIR, 'server.log'), { flags: 'a' });
  for (const s of [process.stdout, process.stderr]) s.write = (chunk, enc, cb) => log.write(chunk, enc, cb);
}
// Ce a lăsat o actualizare în urmă (pe Windows setup-ul poate încă rula câteva clipe).
try {
  fs.rmSync(path.join(process.env.DATA_DIR, 'update'), { recursive: true, force: true });
} catch {}

function openBrowser(url) {
  const cmd = process.platform === 'win32' ? ['cmd', ['/c', 'start', '', url]] : process.platform === 'darwin' ? ['/usr/bin/open', [url]] : ['xdg-open', [url]];
  try {
    spawn(cmd[0], cmd[1], { detached: true, stdio: 'ignore', windowsHide: true }).on('error', () => {}).unref();
  } catch {}
}
const wantsBrowser = install.packaged && !flags.noBrowser && !flags.afterUpdate && !process.env.INVOCATION_ID &&
  (process.platform !== 'linux' || process.env.DISPLAY || process.env.WAYLAND_DISPLAY);

const server = require('./server');
const url = `http://localhost:${server.PORT}`;
// Portul este liber? (verificat cu un server de probă, închis imediat)
const portFree = () =>
  new Promise((resolve) => {
    const probe = require('node:net').createServer();
    probe.once('error', () => resolve(false));
    probe.listen({ port: server.PORT, host: server.HOST }, () => probe.close(() => resolve(true)));
  });

(async () => {
  // După o actualizare, versiunea veche poate încă elibera portul: se așteaptă până la un minut.
  if (flags.afterUpdate) for (let i = 0; i < 60 && !(await portFree()); i++) await new Promise((r) => setTimeout(r, 1000));
  try {
    await server.start();
    if (wantsBrowser) openBrowser(url);
  } catch (err) {
    if (err.code === 'EADDRINUSE' && wantsBrowser) {
      // deja pornit (ex. scurtătura apăsată a doua oară): doar deschide aplicația
      console.log(`${install.NAME} rulează deja pe ${url}.`);
      openBrowser(url);
      process.exit(0);
    }
    console.error(err.code === 'EADDRINUSE' ? `Portul ${server.PORT} este deja folosit de alt program. Setați altul prin variabila PORT.` : err);
    process.exit(1);
  }
})();
