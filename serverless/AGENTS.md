# AGENTS.md — Aral Telegram Serverless

- Runtime: Telegram Serverless (V8). **JavaScript only**. No npm packages in handlers.
- Imports: bare names — `sdk`, `sdk/db`, `schema`, `lib/...`
- Handlers: one file per update type under `handlers/` with `export default async function`.
- Database: declare tables in `schema.js`, apply with `npx tgcloud migrate`.
- Deploy: `npx tgcloud push` then `npx tgcloud migrate` when schema changes.
- Bot API token is NOT in code — platform injects `api` from `sdk`.
- CLI login uses a **separate** token from BotFather → Serverless → CLI Access (`app…:…`).
