'use strict';
// Accès des agents (Claude, Codex, OpenClaw…) à l'espace Projets.
// Une clé par agent, conservée dans data/agent-access.json (hors dépôt).
// Écoute sur ce PC et, si Tailscale est présent, sur son adresse Tailscale : jamais sur Internet.
const http = require('node:http');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');

const PORT = 3890;
const DEFAULT_CLIENTS = { claude: 'Claude', codex: 'Codex', openclaw: 'OpenClaw' };

function loadClients(file) {
  let saved = {};
  try { saved = JSON.parse(fs.readFileSync(file, 'utf8')).clients || {}; } catch (error) { if (error.code !== 'ENOENT') throw error; }
  let changed = false;
  for (const [id, label] of Object.entries(DEFAULT_CLIENTS)) if (!saved[id]?.token) { saved[id] = { label, token: crypto.randomBytes(32).toString('base64url') }; changed = true; }
  if (changed) {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    const temp = file + '.' + process.pid + '.tmp';
    fs.writeFileSync(temp, JSON.stringify({ note: 'Clés d’accès des agents à Projets. Supprimer une entrée puis relancer Cockpit en génère une nouvelle.', clients: saved }, null, 2));
    fs.renameSync(temp, file);
  }
  return saved;
}

// Adresse Tailscale (plage CGNAT 100.64.0.0/10) de ce PC, s'il y en a une.
function tailscaleAddress(interfaces = os.networkInterfaces()) {
  for (const list of Object.values(interfaces)) for (const entry of list || []) {
    if (entry.family !== 'IPv4' && entry.family !== 4) continue;
    const [a, b] = entry.address.split('.').map(Number);
    if (a === 100 && b >= 64 && b <= 127) return entry.address;
  }
  return null;
}

function createAgentAccess({ projects, file = path.join(__dirname, 'data', 'agent-access.json'), clients = loadClients(file) }) {
  const tokens = Object.entries(clients).map(([id, c]) => ({ id, label: c.label || id, hash: crypto.createHash('sha256').update(String(c.token)).digest() }));
  const who = header => {
    const token = /^Bearer (.+)$/.exec(header || '')?.[1];
    if (!token || token.length > 512) return null;
    const hash = crypto.createHash('sha256').update(token).digest();
    return tokens.find(t => crypto.timingSafeEqual(t.hash, hash)) || null;
  };
  const json = (res, status, value) => { res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff' }); res.end(JSON.stringify(value)); };
  return http.createServer(async (req, res) => {
    try {
      // Réservé aux programmes : un navigateur (page web) n'a rien à faire ici.
      if (req.headers.origin || req.headers['sec-fetch-site']) return json(res, 403, { error: 'Accès réservé aux agents, pas aux pages web.' });
      const url = new URL(req.url, 'http://localhost');
      if (url.pathname === '/agent/v1' || url.pathname === '/agent/v1/') return json(res, 200, { app: 'cockpit-projets', auth: 'Authorization: Bearer <clé>' });
      if (!url.pathname.startsWith('/agent/v1/')) return json(res, 404, { error: 'Introuvable.' });
      const client = who(req.headers.authorization);
      if (!client) return json(res, 401, { error: 'Clé d’accès manquante ou invalide.' });
      return projects.agentHandle(req, res, url, json, client.label);
    } catch { if (!res.headersSent) json(res, 500, { error: 'Une erreur est survenue.' }); else res.end(); }
  });
}

module.exports = { createAgentAccess, loadClients, tailscaleAddress, PORT, DEFAULT_CLIENTS };
