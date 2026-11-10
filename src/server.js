'use strict';
const path = require('node:path');
const fs = require('node:fs');
const crypto = require('node:crypto');
const { pipeline } = require('node:stream/promises');
const Fastify = require('fastify');
const { db, tx, hashPassword, checkPassword, UPLOAD_DIR, INITIAL_PASSWORD_FILE } = require('./db');
const mail = require('./mail');
const backup = require('./backup');

const PORT = Number(process.env.PORT) || 3080;
const HOST = process.env.HOST || '0.0.0.0';
const MAX_FILE = 50 * 1024 * 1024;
const SESSION_MS = 12 * 3600 * 1000; // o zi de lucru; după aceea se cere din nou autentificarea
const ROLES = ['admin', 'editor', 'user'];

// Antetele X-Forwarded-* sunt crezute doar dacă vin de la un proxy de pe aceeași mașină (cazul obișnuit).
// Astfel adresa IP reală ajunge în jurnal și în limitarea autentificărilor, fără a putea fi falsificată din rețea.
const app = Fastify({ logger: { level: 'warn' }, trustProxy: process.env.TRUST_PROXY || 'loopback' });

// ---------- utilitare ----------
const fail = (code, message) => Object.assign(new Error(message), { statusCode: code, expose: true });
const str = (v, max) => String(v ?? '').trim().slice(0, max);
const idOrNull = (v) => (v === null || v === undefined || v === '' ? null : Number.isInteger(Number(v)) ? Number(v) : null);
const idList = (v) => [...new Set((Array.isArray(v) ? v : []).map(Number).filter(Number.isInteger))];
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
setInterval(() => {
  const now = Date.now();
  for (const [k, f] of loginFails) if (f.until < now && f.last < now - 30 * 60000) loginFails.delete(k);
}, 5 * 60000).unref();
// Verificată când utilizatorul nu există, ca timpul de răspuns să nu trădeze ce conturi sunt reale.
const DUMMY_HASH = hashPassword(crypto.randomBytes(16).toString('hex'));

const isHttps = (req) => req.protocol === 'https' || req.headers['x-forwarded-proto'] === 'https';

// Jurnal de audit: cine, ce și când. Nu se șterge la import și nu poate fi modificat din interfață.
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
  return { full_name, username, role, unit_id, position: str(body.position, 150), email: str(body.email, 150), active: body.active === false ? 0 : 1 };
}

function readPassword(v) {
  const p = String(v ?? '');
  if (p.length < 10 || p.length > 200) throw fail(400, 'Parola trebuie să aibă cel puțin 10 caractere.');
  if (/^(.)\1*$/.test(p) || ['1234567890', 'parola1234', 'password123', 'qwertyuiop'].includes(p.toLowerCase())) {
    throw fail(400, 'Parola este prea ușor de ghicit.');
  }
  return p;
}

function readDoc(data) {
  if (!data || typeof data !== 'object') throw fail(400, 'Date lipsă.');
  const title = str(data.title, 300);
  if (!title) throw fail(400, 'Introduceți denumirea documentului.');
  const doc_date = str(data.doc_date, 10);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(doc_date) || Number.isNaN(Date.parse(doc_date))) {
    throw fail(400, 'Indicați data documentului.');
  }
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
    signerIds: exists('users', idList(data.signerIds)),
    removeFileIds: idList(data.removeFileIds),
  };
}

async function readDocForm(req) {
  const { data, saved } = await readUploads(req);
  try {
    return { doc: readDoc(data), saved };
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

// Semnarea este în lanț: următorul la rând este primul semnatar (după poziție) care încă nu a semnat.
function currentSigner(docId) {
  const r = db.prepare('SELECT user_id FROM document_signers WHERE document_id = ? AND signed_at IS NULL ORDER BY position, user_id LIMIT 1').get(docId);
  return r ? r.user_id : null;
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

function listDocuments(user, onlyId) {
  const acc = accessClause(user);
  const rows = db
    .prepare(
      `SELECT d.id, d.title, d.number, d.doc_date, d.description, d.visibility, d.created_by, d.created_at,
              a.full_name AS author,
              EXISTS (SELECT 1 FROM document_seen s WHERE s.document_id = d.id AND s.user_id = ?) AS seen
       FROM documents d LEFT JOIN users a ON a.id = d.created_by
       WHERE ${acc.sql} ${onlyId ? 'AND d.id = ?' : ''}
       ORDER BY d.doc_date DESC, d.id DESC`
    )
    .all(user.id, ...acc.params, ...(onlyId ? [onlyId] : []));
  const signers = db.prepare(
    'SELECT s.user_id AS id, u.full_name AS name, s.signed_at FROM document_signers s JOIN users u ON u.id = s.user_id WHERE s.document_id = ? ORDER BY s.position, s.user_id'
  );
  const tags = db.prepare('SELECT tag_id FROM document_tags WHERE document_id = ?');
  const units = db.prepare('SELECT unit_id FROM document_units WHERE document_id = ?');
  const users = db.prepare('SELECT user_id FROM document_users WHERE document_id = ?');
  const files = db.prepare('SELECT id, name, size, signed_by, signed_by_name, created_at FROM document_files WHERE document_id = ? ORDER BY id');
  return rows.map(({ seen, ...d }) => {
    const sig = signers.all(d.id);
    const mine = sig.find((s) => s.id === user.id);
    const turn = sig.find((s) => !s.signed_at);
    return {
    ...d,
    signers: sig,
    signTurn: turn ? turn.id : null,
    // 'pending' = este rândul meu; 'waiting' = aștept să semneze cei dinaintea mea
    mySign: mine ? (mine.signed_at ? 'signed' : turn.id === user.id ? 'pending' : 'waiting') : null,
    canDelete: canDelete(user, d, sig),
    // „nevăzut” = document al altcuiva, apărut după crearea contului și încă nedeschis
    unseen: !seen && d.created_by !== user.id && d.created_at >= user.created_at,
    tagIds: tags.all(d.id).map((r) => r.tag_id),
    unitIds: units.all(d.id).map((r) => r.unit_id),
    userIds: users.all(d.id).map((r) => r.user_id),
    files: files.all(d.id),
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
const CSP = "default-src 'self'; script-src 'self' 'unsafe-eval'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; object-src 'none'; base-uri 'self'; form-action 'self'; frame-ancestors 'none'";
app.addHook('onSend', async (req, reply) => {
  reply.header('X-Content-Type-Options', 'nosniff');
  reply.header('X-Frame-Options', 'DENY');
  reply.header('Referrer-Policy', 'same-origin');
  reply.header('Permissions-Policy', 'camera=(), microphone=(), geolocation=()');
  if (isHttps(req)) reply.header('Strict-Transport-Security', 'max-age=31536000; includeSubDomains');
  if (req.url.startsWith('/api/')) reply.header('Cache-Control', 'no-store');
  // fișierele descărcate nu primesc CSP-ul aplicației: vizualizatorul PDF al browserului are nevoie de propriile resurse
  if (!req.url.startsWith('/api/files/')) reply.header('Content-Security-Policy', CSP);
});

app.setErrorHandler((err, req, reply) => {
  if (err.code === 'FST_REQ_FILE_TOO_LARGE') return reply.code(413).send({ error: 'Fișierul depășește limita de 50 MB.' });
  if (err.code === 'FST_FILES_LIMIT') return reply.code(413).send({ error: 'Cel mult 10 fișiere per document.' });
  const code = err.statusCode && err.statusCode >= 400 ? err.statusCode : 500;
  if (code >= 500) req.log.error(err);
  reply.code(code).send({ error: err.expose ? err.message : code >= 500 ? 'Eroare internă de server.' : 'Cerere invalidă.' });
});

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
    const row = db.prepare('SELECT pass_hash FROM users WHERE id = ?').get(req.user.id);
    if (!checkPassword(String(req.body?.current ?? ''), row.pass_hash)) throw fail(400, 'Parola curentă este incorectă.');
    const next = readPassword(req.body?.next);
    if (next === String(req.body.current)) throw fail(400, 'Parola nouă trebuie să difere de cea curentă.');
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
    return { id: lastId(r) };
  });
  app.put('/api/units/:id', { preHandler: requireAdmin }, async (req) => {
    const id = Number(req.params.id);
    const u = readUnit(req.body || {}, id);
    const r = db.prepare('UPDATE units SET name = ?, type = ?, parent_id = ?, sort = ? WHERE id = ?').run(u.name, u.type, u.parent_id, u.sort, id);
    if (!r.changes) throw fail(404, 'Subdiviziunea nu a fost găsită.');
    return { ok: true };
  });
  app.delete('/api/units/:id', { preHandler: requireAdmin }, async (req) => {
    const id = Number(req.params.id);
    if (db.prepare('SELECT 1 FROM units WHERE parent_id = ?').get(id)) throw fail(400, 'Mutați sau ștergeți mai întâi subdiviziunile din subordine.');
    if (db.prepare('SELECT 1 FROM users WHERE unit_id = ?').get(id)) throw fail(400, 'Mutați mai întâi angajații din această subdiviziune.');
    const r = db.prepare('DELETE FROM units WHERE id = ?').run(id);
    if (!r.changes) throw fail(404, 'Subdiviziunea nu a fost găsită.');
    return { ok: true };
  });

  // --- utilizatori (admin) ---
  app.get('/api/users', { preHandler: requireAdmin }, async () =>
    db.prepare('SELECT id, username, full_name, position, email, unit_id, role, active, must_change FROM users ORDER BY full_name').all()
  );
  app.post('/api/users', { preHandler: requireAdmin }, async (req) => {
    const u = readUser(req.body || {});
    const password = readPassword(req.body.password);
    if (db.prepare('SELECT 1 FROM users WHERE username = ?').get(u.username)) throw fail(400, 'Acest nume de utilizator există deja.');
    const r = db
      .prepare('INSERT INTO users (username, full_name, position, email, unit_id, role, active, pass_hash, must_change) VALUES (?, ?, ?, ?, ?, ?, ?, ?, 1)')
      .run(u.username, u.full_name, u.position, u.email, u.unit_id, u.role, u.active, hashPassword(password));
    audit(req, 'utilizator creat', `${u.username} (${u.role})`);
    return { id: lastId(r) };
  });
  app.put('/api/users/:id', { preHandler: requireAdmin }, async (req) => {
    const id = Number(req.params.id);
    const old = db.prepare('SELECT id, role, active FROM users WHERE id = ?').get(id);
    if (!old) throw fail(404, 'Utilizatorul nu a fost găsit.');
    const u = readUser(req.body || {});
    if (db.prepare('SELECT 1 FROM users WHERE username = ? AND id <> ?').get(u.username, id)) throw fail(400, 'Acest nume de utilizator există deja.');
    if (old.role === 'admin' && old.active && (u.role !== 'admin' || !u.active) && !activeAdminsExcept(id)) {
      throw fail(400, 'Trebuie să rămână cel puțin un administrator activ.');
    }
    tx(() => {
      db.prepare('UPDATE users SET username = ?, full_name = ?, position = ?, email = ?, unit_id = ?, role = ?, active = ? WHERE id = ?').run(
        u.username, u.full_name, u.position, u.email, u.unit_id, u.role, u.active, id
      );
      if (req.body.password) {
        db.prepare('UPDATE users SET pass_hash = ?, must_change = 1 WHERE id = ?').run(hashPassword(readPassword(req.body.password)), id);
      }
      // parolă resetată sau cont dezactivat: sesiunile vechi nu mai sunt valabile
      if ((req.body.password && id !== req.user.id) || !u.active) db.prepare('DELETE FROM sessions WHERE user_id = ?').run(id);
    });
    audit(req, 'utilizator modificat', `${u.username} (${u.role}${u.active ? '' : ', dezactivat'}${req.body.password ? ', parolă resetată' : ''})`);
    return { ok: true };
  });
  app.delete('/api/users/:id', { preHandler: requireAdmin }, async (req) => {
    const id = Number(req.params.id);
    if (id === req.user.id) throw fail(400, 'Nu vă puteți șterge propriul cont.');
    const old = db.prepare('SELECT username, role, active FROM users WHERE id = ?').get(id);
    if (!old) throw fail(404, 'Utilizatorul nu a fost găsit.');
    if (old.role === 'admin' && old.active && !activeAdminsExcept(id)) throw fail(400, 'Trebuie să rămână cel puțin un administrator activ.');
    db.prepare('DELETE FROM users WHERE id = ?').run(id);
    audit(req, 'utilizator șters', old.username);
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
    const r = db.prepare('UPDATE categories SET name = ?, color = ?, sort = ? WHERE id = ?').run(c.name, c.color, c.sort, Number(req.params.id));
    if (!r.changes) throw fail(404, 'Categoria nu a fost găsită.');
    return { ok: true };
  });
  app.delete('/api/categories/:id', { preHandler: requireAdmin }, async (req) => {
    const r = db.prepare('DELETE FROM categories WHERE id = ?').run(Number(req.params.id));
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
    const r = db.prepare('UPDATE tags SET name = ? WHERE id = ?').run(name, Number(req.params.id));
    if (!r.changes) throw fail(404, 'Eticheta nu a fost găsită.');
    return { ok: true };
  });
  app.delete('/api/tags/:id', { preHandler: requireAdmin }, async (req) => {
    const r = db.prepare('DELETE FROM tags WHERE id = ?').run(Number(req.params.id));
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
    const id = Number(req.params.id);
    const old = db.prepare('SELECT id, created_by FROM documents WHERE id = ?').get(id);
    if (!old || !canEdit(req.user, old)) {
      // consumăm corpul cererii înainte de a răspunde
      const { saved } = await readDocForm(req).catch(() => ({ saved: [] }));
      removeStored(saved.map((f) => f.stored));
      throw fail(404, 'Documentul nu a fost găsit sau nu îl puteți modifica.');
    }
    const { doc, saved } = await readDocForm(req);
    let removed = [];
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
    const doc = accessibleDoc(req.user, Number(req.params.id));
    if (!doc) throw fail(404, 'Documentul nu a fost găsit.');
    markSeen(req.user.id, doc.id);
    return { ok: true };
  });
  // Semnatarul aflat la rând încarcă versiunea semnată digital; ea devine versiunea pe care o semnează următorul.
  app.post('/api/documents/:id/sign', { preHandler: requireUser }, async (req) => {
    const id = Number(req.params.id);
    const { saved } = await readUploads(req);
    const stored = saved.map((f) => f.stored);
    try {
      const doc = db.prepare('SELECT id, title FROM documents WHERE id = ?').get(id);
      if (!doc || currentSigner(id) !== req.user.id) throw fail(403, 'Nu este rândul dvs. să semnați acest document.');
      if (!saved.length) throw fail(400, 'Încărcați documentul semnat.');
      // Nu putem valida criptografic semnătura, dar putem refuza un fișier identic cu unul deja existent
      // (adică documentul descărcat și încărcat înapoi fără a fi semnat).
      const known = new Set();
      for (const f of db.prepare('SELECT stored FROM document_files WHERE document_id = ?').all(id)) known.add(await fileHash(f.stored).catch(() => ''));
      for (const f of saved) {
        if (known.has(await fileHash(f.stored))) throw fail(400, `„${f.name}” este identic cu un fișier deja existent. Încărcați versiunea semnată de dvs.`);
      }
      tx(() => {
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
    const id = Number(req.params.id);
    const old = db.prepare('SELECT id, created_by FROM documents WHERE id = ?').get(id);
    if (!old || !canEdit(req.user, old)) throw fail(404, 'Documentul nu a fost găsit.');
    const turn = currentSigner(id);
    if (!turn) throw fail(400, 'Toți semnatarii au semnat deja.');
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
    if (!/^[^\s@]+@[^\s@]+$/.test(to)) throw fail(400, 'Introduceți adresa de e-mail pentru test.');
    if (!mail.enabled()) throw fail(400, 'Completați și salvați mai întâi serverul SMTP.');
    try {
      await mail.sendTest(to);
    } catch (e) {
      throw fail(400, 'E-mailul nu a putut fi trimis: ' + e.message);
    }
    return { ok: true };
  });

  app.get('/api/admin/audit', { preHandler: requireAdmin }, async () =>
    db.prepare('SELECT id, at, username, ip, action, details FROM audit_log ORDER BY id DESC LIMIT 2000').all()
  );

  // --- copie de rezervă completă (admin) ---
  app.get('/api/admin/export', { preHandler: requireAdmin }, async (req, reply) => {
    const stamp = new Date().toISOString().slice(0, 16).replace(/[T:]/g, '-');
    audit(req, 'export complet');
    reply.type('application/octet-stream').header('Content-Disposition', `attachment; filename="ansc-backup-${stamp}.anscbackup"`);
    return reply.send(backup.createExportStream());
  });
  // Corpul cererii este chiar arhiva, citită ca flux (poate avea mulți GB).
  app.addContentTypeParser('application/octet-stream', (req, payload, done) => done(null, payload));
  app.post('/api/admin/import', { preHandler: requireAdmin, bodyLimit: 1024 ** 4 }, async (req) => {
    if (!req.body || typeof req.body.pipe !== 'function') throw fail(400, 'Încărcați fișierul de backup.');
    try {
      const r = await backup.importArchive(req.body);
      audit(req, 'import complet', `${r.documents} documente, ${r.users} utilizatori, backup din ${r.created_at}`);
      return r;
    } catch (e) {
      req.log.warn(e);
      audit(req, 'import eșuat', e.message);
      throw fail(400, e.expose ? e.message : 'Arhiva este deteriorată sau nu este un backup e-Management ANSC. Nimic nu a fost modificat.');
    }
  });

  app.delete('/api/documents/:id', { preHandler: requireEditor }, async (req) => {
    const id = Number(req.params.id);
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
      .get(Number(req.params.id), ...acc.params);
    const file = f && path.join(UPLOAD_DIR, f.stored);
    if (!f || !fs.existsSync(file)) throw fail(404, 'Fișierul nu a fost găsit.');
    markSeen(req.user.id, f.document_id); // deschiderea unui fișier înseamnă că documentul a fost văzut
    audit(req, 'fișier descărcat', `#${f.document_id} ${f.name}`);
    // doar PDF și imaginile se deschid în browser; restul se descarcă
    const inline = INLINE_TYPES[path.extname(f.name).toLowerCase()];
    reply
      .type(inline || 'application/octet-stream')
      .header('Content-Disposition', `${inline && !req.query.download ? 'inline' : 'attachment'}; filename*=UTF-8''${encodeURIComponent(f.name)}`);
    return reply.send(fs.createReadStream(file));
  });
});

app.listen({ port: PORT, host: HOST }).then(
  () => console.log(`e-Management ANSC rulează pe http://localhost:${PORT}`),
  (err) => {
    console.error(err);
    process.exit(1);
  }
);
