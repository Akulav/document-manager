# CLAUDE.md

Notes for working on **e-Management ANSC** (repo `document-manager`), an internal document-management web app for
the Agenția Națională pentru Soluționarea Contestațiilor, made by Akulav. Runs on the internal network: no telemetry,
no CDN, no build step. **The UI, README, audit messages and code comments are in Romanian; keep them that way.**

## Run

```bash
npm install
npm start          # http://localhost:3080 (HOST defaults to 0.0.0.0)
```

- First start creates `admin` with a random password, printed in the server log and saved to
  `data/parola-initiala-admin.txt`; it must be changed at first sign-in.
- All state lives in `data/` (or `DATA_DIR`): SQLite database and uploaded files. No `.env`.
- For testing, use a throwaway `DATA_DIR` and another `PORT`. **Never touch the real `data/` folder.**
- There is no automated test suite; CI (`.github/workflows/ci.yml`) runs `npm ci` and syntax checks.
  Verify changes by running the server against a scratch `DATA_DIR` and using the UI.

## Layout

- `src/server.js` — Fastify app: auth (sessions in SQLite, cookie `sid`, hashed tokens), roles, all `/api/*` routes,
  uploads, signing chain, backup import/export, security headers / CSP
- `src/db.js` — schema and migrations; `src/backup.js` — `.anscbackup` export/import; `src/mail.js` — SMTP
- `public/` — Vue 3 frontend served as static files (`app.js`, `style.css`, `index.html`); Vue is served from
  `node_modules` at `/vendor/vue.js`

## Security rules (keep them)

- Every `/api/*` route has a `preHandler` (`requireUser` / `requireEditor` / `requireAdmin`).
- Document and file reads go through `accessClause(req.user)` so visibility rules apply everywhere.
- Only PDF/PNG/JPEG are served inline (`INLINE_TYPES`); everything else downloads as `application/octet-stream`.
  Never add SVG or HTML to that list.
- Login compares against `DUMMY_HASH` when the user doesn't exist (timing-safe). Keep `nosniff`, `X-Frame-Options`
  and the CSP hook.
- Changes to users, documents and settings are written to the audit log (`audit(req, ...)`).

## graphify

This project has a knowledge graph at graphify-out/ with god nodes, community structure, and cross-file relationships. It is local only (`graphify-out/` is git-ignored).

Rules:
- When graphify-out/graph.json exists, run `graphify query "<question>"` before your first grep, search or source-file read for a codebase question, and put this rule in every subagent prompt that explores code. Read raw files only for lines the graph or an earlier read already located. Use `graphify path "<A>" "<B>"` for relationships and `graphify explain "<concept>"` for focused concepts.
- Read graphify-out/GRAPH_REPORT.md only for broad architecture review or when query/path/explain do not surface enough context.
- After modifying code, run `graphify update .` to keep the graph current (AST-only, no API cost). If graphify-out/ is missing, rebuild it the same way.
