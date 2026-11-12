'use strict';
const path = require('node:path');
const fs = require('node:fs');
const crypto = require('node:crypto');
const { pipeline } = require('node:stream/promises');
const Fastify = require('fastify');
const { db, tx, hashPassword, checkPassword, UPLOAD_DIR, DATA_DIR, INITIAL_PASSWORD_FILE } = require('./db');
const mail = require('./mail');
const backup = require('./backup');
const assets = require('./assets');
const update = require('./update');
const { NAME, VERSION } = require('./install');

const PORT = Number(process.env.PORT) || 3080;
const HOST = process.env.HOST || '0.0.0.0';
const MAX_FILE = 50 * 1024 * 1024;
const SESSION_MS = 12 * 3600 * 1000; // o zi de lucru; după aceea se cere din nou autentificarea
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
setInterval(() => {
  const now = Date.now();
  for (const [k, f] of loginFails) if (f.until < now && f.last < now - 30 * 60000) loginFails.delete(k);
  for (const [k, t] of reminded) if (t < now - 10 * 60000) reminded.delete(k);
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

async function requireUser(req) {
  const sid = req.cookies.sid;
  const user = sid
    ? db
        .prepare(
          `SELECT u.id, u.username, u.full_name, u.position, u.email, u.unit_id, u.role, u.must_change, u.created_at
           FROM sessions s JOIN users u ON u.id = s.user_id
           WHERE s.token_hash = ? AND s.expires_at > ? AND u.active = 1`
        )
        .get(sha(sid), Date.now())
    : null;
  if (!user) throw fail(401, 'Este necesară autentificarea.');
  if (user.must_change && !req.routeOptions.config.allowMustChange) throw fail(403, 'Schimbați mai întâi parola.');
  req.user = user;
}
async function requireAdmin(req) {
  await requireUser(req);
  if (req.user.role !== 'admin') throw fail(403, 'Acțiune permisă doar administratorilor.');
}
async function requireEditor(req) {
  await requireUser(req);
  if (req.user.role === 'user') throw fail(403, 'Nu aveți dreptul de a adăuga documente.');
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
  return { full_name, username, role, unit_id, position: str(body.position, 150), email, active: body.active === false ? 0 : 1 };
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
  const doc_date = str(data.doc_date, 10);
  if (!validDate(doc_date)) throw fail(400, 'Indicați o dată validă a documentului.');
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
function currentSigner(docId) {
  const r = db.prepare('SELECT user_id FROM document_signers WHERE document_id = ? AND signed_at IS NULL ORDER BY position, user_id LIMIT 1').get(docId);
  return r ? r.user_id : null;
}

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
      `SELECT d.id, d.title, d.number, d.doc_date, d.description, d.visibility, d.created_by, d.created_at,
              a.full_name AS author,
              EXISTS (SELECT 1 FROM document_seen s WHERE s.document_id = d.id AND s.user_id = ?) AS seen
       FROM documents d LEFT JOIN users a ON a.id = d.created_by
       WHERE ${acc.sql}
       ORDER BY d.doc_date DESC, d.id DESC`
    )
    .all(user.id, ...acc.params);
  if (!rows.length) return [];
  const signers = byDocument(
    db.prepare(
      'SELECT s.document_id, s.user_id AS id, u.full_name AS name, u.active, s.signed_at FROM document_signers s JOIN users u ON u.id = s.user_id ORDER BY s.position, s.user_id'
    ).all(),
    (r) => ({ ...r, active: !!r.active })
  );
  const tags = byDocument(db.prepare('SELECT document_id, tag_id FROM document_tags').all(), (r) => r.tag_id);
  const units = byDocument(db.prepare('SELECT document_id, unit_id FROM document_units').all(), (r) => r.unit_id);
  const users = byDocument(db.prepare('SELECT document_id, user_id FROM document_users').all(), (r) => r.user_id);
  const files = byDocument(db.prepare('SELECT document_id, id, name, size, signed_by, signed_by_name, created_at FROM document_files ORDER BY id').all());
  return rows.map(({ seen, ...d }) => {
    const sig = signers.get(d.id) || [];
    const mine = sig.find((s) => s.id === user.id);
    const turn = sig.find((s) => !s.signed_at);
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
    };
  });
}

const markSeen = (userId, docId) => db.prepare('INSERT OR IGNORE INTO document_seen (user_id, document_id) VALUES (?, ?)').run(userId, docId);
function accessibleDoc(user, id) {
  const acc = accessClause(user);
  return db.prepare(`SELECT d.id, d.created_by FROM documents d WHERE d.id = ? AND ${acc.sql}`).get(id, ...acc.params);
}

const INLINE_TYPES = { '.pdf': 'application/pdf', '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg' };

// ---------- pluginuri ----------
app.register(require('@fastify/cookie'));
app.register(require('@fastify/multipart'), { limits: { fileSize: MAX_FILE, files: 10, fields: 5, fieldSize: 200000 } });
// Interfața (public/ și Vue): din programul publicat sau de pe disc, vezi src/assets.js.
for (const url of Object.keys(assets.FILES)) {
  app.get(url, (req, reply) => {
    const f = assets.get(url);
    // Vue se schimbă doar odată cu versiunea aplicației; restul se reverifică la fiecare încărcare (ETag).
    reply.type(f.type).header('ETag', f.etag).header('Cache-Control', url === '/vendor/vue.js' ? 'public, max-age=86400' : 'no-cache');
    if (req.headers['if-none-match'] === f.etag) return reply.code(304).send();
    return reply.send(f.body);
  });
}

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
const CSP = "default-src 'self'; script-src 'self' 'unsafe-eval'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; object-src 'none'; base-uri 'self'; form-action 'self'; frame-ancestors 'none'";
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
  if (!req.url.startsWith('/api/files/')) reply.header('Content-Security-Policy', CSP);
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
  // (Vue este servit local, fără CDN, ca aplicația să funcționeze și într-o rețea internă: /vendor/vue.js, mai sus.)

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
    reply.setCookie('sid', token, {
      path: '/',
      httpOnly: true,
      sameSite: 'strict',
      secure: isHttps(req),
      maxAge: SESSION_MS / 1000,
    });
    return { ok: true };
  });

  app.post('/api/logout', async (req, reply) => {
    if (req.cookies.sid) db.prepare('DELETE FROM sessions WHERE token_hash = ?').run(sha(req.cookies.sid));
    reply.clearCookie('sid', { path: '/' });
    return { ok: true };
  });

  app.get('/api/me', { preHandler: requireUser, config: { allowMustChange: true } }, async (req) => ({ ...req.user, mailEnabled: mail.enabled() }));

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

  // --- organigramă (vizibilă tuturor angajaților) ---
  app.get('/api/directory', { preHandler: requireUser }, async () => ({
    units: db.prepare('SELECT id, name, type, parent_id, sort FROM units ORDER BY sort, name').all(),
    users: db.prepare('SELECT id, full_name, position, email, unit_id FROM users WHERE active = 1 ORDER BY full_name').all(),
  }));

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
    db.prepare('SELECT id, username, full_name, position, email, unit_id, role, active, must_change FROM users ORDER BY full_name').all()
  );
  app.post('/api/users', { preHandler: requireAdmin }, async (req) => {
    const body = req.body || {};
    const u = readUser(body);
    const password = readPassword(body.password);
    if (db.prepare('SELECT 1 FROM users WHERE username = ?').get(u.username)) throw fail(400, 'Acest nume de utilizator există deja.');
    const r = db
      .prepare('INSERT INTO users (username, full_name, position, email, unit_id, role, active, pass_hash, must_change) VALUES (?, ?, ?, ?, ?, ?, ?, ?, 1)')
      .run(u.username, u.full_name, u.position, u.email, u.unit_id, u.role, u.active, hashPassword(password));
    audit(req, 'utilizator creat', `${u.username} (${u.role})`);
    return { id: lastId(r) };
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
      db.prepare('UPDATE users SET username = ?, full_name = ?, position = ?, email = ?, unit_id = ?, role = ?, active = ? WHERE id = ?').run(
        u.username, u.full_name, u.position, u.email, u.unit_id, u.role, u.active, id
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
    return { id: lastId(db.prepare('INSERT INTO categories (name, color, sort) VALUES (?, ?, ?)').run(c.name, c.color, max)) };
  });
  app.put('/api/categories/:id', { preHandler: requireAdmin }, async (req) => {
    const c = readCategory(req.body || {});
    const r = db.prepare('UPDATE categories SET name = ?, color = ?, sort = ? WHERE id = ?').run(c.name, c.color, c.sort, paramId(req));
    if (!r.changes) throw fail(404, 'Categoria nu a fost găsită.');
    return { ok: true };
  });
  app.delete('/api/categories/:id', { preHandler: requireAdmin }, async (req) => {
    const r = db.prepare('DELETE FROM categories WHERE id = ?').run(paramId(req));
    if (!r.changes) throw fail(404, 'Categoria nu a fost găsită.');
    return { ok: true };
  });
  app.post('/api/tags', { preHandler: requireAdmin }, async (req) => {
    const name = str(req.body?.name, 80);
    const category_id = idOrNull(req.body?.category_id);
    if (!name) throw fail(400, 'Introduceți denumirea etichetei.');
    if (!db.prepare('SELECT 1 FROM categories WHERE id = ?').get(category_id)) throw fail(400, 'Categoria nu există.');
    return { id: lastId(db.prepare('INSERT INTO tags (category_id, name) VALUES (?, ?)').run(category_id, name)) };
  });
  app.put('/api/tags/:id', { preHandler: requireAdmin }, async (req) => {
    const name = str(req.body?.name, 80);
    if (!name) throw fail(400, 'Introduceți denumirea etichetei.');
    const r = db.prepare('UPDATE tags SET name = ? WHERE id = ?').run(name, paramId(req));
    if (!r.changes) throw fail(404, 'Eticheta nu a fost găsită.');
    return { ok: true };
  });
  app.delete('/api/tags/:id', { preHandler: requireAdmin }, async (req) => {
    const r = db.prepare('DELETE FROM tags WHERE id = ?').run(paramId(req));
    if (!r.changes) throw fail(404, 'Eticheta nu a fost găsită.');
    return { ok: true };
  });

  // --- documente ---
  app.get('/api/documents', { preHandler: requireUser }, async (req) => listDocuments(req.user));

  app.post('/api/documents', { preHandler: requireEditor }, async (req) => {
    const { doc, saved } = await readDocForm(req);
    try {
      const id = tx(() => {
        const r = db
          .prepare('INSERT INTO documents (title, number, doc_date, description, visibility, created_by) VALUES (?, ?, ?, ?, ?, ?)')
          .run(doc.title, doc.number, doc.doc_date, doc.description, doc.visibility, req.user.id);
        saveDocLinks(lastId(r), doc, saved);
        return lastId(r);
      });
      audit(req, 'document adăugat', `#${id} ${doc.title}`);
      return { id, mail: await notifySigners(req, id, [currentSigner(id)]) };
    } catch (e) {
      removeStored(saved.map((f) => f.stored));
      throw e;
    }
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
        db.prepare("UPDATE documents SET title = ?, number = ?, doc_date = ?, description = ?, visibility = ?, updated_at = datetime('now') WHERE id = ?").run(
          doc.title, doc.number, doc.doc_date, doc.description, doc.visibility, id
        );
        // versiunile semnate fac parte din lanțul de semnare și nu pot fi eliminate la editare
        const q = db.prepare('SELECT stored FROM document_files WHERE id = ? AND document_id = ? AND signed_by_name IS NULL');
        const del = db.prepare('DELETE FROM document_files WHERE id = ? AND document_id = ?');
        for (const fid of doc.removeFileIds) {
          const f = q.get(fid, id);
          if (f) {
            removed.push(f.stored);
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
  // Semnatarul aflat la rând încarcă versiunea semnată digital; ea devine versiunea pe care o semnează următorul.
  app.post('/api/documents/:id/sign', { preHandler: requireUser }, async (req) => {
    const id = paramId(req);
    const doc = db.prepare('SELECT id, title FROM documents WHERE id = ?').get(id);
    // verificăm înainte de a scrie ceva pe disc: doar persoana aflată la rând poate încărca
    if (!doc || currentSigner(id) !== req.user.id) {
      await discardUploads(req);
      throw fail(403, 'Nu este rândul dvs. să semnați acest document.');
    }
    const { saved } = await readUploads(req);
    const stored = saved.map((f) => f.stored);
    try {
      if (!saved.length) throw fail(400, 'Încărcați documentul semnat.');
      // Nu putem valida criptografic semnătura, dar putem refuza un fișier identic cu unul deja existent
      // (adică documentul descărcat și încărcat înapoi fără a fi semnat).
      const known = new Set();
      for (const f of db.prepare('SELECT stored FROM document_files WHERE document_id = ?').all(id)) known.add(await fileHash(f.stored).catch(() => ''));
      for (const f of saved) {
        if (known.has(await fileHash(f.stored))) throw fail(400, `„${f.name}” este identic cu un fișier deja existent. Încărcați versiunea semnată de dvs.`);
      }
      tx(() => {
        // lanțul poate fi modificat de autor cât timp fișierul se încarcă: verificăm din nou, atomic
        if (currentSigner(id) !== req.user.id) throw fail(403, 'Ordinea semnării s-a schimbat între timp; nu mai este rândul dvs.');
        const ins = db.prepare("INSERT INTO document_files (document_id, name, stored, size, signed_by, signed_by_name, created_at) VALUES (?, ?, ?, ?, ?, ?, datetime('now'))");
        saved.forEach((f) => ins.run(id, f.name, f.stored, f.size, req.user.id, req.user.full_name));
        const r = db.prepare("UPDATE document_signers SET signed_at = datetime('now') WHERE document_id = ? AND user_id = ? AND signed_at IS NULL").run(id, req.user.id);
        if (!r.changes) throw fail(403, 'Nu este rândul dvs. să semnați acest document.');
        markSeen(req.user.id, id);
      });
      audit(req, 'document semnat', `#${id} ${doc.title}: ${saved.map((f) => f.name).join(', ')}`);
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
    return { ...s, has_password: !!smtp_pass };
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
    tx(() => mail.saveSettings(values));
    audit(req, 'setări modificate', `SMTP ${values.smtp_host || 'dezactivat'}`);
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
    // data de azi după ceasul local al serverului (același fus orar cu utilizatorii)
    const now = new Date();
    const today = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}-${String(now.getDate()).padStart(2, '0')}`;
    if (until >= today) throw fail(400, 'Se pot șterge doar înregistrările din zilele anterioare celei de azi.');
    const r = db.prepare("DELETE FROM audit_log WHERE at < date(?, '+1 day')").run(until);
    audit(req, 'jurnal curățat', `${r.changes} înregistrări până la ${until.split('-').reverse().join('.')} inclusiv`);
    return { deleted: Number(r.changes) };
  });

  // --- actualizări (admin): versiunile publicate pe GitHub, verificate cu SHA-256 ---
  app.get('/api/admin/update', { preHandler: requireAdmin }, async () => update.publicState());
  app.post('/api/admin/update/check', { preHandler: requireAdmin }, async () => {
    await update.check();
    return update.publicState();
  });
  app.post('/api/admin/update/apply', { preHandler: requireAdmin }, async (req) => {
    if (!update.state.canApply) throw fail(400, 'Rulează din surse (npm start): actualizați codul cu git, nu din aplicație.');
    if (!update.state.available) throw fail(400, 'Nu există o versiune mai nouă.');
    if (update.state.busy) throw fail(409, 'O actualizare este deja în curs.');
    update.state.busy = true;
    let file;
    try {
      file = await update.download(DATA_DIR);
    } catch (e) {
      throw fail(400, e.message);
    } finally {
      update.state.busy = false;
    }
    const version = update.state.latest;
    audit(req, 'actualizare', `${update.state.current} → ${version}`);
    // răspunsul pleacă înainte ca serverul să se oprească; noua versiune pornește singură
    setTimeout(() => {
      try {
        update.apply(file, shutdown);
      } catch (e) {
        app.log.error(e);
      }
    }, 500);
    return { ok: true, version };
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
    const stored = db.prepare('SELECT stored FROM document_files WHERE document_id = ?').all(id).map((f) => f.stored);
    db.prepare('DELETE FROM documents WHERE id = ?').run(id);
    removeStored(stored);
    return { ok: true };
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
});

// ---------- întreținere la pornire ----------
// Un import întrerupt (oprirea serverului, pana de curent) lasă în urmă un folder temporar, uneori mare.
function cleanupLeftovers() {
  try {
    for (const n of fs.readdirSync(DATA_DIR)) {
      if (/^import-/.test(n)) fs.rmSync(path.join(DATA_DIR, n), { recursive: true, force: true });
    }
    // Fișierele fără document (o încărcare întreruptă) nu se șterg automat, doar se semnalează.
    const known = new Set(db.prepare('SELECT stored FROM document_files').all().map((r) => r.stored));
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

// Pornit de src/main.js (sau direct, `node src/server.js`).
async function start() {
  await app.listen({ port: PORT, host: HOST });
  console.log(`${NAME} ${VERSION} rulează pe http://localhost:${PORT}`);
  update.schedule();
}

module.exports = { start, shutdown, PORT, HOST };

if (require.main === module) {
  start().catch((err) => {
    console.error(err.code === 'EADDRINUSE' ? `Portul ${PORT} este deja folosit de alt program. Setați altul prin variabila PORT.` : err);
    process.exit(1);
  });
}
