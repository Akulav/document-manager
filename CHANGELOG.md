# Jurnalul modificărilor

Modificările importante din e-Management ANSC. Versiunile urmează [Semantic Versioning](https://semver.org/).

## [1.0.2] - 2026-11-21

### Securitate
- Semnăturile PDF: certificatele intermediare incluse în semnătură contează doar dacă sunt certificate de
  autoritate (CA); un certificat obișnuit nu mai poate „emite” un certificat pe numele altcuiva.
- Editorul ONLYOFFICE nu mai poate suprascrie un fișier după ce documentul a primit o semnătură.
- Jurnalul de audit nu mai poate fi modificat (doar curățat, iar curățarea este consemnată).
- Adăugarea, modificarea și ștergerea categoriilor și etichetelor apar acum în jurnalul de audit.

### Corectat
- Un document nou nu își mai pierde fișierele dacă trimiterea e-mailului către semnatar eșuează.

### Modificat
- Fontul Geist este servit de aplicație (latin + latin-ext), fără nicio cerere către alte servere.
- Curățenie: stiluri și cod nefolosite eliminate.

### Eliminat
- Actualizarea automată a bazelor de date create înainte de 1.0.1. O astfel de bază se pornește o dată cu
  versiunea 1.0.1, apoi cu aceasta (aplicația explică asta la pornire).

## [1.0.1] - 2026-11-20

### Modificat
- Documentație: un nou `docs/ARHITECTURA.md` (structura aplicației, regulile de acces, semnarea și copiile de
  rezervă), cu legătură din README.