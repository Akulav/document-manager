'use strict';
// Construiește programul publicat pentru sistemul curent: un singur executabil (Node.js Single Executable
// Application) cu serverul, interfața și Vue incluse.
//
//   node scripts/build-sea.js
//
// Rezultat în dist/:
//   Windows  eManagement.exe          (cu pictograma și informațiile de versiune; setup-ul îl include)
//   Linux    eManagement-linux-x64
//   macOS    eManagement-macos-arm64  (semnat ad hoc)
//
// Pașii: esbuild adună src/main.js și dependențele într-un singur fișier → blob SEA (cu fișierele interfeței ca
// resurse) → copie a lui node → (Windows) pictogramă și versiune → blob-ul injectat cu postject → (macOS) semnare.
const fs = require('node:fs');
const path = require('node:path');
const { execFileSync } = require('node:child_process');

const ROOT = path.join(__dirname, '..');
const BUILD = path.join(ROOT, 'build');
const DIST = path.join(ROOT, 'dist');
const pkg = require('../package.json');
const OUT_NAME = { win32: 'eManagement.exe', linux: 'eManagement-linux-x64', darwin: 'eManagement-macos-arm64' }[process.platform];
const FUSE = 'NODE_SEA_FUSE_fce680ab2cc467b6e072b8b5df1996b2';

async function main() {
  if (!OUT_NAME) throw new Error('sistem nesuportat: ' + process.platform);
  fs.rmSync(BUILD, { recursive: true, force: true });
  fs.mkdirSync(BUILD, { recursive: true });
  fs.mkdirSync(DIST, { recursive: true });

  // 1. Un singur fișier CommonJS
  const bundle = path.join(BUILD, 'eManagement.cjs');
  await require('esbuild').build({
    entryPoints: [path.join(ROOT, 'src', 'main.js')],
    bundle: true,
    platform: 'node',
    target: 'node22',
    format: 'cjs',
    outfile: bundle,
    legalComments: 'none',
    logLevel: 'warning',
  });

  // 2. Blob-ul SEA, cu fișierele interfeței ca resurse
  const config = path.join(BUILD, 'sea-config.json');
  const blob = path.join(BUILD, 'sea-prep.blob');
  const assets = {};
  for (const [name, file] of Object.entries(require('../src/assets').seaAssets())) assets[name] = path.join(ROOT, file);
  fs.writeFileSync(config, JSON.stringify({ main: bundle, output: blob, disableExperimentalSEAWarning: true, useCodeCache: false, assets }, null, 2));
  execFileSync(process.execPath, ['--experimental-sea-config', config], { stdio: 'inherit' });

  // 3. Copia lui node care devine programul
  const out = path.join(DIST, OUT_NAME);
  fs.rmSync(out, { force: true });
  fs.copyFileSync(process.execPath, out);
  fs.chmodSync(out, 0o755);
  if (process.platform === 'darwin') execFileSync('codesign', ['--remove-signature', out], { stdio: 'inherit' });
  if (process.platform === 'win32') {
    // pictograma și numele afișat de Explorer / Task Manager (înainte de injectare)
    const mod = await import('rcedit');
    const rcedit = mod.rcedit || mod.default;
    await rcedit(out, {
      icon: path.join(ROOT, 'assets', 'icon.ico'),
      'file-version': pkg.version,
      'product-version': pkg.version,
      'version-string': {
        ProductName: 'e-Management ANSC',
        FileDescription: 'e-Management ANSC - made by Akulav',
        CompanyName: 'Akulav',
        LegalCopyright: '© Akulav. All rights reserved.',
        OriginalFilename: 'eManagement.exe',
        InternalName: 'eManagement',
      },
    });
  }

  // 4. Injectarea
  const { inject } = require('postject');
  await inject(out, 'NODE_SEA_BLOB', fs.readFileSync(blob), {
    sentinelFuse: FUSE,
    ...(process.platform === 'darwin' ? { machoSegmentName: 'NODE_SEA' } : {}),
  });
  if (process.platform === 'darwin') execFileSync('codesign', ['--sign', '-', out], { stdio: 'inherit' });

  const version = execFileSync(out, ['--version'], { encoding: 'utf8' }).trim();
  console.log(`${out} (${(fs.statSync(out).size / 1048576).toFixed(1)} MB): ${version}`);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
