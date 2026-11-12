<div align="center">

<img src="assets/icon.png" alt="e-Management ANSC" width="128" height="128">

# e-Management ANSC

**Sistem intern de management al documentelor pentru Agenția Națională pentru Soluționarea Contestațiilor. Made by Akulav.**

O aplicație web pentru rețeaua internă. Fără telemetrie. Fără CDN. Fără pas de build.

[![CI](https://img.shields.io/github/actions/workflow/status/Akulav/document-manager/ci.yml?branch=main&style=for-the-badge&label=ci)](https://github.com/Akulav/document-manager/actions/workflows/ci.yml)
![Version](https://img.shields.io/github/package-json/v/Akulav/document-manager?style=for-the-badge&label=versiune&color=e5383b)

![Node.js](https://img.shields.io/badge/Node.js-22.13+-5FA04E?style=flat-square&logo=nodedotjs&logoColor=white)
![Fastify](https://img.shields.io/badge/server-Fastify-000000?style=flat-square&logo=fastify&logoColor=white)
![Vue](https://img.shields.io/badge/UI-Vue%203-4FC08D?style=flat-square&logo=vuedotjs&logoColor=white)
![SQLite](https://img.shields.io/badge/DB-SQLite-003B57?style=flat-square&logo=sqlite&logoColor=white)

</div>

---

## ✨ Funcții

<table>
<tr>
<td width="50%" valign="top">

### 📄 Documente
- Afișate cronologic după **data documentului** (nu după data adăugării), grupate pe luni, cu filtre după categorie,
  etichetă, an și căutare.
- **Categorii și etichete** definite de administrator (ex. „Resurse umane” → „Concedii”).
- **Vizibilitate** pentru toți angajații sau doar pentru subdiviziunile și persoanele selectate (o subdiviziune include
  și subdiviziunile din subordinea ei). Autorul și administratorii văd documentul întotdeauna.
- **Notificări**: pictograma cutiei poștale arată documentele nevăzute și cele care așteaptă semnătura.

</td>
<td width="50%" valign="top">

### ✍️ Semnare în lanț
- Autorul încarcă documentul și stabilește ordinea semnatarilor. Primul îl descarcă, îl semnează digital (în afara
  aplicației) și încarcă versiunea semnată; apoi următorul, și tot așa.
- Persoana aflată la rând primește un **e-mail**.
- Aplicația nu validează criptografic semnătura; refuză doar un fișier identic cu unul deja existent.

</td>
</tr>
<tr>
<td width="50%" valign="top">

### 🏢 Organizație
- **Organigramă** vizibilă tuturor, ca schemă (arbore cu ramuri care se restrâng, mărire, deplasare, căutare) sau ca
  listă; administratorul o editează direct din pagină.
- **Roluri**: Administrator (gestionează tot), Editor (adaugă documente și le modifică pe cele proprii), Angajat
  (doar vizualizare).
- **Utilizatori**: cine a semnat documente nu poate fi șters, doar dezactivat; un semnatar dezactivat aflat la rând
  marchează lanțul ca blocat.

</td>
<td width="50%" valign="top">

### 🛠️ Administrare
- **Jurnal** de audit: ultimele 90 de zile, curățare manuală consemnată.
- **Setări**: serverul de e-mail (SMTP) și copia de rezervă, pe aceeași pagină.
- **Backup** complet într-un singur fișier `.anscbackup` (Brotli, SHA-256 pentru fiecare element); importul verifică
  arhiva integral și abia apoi înlocuiește datele.

</td>
</tr>
</table>

## 🚀 Pornire

Necesită [Node.js](https://nodejs.org) **22.13 sau mai nou**.

```bash
npm install
npm start
```

Aplicația pornește pe `http://localhost:3080`. La prima pornire se creează contul `admin` cu o parolă aleatorie,
afișată în jurnalul serverului și salvată în `data/parola-initiala-admin.txt`. Sistemul cere schimbarea ei la prima
autentificare, apoi șterge fișierul.

La pornire, serverul șterge folderele temporare rămase de la un import întrerupt și semnalează în jurnal fișierele care
lipsesc sau nu aparțin niciunui document. La oprire (Ctrl+C / SIGTERM) termină cererile în curs și închide baza de date.

### Actualizare

```bash
git pull
npm install
```

Apoi reporniți serverul. Datele din `data/` (inclusiv setările SMTP, păstrate în baza de date) rămân neschimbate.

## 📁 Unde sunt datele

Totul este în folderul `data/` al aplicației (sau în `DATA_DIR`):

| Cale | Conținut |
| :-- | :-- |
| `data/ansc.db` | baza de date SQLite (utilizatori, organigramă, etichete, documente, semnături, setări SMTP) |
| `data/uploads/` | fișierele încărcate, sub nume aleatorii (numele original este în baza de date); nu sunt criptate pe disc |

Aplicația nu folosește fișier `.env`. Setările SMTP nu sunt incluse în exportul de backup, fiind specifice serverului.

| Variabilă | Implicit | Rol |
| :-- | :-- | :-- |
| `PORT` | `3080` | portul serverului |
| `HOST` | `0.0.0.0` | adresa pe care ascultă |
| `DATA_DIR` | `./data` | baza de date (`ansc.db`) și fișierele încărcate (`uploads/`) |
| `TRUST_PROXY` | `loopback` | proxy-ul HTTPS (nginx, IIS) de încredere: adresa lui IP/CIDR, `1` = un singur proxy în față, `true` = oricare |

## 🔐 Securitate

Făcut în aplicație: parole scrypt (minimum 10 caractere), sesiuni de 12 ore în cookie `HttpOnly` + `SameSite=Strict`,
verificarea originii la cererile care modifică date, antete CSP / HSTS / anti-clickjacking / COOP, blocare temporară
după încercări eșuate de autentificare și de schimbare a parolei, jurnal de audit, verificarea accesului la fiecare
fișier descărcat, refuzul încărcărilor neautorizate înainte de a scrie pe disc, limită de o retrimitere a e-mailului
de semnare la 5 minute. Datele contului dispar din pagină imediat la ieșire sau la expirarea sesiunii.

De asigurat la instalare:

- **HTTPS obligatoriu**, printr-un proxy (aplicația vorbește doar HTTP). Proxy-ul de pe aceeași mașină este recunoscut
  automat; pentru unul de pe altă mașină setați `TRUST_PROXY` la adresa lui.
- **Disc criptat** pentru folderul `data/`: fișierele, baza de date și parola SMTP nu sunt criptate de aplicație.
- **Antivirus** pe server: fișierele încărcate nu sunt scanate.
- **Adresa aplicației** completată în Setări, ca linkurile din e-mailuri să nu depindă de adresa din cerere.
- Fișierele de backup păstrate în siguranță: conțin toate documentele și hash-urile parolelor.
- Nu există autentificare în doi pași; conturile de administrator trebuie să aibă parole lungi și unice.

<details>
<summary><b>🛠️ Pentru dezvoltatori: structură și verificări</b></summary>

### Structură

- `src/db.js`: schema SQLite (`node:sqlite`), datele inițiale, parolele (scrypt).
- `src/server.js`: serverul Fastify și toate rutele `/api`.
- `src/backup.js`: exportul și importul complet.
- `src/mail.js`: e-mailurile de semnare (nodemailer).
- `public/`: interfața (Vue 3 fără pas de build, servit local, fără CDN) și pictogramele (`favicon.ico`,
  `favicon.svg`, `apple-touch-icon.png`).
- `scripts/make-icons.js`: regenerează pictogramele (`node scripts/make-icons.js`), fără dependențe.

### Verificări automate

[`.github/workflows/ci.yml`](.github/workflows/ci.yml) rulează la fiecare push: instalează dependențele din
`package-lock.json`, verifică sintaxa fiecărui fișier sursă și pornește serverul pe un folder de date gol, verificând
că pagina, scripturile și API-ul răspund.

</details>

---

<div align="center">

**Made with ❤️ by [Akulav](https://github.com/Akulav)**

<sub>© 2026 Akulav. Source-available sub <a href="LICENSE">Akulav Source-Available License</a>.</sub>

</div>
