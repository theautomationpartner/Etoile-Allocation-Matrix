# Etoile-Allocation-Matrix

Allocation Matrix screen for Etoile Flow: for every open US wholesale order and SKU, how much is
still uncovered and which source (warehouse, container in transit, purchase order) can cover it.
Data is read from monday.com.

## Run locally

Requires Node 20.19+.

```sh
npm install
cp .env.example .env.local   # then set MONDAY_TOKEN
npm run dev                  # http://localhost:5173
npm test                     # engine tests
npm run ui-check             # visual/usability regression checks (needs npm run dev running)
```

## Layout

| Path | What it is |
|---|---|
| `src/` | React app (Vite). `features/allocation-matrix/` holds the screen |
| `src/lib/engine.js` | Calculation rules (pure functions, covered by `tests/`) |
| `src/lib/monday.js` | Reads the monday.com boards; transport-agnostic (proxy locally, `monday.api` in Vibe) |
| `api/monday.js` | Server-side read proxy; the monday token never reaches the browser |
| `api/monday-write.js` | Server-side writes, limited to the operations in `src/lib/mondayWrites.js` |
| `vite.config.js` | Runs `api/` during `npm run dev` the same way Vercel does |
| `PROMPT-MONDAY-VIBE.txt` | Detailed spec that becomes the monday Vibe prompt, updated step by step |

## Branches

- `dev`: day-to-day work. Vercel deployments are disabled for it in `vercel.json`.
- `main`: production. Every push deploys on Vercel, so it only receives merges from `dev` when approved.
