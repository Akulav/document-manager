'use strict';
// Verificarea semnăturilor electronice din fișierele PDF (PAdES / CMS), complet pe server, fără rețea.
// Se verifică: integritatea (documentul nu a fost modificat după semnare), semnătura criptografică,
// lanțul certificatului până la o autoritate de certificare de încredere și marca temporală, dacă există.
// Revocarea (OCSP/CRL) nu se verifică: ar cere acces la internet.
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');

// ---------- citire DER/BER minimală ----------
function readNode(buf, pos, end = buf.length) {
  const start = pos;
  if (pos + 2 > end) throw new Error('ASN.1 trunchiat');
  const tag = buf[pos++];
  if ((tag & 0x1f) === 0x1f) while (buf[pos++] & 0x80);
  let len = buf[pos++];
  let indefinite = false;
  if (len === 0x80) indefinite = true;
  else if (len & 0x80) {
    const n = len & 0x7f;
    if (n > 4) throw new Error('ASN.1: lungime prea mare');
    len = 0;
    for (let i = 0; i < n; i++) len = len * 256 + buf[pos++];
  }
  const node = { tag, cons: !!(tag & 0x20), start, body: pos, buf };
  if (indefinite) {
    if (!node.cons) throw new Error('ASN.1: lungime nedefinită invalidă');
    node.children = [];
    let p = pos;
    while (!(buf[p] === 0 && buf[p + 1] === 0)) {
      const c = readNode(buf, p, end);
      node.children.push(c);
      p = c.end;
      if (p >= end) throw new Error('ASN.1 trunchiat');
    }
    node.bodyEnd = p;
    node.end = p + 2;
  } else {
    node.bodyEnd = pos + len;
    node.end = pos + len;
    if (node.end > end) throw new Error('ASN.1 trunchiat');
  }
  return node;
}
function kids(node) {
  if (!node.children) {
    node.children = [];
    for (let p = node.body; p < node.bodyEnd; ) {
      const c = readNode(node.buf, p, node.bodyEnd);
      node.children.push(c);
      p = c.end;
    }
  }
  return node.children;
}
const raw = (n) => n.buf.subarray(n.start, n.end);
const content = (n) => n.buf.subarray(n.body, n.bodyEnd);
// conținutul unui OCTET STRING, inclusiv forma construită (BER)
const octets = (n) => (n.cons ? Buffer.concat(kids(n).map(octets)) : Buffer.from(content(n)));
function oid(n) {
  const b = content(n);
  const out = [];
  let v = 0;
  for (let i = 0; i < b.length; i++) {
    v = v * 128 + (b[i] & 0x7f);
    if (!(b[i] & 0x80)) {
      if (!out.length) out.push(v < 80 ? Math.floor(v / 40) : 2, v < 80 ? v % 40 : v - 80);
      else out.push(v);
      v = 0;
    }
  }
  return out.join('.');
}
function asnTime(n) {
  const s = content(n).toString('latin1');
  const m = n.tag === 0x17 ? /^(\d{2})(\d{2})(\d{2})(\d{2})(\d{2})(\d{2})?/.exec(s) : /^(\d{4})(\d{2})(\d{2})(\d{2})(\d{2})(\d{2})?/.exec(s);
  if (!m) return null;
  let y = Number(m[1]);
  if (n.tag === 0x17) y += y < 50 ? 2000 : 1900;
  return new Date(Date.UTC(y, m[2] - 1, m[3], m[4], m[5], m[6] || 0));
}
const intHex = (n) => content(n).toString('hex').replace(/^(00)+(?=.)/, '').toUpperCase();

// ---------- algoritmi ----------
const DIGESTS = {
  '1.3.14.3.2.26': 'sha1',
  '2.16.840.1.101.3.4.2.4': 'sha224',
  '2.16.840.1.101.3.4.2.1': 'sha256',
  '2.16.840.1.101.3.4.2.2': 'sha384',
  '2.16.840.1.101.3.4.2.3': 'sha512',
};
// semnătură cu algoritmul de rezumat inclus (altfel se folosește cel din digestAlgorithm)
const SIG_DIGEST = {
  '1.2.840.113549.1.1.5': 'sha1',
  '1.2.840.113549.1.1.14': 'sha224',
  '1.2.840.113549.1.1.11': 'sha256',
  '1.2.840.113549.1.1.12': 'sha384',
  '1.2.840.113549.1.1.13': 'sha512',
  '1.2.840.10045.4.1': 'sha1',
  '1.2.840.10045.4.3.1': 'sha224',
  '1.2.840.10045.4.3.2': 'sha256',
  '1.2.840.10045.4.3.3': 'sha384',
  '1.2.840.10045.4.3.4': 'sha512',
};
const OID = {
  signedData: '1.2.840.113549.1.7.2',
  contentType: '1.2.840.113549.1.9.3',
  messageDigest: '1.2.840.113549.1.9.4',
  signingTime: '1.2.840.113549.1.9.5',
  timeStampToken: '1.2.840.113549.1.9.16.2.14',
  rsaPss: '1.2.840.113549.1.1.10',
};

// ---------- autorități de încredere ----------
// Lista livrată cu aplicația (src/ancore-md.pem) plus orice certificat pus de administrator în data/ancore/.
let trustCache = null;
function loadTrust(dataDir) {
  if (trustCache) return trustCache;
  const certs = [];
  const add = (text, bin) => {
    const pems = text ? text.match(/-----BEGIN CERTIFICATE-----[\s\S]+?-----END CERTIFICATE-----/g) : null;
    for (const p of pems || (bin ? [bin] : [])) {
      try {
        certs.push(new crypto.X509Certificate(p));
      } catch {}
    }
  };
  add(fs.readFileSync(path.join(__dirname, 'ancore-md.pem'), 'utf8'));
  const extra = path.join(dataDir, 'ancore');
  try {
    for (const n of fs.readdirSync(extra)) {
      if (!/\.(pem|cer|crt|der)$/i.test(n)) continue;
      const b = fs.readFileSync(path.join(extra, n));
      add(b.includes('-----BEGIN') ? b.toString('latin1') : null, b);
    }
  } catch {}
  const seen = new Set();
  const uniq = certs.filter((c) => !seen.has(c.fingerprint256) && seen.add(c.fingerprint256));
  trustCache = {
    roots: uniq.filter((c) => c.ca && c.checkIssued(c)),
    intermediates: uniq.filter((c) => c.ca && !c.checkIssued(c)),
  };
  return trustCache;
}

const field = (dn, key) => {
  const m = new RegExp('^' + key + '=(.+)$', 'mi').exec(dn || '');
  return m ? m[1].replace(/\\(.)/g, '$1').trim() : '';
};
const certName = (c) => field(c.subject, 'CN') || field(c.subject, 'O') || c.subject.split('\n')[0];
const validAt = (c, t) => new Date(c.validFrom) <= t && t <= new Date(c.validTo);

// Lanțul de la certificatul semnatarului până la o rădăcină de încredere.
function buildChain(leaf, embedded, trust) {
  const pool = [...embedded, ...trust.intermediates];
  const chain = [leaf];
  let cur = leaf;
  for (let i = 0; i < 10; i++) {
    const root = trust.roots.find((r) => cur.checkIssued(r) && cur.verify(r.publicKey));
    if (root) {
      if (root.fingerprint256 !== cur.fingerprint256) chain.push(root);
      return { chain, trusted: true };
    }
    const parent = pool.find((p) => p.fingerprint256 !== cur.fingerprint256 && cur.checkIssued(p) && cur.verify(p.publicKey));
    if (!parent || chain.some((c) => c.fingerprint256 === parent.fingerprint256)) break;
    chain.push(parent);
    cur = parent;
  }
  return { chain, trusted: false };
}

// ---------- CMS SignedData ----------
function parseSignedData(der) {
  const ci = readNode(der, 0);
  const [type, wrapped] = kids(ci);
  if (!type || oid(type) !== OID.signedData || !wrapped) throw new Error('nu este o semnătură CMS');
  const sd = kids(wrapped)[0];
  const parts = kids(sd);
  let i = 1; // după versiune
  i++; // digestAlgorithms
  const encap = parts[i++];
  const certs = [];
  for (; i < parts.length && (parts[i].tag & 0xc0) === 0x80; i++) {
    if (parts[i].tag === 0xa0) {
      for (const c of kids(parts[i])) {
        if (c.tag !== 0x30) continue; // doar certificatele X.509 obișnuite
        try {
          certs.push(new crypto.X509Certificate(Buffer.from(raw(c))));
        } catch {}
      }
    }
  }
  const signerInfos = kids(parts[i]).map(parseSignerInfo);
  const ek = kids(encap);
  const eContent = ek[1] ? octets(kids(ek[1])[0]) : null;
  return { certs, signerInfos, eContent };
}
function parseSignerInfo(si) {
  const p = kids(si);
  let i = 1;
  const sid = p[i++];
  const digestOid = oid(kids(p[i++])[0]);
  let signedAttrs = null;
  if (p[i].tag === 0xa0) signedAttrs = p[i++];
  const sigAlg = p[i++];
  const signature = octets(p[i++]);
  const unsignedAttrs = p[i] && p[i].tag === 0xa1 ? p[i] : null;
  let serial = null;
  if (sid.tag === 0x30) serial = intHex(kids(sid)[1]);
  return { serial, digestOid, signedAttrs, sigAlg, signature, unsignedAttrs };
}
function attrs(node) {
  const out = new Map();
  if (node) for (const a of kids(node)) {
    const [t, vals] = kids(a);
    out.set(oid(t), kids(vals));
  }
  return out;
}

// Verifică semnătura unui SignerInfo cu cheia publică a certificatului dat.
function checkSignature(si, cert) {
  const algOid = oid(kids(si.sigAlg)[0]);
  const digest = SIG_DIGEST[algOid] || DIGESTS[si.digestOid];
  if (!digest) return false;
  // atributele semnate se semnează codificate ca SET (eticheta 0x31), nu ca [0]
  const data = Buffer.from(raw(si.signedAttrs));
  data[0] = 0x31;
  const key = { key: cert.publicKey };
  if (algOid === OID.rsaPss) {
    let hash = 'sha1';
    let salt = 20;
    const params = kids(si.sigAlg)[1];
    if (params && params.tag === 0x30) for (const f of kids(params)) {
      if (f.tag === 0xa0) hash = DIGESTS[oid(kids(kids(f)[0])[0])] || hash;
      if (f.tag === 0xa2) salt = parseInt(content(kids(f)[0]).toString('hex'), 16);
    }
    Object.assign(key, { padding: crypto.constants.RSA_PKCS1_PSS_PADDING, saltLength: salt });
    try {
      return crypto.verify(hash, data, key, si.signature);
    } catch {
      return false;
    }
  }
  try {
    return crypto.verify(digest, data, key, si.signature);
  } catch {
    return false;
  }
}

// Verifică un CMS detașat peste `signed` (octeții acoperiți). Întoarce detaliile primului semnatar.
function verifyCms(der, signed) {
  const sd = parseSignedData(der);
  const si = sd.signerInfos[0];
  if (!si) throw new Error('semnătura nu are semnatar');
  if (!si.signedAttrs) throw new Error('semnătura nu are atribute semnate');
  const a = attrs(si.signedAttrs);
  const digestName = DIGESTS[si.digestOid];
  if (!digestName) throw new Error('algoritm de rezumat necunoscut');
  const md = a.get(OID.messageDigest);
  const intact = !!md && octets(md[0]).equals(crypto.createHash(digestName).update(signed).digest());
  const candidates = sd.certs.filter((c) => !si.serial || c.serialNumber.toUpperCase().replace(/^(00)+(?=.)/, '') === si.serial);
  const cert = candidates.find((c) => checkSignature(si, c)) || null;
  const st = a.get(OID.signingTime);
  return { sd, si, intact, cert, signatureOk: !!cert, signingTime: st ? asnTime(st[0]) : null };
}

// Marca temporală (PAdES-T): un al doilea CMS, semnat de serverul de timp, peste valoarea semnăturii.
function checkTimestamp(si, trust) {
  const tst = attrs(si.unsignedAttrs).get(OID.timeStampToken);
  if (!tst) return null;
  try {
    const der = Buffer.from(raw(tst[0]));
    const sd = parseSignedData(der);
    const info = readNode(sd.eContent, 0);
    const f = kids(info);
    const imprint = kids(f[2]);
    const alg = DIGESTS[oid(kids(imprint[0])[0])];
    const genTime = asnTime(f[4]);
    const imprintOk = !!alg && octets(imprint[1]).equals(crypto.createHash(alg).update(si.signature).digest());
    const v = verifyCms(der, sd.eContent);
    const chain = v.cert ? buildChain(v.cert, v.sd.certs, trust) : { trusted: false };
    return { time: genTime, ok: imprintOk && v.intact && v.signatureOk, trusted: chain.trusted, authority: v.cert ? certName(v.cert) : '' };
  } catch {
    return { time: null, ok: false, trusted: false, authority: '' };
  }
}

// ---------- PDF ----------
// Fiecare semnătură are /ByteRange [a b c d]: octeții semnați sunt [a, a+b) și [c, c+d);
// între ele se află /Contents <...>, adică semnătura CMS în hexazecimal.
function findSignatures(pdf) {
  const text = pdf.toString('latin1');
  const out = [];
  const seen = new Set();
  const re = /\/ByteRange\s*\[\s*(\d+)\s+(\d+)\s+(\d+)\s+(\d+)\s*\]/g;
  for (let m; (m = re.exec(text)); ) {
    const [a, b, c, d] = m.slice(1).map(Number);
    const key = m.slice(1).join(' ');
    if (seen.has(key)) continue;
    seen.add(key);
    if (a !== 0 || b <= 0 || c <= b || c + d > pdf.length) {
      out.push({ range: [a, b, c, d], broken: true });
      continue;
    }
    const hex = text.slice(b, c).replace(/[\s<>]/g, '');
    let der = null;
    try {
      const bytes = Buffer.from(hex, 'hex');
      der = bytes.subarray(0, readNode(bytes, 0).end); // fără completarea cu zerouri
    } catch {}
    out.push({ range: [a, b, c, d], der, signed: Buffer.concat([pdf.subarray(a, a + b), pdf.subarray(c, c + d)]), broken: !der });
  }
  return out.sort((x, y) => x.range[2] + x.range[3] - (y.range[2] + y.range[3]));
}

// Rezultatul pentru fiecare semnătură: status 'valid' | 'warning' | 'invalid' și explicații pentru utilizator.
function verifyPdf(buf, dataDir) {
  const trust = loadTrust(dataDir);
  const sigs = findSignatures(buf);
  return sigs.map((s, i) => {
    const r = { index: i + 1, status: 'invalid', problems: [], notes: [], coversWholeFile: !s.broken && s.range[2] + s.range[3] === buf.length };
    if (s.broken) {
      r.problems.push('Semnătura este deteriorată și nu poate fi citită.');
      return r;
    }
    let v;
    try {
      v = verifyCms(s.der, s.signed);
    } catch (e) {
      r.problems.push('Semnătura nu poate fi citită (' + e.message + ').');
      return r;
    }
    const ts = checkTimestamp(v.si, trust);
    const at = ts && ts.ok && ts.time ? ts.time : v.signingTime || new Date();
    Object.assign(r, { signingTime: v.signingTime, timestamp: ts });
    if (!v.intact) r.problems.push('Documentul a fost modificat după semnare.');
    if (!v.signatureOk) r.problems.push('Semnătura criptografică nu corespunde certificatului.');
    const cert = v.cert || v.sd.certs[0];
    if (cert) {
      const { chain, trusted } = buildChain(cert, v.sd.certs, trust);
      Object.assign(r, {
        signer: certName(cert),
        idnp: field(cert.subject, 'serialNumber'),
        organization: field(cert.subject, 'O'),
        issuer: field(cert.issuer, 'CN'),
        validFrom: cert.validFrom,
        validTo: cert.validTo,
        chain: chain.map(certName),
        trusted,
      });
      if (!trusted) r.problems.push('Certificatul nu provine de la o autoritate de certificare cunoscută.');
      if (!chain.every((c) => validAt(c, at))) r.problems.push('Certificatul nu era valabil la momentul semnării.');
      else if (!validAt(cert, new Date())) r.notes.push('Certificatul a expirat între timp; semnătura rămâne valabilă pentru momentul semnării.');
    } else r.problems.push('Semnătura nu conține certificatul semnatarului.');
    if (ts && !ts.ok) r.problems.push('Marca temporală nu este validă.');
    if (!r.coversWholeFile) r.notes.push(i < sigs.length - 1 ? 'După această semnătură au fost adăugate altele (versiunile următoare).' : 'Documentul a fost completat după ultima semnătură.');
    r.notes.push('Revocarea certificatului nu a fost verificată (necesită acces la internet).');
    const cryptoOk = v.intact && v.signatureOk;
    r.status = !cryptoOk ? 'invalid' : r.problems.length ? 'warning' : 'valid';
    return r;
  });
}

module.exports = { verifyPdf, loadTrust };
