'use strict';
// Fișierele interfeței (public/ și Vue). În programul publicat (un singur executabil) sunt incluse în el
// (sea-config.json → „assets”); din surse sunt citite de pe disc. Același tabel servește ambele cazuri.
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');

// URL → [numele resursei incluse, calea de pe disc, tipul]
const FILES = {
  '/': ['public/index.html', 'public/index.html', 'text/html; charset=utf-8'],
  '/index.html': ['public/index.html', 'public/index.html', 'text/html; charset=utf-8'],
  '/app.js': ['public/app.js', 'public/app.js', 'text/javascript; charset=utf-8'],
  '/style.css': ['public/style.css', 'public/style.css', 'text/css; charset=utf-8'],
  '/favicon.ico': ['public/favicon.ico', 'public/favicon.ico', 'image/x-icon'],
  '/favicon.svg': ['public/favicon.svg', 'public/favicon.svg', 'image/svg+xml'],
  '/apple-touch-icon.png': ['public/apple-touch-icon.png', 'public/apple-touch-icon.png', 'image/png'],
  '/vendor/vue.js': ['vendor/vue.js', 'node_modules/vue/dist/vue.esm-browser.prod.js', 'text/javascript; charset=utf-8'],
};

let sea = null;
try {
  sea = require('node:sea');
  if (!sea.isSea()) sea = null;
} catch {}

const cache = new Map();
// { body, type, etag } pentru un URL cunoscut, altfel null.
function get(url) {
  const f = FILES[url];
  if (!f) return null;
  if (!cache.has(url)) {
    const body = sea ? Buffer.from(sea.getAsset(f[0])) : fs.readFileSync(path.join(__dirname, '..', f[1]));
    cache.set(url, { body, type: f[2], etag: '"' + crypto.createHash('sha1').update(body).digest('hex').slice(0, 20) + '"' });
  }
  return cache.get(url);
}

// Resursele pentru sea-config.json (folosit de scripts/build-sea.js).
const seaAssets = () => {
  const out = { 'icon.png': 'assets/icon.png' };
  for (const [name, file] of Object.values(FILES)) out[name] = file;
  return out;
};

module.exports = { FILES, get, seaAssets };
