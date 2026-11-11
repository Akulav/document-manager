# e-Management ANSC

Sistem intern de management al documentelor pentru Agenția Națională pentru Soluționarea Contestațiilor.

## Pornire

Necesită Node.js 22.13 sau mai nou.

```bash
npm install
npm start
```

Aplicația pornește pe `http://localhost:3080`. La prima pornire se creează contul `admin` cu o parolă aleatorie, afișată în jurnalul serverului și salvată în `data/parola-initiala-admin.txt`. Sistemul cere schimbarea ei la prima autentificare, apoi șterge fișierul.

## Securitate

Făcut în aplicație: parole scrypt (minimum 10 caractere), sesiuni de 12 ore în cookie `HttpOnly` + `SameSite=Strict`, verificarea originii la cererile care modifică date, antete CSP / HSTS / anti-clickjacking / COOP, blocare temporară după încercări eșuate de autentificare și de schimbare a parolei, jurnal de audit (pagina **Jurnal**), verificarea accesului la fiecare fișier descărcat, refuzul încărcărilor neautorizate înainte de a scrie pe disc, limită de o retrimitere a e-mailului de semnare la 5 minute. Datele contului dispar din pagină imediat la ieșire sau la expirarea sesiunii.

De asigurat la instalare:

- **HTTPS obligatoriu**, printr-un proxy (aplicația vorbește doar HTTP). Proxy-ul de pe aceeași mașină este recunoscut automat; pentru unul de pe altă mașină setați `TRUST_PROXY` la adresa lui.
- **Disc criptat** pentru folderul `data/`: fișierele, baza de date și parola SMTP nu sunt criptate de aplicație.
- **Antivirus** pe server: fișierele încărcate nu sunt scanate.
- **Adresa aplicației** completată în Setări, ca linkurile din e-mailuri să nu depindă de adresa din cerere.
- Fișierele de backup păstrate în siguranță: conțin toate documentele și hash-urile parolelor.
- Nu există autentificare în doi pași; conturile de administrator trebuie să aibă parole lungi și unice.

Variabile de mediu opționale:

| Variabilă | Implicit | Rol |
| --- | --- | --- |
| `PORT` | `3080` | portul serverului |
| `HOST` | `0.0.0.0` | adresa pe care ascultă |
| `DATA_DIR` | `./data` | baza de date (`ansc.db`) și fișierele încărcate (`uploads/`) |
| `TRUST_PROXY` | `loopback` | proxy-ul HTTPS (nginx, IIS) în care are încredere: adresa lui IP/CIDR, `1` = un singur proxy în față, `true` = oricare |

Aplicația nu folosește fișier `.env`. Setările SMTP pentru e-mailurile de semnare se completează de administrator în pagina **Setări** și sunt păstrate în baza de date (`data/`), deci rămân neschimbate la actualizarea codului. Ele nu sunt incluse în exportul de backup, fiind specifice serverului.

## Unde sunt datele

- `data/ansc.db`: baza de date SQLite (utilizatori, organigramă, etichete, documente, semnături).
- `data/uploads/`: fișierele încărcate, sub nume aleatorii; numele original este în baza de date. Fișierele nu sunt criptate pe disc.

Copia de rezervă se face din pagina **Backup** (admin): un singur fișier `.anscbackup` comprimat Brotli, cu sume de control SHA-256 pentru fiecare element. Importul verifică arhiva integral și abia apoi înlocuiește datele.

## Funcții

- **Documente**: afișate cronologic după *data documentului* (nu după data adăugării), grupate pe luni, cu filtrare după categorie, etichetă, an și căutare.
- **Categorii și etichete**: definite de administrator (ex. „Resurse umane” → „Concedii”).
- **Vizibilitate**: fiecare document este vizibil tuturor angajaților sau doar subdiviziunilor și persoanelor selectate. O subdiviziune selectată include și subdiviziunile din subordinea ei. Autorul și administratorii văd documentul întotdeauna.
- **Notificări**: pictograma cutiei poștale din dreapta barei de sus arată numărul de documente nevăzute sau care așteaptă semnătura și se animă când există ceva nou; pagina ei listează aceste documente.
- **Jurnal**: păstrează ultimele 90 de zile (cele mai vechi se șterg automat la pornire și zilnic). Administratorul poate șterge manual înregistrările până la o dată anterioară zilei de azi; ștergerea rămâne consemnată.
- **Setări**: serverul de e-mail și copia de rezervă (export / import) sunt pe aceeași pagină.
- **Semnare în lanț**: autorul încarcă documentul și stabilește ordinea semnatarilor. Primul îl descarcă, îl semnează digital (în afara aplicației) și încarcă versiunea semnată în aceeași înregistrare; apoi următorul descarcă acea versiune, și tot așa. Persoana aflată la rând primește un e-mail. Aplicația nu validează criptografic semnătura; refuză doar un fișier identic cu unul deja existent.
- **Organigramă**: vizibilă tuturor angajaților, ca schemă (arbore cu linii de legătură, ramuri care se pot restrânge, mărire și deplasare prin tragere) sau ca listă indentată. Căutarea găsește persoane după nume, funcție sau e-mail și subdiviziuni, și le evidențiază în schemă. Administratorul o editează direct din pagină.
- **Utilizatori**: o persoană care a semnat documente nu poate fi ștearsă (semnăturile rămân în istoric), doar dezactivată; la dezactivarea unui semnatar aflat la rând, aplicația avertizează și marchează lanțul ca blocat.
- **Roluri**: Administrator (gestionează tot), Editor (adaugă documente și le modifică pe cele proprii), Angajat (doar vizualizare).

## Structură

- `src/db.js`: schema SQLite (`node:sqlite`), datele inițiale, parolele (scrypt).
- `src/server.js`: serverul Fastify și toate rutele `/api`.
- `public/`: interfața (Vue 3 fără pas de build, servit local, fără CDN) și pictogramele (`favicon.ico`, `favicon.svg`, `apple-touch-icon.png`).
- `scripts/make-icons.js`: regenerează pictogramele (`node scripts/make-icons.js`), fără dependențe.

La pornire, serverul șterge folderele temporare rămase de la un import întrerupt și semnalează în jurnal fișierele care lipsesc sau nu aparțin niciunui document. La oprire (Ctrl+C / SIGTERM) termină cererile în curs și închide baza de date.
