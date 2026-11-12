<div align="center">

<img src="assets/icon.png" alt="e-Management ANSC" width="128" height="128">

# e-Management ANSC

**Sistem intern de management al documentelor pentru Agenția Națională pentru Soluționarea Contestațiilor. Made by Akulav.**

Fără telemetrie. Fără CDN. Fără Node.js de instalat. Un singur fișier pe sistem, care se instalează și se actualizează singur.

[![Latest release](https://img.shields.io/github/v/release/Akulav/document-manager?style=for-the-badge&label=release&color=e5383b)](https://github.com/Akulav/document-manager/releases/latest)
[![Downloads](https://img.shields.io/github/downloads/Akulav/document-manager/total?style=for-the-badge&color=f4b740)](https://github.com/Akulav/document-manager/releases)
[![Build](https://img.shields.io/github/actions/workflow/status/Akulav/document-manager/build.yml?branch=main&style=for-the-badge&label=build)](https://github.com/Akulav/document-manager/actions/workflows/build.yml)

![Windows](https://img.shields.io/badge/Windows-10%20%7C%2011%20%7C%20Server-0078D6?style=flat-square&logo=windows&logoColor=white)
![Linux](https://img.shields.io/badge/Linux-x64-FCC624?style=flat-square&logo=linux&logoColor=black)
![macOS](https://img.shields.io/badge/macOS-Apple%20Silicon-000000?style=flat-square&logo=apple&logoColor=white)
![Node.js](https://img.shields.io/badge/made%20with-Node.js-5FA04E?style=flat-square&logo=nodedotjs&logoColor=white)
![Vue](https://img.shields.io/badge/UI-Vue%203-4FC08D?style=flat-square&logo=vuedotjs&logoColor=white)

### [⬇ Descărcați ultima versiune](https://github.com/Akulav/document-manager/releases/latest)

</div>

---

## ⬇️ Descărcare

Un singur fișier pe sistem. Același fișier instalează aplicația prima dată și o actualizează ulterior.

| Sistem | Fișier | Note |
| :-- | :-- | :-- |
| 🪟 **Windows 10 / 11 / Server 2016+** (x64) | [`eManagement-setup.exe`](https://github.com/Akulav/document-manager/releases/latest/download/eManagement-setup.exe) | Întreabă unde să instaleze. Nu necesită drepturi de administrator. |
| 🐧 **Linux** (x64) | [`eManagement-linux-x64`](https://github.com/Akulav/document-manager/releases/latest/download/eManagement-linux-x64) | glibc 2.28+. `chmod +x` și rulați-l. |
| 🍎 **macOS** (Apple Silicon) | [`eManagement-macos-arm64`](https://github.com/Akulav/document-manager/releases/latest/download/eManagement-macos-arm64) | macOS 12+ |

Fiecare versiune include și `SHA256SUMS.txt`, pentru verificarea fișierelor descărcate.

## ✨ Funcții

<table>
<tr>
<td width="50%" valign="top">

### 📄 Documente
- Afișate cronologic după **data documentului**, grupate pe luni, cu filtre după categorie, etichetă, an și căutare.
- **Categorii și etichete** definite de administrator (ex. „Resurse umane” → „Concedii”).
- **Vizibilitate** pentru toți angajații sau doar pentru subdiviziunile și persoanele selectate.
- **Notificări**: documentele nevăzute și cele care așteaptă semnătura.

</td>
<td width="50%" valign="top">

### ✍️ Semnare în lanț
- Autorul stabilește ordinea semnatarilor; fiecare descarcă, semnează digital și încarcă versiunea semnată.
- Persoana aflată la rând primește un **e-mail**.
- Un semnatar dezactivat blochează vizibil lanțul; semnăturile rămân în istoric.

</td>
</tr>
<tr>
<td width="50%" valign="top">

### 🏢 Organizație
- **Organigramă** ca schemă (arbore, mărire, căutare) sau listă, editabilă de administrator.
- **Roluri**: Administrator, Editor, Angajat.
- **Jurnal de audit**: cine, ce și când, păstrat 90 de zile.

</td>
<td width="50%" valign="top">

### 🔄 Întreținere
- **Folderul de instalare îl alegeți dvs.**; programul și toate datele stau acolo.
- **Actualizări dintr-un clic** (Setări → Actualizări), verificate cu SHA-256, în același folder.
- **Copie de rezervă** completă într-un singur fișier `.anscbackup`, cu import verificat integral.

</td>
</tr>
</table>

## 🚀 Pornire

### Windows
1. Descărcați **`eManagement-setup.exe`** și rulați-l.
2. Alegeți folderul de instalare (implicit `%LOCALAPPDATA%\Programs\eManagement`; oricare folder în care puteți
   scrie, ex. `D:\eManagement`). Se adaugă scurtături în meniul Start și (opțional) pe Desktop și o intrare în
   *Setări → Aplicații*.
3. Pornirea deschide o fereastră de consolă (serverul) și aplicația în browser. Închiderea ferestrei oprește serverul.

Actualizările se instalează în același folder fără întrebări: din aplicație sau rulând un setup mai nou.
Dezinstalarea, din *Setări → Aplicații*, întreabă dacă datele se păstrează.

### Linux
```bash
chmod +x eManagement-linux-x64
./eManagement-linux-x64
```
Întreabă unde să se instaleze (implicit `~/.local/share/eManagement`), se copiază acolo și adaugă o intrare în meniu.
Pe un server fără interfață: `./eManagement-linux-x64 --install /opt/eManagement`, apoi rulați
`/opt/eManagement/eManagement --no-browser` (de exemplu ca serviciu systemd). Un program mai nou pornit ulterior se
oferă să actualizeze instalarea. Dezinstalare: `eManagement --uninstall`.

### macOS (Apple Silicon)
```bash
chmod +x eManagement-macos-arm64
xattr -d com.apple.quarantine eManagement-macos-arm64
./eManagement-macos-arm64
```
Întreabă unde să se instaleze (implicit `~/Applications/eManagement`) și creează acolo `e-Management ANSC.app`, care
pornește serverul în fundal și deschide aplicația în browser.

### Prima autentificare
Aplicația pornește pe `http://localhost:3080`. La prima pornire se creează contul `admin` cu o parolă aleatorie,
afișată în consolă și salvată în `data/parola-initiala-admin.txt`. Sistemul cere schimbarea ei la prima autentificare,
apoi șterge fișierul.

> 💡 Rulați din surse? Necesită Node.js 22.13+: `npm install`, apoi `npm start`. Din surse aplicația nu se instalează
> și nu se actualizează singură.

## 📁 Unde sunt datele

**În folderul de instalare ales**, în subfolderul `data`. Instalați în `D:\eManagement` și baza de date, fișierele
încărcate și actualizările descărcate ajung toate în `D:\eManagement\data`; nimic în `%APPDATA%`, `/tmp` sau alte
foldere ale sistemului. În afara folderului există doar intrările sistemului pentru o aplicație instalată (scurtăturile,
intrarea din *Aplicații*, intrarea din meniul Linux).

| Cale | Conținut |
| :-- | :-- |
| `data/ansc.db` | baza de date SQLite (utilizatori, organigramă, etichete, documente, semnături, setări SMTP) |
| `data/uploads/` | fișierele încărcate, sub nume aleatorii (numele original este în baza de date) |
| `data/update/` | o actualizare descărcată, până la instalare |
| `data/server.log` | ce afișează serverul, când rulează fără consolă (aplicația macOS, servicii) |
| `.emanagement-install` | marchează folderul de instalare (conține versiunea) |

Variabile de mediu opționale:

| Variabilă | Implicit | Rol |
| :-- | :-- | :-- |
| `PORT` | `3080` | portul serverului |
| `HOST` | `0.0.0.0` | adresa pe care ascultă |
| `DATA_DIR` | `<folderul de instalare>/data` | baza de date și fișierele încărcate |
| `TRUST_PROXY` | `loopback` | proxy-ul HTTPS (nginx, IIS) de încredere: IP/CIDR, `1` = un proxy în față, `true` = oricare |

## 🖥️ Linia de comandă

| Opțiune | Rol |
| :-- | :-- |
| `--version` | Afișează versiunea |
| `--no-browser` | Pornește doar serverul, fără să deschidă browserul |
| `--here` | Linux/macOS: rulează de aici, fără să se ofere să se instaleze |
| `--install <folder>` | Linux/macOS: instalează în folder fără întrebări |
| `--uninstall` | Dezinstalează (Windows: pornește dezinstalatorul) |

## 🔐 Securitate

Făcut în aplicație: parole scrypt (minimum 10 caractere), sesiuni de 12 ore în cookie `HttpOnly` + `SameSite=Strict`,
verificarea originii la cererile care modifică date, antete CSP / HSTS / anti-clickjacking / COOP, blocare temporară
după încercări eșuate de autentificare, jurnal de audit, verificarea accesului la fiecare fișier descărcat,
actualizări verificate cu SHA-256 înainte de instalare.

De asigurat la instalare:

- **HTTPS obligatoriu**, printr-un proxy (aplicația vorbește doar HTTP). Proxy-ul de pe aceeași mașină este recunoscut
  automat; pentru unul de pe altă mașină setați `TRUST_PROXY`.
- **Disc criptat** pentru folderul `data/`: fișierele, baza de date și parola SMTP nu sunt criptate de aplicație.
- **Antivirus** pe server: fișierele încărcate nu sunt scanate.
- **Adresa aplicației** completată în Setări, ca linkurile din e-mailuri să nu depindă de adresa din cerere.
- Fișierele de backup păstrate în siguranță: conțin toate documentele și hash-urile parolelor.

<details>
<summary><b>🛠️ Pentru dezvoltatori: structură, construire și versiuni</b></summary>

### Structură

- `src/main.js`: punctul de intrare (opțiuni, instalare/actualizare, pornirea serverului, browserul).
- `src/server.js`: serverul Fastify și toate rutele `/api`.
- `src/db.js`: schema SQLite (`node:sqlite`), datele inițiale, parolele (scrypt).
- `src/install.js`, `src/update.js`: instalarea în folderul ales și actualizările din versiunile GitHub.
- `src/assets.js`: fișierele interfeței, incluse în program sau citite de pe disc.
- `public/`: interfața (Vue 3 fără pas de build, servit local) și pictogramele.
- `installer/emanagement.iss`: setup-ul Windows (Inno Setup 6).
- `scripts/make-icons.js`: regenerează toate pictogramele (`npm run icons`), fără dependențe.

### Construire

```bash
npm ci
npm test
npm run build
```

`npm run build` (`scripts/build-sea.js`) produce în `dist/` programul acestui sistem: un executabil Node.js
(Single Executable Application) cu serverul, interfața și Vue incluse. Setup-ul Windows necesită
[Inno Setup 6](https://jrsoftware.org/isinfo.php):

```bash
iscc /DAppVersion=1.0.0 installer\emanagement.iss
```

### Publicarea unei versiuni

Automat, prin [`.github/workflows/build.yml`](.github/workflows/build.yml):

1. Schimbați `version` în `package.json`.
2. Faceți push pe `main`.
3. Dacă versiunea nu există încă, CI testează și construiește pe toate trei sistemele, etichetează commit-ul și publică
   exact trei programe, `eManagement-setup.exe`, `eManagement-linux-x64` și `eManagement-macos-arm64`, plus
   `SHA256SUMS.txt`.

### Cum se aplică actualizările

Serverul verifică GitHub la un minut după pornire și apoi la 6 ore. Administratorul vede versiunea nouă în
**Setări → Actualizări**; *Actualizează* descarcă fișierul sistemului în `data/update`, îl verifică cu
`SHA256SUMS.txt`, apoi:

- **Windows:** rulează `eManagement-setup.exe /VERYSILENT /UPDATE` cu folderul curent; setup-ul oprește serverul,
  instalează în același folder și îl repornește.
- **Linux / macOS:** înlocuiește programul pe loc și îl repornește (sub systemd, serviciul îl repornește singur).

</details>

---

<div align="center">

**Made with ❤️ by [Akulav](https://github.com/Akulav)**

<sub>© 2026 Akulav. Toate drepturile rezervate.</sub>

</div>
