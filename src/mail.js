'use strict';
// Notificări prin e-mail (SMTP). Setările stau în baza de date (pagina „Setări”), nu în fișiere de
// configurare, ca să supraviețuiască actualizărilor aplicației. Fără server SMTP nu se trimite nimic.
const nodemailer = require('nodemailer');
const { db } = require('./db');

const KEYS = ['smtp_host', 'smtp_port', 'smtp_secure', 'smtp_user', 'smtp_pass', 'smtp_from', 'app_url'];

function getSettings() {
  const s = Object.fromEntries(KEYS.map((k) => [k, '']));
  for (const r of db.prepare('SELECT key, value FROM settings').all()) if (r.key in s) s[r.key] = r.value;
  return s;
}

function saveSettings(values) {
  const set = db.prepare('INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value');
  for (const k of KEYS) if (k in values) set.run(k, String(values[k]));
}

const enabled = () => !!getSettings().smtp_host;

function open(s) {
  const port = Number(s.smtp_port) || 587;
  return nodemailer.createTransport({
    host: s.smtp_host,
    port,
    secure: s.smtp_secure === 'tls' || port === 465,
    auth: s.smtp_user ? { user: s.smtp_user, pass: s.smtp_pass } : undefined,
    connectionTimeout: 10000,
    greetingTimeout: 10000,
  });
}
const sender = (s) => s.smtp_from || s.smtp_user || 'e-management@localhost';

// Trimite fiecărui semnatar solicitarea de semnare. Întoarce cine a fost notificat și cine nu,
// ca interfața să poată avertiza autorul; o eroare de e-mail nu anulează salvarea documentului.
// `origin` este adresa de la care a venit cererea, folosită când „Adresa aplicației” nu este setată.
async function sendSignRequests(doc, users, origin) {
  const s = getSettings();
  const out = { disabled: !s.smtp_host, sent: [], failed: [], noEmail: [] };
  if (out.disabled) return out;
  const transport = open(s);
  const url = (s.app_url || origin).replace(/\/+$/, '');
  const date = doc.doc_date.split('-').reverse().join('.');
  await Promise.all(
    users.map(async (u) => {
      if (!u.email) return out.noEmail.push(u.full_name);
      try {
        await transport.sendMail({
          from: sender(s),
          to: { name: u.full_name, address: u.email },
          subject: `Document de semnat: ${doc.title}`,
          text:
            `Bună ziua, ${u.full_name},\n\n` +
            `Aveți un document care așteaptă semnătura dvs. în sistemul e-Management ANSC:\n\n` +
            `  ${doc.title}${doc.number ? ' (nr. ' + doc.number + ')' : ''}\n` +
            `  Data documentului: ${date}\n\n` +
            `Deschideți ${url}/#notificari pentru a-l vedea și a confirma semnarea.\n\n` +
            `Acest mesaj a fost generat automat.`,
        });
        out.sent.push(u.full_name);
      } catch (e) {
        console.error('E-mail netrimis către', u.email, '-', e.message);
        out.failed.push(u.full_name);
      }
    })
  );
  transport.close();
  return out;
}

// E-mail de probă din pagina „Setări”; aruncă eroarea serverului SMTP, ca adminul să o vadă.
async function sendTest(to) {
  const s = getSettings();
  const transport = open(s);
  try {
    await transport.sendMail({
      from: sender(s),
      to,
      subject: 'e-Management ANSC: e-mail de test',
      text: 'Setările SMTP funcționează. Notificările de semnare vor fi trimise de la această adresă.',
    });
  } finally {
    transport.close();
  }
}

module.exports = { KEYS, getSettings, saveSettings, enabled, sendSignRequests, sendTest };
