# Etoile-Allocation-Matrix

Allocation Matrix screen for Etoile Flow: for every open US wholesale order and SKU, how much is
still uncovered and which source (warehouse, container in transit, purchase order) can cover it.
Data is read from monday.com.

## Run locally

Requires Node 20+. No dependencies to install.

```sh
cp .env.example .env.local   # then set MONDAY_TOKEN
npm run dev                  # http://localhost:3000
npm test                     # engine tests
```

## Layout

| Path | What it is |
|---|---|
| `index.html`, `src/` | The page (vanilla JS modules, no build step) |
| `src/engine.js` | Calculation rules (pure functions, covered by `tests/`) |
| `src/monday.js` | Reads the monday.com boards and normalizes them |
| `api/monday.js` | Server-side proxy; the monday token never reaches the browser |
| `scripts/dev-server.mjs` | Local server that runs `api/` the same way Vercel does |

## Branches

- `dev`: day-to-day work. Vercel deployments are disabled for it in `vercel.json`.
- `main`: production. Every push deploys on Vercel, so it only receives merges from `dev` when approved.
