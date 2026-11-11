'use strict';
// Baza de date SQLite (modulul integrat node:sqlite) și folderul de fișiere încărcate.
const { DatabaseSync } = require('node:sqlite');
const path = require('node:path');
const fs = require('node:fs');
const crypto = require('node:crypto');

const DATA_DIR = path.resolve(process.env.DATA_DIR || path.join(__dirname, '..', 'data'));
const UPLOAD_DIR = path.join(DATA_DIR, 'uploads');
fs.mkdirSync(UPLOAD_DIR, { recursive: true });

const db = new DatabaseSync(path.join(DATA_DIR, 'ansc.db'));
db.exec('PRAGMA journal_mode = WAL; PRAGMA foreign_keys = ON; PRAGMA busy_timeout = 5000;');

db.exec(`
CREATE TABLE IF NOT EXISTS units (
  id INTEGER PRIMARY KEY,
  name TEXT NOT NULL,
  type TEXT NOT NULL DEFAULT '',
  parent_id INTEGER REFERENCES units(id),
  sort INTEGER NOT NULL DEFAULT 0
);
CREATE TABLE IF NOT EXISTS users (
  id INTEGER PRIMARY KEY,
  username TEXT NOT NULL UNIQUE,
  full_name TEXT NOT NULL,
  position TEXT NOT NULL DEFAULT '',
  email TEXT NOT NULL DEFAULT '',
  unit_id INTEGER REFERENCES units(id) ON DELETE SET NULL,
  role TEXT NOT NULL DEFAULT 'user',
  pass_hash TEXT NOT NULL,
  must_change INTEGER NOT NULL DEFAULT 1,
  active INTEGER NOT NULL DEFAULT 1,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE TABLE IF NOT EXISTS sessions (
  token_hash TEXT PRIMARY KEY,
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  expires_at INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS categories (
  id INTEGER PRIMARY KEY,
  name TEXT NOT NULL,
  color TEXT NOT NULL DEFAULT '#1d4e89',
  sort INTEGER NOT NULL DEFAULT 0
);
CREATE TABLE IF NOT EXISTS tags (
  id INTEGER PRIMARY KEY,
  category_id INTEGER NOT NULL REFERENCES categories(id) ON DELETE CASCADE,
  name TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS documents (
  id INTEGER PRIMARY KEY,
  title TEXT NOT NULL,
  number TEXT NOT NULL DEFAULT '',
  doc_date TEXT NOT NULL,
  description TEXT NOT NULL DEFAULT '',
  visibility TEXT NOT NULL DEFAULT 'all',
  created_by INTEGER REFERENCES users(id) ON DELETE SET NULL,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_documents_date ON documents(doc_date);
CREATE TABLE IF NOT EXISTS document_files (
  id INTEGER PRIMARY KEY,
  document_id INTEGER NOT NULL REFERENCES documents(id) ON DELETE CASCADE,
  name TEXT NOT NULL,
  stored TEXT NOT NULL,
  size INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS document_tags (
  document_id INTEGER NOT NULL REFERENCES documents(id) ON DELETE CASCADE,
  tag_id INTEGER NOT NULL REFERENCES tags(id) ON DELETE CASCADE,
  PRIMARY KEY (document_id, tag_id)
);
CREATE TABLE IF NOT EXISTS document_units (
  document_id INTEGER NOT NULL REFERENCES documents(id) ON DELETE CASCADE,
  unit_id INTEGER NOT NULL REFERENCES units(id) ON DELETE CASCADE,
  PRIMARY KEY (document_id, unit_id)
);
CREATE TABLE IF NOT EXISTS document_users (
  document_id INTEGER NOT NULL REFERENCES documents(id) ON DELETE CASCADE,
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  PRIMARY KEY (document_id, user_id)
);
CREATE TABLE IF NOT EXISTS settings (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS document_seen (
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  document_id INTEGER NOT NULL REFERENCES documents(id) ON DELETE CASCADE,
  seen_at TEXT NOT NULL DEFAULT (datetime('now')),
  PRIMARY KEY (user_id, document_id)
);
CREATE TABLE IF NOT EXISTS document_signers (
  document_id INTEGER NOT NULL REFERENCES documents(id) ON DELETE CASCADE,
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  signed_at TEXT,
  PRIMARY KEY (document_id, user_id)
);
CREATE TABLE IF NOT EXISTS audit_log (
  id INTEGER PRIMARY KEY,
  at TEXT NOT NULL DEFAULT (datetime('now')),
  username TEXT NOT NULL DEFAULT '',
  ip TEXT NOT NULL DEFAULT '',
  action TEXT NOT NULL,
  details TEXT NOT NULL DEFAULT ''
);
`);

// Coloane adăugate după prima versiune; verificarea face pasul repetabil pe baze de date existente.
function addColumn(table, column, definition) {
  if (!db.prepare(`PRAGMA table_info(${table})`).all().some((c) => c.name === column)) {
    db.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${definition}`);
  }
}
addColumn('document_signers', 'position', 'INTEGER NOT NULL DEFAULT 0'); // ordinea în lanțul de semnare
addColumn('document_files', 'signed_by', 'INTEGER'); // cine a încărcat această versiune semnată
addColumn('document_files', 'signed_by_name', 'TEXT'); // numele rămâne chiar dacă utilizatorul este șters
addColumn('document_files', 'created_at', 'TEXT');

const INITIAL_PASSWORD_FILE = path.join(DATA_DIR, 'parola-initiala-admin.txt');

function tx(fn) {
  db.exec('BEGIN');
  try {
    const out = fn();
    db.exec('COMMIT');
    return out;
  } catch (e) {
    db.exec('ROLLBACK');
    throw e;
  }
}

function hashPassword(password) {
  const salt = crypto.randomBytes(16);
  const hash = crypto.scryptSync(password, salt, 64);
  return salt.toString('hex') + ':' + hash.toString('hex');
}

function checkPassword(password, stored) {
  const [saltHex, hashHex] = String(stored).split(':');
  if (!saltHex || !hashHex) return false;
  const expected = Buffer.from(hashHex, 'hex');
  const actual = crypto.scryptSync(password, Buffer.from(saltHex, 'hex'), expected.length);
  return crypto.timingSafeEqual(actual, expected);
}

// Prima pornire: cont de administrator și câteva categorii de exemplu (pot fi schimbate din interfață).
if (!db.prepare('SELECT 1 FROM users LIMIT 1').get()) {
  // Parola inițială este aleatorie (nu „admin”), ca nimeni din rețea să nu poată prelua sistemul
  // înainte de prima autentificare. Se găsește în folderul de date și în jurnalul serverului.
  const initial = crypto.randomBytes(12).toString('base64url');
  fs.writeFileSync(
    INITIAL_PASSWORD_FILE,
    `Utilizator: admin\nParola: ${initial}\n\nLa prima autentificare sistemul cere o parolă nouă, iar acest fișier este șters automat.\n`,
    { mode: 0o600 }
  );
  console.log(`\nCont inițial creat — utilizator: admin, parola: ${initial}\n(salvată și în ${INITIAL_PASSWORD_FILE})\n`);
  tx(() => {
    db.prepare(
      "INSERT INTO users (username, full_name, position, role, pass_hash, must_change) VALUES ('admin', 'Administrator', 'Administrator de sistem', 'admin', ?, 1)"
    ).run(hashPassword(initial));
    db.prepare("INSERT INTO units (name, type) VALUES ('Agenția Națională pentru Soluționarea Contestațiilor', 'Instituție')").run();
    const cat = db.prepare('INSERT INTO categories (name, color, sort) VALUES (?, ?, ?)');
    const tag = db.prepare('INSERT INTO tags (category_id, name) VALUES (?, ?)');
    const seed = [
      ['Resurse umane', '#0f766e', ['Concedii', 'Angajări', 'Fișe de post', 'Ordine de personal']],
      ['Documente generale', '#1d4e89', ['Regulament intern', 'Cod de etică', 'Proceduri interne']],
      ['Ordine și dispoziții', '#9a3412', ['Ordine', 'Dispoziții']],
    ];
    seed.forEach(([name, color, tags], i) => {
      const id = Number(cat.run(name, color, i).lastInsertRowid);
      for (const t of tags) tag.run(id, t);
    });
  });
}
db.prepare('DELETE FROM sessions WHERE expires_at < ?').run(Date.now());

module.exports = { db, tx, hashPassword, checkPassword, UPLOAD_DIR, DATA_DIR, INITIAL_PASSWORD_FILE };
