'use strict';
// Faux service de déploiement : reproduit le contrat v1 (health, projets, déploiements, sous-domaine) en mémoire.
// Aucun réseau réel. `calls` garde chaque requête reçue (méthode, route, jeton vu, corps) pour les assertions.
const http = require('node:http');

const TOKEN = 'tok-test-secret-0123456789abcdef';
async function fakeDeployer({ token = TOKEN } = {}) {
  const state = { projects: new Map(), deployments: new Map(), subdomains: new Map(), calls: [], down: false, delayMs: 0, mode: {}, seq: 0 };
  const server = http.createServer(async (req, res) => {
    let raw = ''; for await (const chunk of req) raw += chunk;
    const body = raw ? JSON.parse(raw) : undefined, url = new URL(req.url, 'http://x'), seen = req.headers.authorization || '';
    state.calls.push({ method: req.method, route: url.pathname + url.search, auth: seen, body });
    if (state.down) return req.socket.destroy();
    if (state.delayMs) await new Promise(r => setTimeout(r, state.delayMs));
    const send = (status, value) => { res.writeHead(status, { 'Content-Type': 'application/json' }); res.end(value === undefined ? '' : JSON.stringify(value)); };
    if (url.pathname === '/health') return send(200, { status: 'ok', version: '1.0.0', uptime_s: 5, projects: state.projects.size, running: 0 });
    if (seen !== 'Bearer ' + token) return send(401, { error: 'unauthorized', message: 'Jeton absent ou invalide.' });
    if (state.mode.huge) { res.writeHead(200, { 'Content-Type': 'application/json' }); return res.end('{"x":"' + 'a'.repeat(2 * 1024 * 1024) + '"}'); }
    if (state.mode.html) { res.writeHead(200, { 'Content-Type': 'text/html' }); return res.end('<html>oups</html>'); }
    if (state.mode.fail500) return send(500, { error: 'internal', message: 'Erreur interne du service (jeton ' + token + ').' });
    const parts = url.pathname.split('/').filter(Boolean);
    if (parts[0] !== 'projects') return send(404, { error: 'not_found', message: 'Route inconnue.' });
    const id = parts[1], project = id && state.projects.get(id);
    const latest = () => { const list = state.deployments.get(id) || []; return list[0] || null; };
    if (req.method === 'PUT' && parts.length === 2) {
      for (const key of ['repo', 'branch', 'type', 'deploy', 'auto']) if (body?.[key] === undefined) return send(422, { error: 'invalid', message: 'Champ obligatoire : ' + key + '.' });
      if (state.mode.reject422) return send(422, { error: 'invalid', message: 'Le dossier à publier n’existe pas dans le dépôt.' });
      const created = !project; const full = { id, ...body, created_at: 'x', updated_at: 'x' };
      state.projects.set(id, full);
      if (body.subdomain) { state.subdomains.set(id, { name: body.subdomain.name, status: state.subdomains.get(id)?.status || 'awaiting_validation', detail: '' }); full.subdomain_status = state.subdomains.get(id).status; }
      return send(created ? 201 : 200, full);
    }
    if (!project) return send(404, { error: 'not_found', message: 'Projet inconnu.' });
    if (req.method === 'GET' && parts.length === 2) return send(200, { ...project, deploying: false, latest_deployment: latest(), ...(state.subdomains.has(id) ? { subdomain_status: state.subdomains.get(id).status } : {}) });
    if (parts[2] === 'deploy' && req.method === 'POST') {
      const list = state.deployments.get(id) || [];
      if (list[0] && ['pending', 'running'].includes(list[0].status)) return send(409, { error: 'deploy_in_progress', message: 'Un déploiement est déjà en cours.', deployment_id: list[0].id });
      const dep = { id: 'd-' + (++state.seq), project: id, trigger: 'manual', status: 'pending', status_label: 'en attente', commit: 'a1b2c3d', created_at: '2026-11-04T12:00:00Z', step: 'clone', message: 'En file', log_tail: 'clone…' };
      state.deployments.set(id, [dep, ...list]);
      return send(202, { deployment_id: dep.id, status: 'pending', status_label: 'en attente' });
    }
    if (parts[2] === 'deployments' && req.method === 'GET') return send(200, { deployments: state.deployments.get(id) || [] });
    if (parts[2] === 'subdomain' && parts.length === 3) { const sub = state.subdomains.get(id); return sub ? send(200, sub) : send(404, { error: 'not_found', message: 'Aucun sous-domaine.' }); }
    if (parts[2] === 'subdomain' && parts[3] === 'approve' && req.method === 'POST') { const sub = state.subdomains.get(id); if (!sub) return send(404, { error: 'not_found', message: 'Aucun sous-domaine.' }); sub.status = 'published'; return send(200, sub); }
    send(404, { error: 'not_found', message: 'Route inconnue.' });
  });
  await new Promise(r => server.listen(0, '127.0.0.1', r));
  return { state, token, url: 'http://127.0.0.1:' + server.address().port, close: () => { server.closeAllConnections(); server.close(); },
    // Fait avancer le dernier déploiement d'un projet (pending → running → succeeded…), comme le ferait le service.
    set(id, patch) { const dep = state.deployments.get(id)?.[0]; if (dep) Object.assign(dep, patch); return dep; },
    // Déploiement déclenché par le service lui-même (sondage GitHub, mode automatique).
    autoDeploy(id, patch = {}) { const dep = { id: 'd-' + (++state.seq), project: id, trigger: 'auto', status: 'succeeded', status_label: 'réussi', commit: 'f00ba12', created_at: '2026-11-04T13:00:00Z', step: 'health', message: 'Santé OK (HTTP 200)', log_tail: 'ok', ...patch }; state.deployments.set(id, [dep, ...(state.deployments.get(id) || [])]); return dep; } };
}
module.exports = { fakeDeployer, TOKEN };
