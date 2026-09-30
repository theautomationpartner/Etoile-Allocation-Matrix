// Local development server: serves the static app and runs /api/* handlers the same way
// Vercel does (web-standard Request → Response). Reads secrets from .env.local.
// Usage: npm run dev   (PORT=3000 by default)

import { createServer } from "node:http";
import { readFile, stat } from "node:fs/promises";
import { existsSync, readFileSync } from "node:fs";
import { extname, join, normalize, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const ROOT = resolve(fileURLToPath(new URL("..", import.meta.url)));
const PORT = Number(process.env.PORT) || 3000;

function loadEnvFile(file) {
  const path = join(ROOT, file);
  if (!existsSync(path)) return;
  for (const line of readFileSync(path, "utf8").split(/\r?\n/)) {
    const m = line.match(/^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)\s*$/);
    if (!m || line.trim().startsWith("#")) continue;
    const value = m[2].replace(/^(['"])(.*)\1$/, "$2");
    if (!(m[1] in process.env)) process.env[m[1]] = value;
  }
}
loadEnvFile(".env.local");
loadEnvFile(".env");

const TYPES = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".mjs": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".ico": "image/x-icon",
};
// Only these folders are served; everything else (context docs, .env, scripts) stays private.
const PUBLIC = ["/index.html", "/src/"];

async function handleApi(req, res, pathname) {
  const file = join(ROOT, "api", pathname.replace(/^\/api\//, "") + ".js");
  if (!existsSync(file)) return send(res, 404, "Not found");
  const mod = await import(pathToFileURL(file).href + `?t=${Date.now()}`);
  const handler = mod[req.method];
  if (typeof handler !== "function") return send(res, 405, "Method not allowed");

  const chunks = [];
  for await (const c of req) chunks.push(c);
  const request = new Request(`http://localhost:${PORT}${req.url}`, {
    method: req.method,
    headers: req.headers,
    body: ["GET", "HEAD"].includes(req.method) ? undefined : Buffer.concat(chunks),
  });
  const response = await handler(request);
  res.writeHead(response.status, Object.fromEntries(response.headers));
  res.end(Buffer.from(await response.arrayBuffer()));
}

function send(res, status, text) {
  res.writeHead(status, { "Content-Type": "text/plain; charset=utf-8" });
  res.end(text);
}

createServer(async (req, res) => {
  try {
    const { pathname } = new URL(req.url, "http://localhost");
    if (pathname.startsWith("/api/")) return await handleApi(req, res, pathname);

    const path = pathname === "/" ? "/index.html" : normalize(decodeURIComponent(pathname)).replace(/\\/g, "/");
    if (!PUBLIC.some((p) => path === p || (p.endsWith("/") && path.startsWith(p)))) return send(res, 404, "Not found");
    const file = join(ROOT, path);
    if (!file.startsWith(ROOT) || !(await stat(file).catch(() => null))?.isFile()) return send(res, 404, "Not found");
    res.writeHead(200, { "Content-Type": TYPES[extname(file)] || "application/octet-stream", "Cache-Control": "no-store" });
    res.end(await readFile(file));
  } catch (error) {
    console.error(error);
    send(res, 500, "Server error");
  }
}).listen(PORT, () => {
  console.log(`Etoile Allocation Matrix → http://localhost:${PORT}`);
  if (!process.env.MONDAY_TOKEN) console.warn("⚠ MONDAY_TOKEN is not set. Create .env.local from .env.example.");
});
