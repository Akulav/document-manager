# e-Management ANSC

Sistem intern de management al documentelor pentru Agenția Națională pentru Soluționarea Contestațiilor.

## Pornire

Necesită Node.js 22.13 sau mai nou.

```bash
npm install
npm start
```

Aplicația pornește pe `http://localhost:3080`. La prima pornire se creează contul `admin` cu parola `admin`; sistemul cere schimbarea parolei la prima autentificare.

Variabile de mediu opționale:

| Variabilă | Implicit | Rol |
| --- | --- | --- |
| `PORT` | `3080` | portul serverului |
| `HOST` | `0.0.0.0` | adresa pe care ascultă |
| `DATA_DIR` | `./data` | baza de date (`ansc.db`) și fișierele încărcate (`uploads/`) |
| `TRUST_PROXY` | — | setați `1` dacă aplicația stă în spatele unui proxy HTTPS (nginx, IIS) |

Copia de rezervă înseamnă copierea folderului `data/` cu serverul oprit.

## Funcții

- **Documente**: afișate cronologic după *data documentului* (nu după data adăugării), grupate pe luni, cu filtrare după categorie, etichetă, an și căutare.
- **Categorii și etichete**: definite de administrator (ex. „Resurse umane” → „Concedii”).
- **Vizibilitate**: fiecare document este vizibil tuturor angajaților sau doar subdiviziunilor și persoanelor selectate. O subdiviziune selectată include și subdiviziunile din subordinea ei. Autorul și administratorii văd documentul întotdeauna.
- **Organigramă**: structură ierarhică de subdiviziuni, cu angajații fiecăreia; administratorul o editează direct din pagină.
- **Roluri**: Administrator (gestionează tot), Editor (adaugă documente și le modifică pe cele proprii), Angajat (doar vizualizare).

## Structură

- `src/db.js`: schema SQLite (`node:sqlite`), datele inițiale, parolele (scrypt).
- `src/server.js`: serverul Fastify și toate rutele `/api`.
- `public/`: interfața (Vue 3 fără pas de build, servit local, fără CDN).
