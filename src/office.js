'use strict';
// Editare în pagină prin ONLYOFFICE Docs (server de documente instalat separat, în rețeaua internă).
// Aplicația nu editează ea însăși fișierele: construiește configurația semnată (JWT) pentru editor,
// îi dă serverului de documente un link temporar spre fișier și primește înapoi versiunea salvată.
//
// Regula „o singură persoană editează”: cine deschide primul primește dreptul de editare (blocarea),
// ceilalți deschid documentul doar pentru citire. Blocarea ține cât timp pagina editorului trimite
// semnale de viață; se eliberează când serverul de documente anunță închiderea sau semnalele încetează.
const crypto = require('node:crypto');
const path = require('node:path');
const { db } = require('./db');

const KEYS = ['office_url', 'office_secret', 'office_app_url'];

// citite la fiecare cerere (antetul CSP), deci păstrate în memorie până la următoarea salvare
let cached = null;
function getSettings() {
  if (cached) return { ...cached };
  const s = Object.fromEntries(KEYS.map((k) => [k, '']));
  for (const r of db.prepare('SELECT key, value FROM settings').all()) if (r.key in s) s[r.key] = r.value;
  cached = s;
  return { ...s };
}
function saveSettings(values) {
  const set = db.prepare('INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value');
  for (const k of KEYS) if (k in values) set.run(k, String(values[k]));
  cached = null;
}
const trimUrl = (u) => String(u || '').replace(/\/+$/, '');
// editorul este disponibil doar cu adresă și cheie secretă (fără JWT, oricine din rețea ar putea scrie fișiere)
const enabled = () => {
  const s = getSettings();
  return !!(s.office_url && s.office_secret);
};
const officeOrigin = () => {
  try {
    return enabled() ? new URL(getSettings().office_url).origin : '';
  } catch {
    return '';
  }
};

// ---------- JWT (HS256), așa cum îl cere ONLYOFFICE ----------
const b64 = (buf) => Buffer.from(buf).toString('base64url');
function sign(payload, secret = getSettings().office_secret) {
  const head = b64(JSON.stringify({ alg: 'HS256', typ: 'JWT' }));
  const body = b64(JSON.stringify(payload));
  return `${head}.${body}.${b64(crypto.createHmac('sha256', secret).update(`${head}.${body}`).digest())}`;
}
function verify(token, secret = getSettings().office_secret) {
  const parts = String(token || '').split('.');
  if (parts.length !== 3 || !secret) return null;
  const expected = crypto.createHmac('sha256', secret).update(`${parts[0]}.${parts[1]}`).digest();
  const actual = Buffer.from(parts[2], 'base64url');
  if (actual.length !== expected.length || !crypto.timingSafeEqual(actual, expected)) return null;
  try {
    if (JSON.parse(Buffer.from(parts[0], 'base64url')).alg !== 'HS256') return null;
    const payload = JSON.parse(Buffer.from(parts[1], 'base64url'));
    if (payload.exp && payload.exp * 1000 < Date.now()) return null;
    return payload;
  } catch {
    return null;
  }
}

// ---------- tipuri de fișiere ----------
// Formatele moderne se editează; cele vechi (.doc, .xls…) se deschid doar pentru citire.
const TYPES = {
  docx: ['word', true], odt: ['word', true], doc: ['word', false], rtf: ['word', false], txt: ['word', false],
  xlsx: ['cell', true], ods: ['cell', true], xls: ['cell', false], csv: ['cell', false],
  pptx: ['slide', true], odp: ['slide', true], ppt: ['slide', false],
  pdf: ['pdf', true],
};
const extOf = (name) => path.extname(String(name)).slice(1).toLowerCase();
const typeOf = (name) => TYPES[extOf(name)] || null;

// Cheia identifică o versiune anume a fișierului pentru serverul de documente; numele stocat
// se schimbă la fiecare salvare, deci și cheia.
const docKey = (stored) => crypto.createHash('sha256').update('ansc-office:' + stored).digest('hex').slice(0, 40);

// ---------- blocarea de editare (în memorie: la repornire, sesiunile de editare se reiau) ----------
const LOCK_MS = 3 * 60 * 1000; // fără semnal de viață atât timp, blocarea expiră (filele din fundal trimit mai rar)
const locks = new Map(); // fileId -> { userId, name, until, since }
function lockOf(fileId) {
  const l = locks.get(fileId);
  if (l && l.until < Date.now()) {
    locks.delete(fileId);
    return null;
  }
  return l || null;
}
// Ia sau prelungește blocarea; întoarce blocarea existentă a altcuiva, dacă este cazul.
function takeLock(fileId, user) {
  const l = lockOf(fileId);
  if (l && l.userId !== user.id) return { ok: false, lock: l };
  const next = { userId: user.id, name: user.full_name, since: l ? l.since : Date.now(), until: Date.now() + LOCK_MS };
  locks.set(fileId, next);
  return { ok: true, lock: next };
}
function releaseLock(fileId, userId) {
  const l = locks.get(fileId);
  if (l && (userId === undefined || l.userId === userId)) locks.delete(fileId);
}
setInterval(() => {
  for (const [id, l] of locks) if (l.until < Date.now()) locks.delete(id);
}, 60000).unref();

// Link temporar prin care serverul de documente descarcă fișierul (nu are cookie-ul utilizatorului).
const FILE_LINK_MS = 6 * 3600 * 1000;
function fileToken(fileId, stored) {
  return sign({ f: fileId, s: stored, exp: Math.floor((Date.now() + FILE_LINK_MS) / 1000) });
}

module.exports = { getSettings, saveSettings, enabled, officeOrigin, trimUrl, sign, verify, typeOf, extOf, docKey, lockOf, takeLock, releaseLock, fileToken, LOCK_MS };
