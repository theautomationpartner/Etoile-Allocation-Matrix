import { defineConfig, loadEnv } from "vite";
import react from "@vitejs/plugin-react";

// Runs the Vercel functions in /api during `npm run dev`, same Request → Response contract,
// so the monday token stays on the server locally too (read from .env.local).
function vercelApi() {
  return {
    name: "vercel-api",
    configureServer(server) {
      server.middlewares.use(async (req, res, next) => {
        if (!req.url?.startsWith("/api/")) return next();
        try {
          const name = req.url.split("?")[0].replace(/^\/api\//, "");
          const mod = await server.ssrLoadModule(`/api/${name}.js`);
          const handler = mod[req.method];
          if (typeof handler !== "function") {
            res.statusCode = 405;
            return res.end("Method not allowed");
          }
          const chunks = [];
          for await (const c of req) chunks.push(c);
          const request = new Request(`http://localhost${req.url}`, {
            method: req.method,
            headers: req.headers,
            body: ["GET", "HEAD"].includes(req.method) ? undefined : Buffer.concat(chunks),
          });
          const response = await handler(request);
          res.writeHead(response.status, Object.fromEntries(response.headers));
          res.end(Buffer.from(await response.arrayBuffer()));
        } catch (error) {
          server.config.logger.error(String(error?.stack || error));
          res.statusCode = 500;
          res.end("API error");
        }
      });
    },
  };
}

export default defineConfig(({ mode }) => {
  // Expose server-only variables (MONDAY_TOKEN) to the /api handlers, never to the client bundle.
  // Variables already set in the shell win over .env files.
  process.env = { ...loadEnv(mode, process.cwd(), ""), ...process.env };
  return {
    plugins: [react(), vercelApi()],
    // Tunnels to test the app inside monday during development (cloudflared / ngrok / monday apps tunnel).
    server: { port: 5173, open: false, allowedHosts: [".trycloudflare.com", ".ngrok-free.app", ".ngrok.app", ".apps-tunnel.monday.app"] },
  };
});
