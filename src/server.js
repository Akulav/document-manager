'use strict';
const path = require('node:path');
const fs = require('node:fs');
const crypto = require('node:crypto');
const { pipeline } = require('node:stream/promises');
const { Readable, Transform } = require('node:stream');
const Fastify = require('fastify');
const { db, tx, hashPassword, checkPassword, UPLOAD_DIR, DATA_DIR, INITIAL_PASSWORD_FILE } = require('./db');
const mail = require('./mail');
const backup = require('./backup');
const pdfsig = require('./pdfsig');
const office = require('./office');

const PORT = Number(process.env.PORT) || 3080;
const HOST = process.env.HOST || '0.0.0.0';
const MAX_FILE = 50 * 1024 * 1024;
// Sesiunea expiră după 30 de zile fără activitate; fiecare folosire o prelungește (cel mult o dată pe oră,
// ca baza de date să nu fie scrisă la fiecare cerere). Ieșirea, schimbarea parolei sau dezactivarea contului o închid imediat.
const SESSION_MS = 30 * 24 * 3600 * 1000;
const SESSION_RENEW_MS = 3600 * 1000;
function setSessionCookie(req, reply, token) {
  reply.setCookie('sid', token, {
    path: '/',
    httpOnly: true,
    sameSite: 'strict',
    secure: isHttps(req),
    maxAge: SESSION_MS / 1000,
  });
}
const ROLES = ['admin', 'editor', 'user'];

// Antetele X-Forwarded-* sunt crezute doar dacă vin de la un proxy de pe aceeași mașină (cazul obișnuit).
// Astfel adresa IP reală ajunge în jurnal și în limitarea autentificărilor, fără a putea fi falsificată din rețea.
// TRUST_PROXY: „true” = orice proxy, un număr = câte proxy-uri în față, altfel adrese IP/CIDR separate prin virgulă.
function trustProxySetting(v) {
  if (!v) return 'loopback';
  if (v === 'true') return true;
  if (/^\d+$/.test(v)) return Number(v);
  return v;
}
const app = Fastify({ logger: { level: 'warn' }, trustProxy: trustProxySetting(process.env.TRUST_PROXY) });

// ---------- utilitare ----------
const fail = (code, message) => Object.assign(new Error(message), { statusCode: code, expose: true });
// eslint-disable-next-line no-control-regex
const CONTROL = /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g;
const str = (v, max) => String(v ?? '').replace(CONTROL, '').trim().slice(0, max);
const isId = (n) => Number.isSafeInteger(n) && n > 0;
const idOrNull = (v) => (v === null || v === undefined || v === '' ? null : isId(Number(v)) ? Number(v) : null);
const idList = (v) => [...new Set((Array.isArray(v) ? v : []).slice(0, 2000).map(Number).filter(isId))];
// Identificatorul din adresă (/api/.../:id); orice altceva decât un număr pozitiv înseamnă „nu există”.
const paramId = (req) => {
  const n = Number(req.params.id);
  if (!isId(n)) throw fail(404, 'Înregistrarea nu a fost găsită.');
  return n;
};
const EMAIL_RE = /^[^\s@<>",;]+@[^\s@<>",;]+\.[^\s@<>",;]+$/;
const sha = (s) => crypto.createHash('sha256').update(s).digest('hex');
const lastId = (r) => Number(r.lastInsertRowid);

function unitMap() {
  return new Map(db.prepare('SELECT id, name, type, parent_id, sort FROM units').all().map((u) => [u.id, u]));
}
// Subdiviziunea utilizatorului și toate cele ierarhic superioare: un document partajat
// cu o direcție este vizibil și serviciilor/secțiilor din subordinea ei.
function unitChain(unitId) {
  const map = unitMap();
  const chain = [];
  let cur = map.get(unitId);
  while (cur && !chain.includes(cur.id)) {
    chain.push(cur.id);
    cur = map.get(cur.parent_id);
  }
  return chain;
}

function accessClause(user) {
  if (user.role === 'admin') return { sql: '1=1', params: [] };
  const chain = unitChain(user.unit_id);
  const marks = chain.length ? chain.map(() => '?').join(',') : 'NULL';
  return {
    sql: `(d.visibility = 'all' OR d.created_by = ?
      OR EXISTS (SELECT 1 FROM document_users x WHERE x.document_id = d.id AND x.user_id = ?)
      OR EXISTS (SELECT 1 FROM document_signers x WHERE x.document_id = d.id AND x.user_id = ?)
      OR EXISTS (SELECT 1 FROM document_units x WHERE x.document_id = d.id AND x.unit_id IN (${marks})))`,
    params: [user.id, user.id, user.id, ...chain],
  };
}
const canEdit = (user, doc) => user.role === 'admin' || (user.role === 'editor' && doc.created_by === user.id);
// Un document pe care cineva l-a semnat deja poate fi șters doar de un administrator.
const canDelete = (user, doc, signers) => user.role === 'admin' || (canEdit(user, doc) && !signers.some((s) => s.signed_at));

function removeStored(names) {
  for (const n of names) fs.rm(path.join(UPLOAD_DIR, n), { force: true }, () => {});
}
const versionsStored = (fileId) => db.prepare('SELECT stored FROM file_versions WHERE file_id = ?').all(fileId).map((v) => v.stored);

// data de azi după ceasul local al serverului (același fus orar cu utilizatorii)
function localToday() {
  const now = new Date();
  return `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}-${String(now.getDate()).padStart(2, '0')}`;
}
// Avizarea este deschisă până la sfârșitul zilei-termen, inclusiv.
const reviewOpen = (doc) => !!doc.review_until && doc.review_until >= localToday();

// ---------- autentificare ----------
// Încercările eșuate se numără pe (IP + utilizator) și pe IP; după prag urmează o pauză de 10 minute.
const loginFails = new Map(); // cheie -> { count, until, last }
const isBlocked = (key) => (loginFails.get(key)?.until || 0) > Date.now();
function recordFail(key, max) {
  const f = loginFails.get(key) || { count: 0, until: 0 };
  f.count++;
  f.last = Date.now();
  if (f.count >= max) {
    f.count = 0;
    f.until = Date.now() + 10 * 60000;
  }
  loginFails.set(key, f);
}
const reminded = new Map(); // document -> momentul ultimei retrimiteri a e-mailului de semnare
// Jetoane de semnare pentru puntea FleetView (browser → tava FleetView → MoldSign).
// Browserul obține un jeton după autentificare și îl trimite tăvii; tava îl validează
// apelând înapoi /api/sign/validate. Jetonul este legat de utilizator și expiră repede.
const signTokens = new Map(); // sha(token) -> { userId, exp }
const SIGN_TOKEN_MS = 15 * 60000; // acoperă o sesiune de semnare (PIN + așteptare ~5 min)
const MAX_SIGN_TOKENS_PER_USER = 5;
setInterval(() => {
  const now = Date.now();
  for (const [k, f] of loginFails) if (f.until < now && f.last < now - 30 * 60000) loginFails.delete(k);
  for (const [k, t] of reminded) if (t < now - 10 * 60000) reminded.delete(k);
  for (const [k, t] of signTokens) if (t.exp < now) signTokens.delete(k);
}, 5 * 60000).unref();
// Verificată când utilizatorul nu există, ca timpul de răspuns să nu trădeze ce conturi sunt reale.
const DUMMY_HASH = hashPassword(crypto.randomBytes(16).toString('hex'));

const isHttps = (req) => req.protocol === 'https' || req.headers['x-forwarded-proto'] === 'https';

// Jurnal de audit: cine, ce și când. Nu se șterge la import și nu poate fi modificat din interfață.
const AUDIT_RETENTION_DAYS = 90;
const auditInsert = db.prepare('INSERT INTO audit_log (username, ip, action, details) VALUES (?, ?, ?, ?)');
function audit(req, action, details = '', username) {
  try {
    auditInsert.run(username || req.user?.username || '', req.ip || '', action, String(details).slice(0, 500));
  } catch (e) {
    req.log.error(e);
  }
}

async function requireUser(req, reply) {
  const sid = req.cookies.sid;
  const user = sid
    ? db
        .prepare(
          `SELECT u.id, u.username, u.full_name, u.position, u.email, u.unit_id, u.role, u.must_change, u.created_at, s.expires_at
           FROM sessions s JOIN users u ON u.id = s.user_id
           WHERE s.token_hash = ? AND s.expires_at > ? AND u.active = 1`
        )
        .get(sha(sid), Date.now())
    : null;
  if (!user) throw fail(401, 'Este necesară autentificarea.');
  const { expires_at, ...me } = user;
  // prelungirea sesiunii: utilizatorul activ nu mai este deconectat
  if (reply && expires_at - Date.now() < SESSION_MS - SESSION_RENEW_MS) {
    db.prepare('UPDATE sessions SET expires_at = ? WHERE token_hash = ?').run(Date.now() + SESSION_MS, sha(sid));
    setSessionCookie(req, reply, sid);
  }
  if (user.must_change && !req.routeOptions.config.allowMustChange) throw fail(403, 'Schimbați mai întâi parola.');
  req.user = me;
}
async function requireAdmin(req, reply) {
  await requireUser(req, reply);
  if (req.user.role !== 'admin') throw fail(403, 'Acțiune permisă doar administratorilor.');
}
async function requireEditor(req, reply) {
  await requireUser(req, reply);
  if (req.user.role === 'user') throw fail(403, 'Nu aveți dreptul de a adăuga documente.');
}

// Autentifică apelul venit de la puntea FleetView: jetonul de semnare (trimis în corp)
// ține loc de sesiune, deoarece tava nu are cookie-ul utilizatorului. Nu atinge req.user.
async function requireSignToken(req) {
  const token = typeof req.body?.token === 'string' ? req.body.token : '';
  const rec = token ? signTokens.get(sha(token)) : null;
  if (!rec || rec.exp < Date.now()) throw fail(401, 'Jeton de semnare invalid sau expirat.');
  const u = db.prepare('SELECT id, username, full_name, active FROM users WHERE id = ?').get(rec.userId);
  if (!u || !u.active) throw fail(401, 'Jeton de semnare invalid sau expirat.');
  req.signUser = u;
}

function activeAdminsExcept(id) {
  return db.prepare("SELECT COUNT(*) AS n FROM users WHERE role = 'admin' AND active = 1 AND id <> ?").get(id).n;
}

// ---------- validări ----------
function readUnit(body, selfId) {
  const name = str(body.name, 200);
  if (!name) throw fail(400, 'Introduceți denumirea subdiviziunii.');
  const parent_id = idOrNull(body.parent_id);
  const map = unitMap();
  if (parent_id !== null) {
    if (!map.has(parent_id)) throw fail(400, 'Subdiviziunea superioară nu există.');
    // nu permitem cicluri în ierarhie
    for (let cur = map.get(parent_id), n = 0; cur && n < 1000; cur = map.get(cur.parent_id), n++) {
      if (cur.id === selfId) throw fail(400, 'O subdiviziune nu poate fi subordonată ei înseși.');
    }
  }
  return { name, type: str(body.type, 60), parent_id, sort: Number.isInteger(Number(body.sort)) ? Number(body.sort) : 0 };
}

function readUser(body) {
  const full_name = str(body.full_name, 150);
  if (!full_name) throw fail(400, 'Introduceți numele și prenumele.');
  const username = str(body.username, 40).toLowerCase();
  if (!/^[a-z0-9._-]{3,40}$/.test(username)) {
    throw fail(400, 'Numele de utilizator: 3–40 caractere, doar litere latine, cifre, punct, cratimă sau _.');
  }
  const role = ROLES.includes(body.role) ? body.role : 'user';
  const unit_id = idOrNull(body.unit_id);
  if (unit_id !== null && !unitMap().has(unit_id)) throw fail(400, 'Subdiviziunea selectată nu există.');
  const email = str(body.email, 150);
  if (email && !EMAIL_RE.test(email)) throw fail(400, 'Adresa de e-mail nu este validă.');
  const phone = str(body.phone, 40);
  if (phone && !/^[0-9+()./ -]{3,40}$/.test(phone)) throw fail(400, 'Numărul de telefon poate conține doar cifre, spații și + ( ) - . /');
  return { full_name, username, role, unit_id, position: str(body.position, 150), email, phone, active: body.active === false ? 0 : 1 };
}

// Parolă temporară ușor de transmis: fără caractere care se confundă (0/O, 1/l/I).
function tempPassword() {
  const alphabet = 'abcdefghjkmnpqrstuvwxyzABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  const bytes = crypto.randomBytes(12);
  let out = '';
  for (const b of bytes) out += alphabet[b % alphabet.length];
  return out;
}

function readPassword(v) {
  const p = String(v ?? '');
  if (p.length < 10 || p.length > 200) throw fail(400, 'Parola trebuie să aibă cel puțin 10 caractere.');
  if (/^(.)\1*$/.test(p) || ['1234567890', 'parola1234', 'password123', 'qwertyuiop'].includes(p.toLowerCase())) {
    throw fail(400, 'Parola este prea ușor de ghicit.');
  }
  return p;
}

// Data calendaristică reală (respinge 2024-02-31 etc.), într-un interval rezonabil.
function validDate(s) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(s)) return false;
  const d = new Date(s + 'T00:00:00Z');
  const y = Number(s.slice(0, 4));
  return !Number.isNaN(d.getTime()) && d.toISOString().slice(0, 10) === s && y >= 1900 && y <= 2200;
}

function readDoc(data, docId = null) {
  if (!data || typeof data !== 'object' || Array.isArray(data)) throw fail(400, 'Date lipsă.');
  const title = str(data.title, 300);
  if (!title) throw fail(400, 'Introduceți denumirea documentului.');
  // data poate lipsi (formulare, modele, documente de referință): se păstrează ca șir gol
  const doc_date = str(data.doc_date, 10);
  if (doc_date && !validDate(doc_date)) throw fail(400, 'Indicați o dată validă a documentului sau bifați „fără dată”.');
  const visibility = data.visibility === 'restricted' ? 'restricted' : 'all';
  const exists = (table, ids) => {
    const q = db.prepare(`SELECT 1 FROM ${table} WHERE id = ?`);
    return ids.filter((id) => q.get(id));
  };
  return {
    title,
    doc_date,
    visibility,
    number: str(data.number, 60),
    description: str(data.description, 5000),
    review_until: data.review_until && validDate(str(data.review_until, 10)) ? str(data.review_until, 10) : '',
    tagIds: exists('tags', idList(data.tagIds)),
    unitIds: visibility === 'restricted' ? exists('units', idList(data.unitIds)) : [],
    userIds: visibility === 'restricted' ? exists('users', idList(data.userIds)) : [],
    // semnatarii noi trebuie să aibă cont activ (altfel lanțul s-ar bloca); cei deja în lanț rămân
    signerIds: idList(data.signerIds).filter((uid) => signerOk.get(uid, docId ?? 0, uid)),
    removeFileIds: idList(data.removeFileIds),
  };
}
const signerOk = db.prepare(
  'SELECT 1 FROM users u WHERE u.id = ? AND (u.active = 1 OR EXISTS (SELECT 1 FROM document_signers s WHERE s.document_id = ? AND s.user_id = ?))'
);

async function readDocForm(req, docId = null) {
  const { data, saved } = await readUploads(req);
  try {
    return { doc: readDoc(data, docId), saved };
  } catch (e) {
    removeStored(saved.map((f) => f.stored));
    throw e;
  }
}

function fileHash(stored) {
  return new Promise((resolve, reject) => {
    const h = crypto.createHash('sha256');
    fs.createReadStream(path.join(UPLOAD_DIR, stored)).on('data', (c) => h.update(c)).on('error', reject).on('end', () => resolve(h.digest('hex')));
  });
}

// Citește formularul multipart: câmpul „data” (JSON) și fișierele, scrise direct pe disc.
async function readUploads(req) {
  let data = null;
  const saved = [];
  try {
    for await (const part of req.parts()) {
      if (part.type === 'file') {
        if (!part.filename) {
          part.file.resume();
          continue;
        }
        const stored = crypto.randomBytes(16).toString('hex');
        saved.push({ stored, name: str(path.basename(part.filename), 200) || 'fisier', size: 0 });
        await pipeline(part.file, fs.createWriteStream(path.join(UPLOAD_DIR, stored)));
        if (part.file.truncated) throw fail(413, 'Fișierul depășește limita de 50 MB.');
        saved[saved.length - 1].size = fs.statSync(path.join(UPLOAD_DIR, stored)).size;
      } else if (part.fieldname === 'data') {
        try {
          data = JSON.parse(part.value);
        } catch {
          throw fail(400, 'Date invalide.');
        }
      }
    }
    return { data, saved };
  } catch (e) {
    removeStored(saved.map((f) => f.stored));
    throw e;
  }
}
// Cererea este refuzată oricum: citim corpul până la capăt (fără a scrie nimic pe disc),
// altfel browserul vede o conexiune întreruptă în loc de mesajul de eroare.
async function discardUploads(req) {
  try {
    for await (const part of req.parts()) if (part.type === 'file') part.file.resume();
  } catch {}
}

// Semnarea este în lanț: următorul la rând este primul semnatar (după poziție) care încă nu a semnat.
// Cine este absent azi (concediu, deplasare…) trece la finalul lanțului până se întoarce; dacă au rămas
// doar persoane absente, rândul este tot al lor.
const ABSENT_NOW = 'EXISTS (SELECT 1 FROM absences a WHERE a.user_id = s.user_id AND a.from_date <= ? AND a.to_date >= ?)';
function currentSigner(docId) {
  const today = localToday();
  const r = db
    .prepare(`SELECT s.user_id FROM document_signers s WHERE s.document_id = ? AND s.signed_at IS NULL ORDER BY ${ABSENT_NOW}, s.position, s.user_id LIMIT 1`)
    .get(docId, today, today);
  return r ? r.user_id : null;
}
// absențele în curs azi, după utilizator
function absentToday() {
  const today = localToday();
  const map = new Map();
  for (const a of db.prepare('SELECT user_id, kind, to_date FROM absences WHERE from_date <= ? AND to_date >= ? ORDER BY to_date').all(today, today)) {
    map.set(a.user_id, { kind: a.kind, to_date: a.to_date });
  }
  return map;
}
const ABSENCE_KINDS = ['Concediu de odihnă', 'Concediu medical', 'Concediu de studii', 'Concediu fără plată', 'Deplasare', 'Altele'];

// Documentele la care persoana este acum la rând să semneze.
function signTurnsOf(userId) {
  return db
    .prepare('SELECT document_id FROM document_signers WHERE user_id = ? AND signed_at IS NULL')
    .all(userId)
    .map((r) => r.document_id)
    .filter((docId) => currentSigner(docId) === userId);
}

function saveDocLinks(id, doc, saved) {
  db.prepare('DELETE FROM document_tags WHERE document_id = ?').run(id);
  db.prepare('DELETE FROM document_units WHERE document_id = ?').run(id);
  db.prepare('DELETE FROM document_users WHERE document_id = ?').run(id);
  const t = db.prepare('INSERT INTO document_tags (document_id, tag_id) VALUES (?, ?)');
  const u = db.prepare('INSERT INTO document_units (document_id, unit_id) VALUES (?, ?)');
  const p = db.prepare('INSERT INTO document_users (document_id, user_id) VALUES (?, ?)');
  const f = db.prepare("INSERT INTO document_files (document_id, name, stored, size, created_at) VALUES (?, ?, ?, ?, datetime('now'))");
  doc.tagIds.forEach((x) => t.run(id, x));
  doc.unitIds.forEach((x) => u.run(id, x));
  doc.userIds.forEach((x) => p.run(id, x));
  saved.forEach((x) => f.run(id, x.name, x.stored, x.size));
  // Ordinea din formular este ordinea semnării. Cine a semnat deja își păstrează semnătura
  // și nu poate fi scos din lanț (altfel fișierul semnat ar rămâne fără autor).
  const current = db.prepare('SELECT user_id, signed_at FROM document_signers WHERE document_id = ?').all(id);
  const delSigner = db.prepare('DELETE FROM document_signers WHERE document_id = ? AND user_id = ?');
  const addSigner = db.prepare('INSERT INTO document_signers (document_id, user_id, position) VALUES (?, ?, ?)');
  const moveSigner = db.prepare('UPDATE document_signers SET position = ? WHERE document_id = ? AND user_id = ?');
  const signed = current.filter((s) => s.signed_at).map((s) => s.user_id);
  const order = [...signed.filter((x) => !doc.signerIds.includes(x)), ...doc.signerIds];
  current.filter((s) => !order.includes(s.user_id)).forEach((s) => delSigner.run(id, s.user_id));
  order.forEach((x, i) => (current.some((s) => s.user_id === x) ? moveSigner.run(i, id, x) : addSigner.run(id, x, i)));
}

async function notifySigners(req, docId, userIds) {
  userIds = userIds.filter(Boolean);
  if (!userIds.length) return null;
  const doc = db.prepare('SELECT id, title, number, doc_date FROM documents WHERE id = ?').get(docId);
  const q = db.prepare('SELECT full_name, email FROM users WHERE id = ? AND active = 1');
  return mail.sendSignRequests(doc, userIds.map((id) => q.get(id)).filter(Boolean), `${req.protocol}://${req.host}`);
}

// Grupează rândurile după document; elimină coloana document_id din fiecare rând.
function byDocument(rows, pick = (r) => r) {
  const map = new Map();
  for (const { document_id, ...r } of rows) {
    if (!map.has(document_id)) map.set(document_id, []);
    map.get(document_id).push(pick(r));
  }
  return map;
}

// Lista completă se citește cu câte o singură interogare pe tabel (nu câte cinci pentru fiecare document),
// ca pagina să rămână rapidă și cu mii de documente.
function listDocuments(user) {
  const acc = accessClause(user);
  const rows = db
    .prepare(
      `SELECT d.id, d.title, d.number, d.doc_date, d.description, d.visibility, d.review_until, d.created_by, d.created_at,
              a.full_name AS author,
              EXISTS (SELECT 1 FROM document_seen s WHERE s.document_id = d.id AND s.user_id = ?) AS seen
       FROM documents d LEFT JOIN users a ON a.id = d.created_by
       WHERE ${acc.sql}
       ORDER BY d.doc_date DESC, d.id DESC`
    )
    .all(user.id, ...acc.params);
  if (!rows.length) return [];
  const away = absentToday();
  const signers = byDocument(
    db.prepare(
      'SELECT s.document_id, s.user_id AS id, u.full_name AS name, u.active, s.signed_at FROM document_signers s JOIN users u ON u.id = s.user_id ORDER BY s.position, s.user_id'
    ).all(),
    (r) => ({ ...r, active: !!r.active, absent: away.get(r.id) || null })
  );
  const tags = byDocument(db.prepare('SELECT document_id, tag_id FROM document_tags').all(), (r) => r.tag_id);
  const units = byDocument(db.prepare('SELECT document_id, unit_id FROM document_units').all(), (r) => r.unit_id);
  const users = byDocument(db.prepare('SELECT document_id, user_id FROM document_users').all(), (r) => r.user_id);
  const files = byDocument(db.prepare('SELECT document_id, id, name, size, signed_by, signed_by_name, created_at, version, edited_by_name, edited_at FROM document_files ORDER BY id').all());
  return rows.map(({ seen, ...d }) => {
    const sig = signers.get(d.id) || [];
    const mine = sig.find((s) => s.id === user.id);
    const turn = sig.find((s) => !s.signed_at && !s.absent) || sig.find((s) => !s.signed_at);
    return {
      ...d,
      signers: sig,
      signTurn: turn ? turn.id : null,
      // 'pending' = este rândul meu; 'waiting' = aștept să semneze cei dinaintea mea
      mySign: mine ? (mine.signed_at ? 'signed' : turn && turn.id === user.id ? 'pending' : 'waiting') : null,
      canDelete: canDelete(user, d, sig),
      // „nevăzut” = document al altcuiva, apărut după crearea contului și încă nedeschis
      unseen: !seen && d.created_by !== user.id && d.created_at >= user.created_at,
      tagIds: tags.get(d.id) || [],
      unitIds: units.get(d.id) || [],
      userIds: users.get(d.id) || [],
      files: files.get(d.id) || [],
      canEdit: canEdit(user, d),
      reviewOpen: reviewOpen(d),
    };
  });
}

const markSeen = (userId, docId) => db.prepare('INSERT OR IGNORE INTO document_seen (user_id, document_id) VALUES (?, ?)').run(userId, docId);
function accessibleDoc(user, id) {
  const acc = accessClause(user);
  return db.prepare(`SELECT d.id, d.created_by FROM documents d WHERE d.id = ? AND ${acc.sql}`).get(id, ...acc.params);
}

const INLINE_TYPES = { '.pdf': 'application/pdf', '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg' };
const isPdf = (name) => path.extname(name).toLowerCase() === '.pdf';

// ---------- pluginuri ----------
app.register(require('@fastify/cookie'));
app.register(require('@fastify/multipart'), { limits: { fileSize: MAX_FILE, files: 10, fields: 5, fieldSize: 200000 } });
app.register(require('@fastify/static'), { root: path.join(__dirname, '..', 'public') });

// Apărare suplimentară împotriva CSRF (pe lângă cookie-ul SameSite=Strict): cererile care modifică
// date trebuie să vină de pe aceeași origine. Un alt site, chiar de pe un subdomeniu vecin, este refuzat.
app.addHook('onRequest', async (req) => {
  if (req.method === 'GET' || req.method === 'HEAD') return;
  const origin = req.headers.origin;
  if (!origin) return; // clienții care nu sunt browsere nu trimit Origin și nici cookie-uri furate
  let host = '';
  try {
    host = new URL(origin).host;
  } catch {}
  if (host !== req.headers.host && host !== req.host) throw fail(403, 'Cerere refuzată: origine necunoscută.');
});

// Vue compilează șabloanele în browser, de aceea este nevoie de 'unsafe-eval'; restul este blocat.
// connect-src permite, în plus, doar puntea locală FleetView (tava), prin care se face semnarea
// cu tokenul: browserul nu mai contactează MoldSign direct, ci agentul FleetView de pe calculator.
const SIGN_BRIDGE_ORIGIN = 'http://127.0.0.1:48625';
// Când editorul de documente este configurat, scriptul și cadrul (iframe) lui vin de pe serverul ONLYOFFICE.
const csp = (o = office.officeOrigin()) =>
  `default-src 'self'; script-src 'self' 'unsafe-eval'${o ? ' ' + o : ''}; style-src 'self' 'unsafe-inline'; img-src 'self' data:; connect-src 'self' ${SIGN_BRIDGE_ORIGIN}; frame-src ${o || "'none'"}; object-src 'none'; base-uri 'self'; form-action 'self'; frame-ancestors 'none'`;
app.addHook('onSend', async (req, reply) => {
  reply.header('X-Content-Type-Options', 'nosniff');
  reply.header('X-Frame-Options', 'DENY');
  reply.header('Referrer-Policy', 'same-origin');
  reply.header('Permissions-Policy', 'camera=(), microphone=(), geolocation=()');
  reply.header('Cross-Origin-Opener-Policy', 'same-origin');
  reply.header('Cross-Origin-Resource-Policy', 'same-origin');
  if (isHttps(req)) reply.header('Strict-Transport-Security', 'max-age=31536000; includeSubDomains');
  if (req.url.startsWith('/api/')) reply.header('Cache-Control', 'no-store');
  // fișierele descărcate nu primesc CSP-ul aplicației: vizualizatorul PDF al browserului are nevoie de propriile resurse
  if (!req.url.startsWith('/api/files/')) reply.header('Content-Security-Policy', csp());
});

app.setErrorHandler((err, req, reply) => {
  if (err.code === 'FST_REQ_FILE_TOO_LARGE') return reply.code(413).send({ error: 'Fișierul depășește limita de 50 MB.' });
  if (err.code === 'FST_FILES_LIMIT') return reply.code(413).send({ error: 'Cel mult 10 fișiere la o încărcare.' });
  if (err.code === 'FST_FIELDS_LIMIT' || err.code === 'FST_PARTS_LIMIT') return reply.code(413).send({ error: 'Formularul conține prea multe câmpuri.' });
  if (err.code === 'FST_INVALID_MULTIPART_CONTENT_TYPE') return reply.code(400).send({ error: 'Formularul trebuie trimis ca multipart/form-data.' });
  if (err.code === 'FST_ERR_CTP_BODY_TOO_LARGE') return reply.code(413).send({ error: 'Cererea este prea mare.' });
  const code = err.statusCode && err.statusCode >= 400 && err.statusCode < 600 ? err.statusCode : 500;
  if (code >= 500) req.log.error(err);
  reply.code(code).send({ error: err.expose ? err.message : code >= 500 ? 'Eroare internă de server.' : 'Cerere invalidă.' });
});
app.setNotFoundHandler((req, reply) => reply.code(404).send({ error: 'Pagina sau resursa nu există.' }));

// ---------- rute ----------
app.register(async (app) => {
  // Vue este servit local (fără CDN), ca aplicația să funcționeze și într-o rețea internă.
  const vueFile = fs.readFileSync(require.resolve('vue/dist/vue.esm-browser.prod.js'));
  app.get('/vendor/vue.js', (req, reply) => reply.type('text/javascript; charset=utf-8').header('Cache-Control', 'public, max-age=86400').send(vueFile));

  // --- sesiune ---
  app.post('/api/login', async (req, reply) => {
    const username = str(req.body?.username, 40).toLowerCase();
    const password = String(req.body?.password ?? '').slice(0, 200);
    const userKey = req.ip + '|' + username;
    const ipKey = 'ip|' + req.ip;
    if (isBlocked(userKey) || isBlocked(ipKey)) throw fail(429, 'Prea multe încercări. Reîncercați peste câteva minute.');
    const user = db.prepare('SELECT id, pass_hash, active FROM users WHERE username = ?').get(username);
    const ok = checkPassword(password, user ? user.pass_hash : DUMMY_HASH);
    if (!user || !user.active || !ok) {
      recordFail(userKey, 8);
      recordFail(ipKey, 60);
      audit(req, 'autentificare eșuată', '', username);
      throw fail(401, 'Utilizator sau parolă incorectă.');
    }
    loginFails.delete(userKey);
    audit(req, 'autentificare', '', username);
    db.prepare('DELETE FROM sessions WHERE expires_at < ?').run(Date.now());
    const token = crypto.randomBytes(32).toString('hex');
    db.prepare('INSERT INTO sessions (token_hash, user_id, expires_at) VALUES (?, ?, ?)').run(sha(token), user.id, Date.now() + SESSION_MS);
    setSessionCookie(req, reply, token);
    return { ok: true };
  });

  app.post('/api/logout', async (req, reply) => {
    if (req.cookies.sid) db.prepare('DELETE FROM sessions WHERE token_hash = ?').run(sha(req.cookies.sid));
    reply.clearCookie('sid', { path: '/' });
    return { ok: true };
  });

  app.get('/api/me', { preHandler: requireUser, config: { allowMustChange: true } }, async (req) => ({ ...req.user, mailEnabled: mail.enabled(), office: office.enabled() }));

  app.post('/api/password', { preHandler: requireUser, config: { allowMustChange: true } }, async (req) => {
    // o sesiune lăsată deschisă nu trebuie să permită ghicirea parolei la nesfârșit
    const key = 'pw|' + req.user.id;
    if (isBlocked(key)) throw fail(429, 'Prea multe încercări. Reîncercați peste câteva minute.');
    const current = String(req.body?.current ?? '').slice(0, 200);
    const row = db.prepare('SELECT pass_hash FROM users WHERE id = ?').get(req.user.id);
    if (!checkPassword(current, row.pass_hash)) {
      recordFail(key, 8);
      throw fail(400, 'Parola curentă este incorectă.');
    }
    loginFails.delete(key);
    const next = readPassword(req.body?.next);
    if (next === current) throw fail(400, 'Parola nouă trebuie să difere de cea curentă.');
    db.prepare('UPDATE users SET pass_hash = ?, must_change = 0 WHERE id = ?').run(hashPassword(next), req.user.id);
    db.prepare('DELETE FROM sessions WHERE user_id = ? AND token_hash <> ?').run(req.user.id, sha(req.cookies.sid));
    // parola inițială generată la instalare nu mai este valabilă, deci fișierul cu ea dispare
    if (req.user.username === 'admin') fs.rm(INITIAL_PASSWORD_FILE, { force: true }, () => {});
    audit(req, 'parolă schimbată');
    return { ok: true };
  });

  // --- organigramă și lista angajaților (vizibile tuturor angajaților) ---
  app.get('/api/directory', { preHandler: requireUser }, async (req) => ({
    units: db.prepare('SELECT id, name, type, parent_id, sort FROM units ORDER BY sort, name').all(),
    users: db.prepare('SELECT id, full_name, position, email, phone, unit_id FROM users WHERE active = 1 ORDER BY full_name').all(),
    // absențele în curs și cele programate; observația o vede doar administratorul
    absences: db
      .prepare('SELECT id, user_id, kind, from_date, to_date, note FROM absences WHERE to_date >= ? ORDER BY from_date, id')
      .all(localToday())
      .map((a) => (req.user.role === 'admin' ? a : { ...a, note: '' })),
    absenceKinds: ABSENCE_KINDS,
    today: localToday(),
  }));

  // --- absențe (admin) ---
  // Când o absență începe azi sau se anulează, rândul la semnare se poate muta: anunțăm noul semnatar.
  function signTurnsAround(userId, change) {
    const docs = db.prepare('SELECT document_id FROM document_signers WHERE user_id = ? AND signed_at IS NULL').all(userId).map((r) => r.document_id);
    const before = new Map(docs.map((d) => [d, currentSigner(d)]));
    change();
    return docs.filter((d) => currentSigner(d) !== before.get(d));
  }
  function absenceLabel(a) {
    const user = db.prepare('SELECT full_name FROM users WHERE id = ?').get(a.user_id);
    return `${user ? user.full_name : '#' + a.user_id}: ${a.kind}, ${a.from_date} – ${a.to_date}`;
  }
  app.post('/api/absences', { preHandler: requireAdmin }, async (req) => {
    const b = req.body || {};
    const userId = Number(b.user_id);
    if (!Number.isInteger(userId) || !db.prepare('SELECT 1 FROM users WHERE id = ?').get(userId)) throw fail(400, 'Angajatul nu a fost găsit.');
    const kind = ABSENCE_KINDS.includes(b.kind) ? b.kind : null;
    if (!kind) throw fail(400, 'Alegeți tipul absenței.');
    const from = String(b.from_date || '');
    const to = String(b.to_date || '');
    if (!validDate(from) || !validDate(to)) throw fail(400, 'Indicați datele de început și de sfârșit ale absenței.');
    if (to < from) throw fail(400, 'Data de sfârșit nu poate fi înaintea datei de început.');
    if (to < localToday()) throw fail(400, 'Absența s-a încheiat deja; indicați o perioadă actuală sau viitoare.');
    const note = str(b.note, 300);
    let id;
    const moved = signTurnsAround(userId, () => {
      id = lastId(db.prepare('INSERT INTO absences (user_id, kind, from_date, to_date, note) VALUES (?, ?, ?, ?, ?)').run(userId, kind, from, to, note));
    });
    audit(req, 'absență adăugată', absenceLabel({ user_id: userId, kind, from_date: from, to_date: to }));
    for (const docId of moved) notifySigners(req, docId, [currentSigner(docId)]).catch((e) => req.log.error(e));
    return { id, movedDocs: moved.length };
  });
  app.delete('/api/absences/:id', { preHandler: requireAdmin }, async (req) => {
    const id = paramId(req);
    const old = db.prepare('SELECT user_id, kind, from_date, to_date FROM absences WHERE id = ?').get(id);
    if (!old) throw fail(404, 'Absența nu a fost găsită.');
    const moved = signTurnsAround(old.user_id, () => db.prepare('DELETE FROM absences WHERE id = ?').run(id));
    audit(req, 'absență anulată', absenceLabel(old));
    for (const docId of moved) notifySigners(req, docId, [currentSigner(docId)]).catch((e) => req.log.error(e));
    return { ok: true, movedDocs: moved.length };
  });

  app.post('/api/units', { preHandler: requireAdmin }, async (req) => {
    const u = readUnit(req.body || {}, null);
    const r = db.prepare('INSERT INTO units (name, type, parent_id, sort) VALUES (?, ?, ?, ?)').run(u.name, u.type, u.parent_id, u.sort);
    audit(req, 'subdiviziune adăugată', u.name);
    return { id: lastId(r) };
  });
  app.put('/api/units/:id', { preHandler: requireAdmin }, async (req) => {
    const id = paramId(req);
    const u = readUnit(req.body || {}, id);
    const r = db.prepare('UPDATE units SET name = ?, type = ?, parent_id = ?, sort = ? WHERE id = ?').run(u.name, u.type, u.parent_id, u.sort, id);
    if (!r.changes) throw fail(404, 'Subdiviziunea nu a fost găsită.');
    audit(req, 'subdiviziune modificată', u.name);
    return { ok: true };
  });
  app.delete('/api/units/:id', { preHandler: requireAdmin }, async (req) => {
    const id = paramId(req);
    if (db.prepare('SELECT 1 FROM units WHERE parent_id = ?').get(id)) throw fail(400, 'Mutați sau ștergeți mai întâi subdiviziunile din subordine.');
    if (db.prepare('SELECT 1 FROM users WHERE unit_id = ?').get(id)) throw fail(400, 'Mutați mai întâi angajații din această subdiviziune.');
    const old = db.prepare('SELECT name FROM units WHERE id = ?').get(id);
    const r = db.prepare('DELETE FROM units WHERE id = ?').run(id);
    if (!r.changes) throw fail(404, 'Subdiviziunea nu a fost găsită.');
    audit(req, 'subdiviziune ștearsă', old.name);
    return { ok: true };
  });

  // --- utilizatori (admin) ---
  app.get('/api/users', { preHandler: requireAdmin }, async () =>
    db.prepare('SELECT id, username, full_name, position, email, phone, unit_id, role, active, must_change FROM users ORDER BY full_name').all()
  );
  app.post('/api/users', { preHandler: requireAdmin }, async (req) => {
    const body = req.body || {};
    const u = readUser(body);
    const password = readPassword(body.password);
    if (db.prepare('SELECT 1 FROM users WHERE username = ?').get(u.username)) throw fail(400, 'Acest nume de utilizator există deja.');
    const r = db
      .prepare('INSERT INTO users (username, full_name, position, email, phone, unit_id, role, active, pass_hash, must_change) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 1)')
      .run(u.username, u.full_name, u.position, u.email, u.phone, u.unit_id, u.role, u.active, hashPassword(password));
    audit(req, 'utilizator creat', `${u.username} (${u.role})`);
    return { id: lastId(r) };
  });

  // --- import în masă: angajați + organigramă ---
  // Primește rândurile citite din CSV în browser: { rows: [{ full_name, username, email, phone, position,
  // path: [denumiri de subdiviziuni, de sus în jos] }], parent_id, dry_run }.
  // Subdiviziunile se caută după denumire (fără diacritice și majuscule) și se creează doar cele care
  // lipsesc; conturile existente (același utilizator sau e-mail) rămân neatinse. Conturile noi au rolul
  // „user” și o parolă temporară, care trebuie schimbată la prima autentificare. Cu dry_run nu se
  // salvează nimic: răspunsul arată doar ce s-ar întâmpla.
  app.post('/api/admin/import-people', { preHandler: requireAdmin }, async (req) => {
    const body = req.body || {};
    const rows = Array.isArray(body.rows) ? body.rows.slice(0, 2000) : [];
    if (!rows.length) throw fail(400, 'Fișierul nu conține angajați.');
    const rootId = idOrNull(body.parent_id);
    if (rootId !== null && !unitMap().has(rootId)) throw fail(400, 'Subdiviziunea superioară nu există.');
    const dryRun = body.dry_run === true;

    const norm = (s) => String(s).normalize('NFD').replace(/\p{M}/gu, '').toLowerCase().replace(/\s+/g, ' ').trim();
    const typeOf = (name) => {
      const n = norm(name);
      if (n.startsWith('conducere')) return 'Conducere';
      if (n.startsWith('directi')) return 'Direcție';
      if (n.startsWith('serviciu')) return 'Serviciu';
      if (n.startsWith('secti')) return 'Secție';
      return '';
    };
    const result = { units: [], created: [], skipped: [], dry_run: dryRun };
    const ROLLBACK = new Error('rollback');

    try {
      tx(() => {
        const byName = new Map(); // denumire normalizată -> subdiviziuni
        for (const u of db.prepare('SELECT id, name, parent_id FROM units').all()) {
          const k = norm(u.name);
          byName.set(k, [...(byName.get(k) || []), u]);
        }
        const resolved = new Map(); // calea normalizată -> id
        const insertUnit = db.prepare('INSERT INTO units (name, type, parent_id, sort) VALUES (?, ?, ?, 0)');
        const resolve = (path) => {
          let parent = rootId;
          let key = '';
          for (const raw of path) {
            const name = str(raw, 200);
            if (!name) continue;
            key += '\u0001' + norm(name);
            if (resolved.has(key)) {
              parent = resolved.get(key);
              continue;
            }
            const same = byName.get(norm(name)) || [];
            // aceeași denumire sub același părinte; altfel o denumire unică oriunde în organigramă
            const hit = same.find((u) => u.parent_id === parent) || (same.length === 1 ? same[0] : null);
            let id;
            if (hit) id = hit.id;
            else {
              id = lastId(insertUnit.run(name, typeOf(name), parent));
              byName.set(norm(name), [...same, { id, name, parent_id: parent }]);
              result.units.push(name);
            }
            resolved.set(key, id);
            parent = id;
          }
          return parent;
        };

        const insertUser = db.prepare(
          "INSERT INTO users (username, full_name, position, email, phone, unit_id, role, active, pass_hash, must_change) VALUES (?, ?, ?, ?, ?, ?, 'user', 1, ?, 1)"
        );
        rows.forEach((row, i) => {
          const line = i + 1;
          const name = str(row && row.full_name, 150);
          let u;
          try {
            u = readUser({ ...(row || {}), role: 'user', unit_id: null, active: true });
          } catch (e) {
            result.skipped.push({ line, name, reason: e.message });
            return;
          }
          if (db.prepare('SELECT 1 FROM users WHERE username = ?').get(u.username)) {
            result.skipped.push({ line, name, reason: `utilizatorul „${u.username}” există deja` });
            return;
          }
          if (u.email && db.prepare('SELECT 1 FROM users WHERE lower(email) = lower(?)').get(u.email)) {
            result.skipped.push({ line, name, reason: `adresa ${u.email} este deja folosită` });
            return;
          }
          const path = Array.isArray(row.path) ? row.path.slice(0, 10) : [];
          const unitId = resolve(path);
          const password = dryRun ? '' : tempPassword();
          insertUser.run(u.username, u.full_name, u.position, u.email, u.phone, unitId, dryRun ? '-' : hashPassword(password));
          result.created.push({ line, username: u.username, full_name: u.full_name, email: u.email, unit: path.map((p) => str(p, 200)).filter(Boolean).join(' › '), password });
        });
        if (dryRun) throw ROLLBACK;
      });
    } catch (e) {
      if (e !== ROLLBACK) throw e;
    }

    if (!dryRun && (result.created.length || result.units.length)) {
      audit(
        req,
        'import angajați',
        `${result.created.length} utilizatori (${result.created.map((c) => c.username).join(', ').slice(0, 1500)}), ${result.units.length} subdiviziuni noi`
      );
    }
    return result;
  });
  app.put('/api/users/:id', { preHandler: requireAdmin }, async (req) => {
    const id = paramId(req);
    const body = req.body || {};
    const old = db.prepare('SELECT id, role, active FROM users WHERE id = ?').get(id);
    if (!old) throw fail(404, 'Utilizatorul nu a fost găsit.');
    const u = readUser(body);
    const password = body.password ? readPassword(body.password) : null;
    if (id === req.user.id && !u.active) throw fail(400, 'Nu vă puteți dezactiva propriul cont.');
    if (db.prepare('SELECT 1 FROM users WHERE username = ? AND id <> ?').get(u.username, id)) throw fail(400, 'Acest nume de utilizator există deja.');
    if (old.role === 'admin' && old.active && (u.role !== 'admin' || !u.active) && !activeAdminsExcept(id)) {
      throw fail(400, 'Trebuie să rămână cel puțin un administrator activ.');
    }
    const turns = u.active ? [] : signTurnsOf(id);
    tx(() => {
      db.prepare('UPDATE users SET username = ?, full_name = ?, position = ?, email = ?, phone = ?, unit_id = ?, role = ?, active = ? WHERE id = ?').run(
        u.username, u.full_name, u.position, u.email, u.phone, u.unit_id, u.role, u.active, id
      );
      if (password) db.prepare('UPDATE users SET pass_hash = ?, must_change = 1 WHERE id = ?').run(hashPassword(password), id);
      // parolă resetată sau cont dezactivat: sesiunile vechi nu mai sunt valabile
      if ((password && id !== req.user.id) || !u.active) db.prepare('DELETE FROM sessions WHERE user_id = ?').run(id);
    });
    audit(req, 'utilizator modificat', `${u.username} (${u.role}${u.active ? '' : ', dezactivat'}${password ? ', parolă resetată' : ''})`);
    return { ok: true, blockedDocs: turns.length };
  });
  app.delete('/api/users/:id', { preHandler: requireAdmin }, async (req) => {
    const id = paramId(req);
    if (id === req.user.id) throw fail(400, 'Nu vă puteți șterge propriul cont.');
    const old = db.prepare('SELECT username, role, active FROM users WHERE id = ?').get(id);
    if (!old) throw fail(404, 'Utilizatorul nu a fost găsit.');
    if (old.role === 'admin' && old.active && !activeAdminsExcept(id)) throw fail(400, 'Trebuie să rămână cel puțin un administrator activ.');
    // Cine a semnat deja rămâne în istoricul semnăturilor; contul se poate doar dezactiva.
    if (db.prepare('SELECT 1 FROM document_signers WHERE user_id = ? AND signed_at IS NOT NULL').get(id)) {
      throw fail(400, 'Această persoană a semnat documente, iar semnăturile ei trebuie să rămână în istoric. Dezactivați contul în loc să îl ștergeți.');
    }
    const turns = signTurnsOf(id);
    db.prepare('DELETE FROM users WHERE id = ?').run(id);
    audit(req, 'utilizator șters', old.username);
    // documentele la care era rândul acestei persoane trec la următorul semnatar, care trebuie anunțat
    for (const docId of turns) notifySigners(req, docId, [currentSigner(docId)]).catch((e) => req.log.error(e));
    return { ok: true };
  });

  // --- categorii și etichete ---
  app.get('/api/categories', { preHandler: requireUser }, async () => {
    const tags = db.prepare('SELECT id, category_id, name FROM tags ORDER BY name').all();
    return db
      .prepare('SELECT id, name, color, sort FROM categories ORDER BY sort, name')
      .all()
      .map((c) => ({ ...c, tags: tags.filter((t) => t.category_id === c.id) }));
  });
  const readCategory = (body) => {
    const name = str(body.name, 80);
    if (!name) throw fail(400, 'Introduceți denumirea categoriei.');
    const color = /^#[0-9a-fA-F]{6}$/.test(body.color) ? body.color : '#1d4e89';
    return { name, color, sort: Number.isInteger(Number(body.sort)) ? Number(body.sort) : 0 };
  };
  app.post('/api/categories', { preHandler: requireAdmin }, async (req) => {
    const c = readCategory(req.body || {});
    const max = db.prepare('SELECT COALESCE(MAX(sort), -1) + 1 AS n FROM categories').get().n;
    const id = lastId(db.prepare('INSERT INTO categories (name, color, sort) VALUES (?, ?, ?)').run(c.name, c.color, max));
    audit(req, 'categorie adăugată', c.name);
    return { id };
  });
  app.put('/api/categories/:id', { preHandler: requireAdmin }, async (req) => {
    const c = readCategory(req.body || {});
    const r = db.prepare('UPDATE categories SET name = ?, color = ?, sort = ? WHERE id = ?').run(c.name, c.color, c.sort, paramId(req));
    if (!r.changes) throw fail(404, 'Categoria nu a fost găsită.');
    audit(req, 'categorie modificată', c.name);
    return { ok: true };
  });
  // Ordinea categoriilor (în bara laterală, formulare și pagina de categorii): lista completă de id-uri, în noua ordine.
  app.post('/api/categories/order', { preHandler: requireAdmin }, async (req) => {
    const ids = idList(req.body?.ids);
    const all = db.prepare('SELECT id FROM categories').all().map((c) => c.id);
    if (ids.length !== all.length || !all.every((id) => ids.includes(id))) throw fail(400, 'Lista categoriilor s-a schimbat între timp. Reîncărcați pagina.');
    tx(() => {
      const up = db.prepare('UPDATE categories SET sort = ? WHERE id = ?');
      ids.forEach((id, i) => up.run(i, id));
    });
    audit(req, 'categorii reordonate');
    return { ok: true };
  });
  app.delete('/api/categories/:id', { preHandler: requireAdmin }, async (req) => {
    const id = paramId(req);
    const old = db.prepare('SELECT name FROM categories WHERE id = ?').get(id);
    if (!old) throw fail(404, 'Categoria nu a fost găsită.');
    db.prepare('DELETE FROM categories WHERE id = ?').run(id);
    audit(req, 'categorie ștearsă', old.name);
    return { ok: true };
  });
  app.post('/api/tags', { preHandler: requireAdmin }, async (req) => {
    const name = str(req.body?.name, 80);
    const category_id = idOrNull(req.body?.category_id);
    if (!name) throw fail(400, 'Introduceți denumirea etichetei.');
    if (!db.prepare('SELECT 1 FROM categories WHERE id = ?').get(category_id)) throw fail(400, 'Categoria nu există.');
    const id = lastId(db.prepare('INSERT INTO tags (category_id, name) VALUES (?, ?)').run(category_id, name));
    audit(req, 'etichetă adăugată', name);
    return { id };
  });
  app.put('/api/tags/:id', { preHandler: requireAdmin }, async (req) => {
    const name = str(req.body?.name, 80);
    if (!name) throw fail(400, 'Introduceți denumirea etichetei.');
    const r = db.prepare('UPDATE tags SET name = ? WHERE id = ?').run(name, paramId(req));
    if (!r.changes) throw fail(404, 'Eticheta nu a fost găsită.');
    audit(req, 'etichetă modificată', name);
    return { ok: true };
  });
  app.delete('/api/tags/:id', { preHandler: requireAdmin }, async (req) => {
    const id = paramId(req);
    const old = db.prepare('SELECT name FROM tags WHERE id = ?').get(id);
    if (!old) throw fail(404, 'Eticheta nu a fost găsită.');
    db.prepare('DELETE FROM tags WHERE id = ?').run(id);
    audit(req, 'etichetă ștearsă', old.name);
    return { ok: true };
  });

  // --- documente ---
  app.get('/api/documents', { preHandler: requireUser }, async (req) => listDocuments(req.user));

  app.post('/api/documents', { preHandler: requireEditor }, async (req) => {
    const { doc, saved } = await readDocForm(req);
    let id;
    try {
      id = tx(() => {
        const r = db
          .prepare('INSERT INTO documents (title, number, doc_date, description, visibility, review_until, created_by) VALUES (?, ?, ?, ?, ?, ?, ?)')
          .run(doc.title, doc.number, doc.doc_date, doc.description, doc.visibility, doc.review_until, req.user.id);
        saveDocLinks(lastId(r), doc, saved);
        return lastId(r);
      });
    } catch (e) {
      removeStored(saved.map((f) => f.stored));
      throw e;
    }
    // după salvare fișierele aparțin documentului: o eroare la e-mail nu trebuie să le mai șteargă
    audit(req, 'document adăugat', `#${id} ${doc.title}`);
    return { id, mail: await notifySigners(req, id, [currentSigner(id)]) };
  });

  app.put('/api/documents/:id', { preHandler: requireEditor }, async (req) => {
    const id = paramId(req);
    const old = db.prepare('SELECT id, created_by FROM documents WHERE id = ?').get(id);
    if (!old || !canEdit(req.user, old)) {
      await discardUploads(req);
      throw fail(404, 'Documentul nu a fost găsit sau nu îl puteți modifica.');
    }
    const { doc, saved } = await readDocForm(req, id);
    const removed = [];
    const turnBefore = currentSigner(id);
    try {
      tx(() => {
        db.prepare("UPDATE documents SET title = ?, number = ?, doc_date = ?, description = ?, visibility = ?, review_until = ?, updated_at = datetime('now') WHERE id = ?").run(
          doc.title, doc.number, doc.doc_date, doc.description, doc.visibility, doc.review_until, id
        );
        // versiunile semnate fac parte din lanțul de semnare și nu pot fi eliminate la editare
        const q = db.prepare('SELECT stored FROM document_files WHERE id = ? AND document_id = ? AND signed_by_name IS NULL');
        const del = db.prepare('DELETE FROM document_files WHERE id = ? AND document_id = ?');
        for (const fid of doc.removeFileIds) {
          const f = q.get(fid, id);
          if (f) {
            removed.push(f.stored, ...versionsStored(fid));
            del.run(fid, id);
          }
        }
        saveDocLinks(id, doc, saved);
      });
    } catch (e) {
      removeStored(saved.map((f) => f.stored));
      throw e;
    }
    removeStored(removed);
    audit(req, 'document modificat', `#${id} ${doc.title}`);
    // e-mail doar dacă s-a schimbat persoana care este acum la rând
    const turn = currentSigner(id);
    return { ok: true, mail: turn !== turnBefore ? await notifySigners(req, id, [turn]) : null };
  });

  // --- notificări: documente nevăzute și semnături ---
  app.post('/api/documents/seen-all', { preHandler: requireUser }, async (req) => {
    const acc = accessClause(req.user);
    db.prepare(`INSERT OR IGNORE INTO document_seen (user_id, document_id) SELECT ?, d.id FROM documents d WHERE ${acc.sql}`).run(req.user.id, ...acc.params);
    return { ok: true };
  });
  app.post('/api/documents/:id/seen', { preHandler: requireUser }, async (req) => {
    const doc = accessibleDoc(req.user, paramId(req));
    if (!doc) throw fail(404, 'Documentul nu a fost găsit.');
    markSeen(req.user.id, doc.id);
    return { ok: true };
  });
  // --- semnare cu tokenul prin puntea FleetView ---
  // Emite un jeton de scurtă durată, legat de utilizatorul autentificat. Browserul îl
  // trimite tăvii FleetView (ca Bearer), care îl validează prin /api/sign/validate.
  app.post('/api/sign/token', { preHandler: requireUser }, async (req) => {
    // Cel mult câteva jetoane active per utilizator (mai multe file deschise), ca
    // cererile repetate să nu umple memoria; se renunță la cele mai vechi.
    const mine = [...signTokens].filter(([, t]) => t.userId === req.user.id);
    for (const [k] of mine.slice(0, Math.max(0, mine.length - (MAX_SIGN_TOKENS_PER_USER - 1)))) signTokens.delete(k);
    const token = crypto.randomBytes(32).toString('hex');
    signTokens.set(sha(token), { userId: req.user.id, exp: Date.now() + SIGN_TOKEN_MS });
    audit(req, 'jeton de semnare emis');
    return { token, bridge: SIGN_BRIDGE_ORIGIN };
  });
  // Apelat server-la-server de puntea FleetView ca să confirme un jeton de semnare.
  // Jetonul însuși (din corp) este autentificarea; nu se cere cookie de sesiune.
  app.post('/api/sign/validate', { preHandler: requireSignToken }, async (req) => ({
    ok: true,
    user: { username: req.signUser.username, name: req.signUser.full_name },
  }));

  // Semnatarul aflat la rând încarcă versiunea semnată digital; ea devine versiunea pe care o semnează următorul.
  app.post('/api/documents/:id/sign', { preHandler: requireUser }, async (req) => {
    const id = paramId(req);
    const doc = db.prepare('SELECT id, title FROM documents WHERE id = ?').get(id);
    // verificăm înainte de a scrie ceva pe disc: doar persoana aflată la rând poate încărca
    if (!doc || currentSigner(id) !== req.user.id) {
      await discardUploads(req);
      throw fail(403, 'Nu este rândul dvs. să semnați acest document.');
    }
    const { data, saved } = await readUploads(req);
    const stored = saved.map((f) => f.stored);
    const viaMoldSign = data?.method === 'moldsign';
    try {
      if (!saved.length) throw fail(400, 'Încărcați documentul semnat.');
      // Un PDF trebuie să conțină cel puțin o semnătură, iar niciuna nu poate fi deteriorată sau
      // aplicată pe alt conținut. Încrederea în certificat nu blochează încărcarea; se vede la verificare.
      for (const f of saved.filter((x) => isPdf(x.name))) {
        const sigs = pdfsig.verifyPdf(await fs.promises.readFile(path.join(UPLOAD_DIR, f.stored)), DATA_DIR);
        if (!sigs.length) throw fail(400, `„${f.name}” nu conține nicio semnătură electronică.`);
        if (sigs.some((s) => s.status === 'invalid')) throw fail(400, `„${f.name}” conține o semnătură nevalidă: ${sigs.find((s) => s.status === 'invalid').problems[0]}`);
      }
      // Celelalte formate nu se pot verifica pe server; pentru toate refuzăm un fișier identic cu unul
      // deja existent (adică documentul descărcat și încărcat înapoi fără a fi semnat).
      const known = new Set();
      for (const f of db.prepare('SELECT stored FROM document_files WHERE document_id = ?').all(id)) known.add(await fileHash(f.stored).catch(() => ''));
      for (const f of saved) {
        if (known.has(await fileHash(f.stored))) throw fail(400, `„${f.name}” este identic cu un fișier deja existent. Încărcați versiunea semnată de dvs.`);
      }
      let replaced = [];
      tx(() => {
        // lanțul poate fi modificat de autor cât timp fișierul se încarcă: verificăm din nou, atomic
        if (currentSigner(id) !== req.user.id) throw fail(403, 'Ordinea semnării s-a schimbat între timp; nu mai este rândul dvs.');
        // Se păstrează doar originalele și ultima versiune semnată: noua versiune conține deja
        // semnăturile anterioare, deci versiunile semnate intermediare se elimină.
        replaced = db.prepare('SELECT stored FROM document_files WHERE document_id = ? AND signed_by_name IS NOT NULL').all(id).map((f) => f.stored);
        db.prepare('DELETE FROM document_files WHERE document_id = ? AND signed_by_name IS NOT NULL').run(id);
        const ins =db.prepare("INSERT INTO document_files (document_id, name, stored, size, signed_by, signed_by_name, created_at) VALUES (?, ?, ?, ?, ?, ?, datetime('now'))");
        saved.forEach((f) => ins.run(id, f.name, f.stored, f.size, req.user.id, req.user.full_name));
        const r = db.prepare("UPDATE document_signers SET signed_at = datetime('now') WHERE document_id = ? AND user_id = ? AND signed_at IS NULL").run(id, req.user.id);
        if (!r.changes) throw fail(403, 'Nu este rândul dvs. să semnați acest document.');
        markSeen(req.user.id, id);
      });
      removeStored(replaced);
      audit(req, 'document semnat', `#${id} ${doc.title}${viaMoldSign ? ' (MoldSign)' : ''}: ${saved.map((f) => f.name).join(', ')}`);
    } catch (e) {
      removeStored(stored);
      throw e;
    }
    return { ok: true, mail: await notifySigners(req, id, [currentSigner(id)]) };
  });
  app.post('/api/documents/:id/remind', { preHandler: requireEditor }, async (req) => {
    const id = paramId(req);
    const old = db.prepare('SELECT id, created_by FROM documents WHERE id = ?').get(id);
    if (!old || !canEdit(req.user, old)) throw fail(404, 'Documentul nu a fost găsit.');
    const turn = currentSigner(id);
    if (!turn) throw fail(400, 'Toți semnatarii au semnat deja.');
    // cel mult o retrimitere la 5 minute pentru același document, ca semnatarul să nu fie inundat de e-mailuri
    const last = reminded.get(id) || 0;
    if (Date.now() - last < 5 * 60000) throw fail(429, 'Notificarea a fost retrimisă recent. Reîncercați peste câteva minute.');
    reminded.set(id, Date.now());
    return { mail: await notifySigners(req, id, [turn]) };
  });

  // --- setări (admin): păstrate în baza de date, deci rămân la actualizarea aplicației ---
  const publicSettings = () => {
    const { smtp_pass, ...s } = mail.getSettings();
    const { office_secret, ...o } = office.getSettings();
    return { ...s, ...o, has_password: !!smtp_pass, has_office_secret: !!office_secret };
  };
  app.get('/api/admin/settings', { preHandler: requireAdmin }, async () => publicSettings());
  app.put('/api/admin/settings', { preHandler: requireAdmin }, async (req) => {
    const b = req.body || {};
    const port = str(b.smtp_port, 5);
    if (port && !(Number(port) >= 1 && Number(port) <= 65535)) throw fail(400, 'Portul SMTP trebuie să fie între 1 și 65535.');
    const app_url = str(b.app_url, 200);
    if (app_url && !/^https?:\/\/[^\s]+$/.test(app_url)) throw fail(400, 'Adresa aplicației trebuie să înceapă cu http:// sau https://.');
    const values = {
      smtp_host: str(b.smtp_host, 200),
      smtp_port: port,
      smtp_secure: b.smtp_secure === 'tls' ? 'tls' : '',
      smtp_user: str(b.smtp_user, 200),
      smtp_from: str(b.smtp_from, 200),
      app_url,
    };
    // parola nu este trimisă niciodată înapoi către browser; se schimbă doar dacă este completată
    if (b.clear_password) values.smtp_pass = '';
    else if (b.smtp_pass) values.smtp_pass = String(b.smtp_pass).slice(0, 500);
    const office_url = office.trimUrl(str(b.office_url, 200));
    const office_app_url = office.trimUrl(str(b.office_app_url, 200));
    for (const u of [office_url, office_app_url]) {
      if (u && !/^https?:\/\/[^\s/]+(\/[^\s]*)?$/.test(u)) throw fail(400, 'Adresele editorului de documente trebuie să înceapă cu http:// sau https://.');
    }
    const ov = { office_url, office_app_url };
    if (b.clear_office_secret) ov.office_secret = '';
    else if (b.office_secret) {
      if (String(b.office_secret).length < 8) throw fail(400, 'Cheia secretă a editorului trebuie să aibă cel puțin 8 caractere.');
      ov.office_secret = String(b.office_secret).slice(0, 500);
    }
    tx(() => {
      mail.saveSettings(values);
      office.saveSettings(ov);
    });
    audit(req, 'setări modificate', `SMTP ${values.smtp_host || 'dezactivat'}; editor ${office.enabled() ? office_url : 'dezactivat'}`);
    return publicSettings();
  });
  app.post('/api/admin/settings/test', { preHandler: requireAdmin }, async (req) => {
    const to = str(req.body?.to, 200);
    if (!EMAIL_RE.test(to)) throw fail(400, 'Introduceți o adresă de e-mail validă pentru test.');
    if (!mail.enabled()) throw fail(400, 'Completați și salvați mai întâi serverul SMTP.');
    try {
      await mail.sendTest(to);
    } catch (e) {
      throw fail(400, 'E-mailul nu a putut fi trimis: ' + e.message);
    }
    return { ok: true };
  });

  app.get('/api/admin/audit', { preHandler: requireAdmin }, async () => ({
    rows: db.prepare('SELECT id, at, username, ip, action, details FROM audit_log ORDER BY id DESC LIMIT 2000').all(),
    total: db.prepare('SELECT COUNT(*) AS n FROM audit_log').get().n,
    oldest: db.prepare('SELECT MIN(at) AS at FROM audit_log').get().at,
    retentionDays: AUDIT_RETENTION_DAYS,
  }));
  // Șterge înregistrările până la data indicată, inclusiv. Ziua de azi rămâne întotdeauna în jurnal,
  // iar ștergerea însăși este înregistrată, ca să nu poată trece neobservată.
  app.post('/api/admin/audit/prune', { preHandler: requireAdmin }, async (req) => {
    const until = str(req.body?.until, 10);
    if (!validDate(until)) throw fail(400, 'Alegeți o dată validă.');
    if (until >= localToday()) throw fail(400, 'Se pot șterge doar înregistrările din zilele anterioare celei de azi.');
    const r = db.prepare("DELETE FROM audit_log WHERE at < date(?, '+1 day')").run(until);
    audit(req, 'jurnal curățat', `${r.changes} înregistrări până la ${until.split('-').reverse().join('.')} inclusiv`);
    return { deleted: Number(r.changes) };
  });

  // --- copie de rezervă completă (admin) ---
  app.get('/api/admin/export', { preHandler: requireAdmin }, async (req, reply) => {
    const stamp = new Date().toISOString().slice(0, 16).replace(/[T:]/g, '-');
    audit(req, 'export complet');
    reply.type('application/octet-stream').header('Content-Disposition', `attachment; filename="ansc-backup-${stamp}.anscbackup"`);
    return reply.send(backup.createExportStream());
  });
  // Corpul cererii este chiar arhiva, citită ca flux (poate avea mulți GB).
  let importing = false;
  app.addContentTypeParser('application/octet-stream', (req, payload, done) => done(null, payload));
  app.post('/api/admin/import', { preHandler: requireAdmin, bodyLimit: 1024 ** 4 }, async (req) => {
    if (!req.body || typeof req.body.pipe !== 'function') throw fail(400, 'Încărcați fișierul de backup.');
    if (importing) {
      req.body.resume();
      throw fail(409, 'Un import este deja în curs.');
    }
    importing = true;
    try {
      const r = await backup.importArchive(req.body);
      audit(req, 'import complet', `${r.documents} documente, ${r.users} utilizatori, backup din ${r.created_at}`);
      return r;
    } catch (e) {
      req.log.warn(e);
      audit(req, 'import eșuat', e.message);
      throw fail(400, e.expose ? e.message : 'Arhiva este deteriorată sau nu este un backup e-Management ANSC. Nimic nu a fost modificat.');
    } finally {
      importing = false;
    }
  });

  app.delete('/api/documents/:id', { preHandler: requireEditor }, async (req) => {
    const id = paramId(req);
    const old = db.prepare('SELECT id, title, created_by FROM documents WHERE id = ?').get(id);
    if (!old || !canEdit(req.user, old)) throw fail(404, 'Documentul nu a fost găsit sau nu îl puteți șterge.');
    const signers = db.prepare('SELECT signed_at FROM document_signers WHERE document_id = ?').all(id);
    if (!canDelete(req.user, old, signers)) throw fail(403, 'Documentul are deja semnături; doar un administrator îl poate șterge.');
    audit(req, 'document șters', `#${id} ${old.title}`);
    const stored = db.prepare('SELECT id, stored FROM document_files WHERE document_id = ?').all(id).flatMap((f) => [f.stored, ...versionsStored(f.id)]);
    db.prepare('DELETE FROM documents WHERE id = ?').run(id);
    removeStored(stored);
    return { ok: true };
  });

  // --- editare în pagină (ONLYOFFICE) ---
  // Cine poate modifica un fișier: autorul (sau un administrator) oricând; ceilalți care văd documentul
  // doar cât timp avizarea este deschisă, iar la documentele text doar cu modificări urmărite.
  // Versiunile semnate și documentele care au deja semnături nu se mai modifică.
  const officeFile = db.prepare(
    `SELECT f.id, f.name, f.stored, f.size, f.version, f.signed_by_name, d.id AS document_id, d.title, d.created_by, d.review_until
     FROM document_files f JOIN documents d ON d.id = f.document_id WHERE f.id = ?`
  );
  function editRights(user, f) {
    const type = office.typeOf(f.name);
    if (!type) return { edit: false, reason: 'Acest tip de fișier nu se poate deschide în editor.' };
    if (!type[1]) return { edit: false, reason: 'Formatul vechi se poate doar citi. Pentru modificări, salvați fișierul ca .docx, .xlsx sau .pptx.' };
    if (f.signed_by_name) return { edit: false, reason: 'Versiunea semnată nu se poate modifica.' };
    if (db.prepare('SELECT 1 FROM document_signers WHERE document_id = ? AND signed_at IS NOT NULL').get(f.document_id)) {
      return { edit: false, reason: 'Documentul are deja semnături; o modificare le-ar invalida.' };
    }
    if (canEdit(user, f)) return { edit: true, review: false };
    if (reviewOpen(f)) return { edit: true, review: type[0] === 'word' };
    if (f.review_until) return { edit: false, reason: `Termenul de avizare a expirat la ${f.review_until.split('-').reverse().join('.')}.` };
    return { edit: false, reason: 'Doar autorul poate modifica acest document.' };
  }
  function accessibleFile(user, id) {
    const acc = accessClause(user);
    const ok = db.prepare(`SELECT 1 FROM document_files f JOIN documents d ON d.id = f.document_id WHERE f.id = ? AND ${acc.sql}`).get(id, ...acc.params);
    return ok ? officeFile.get(id) : null;
  }
  // adresa la care serverul de documente ajunge la aplicație (poate diferi de cea din browser, ex. în Docker)
  const appBase = (req) => office.trimUrl(office.getSettings().office_app_url || mail.getSettings().app_url || `${req.protocol}://${req.host}`);
  const lockInfo = (l) => (l ? { name: l.name, since: new Date(l.since).toISOString() } : null);

  app.get('/api/office/:id/config', { preHandler: requireUser }, async (req) => {
    if (!office.enabled()) throw fail(400, 'Editorul de documente nu este configurat. Administratorul îl setează în pagina „Setări”.');
    const f = accessibleFile(req.user, paramId(req));
    if (!f || !fs.existsSync(path.join(UPLOAD_DIR, f.stored))) throw fail(404, 'Fișierul nu a fost găsit.');
    const type = office.typeOf(f.name);
    if (!type) throw fail(400, 'Acest tip de fișier nu se poate deschide în editor.');
    const rights = editRights(req.user, f);
    let mode = rights.edit && req.query.view !== '1' ? 'edit' : 'view';
    let lockedBy = null;
    // dacă altcineva lucrează deja la fișier, deschidem doar pentru citire
    if (mode === 'edit') {
      const l = office.takeLock(f.id, req.user);
      if (!l.ok) {
        mode = 'view';
        lockedBy = lockInfo(l.lock);
      }
    }
    const canWrite = mode === 'edit';
    const base = appBase(req);
    const config = {
      documentType: type[0],
      document: {
        fileType: office.extOf(f.name),
        key: office.docKey(f.stored),
        title: f.name,
        url: `${base}/api/office/file/${f.id}?t=${office.fileToken(f.id, f.stored)}`,
        permissions: {
          // la avizarea documentelor text: doar modificări urmărite, pe care autorul le acceptă sau le respinge
          edit: canWrite && !rights.review,
          review: canWrite,
          comment: canWrite,
          download: true,
          print: true,
          chat: false,
        },
      },
      editorConfig: {
        mode,
        lang: 'ro',
        region: 'ro-RO',
        callbackUrl: `${base}/api/office/callback?f=${f.id}`,
        user: { id: String(req.user.id), name: req.user.full_name },
        customization: { forcesave: false, autosave: true, compactHeader: true, uiTheme: 'theme-light', chat: false },
        coEditing: { mode: 'strict', change: false },
      },
    };
    config.token = office.sign(config);
    markSeen(req.user.id, f.document_id);
    audit(req, canWrite ? 'fișier deschis pentru editare' : 'fișier deschis în editor', `#${f.document_id} ${f.name}`);
    return {
      config,
      scriptUrl: `${office.trimUrl(office.getSettings().office_url)}/web-apps/apps/api/documents/api.js`,
      mode,
      review: canWrite && !!rights.review,
      canEdit: rights.edit,
      reason: rights.edit ? (lockedBy ? `${lockedBy.name} lucrează acum la acest fișier.` : '') : rights.reason,
      lockedBy,
      reviewUntil: f.review_until || '',
      name: f.name,
      title: f.title,
    };
  });

  // Semnal de viață din pagina editorului: păstrează blocarea cât timp editorul este deschis.
  // Cine are fișierul doar pentru citire află așa când s-a eliberat.
  app.post('/api/office/:id/heartbeat', { preHandler: requireUser }, async (req) => {
    const f = accessibleFile(req.user, paramId(req));
    if (!f) throw fail(404, 'Fișierul nu a fost găsit.');
    const l = office.lockOf(f.id);
    const rights = editRights(req.user, f);
    if (req.body?.editing && rights.edit && (!l || l.userId === req.user.id)) {
      office.takeLock(f.id, req.user);
      return { mine: true };
    }
    return { mine: false, lockedBy: l && l.userId !== req.user.id ? lockInfo(l) : null, free: !l && rights.edit };
  });

  // Serverul de documente descarcă fișierul prin linkul temporar semnat (nu are sesiunea utilizatorului).
  async function requireOfficeFile(req) {
    const p = office.verify(req.query.t);
    const f = p && db.prepare('SELECT id, name, stored FROM document_files WHERE id = ?').get(paramId(req));
    if (!f || p.f !== f.id || p.s !== f.stored) throw fail(403, 'Link de fișier invalid sau expirat.');
    req.officeFile = f;
  }
  app.get('/api/office/file/:id', { preHandler: requireOfficeFile }, async (req, reply) => {
    const file = path.join(UPLOAD_DIR, req.officeFile.stored);
    if (!fs.existsSync(file)) throw fail(404, 'Fișierul nu a fost găsit.');
    return reply.type('application/octet-stream').header('Content-Disposition', 'attachment').send(fs.createReadStream(file));
  });

  // Apelul serverului de documente (stare sesiune / fișier salvat). Corpul vine semnat cu cheia comună;
  // folosim doar conținutul verificat din jeton, nu câmpurile nesemnate.
  async function requireOfficeCallback(req) {
    const auth = String(req.headers.authorization || '');
    const fromBody = req.body && typeof req.body.token === 'string' ? office.verify(req.body.token) : null;
    const fromHeader = !fromBody && auth.startsWith('Bearer ') ? office.verify(auth.slice(7)) : null;
    const payload = fromBody || (fromHeader && (fromHeader.payload || fromHeader));
    if (!payload || typeof payload !== 'object') throw fail(403, 'Apel nesemnat sau cu semnătură greșită.');
    req.officeCall = payload;
  }
  // Descarcă versiunea salvată de serverul de documente, cu limita obișnuită de 50 MB.
  async function fetchSaved(url, dest) {
    const res = await fetch(url, { signal: AbortSignal.timeout(120000) });
    if (!res.ok || !res.body) throw new Error('descărcare eșuată: HTTP ' + res.status);
    if (Number(res.headers.get('content-length')) > MAX_FILE) throw new Error('fișier prea mare');
    let size = 0;
    const limit = new Transform({
      transform(chunk, enc, cb) {
        size += chunk.length;
        cb(size > MAX_FILE ? new Error('fișier prea mare') : null, chunk);
      },
    });
    await pipeline(Readable.fromWeb(res.body), limit, fs.createWriteStream(dest));
    return size;
  }
  app.post('/api/office/callback', { preHandler: requireOfficeCallback }, async (req) => {
    const c = req.officeCall;
    const fileId = Number(req.query.f);
    const f = isId(fileId) ? officeFile.get(fileId) : null;
    // cheia trebuie să fie a acestui fișier: versiunea curentă sau una anterioară (sesiune începută înainte de ultima salvare)
    const keys = f ? [f.stored, ...versionsStored(f.id)].map(office.docKey) : [];
    if (!f || !keys.includes(c.key)) {
      req.log.warn({ fileId, key: c.key }, 'apel ONLYOFFICE pentru un fișier necunoscut');
      return { error: 1 };
    }
    const users = Array.isArray(c.users) ? c.users.map(Number) : [];
    if (c.status === 1) {
      // sesiune activă: blocarea rămâne a celui care editează
      const l = office.lockOf(f.id);
      if (l && users.includes(l.userId)) office.takeLock(f.id, { id: l.userId, full_name: l.name });
      return { error: 0 };
    }
    if (c.status === 2 || c.status === 6) {
      if (typeof c.url !== 'string' || !/^https?:\/\//.test(c.url)) return { error: 1 };
      // cineva a semnat între deschiderea editorului și salvare: conținutul semnat nu se mai schimbă
      if (f.signed_by_name || db.prepare('SELECT 1 FROM document_signers WHERE document_id = ? AND signed_at IS NOT NULL').get(f.document_id)) {
        req.log.warn({ fileId: f.id }, 'salvare ONLYOFFICE refuzată: documentul are deja semnături');
        office.releaseLock(f.id);
        return { error: 1 };
      }
      const editor = isId(users[0]) ? db.prepare('SELECT username, full_name FROM users WHERE id = ?').get(users[0]) : null;
      const stored = crypto.randomBytes(16).toString('hex');
      try {
        const size = await fetchSaved(c.url, path.join(UPLOAD_DIR, stored));
        const version = tx(() => {
          const cur = db.prepare('SELECT id, stored, size, version, edited_by_name, edited_at, created_at FROM document_files WHERE id = ?').get(f.id);
          if (!cur) throw new Error('fișierul a fost șters între timp');
          db.prepare('INSERT INTO file_versions (file_id, version, stored, size, edited_by_name, created_at) VALUES (?, ?, ?, ?, ?, ?)').run(
            cur.id, cur.version, cur.stored, cur.size, cur.edited_by_name, cur.edited_at || cur.created_at
          );
          db.prepare("UPDATE document_files SET stored = ?, size = ?, version = version + 1, edited_by_name = ?, edited_at = datetime('now') WHERE id = ?").run(
            stored, size, editor ? editor.full_name : 'Editor de documente', f.id
          );
          db.prepare("UPDATE documents SET updated_at = datetime('now') WHERE id = ?").run(f.document_id);
          return cur.version + 1;
        });
        audit(req, 'fișier modificat în editor', `#${f.document_id} ${f.name} (versiunea ${version}; cea anterioară se păstrează)`, editor?.username || 'editor');
      } catch (e) {
        removeStored([stored]);
        req.log.error(e, 'salvarea din ONLYOFFICE a eșuat');
        return { error: 1 };
      }
      if (c.status === 2) office.releaseLock(f.id);
      return { error: 0 };
    }
    // 3 = eroare la salvare, 4 = închis fără modificări, 7 = eroare la salvarea forțată
    if (c.status === 3 || c.status === 7) req.log.error({ fileId: f.id, status: c.status }, 'ONLYOFFICE nu a putut salva documentul');
    if (c.status === 3 || c.status === 4) office.releaseLock(f.id);
    return { error: 0 };
  });

  // Versiunile anterioare ale unui fișier modificat în editor.
  app.get('/api/files/:id/versions', { preHandler: requireUser }, async (req) => {
    const f = accessibleFile(req.user, paramId(req));
    if (!f) throw fail(404, 'Fișierul nu a fost găsit.');
    return db.prepare('SELECT id, version, size, edited_by_name, created_at FROM file_versions WHERE file_id = ? ORDER BY version DESC').all(f.id);
  });
  app.get('/api/file-versions/:id', { preHandler: requireUser }, async (req, reply) => {
    const v = db.prepare('SELECT file_id, version, stored FROM file_versions WHERE id = ?').get(paramId(req));
    const f = v && accessibleFile(req.user, v.file_id);
    const file = f && path.join(UPLOAD_DIR, v.stored);
    if (!f || !fs.existsSync(file)) throw fail(404, 'Versiunea nu a fost găsită.');
    audit(req, 'versiune veche descărcată', `#${f.document_id} ${f.name} (versiunea ${v.version})`);
    const ext = path.extname(f.name);
    const name = `${path.basename(f.name, ext)} (versiunea ${v.version})${ext}`;
    reply
      .type('application/octet-stream')
      .header('Content-Disposition', `attachment; filename="${name.replace(/[^\x20-\x7e]|["\\]/g, '_')}"; filename*=UTF-8''${encodeURIComponent(name)}`);
    return reply.send(fs.createReadStream(file));
  });

  app.get('/api/files/:id', { preHandler: requireUser }, async (req, reply) => {
    const acc = accessClause(req.user);
    const f = db
      .prepare(`SELECT f.name, f.stored, f.document_id FROM document_files f JOIN documents d ON d.id = f.document_id WHERE f.id = ? AND ${acc.sql}`)
      .get(paramId(req), ...acc.params);
    const file = f && path.join(UPLOAD_DIR, f.stored);
    if (!f || !fs.existsSync(file)) throw fail(404, 'Fișierul nu a fost găsit.');
    markSeen(req.user.id, f.document_id); // deschiderea unui fișier înseamnă că documentul a fost văzut
    audit(req, 'fișier descărcat', `#${f.document_id} ${f.name}`);
    // doar PDF și imaginile se deschid în browser; restul se descarcă
    const inline = INLINE_TYPES[path.extname(f.name).toLowerCase()];
    reply
      .type(inline || 'application/octet-stream')
      .header(
        'Content-Disposition',
        `${inline && !req.query.download ? 'inline' : 'attachment'}; filename="${f.name.replace(/[^\x20-\x7e]|["\\]/g, '_')}"; filename*=UTF-8''${encodeURIComponent(f.name)}`
      );
    return reply.send(fs.createReadStream(file));
  });
  // Verificarea semnăturilor dintr-un PDF, pe server și fără rețea (vezi src/pdfsig.js).
  app.get('/api/files/:id/signatures', { preHandler: requireUser }, async (req) => {
    const acc = accessClause(req.user);
    const f = db
      .prepare(`SELECT f.name, f.stored FROM document_files f JOIN documents d ON d.id = f.document_id WHERE f.id = ? AND ${acc.sql}`)
      .get(paramId(req), ...acc.params);
    const file = f && path.join(UPLOAD_DIR, f.stored);
    if (!f || !fs.existsSync(file)) throw fail(404, 'Fișierul nu a fost găsit.');
    if (!isPdf(f.name)) throw fail(400, 'Verificarea semnăturii este disponibilă doar pentru fișiere PDF.');
    return { name: f.name, signatures: pdfsig.verifyPdf(await fs.promises.readFile(file), DATA_DIR) };
  });
});

// ---------- întreținere la pornire ----------
// Un import întrerupt (oprirea serverului, pana de curent) lasă în urmă un folder temporar, uneori mare.
function cleanupLeftovers() {
  try {
    for (const n of fs.readdirSync(DATA_DIR)) {
      if (/^import-/.test(n)) fs.rmSync(path.join(DATA_DIR, n), { recursive: true, force: true });
    }
    // Fișierele fără document (o încărcare întreruptă) nu se șterg automat, doar se semnalează.
    const known = new Set(db.prepare('SELECT stored FROM document_files UNION ALL SELECT stored FROM file_versions').all().map((r) => r.stored));
    const orphans = fs.readdirSync(UPLOAD_DIR).filter((n) => !known.has(n)).length;
    if (orphans) console.warn(`Atenție: ${orphans} fișiere din ${UPLOAD_DIR} nu aparțin niciunui document.`);
    const missing = [...known].filter((n) => !fs.existsSync(path.join(UPLOAD_DIR, n))).length;
    if (missing) console.warn(`Atenție: ${missing} fișiere ale documentelor lipsesc din ${UPLOAD_DIR}.`);
  } catch (e) {
    console.error('Verificarea folderului de date a eșuat:', e.message);
  }
}
cleanupLeftovers();

// Jurnalul păstrează ultimele 90 de zile; ce este mai vechi se șterge la pornire și apoi o dată pe zi.
function pruneOldAudit() {
  try {
    const r = db.prepare("DELETE FROM audit_log WHERE at < datetime('now', ?)").run(`-${AUDIT_RETENTION_DAYS} days`);
    if (r.changes) auditInsert.run('sistem', '', 'jurnal curățat automat', `${r.changes} înregistrări mai vechi de ${AUDIT_RETENTION_DAYS} de zile`);
  } catch (e) {
    console.error('Curățarea jurnalului a eșuat:', e.message);
  }
}
pruneOldAudit();
setInterval(pruneOldAudit, 24 * 3600 * 1000).unref();

process.on('unhandledRejection', (e) => app.log.error(e));

// Oprire curată: cererile în curs se termină, apoi baza de date este închisă (jurnalul WAL este scris în fișier).
let stopping = false;
function shutdown(signal) {
  if (stopping) return;
  stopping = true;
  console.log(`Oprire (${signal})…`);
  setTimeout(() => process.exit(1), 10000).unref();
  app.close().finally(() => {
    try {
      db.close();
    } catch {}
    process.exit(0);
  });
}
process.once('SIGINT', () => shutdown('SIGINT'));
process.once('SIGTERM', () => shutdown('SIGTERM'));

app.listen({ port: PORT, host: HOST }).then(
  () => console.log(`e-Management ANSC rulează pe http://localhost:${PORT}`),
  (err) => {
    console.error(err.code === 'EADDRINUSE' ? `Portul ${PORT} este deja folosit de alt program. Setați altul prin variabila PORT.` : err);
    process.exit(1);
  }
);
