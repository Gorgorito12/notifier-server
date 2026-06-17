import Fastify from "fastify";
import { loadConfig } from "./config.js";
import { buildManifest, type ManifestState } from "./manifest.js";

/**
 * Entry point: holds the latest manifest in memory, rebuilds it on a timer, and
 * serves GET /manifest with ETag/304 support. Stateless beyond the in-memory
 * manifest — restart-safe (the launchers fall back to direct-GitHub if we're
 * briefly down, and re-sync on the next poll).
 */
const config = loadConfig();

// Current manifest; null until the first poll completes (we answer 503 until then).
let state: ManifestState | null = null;

async function poll(): Promise<void> {
  try {
    const nowIso = new Date().toISOString();
    state = await buildManifest(config, nowIso);
    const count = Object.keys(state.manifest.mods).length;
    console.log(`[poll] manifest rebuilt: ${count} mods, etag=${state.etag}`);
  } catch (err) {
    // Keep the previous manifest on a failed poll — never blank it out.
    console.error("[poll] failed:", (err as Error).message);
  }
}

const app = Fastify({ logger: false });

app.get("/health", async () => ({ ok: true, ready: state !== null }));

app.get("/manifest", async (req, reply) => {
  if (!state) {
    return reply.code(503).header("Retry-After", "30").send({ error: "warming_up" });
  }

  // Short CDN/proxy cache aligned with the poll grain; the ETag is the real
  // freshness signal for launchers.
  reply.header("Cache-Control", "public, max-age=300");
  reply.header("ETag", state.etag);
  reply.header("Access-Control-Allow-Origin", "*");

  const inm = req.headers["if-none-match"];
  if (inm && inm === state.etag) {
    return reply.code(304).send();
  }

  return reply.send(state.manifest);
});

async function main(): Promise<void> {
  console.log(`[startup] catalog source: ${config.catalogRepo}` +
    (config.manualOverrides.length ? ` (+${config.manualOverrides.length} manual override(s))` : ""));
  await poll(); // build once before accepting traffic
  setInterval(poll, config.pollIntervalMs);

  await app.listen({ port: config.port, host: config.host });
  console.log(`[startup] listening on ${config.host}:${config.port}, polling every ${config.pollIntervalMs / 60_000} min`);
}

main().catch((err) => {
  console.error("[startup] fatal:", err);
  process.exit(1);
});
