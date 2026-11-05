'use strict';
// Client du service de déploiement (CT 113 « deployer », API HTTP JSON sur le réseau local ; contrat : docs/PROJETS-DEPLOIEMENT.md).
// Le jeton vient uniquement de la configuration du serveur Cockpit (COCKPIT_DEPLOYER_TOKEN) : jamais de l'interface, jamais écrit
// dans un journal, un message d'erreur ou une réponse. Chaque erreur est une DeployerError au message français, sans secret.
const fs = require('node:fs');
const { redact } = require('./direct-harness.cjs');

const DEFAULT_URL = 'http://192.168.1.236:8080';
const ID = /^[a-z0-9][a-z0-9-]{0,39}$/;
const STATUS = { pending: 'En attente', running: 'En cours', succeeded: 'Réussi', failed: 'Échoué', rolled_back: 'Revenu en arrière', unknown: 'État inconnu' };

class DeployerError extends Error {
  // code : not_configured | unreachable | timeout | unauthorized | bad_response | invalid | conflict | not_found | refused
  constructor(code, message, { status = 0, service = '', deploymentId = '' } = {}) { super(message); this.code = code; this.status = status; this.service = service; this.deploymentId = deploymentId; }
}
// Statut HTTP que Cockpit renvoie à son interface pour chaque famille d'erreur.
const HTTP = { not_configured: 503, unreachable: 502, timeout: 504, unauthorized: 502, bad_response: 502, invalid: 422, conflict: 409, not_found: 404, refused: 502 };

const statusOf = value => (value in STATUS && value !== 'unknown') ? value : 'unknown';
const line = (value, max = 300) => String(value ?? '').replace(/[\u0000-\u0008\u000b-\u001f\u007f]/g, ' ').slice(0, max);

function tokenFromEnvironment() {
  if (process.env.COCKPIT_DEPLOYER_TOKEN) return process.env.COCKPIT_DEPLOYER_TOKEN;
  const file = process.env.COCKPIT_DEPLOYER_TOKEN_FILE;
  if (!file) return '';
  try { return fs.readFileSync(file, 'utf8').trim(); } catch { return ''; }
}
function createDeployerClient({ baseUrl = process.env.COCKPIT_DEPLOYER_URL || DEFAULT_URL, token = tokenFromEnvironment(), fetchImpl = fetch, timeoutMs = 10000, maxBytes = 1024 * 1024 } = {}) {
  token = String(token || '').trim();
  let base = null, problem = '';
  try {
    const u = new URL(baseUrl);
    if (!['http:', 'https:'].includes(u.protocol) || u.username || u.password) throw new Error('adresse');
    base = u.origin;
  } catch { problem = 'COCKPIT_DEPLOYER_URL n’est pas une adresse http(s) valide.'; }
  if (!problem && !token) problem = 'Le jeton du service de déploiement n’est pas configuré (COCKPIT_DEPLOYER_TOKEN_FILE ou COCKPIT_DEPLOYER_TOKEN).';
  const configured = !problem;
  const clean = value => redact(token ? String(value).split(token).join('***') : String(value));

  async function request(method, route, body, { auth = true } = {}) {
    if (auth && !configured) throw new DeployerError('not_configured', problem);
    if (!base) throw new DeployerError('not_configured', problem);
    let response, raw = '';
    try {
      response = await fetchImpl(base + route, { method, redirect: 'error', signal: AbortSignal.timeout(timeoutMs),
        headers: { Accept: 'application/json', ...(body !== undefined ? { 'Content-Type': 'application/json' } : {}), ...(auth ? { Authorization: 'Bearer ' + token } : {}) },
        ...(body !== undefined ? { body: JSON.stringify(body) } : {}) });
      // Lecture plafonnée : une réponse démesurée est abandonnée plutôt que chargée en mémoire.
      const chunks = []; let size = 0;
      for await (const chunk of response.body || []) { size += chunk.length; if (size > maxBytes) throw new DeployerError('bad_response', 'Réponse du service de déploiement trop volumineuse.'); chunks.push(chunk); }
      raw = Buffer.concat(chunks).toString('utf8');
    } catch (error) {
      if (error instanceof DeployerError) throw error;
      if (error?.name === 'TimeoutError' || error?.name === 'AbortError') throw new DeployerError('timeout', `Le service de déploiement ne répond pas (délai de ${Math.round(timeoutMs / 1000)} s dépassé).`);
      throw new DeployerError('unreachable', 'Le service de déploiement est injoignable (' + new URL(base).host + '). Vérifiez qu’il est démarré.');
    }
    let data = null;
    if (raw) { try { data = JSON.parse(raw); } catch { data = null; } }
    if (response.ok) {
      if (response.status === 204) return { status: 204, data: {} };
      if (!data || typeof data !== 'object') throw new DeployerError('bad_response', 'Réponse inattendue du service de déploiement.');
      return { status: response.status, data };
    }
    const service = line(data?.error, 60), message = line(clean(data?.message || ''), 400), id = line(data?.deployment_id, 80);
    const info = { status: response.status, service, deploymentId: id };
    if (response.status === 401 || response.status === 403) throw new DeployerError('unauthorized', 'Le service de déploiement a refusé le jeton de Cockpit : vérifiez COCKPIT_DEPLOYER_TOKEN.', info);
    if (response.status === 404) throw new DeployerError('not_found', message || 'Introuvable côté service de déploiement.', info);
    if (response.status === 409) throw new DeployerError('conflict', message || (service === 'deploy_in_progress' ? 'Un déploiement est déjà en cours pour ce projet.' : 'Le service de déploiement refuse : conflit en cours.'), info);
    if (response.status === 400 || response.status === 422) throw new DeployerError('invalid', message || 'Le service de déploiement refuse ces réglages.', info);
    throw new DeployerError('refused', message || 'Le service de déploiement a répondu par une erreur (' + response.status + ').', info);
  }
  const need = id => { if (!ID.test(String(id))) throw new DeployerError('invalid', 'Identifiant de projet invalide pour le service de déploiement.'); return encodeURIComponent(id); };

  // Un déploiement du service, réduit aux champs affichés (journal : 40 lignes de 300 caractères au plus, sans secret).
  function deployment(d) {
    if (!d || typeof d !== 'object') return null;
    const log = String(d.log_tail ?? '').split('\n').map(l => line(clean(l))).filter(l => l.trim()).slice(-40);
    return { id: line(d.id, 80), status: statusOf(d.status), trigger: ['auto', 'manual', 'rollback'].includes(d.trigger) ? d.trigger : '', commit: line(d.commit, 40), previousCommit: line(d.previous_commit, 40),
      createdAt: line(d.created_at, 40), startedAt: line(d.started_at, 40), finishedAt: line(d.finished_at, 40), step: line(d.step, 20), message: line(clean(d.message ?? ''), 300), log };
  }
  const project = p => ({ id: line(p.id, 40), repo: line(p.repo, 200), branch: line(p.branch, 100), deploying: p.deploying === true, subdomainStatus: line(p.subdomain_status, 30), latest: deployment(p.latest_deployment) });

  return {
    configured, reason: problem, host: base ? new URL(base).host : '',
    describe: () => ({ configured, host: base ? new URL(base).host : '', reason: problem }),
    // Sans jeton : seule une absence de réponse réseau compte comme « injoignable ».
    async health() { const { data } = await request('GET', '/health', undefined, { auth: false }); return { ok: data.status === 'ok', version: line(data.version, 30) }; },
    async getProject(id) { try { return project((await request('GET', '/projects/' + need(id))).data); } catch (error) { if (error.code === 'not_found') return null; throw error; } },
    // PUT idempotent : crée (201) ou met à jour (200). subdomainStatus est « awaiting_validation » tant que Ggz n'a rien validé.
    async putProject(id, payload) { const { status, data } = await request('PUT', '/projects/' + need(id), payload); return { created: status === 201, subdomainStatus: line(data.subdomain_status, 30) }; },
    async deploy(id, ref) {
      const { data } = await request('POST', '/projects/' + need(id) + '/deploy', ref ? { ref } : undefined);
      return { deploymentId: line(data.deployment_id, 80), status: statusOf(data.status) };
    },
    async deployments(id, limit = 5) { const { data } = await request('GET', '/projects/' + need(id) + '/deployments?limit=' + Math.min(Math.max(Number(limit) || 5, 1), 20)); return (Array.isArray(data.deployments) ? data.deployments : []).map(deployment).filter(Boolean); },
    async getSubdomain(id) { try { const { data } = await request('GET', '/projects/' + need(id) + '/subdomain'); return { name: line(data.name, 120), status: line(data.status, 30), detail: line(clean(data.detail ?? ''), 300) }; } catch (error) { if (error.code === 'not_found') return null; throw error; } },
    // À n'appeler qu'après un clic explicite de l'utilisateur sur ce nom précis (voir validatePublic dans projects.cjs).
    async approveSubdomain(id) { await request('POST', '/projects/' + need(id) + '/subdomain/approve', {}); return true; },
  };
}

module.exports = { createDeployerClient, DeployerError, STATUS, HTTP, DEFAULT_URL, ID };
