#!/usr/bin/env node
'use strict';
// Serveur MCP (stdio) : donne à Claude, Codex ou tout client MCP les outils Projets de Cockpit.
// Usage : node mcp/cockpit-projets.cjs --client claude|codex|openclaw
// Il passe par l'accès agents de Cockpit (port 3890) : aucun lancement, validation ni suppression possible.
const fs = require('node:fs');
const path = require('node:path');
const readline = require('node:readline');

const arg = name => { const i = process.argv.indexOf('--' + name); return i > 0 ? process.argv[i + 1] : undefined; };
const CLIENT = arg('client') || process.env.COCKPIT_CLIENT || 'claude';
const BASE = (arg('url') || process.env.COCKPIT_URL || 'http://127.0.0.1:3890').replace(/\/$/, '') + '/agent/v1/';
function token() {
  if (process.env.COCKPIT_TOKEN) return process.env.COCKPIT_TOKEN;
  try { return JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'data', 'agent-access.json'), 'utf8')).clients[CLIENT].token; }
  catch { throw Error('Clé introuvable pour « ' + CLIENT + ' » : démarrez Cockpit une fois sur ce PC (elle est créée dans data/agent-access.json).'); }
}

const STATUS_TASK = 'todo (À faire), doing (En cours, tâches manuelles seulement), blocked (Bloqué), review (À valider), done (Terminé). Les libellés français sont acceptés.';
const PRIORITY = { description: '0 aucune, 1 basse, 2 moyenne, 3 haute, 4 urgent (ou le mot).', type: ['integer', 'string'] };
const DATE = { type: 'string', description: 'Échéance AAAA-MM-JJ, ou chaîne vide pour l’effacer.' };
const LINKS = { type: 'array', description: 'Liens http(s).', items: { anyOf: [{ type: 'string' }, { type: 'object', properties: { url: { type: 'string' }, label: { type: 'string' } }, required: ['url'] }] } };
const CONTEXT = { type: 'object', description: 'Contexte transmis aux agents OpenClaw quand une tâche est lancée. Jamais de secret ici.', properties: {
  objective: { type: 'string' }, instructions: { type: 'string', description: 'Consignes générales du projet.' }, resources: { type: 'string' },
  repository: { type: 'string', description: 'Adresse GitHub https://github.com/<compte>/<dépôt> (obligatoire à la création). Cockpit la clone sur le PC de l’utilisateur.' }, environment: { type: 'string' }, links: LINKS } };
const AGENT = { type: ['string', 'null'], description: 'Agent OpenClaw (identifiant ou nom, voir projets_agents). null = aucun.' };
const TASK_FIELDS = {
  title: { type: 'string' }, instructions: { type: 'string', description: 'Consignes précises pour la personne ou l’agent qui fera la tâche.' },
  expected: { type: 'string', description: 'Résultat attendu.' }, criteria: { type: 'string', description: 'Critères de réussite.' },
  resources: { type: 'string' }, links: LINKS, priority: PRIORITY, due: DATE,
  agent: { type: ['string', 'null'], description: 'Agent OpenClaw à qui confier la tâche (identifiant ou nom, voir projets_agents). Par défaut : l’agent du projet. null ou "manuelle" = tâche manuelle. Assigner ne lance rien.' },
  status: { type: 'string', description: STATUS_TASK }, includeContext: { type: 'boolean', description: 'Joindre le contexte du projet au lancement (oui par défaut).' } };
const PROJECT_FIELDS = { name: { type: 'string' }, description: { type: 'string' }, status: { type: 'string', description: 'prep (À préparer), active (Actif), paused (En pause), done (Terminé).' }, priority: PRIORITY, due: DATE, context: CONTEXT,
  agent: { ...AGENT, description: 'Agent OpenClaw du projet : les nouvelles tâches lui sont confiées par défaut. ' + AGENT.description } };

const READ = { readOnlyHint: true, destructiveHint: false, openWorldHint: false };
const WRITE = { readOnlyHint: false, destructiveHint: false, openWorldHint: false };
const TOOLS = [
  { name: 'projets_lister', title: 'Lister projets et tâches', annotations: READ,
    description: 'Liste les projets (non archivés par défaut) et leurs tâches dans Cockpit : statut, priorité, agent, dernière exécution. À appeler avant de créer pour éviter les doublons.',
    inputSchema: { type: 'object', properties: { projet: { type: 'string', description: 'Nom, code ou identifiant pour filtrer.' }, statut: { type: 'string', description: 'Filtre de colonne : ' + STATUS_TASK }, archives: { type: 'boolean' } } },
    call: a => get('state', { project: a.projet, status: a.statut, archived: a.archives ? '1' : undefined }) },
  { name: 'projets_ici', title: 'Projet du dossier courant', annotations: READ,
    description: 'Retrouve le projet Cockpit dont le dossier local contient ce dossier (le dépôt cloné par Cockpit), avec son contexte et ses tâches non terminées (consignes, résultat attendu, pièces jointes avec leur chemin sur le PC). À appeler en arrivant dans un dépôt pour savoir quoi faire.',
    inputSchema: { type: 'object', properties: { dossier: { type: 'string', description: 'Dossier de travail (par défaut, celui où tourne ce serveur MCP).' } } },
    call: a => get('workspace', { path: path.resolve(a.dossier || process.cwd()) }) },
  { name: 'projets_agents', title: 'Agents OpenClaw disponibles', annotations: READ,
    description: 'Liste les agents OpenClaw auxquels une tâche peut être confiée, avec leur disponibilité.',
    inputSchema: { type: 'object', properties: {} }, call: () => get('agents') },
  { name: 'projets_tache', title: 'Détail d’une tâche', annotations: READ,
    description: 'Détail d’une tâche par son code (ex. MAI-3) : consignes, critères, question de l’agent, dernière exécution.',
    inputSchema: { type: 'object', properties: { tache: { type: 'string', description: 'Code ou identifiant.' } }, required: ['tache'] },
    call: a => get('tasks/' + encodeURIComponent(a.tache)) },
  { name: 'projets_creer_projet', title: 'Créer un projet', annotations: WRITE,
    description: 'Crée un projet dans Cockpit. Un dépôt GitHub est obligatoire (context.repository) : Cockpit le clone aussitôt sur le PC, à côté des autres projets. Le code court (ex. MAI) est généré depuis le nom si absent.',
    inputSchema: { type: 'object', properties: { ...PROJECT_FIELDS, key: { type: 'string', description: 'Code court optionnel (2 à 6 lettres).' } }, required: ['name', 'context'] },
    call: a => send('POST', 'projects', a) },
  { name: 'projets_modifier_projet', title: 'Modifier un projet', annotations: WRITE,
    description: 'Modifie un projet existant (seuls les champs fournis changent). archived=true archive le projet, false le restaure.',
    inputSchema: { type: 'object', properties: { projet: { type: 'string', description: 'Nom, code ou identifiant.' }, ...PROJECT_FIELDS, archived: { type: 'boolean' } }, required: ['projet'] },
    call: ({ projet, ...a }) => send('PATCH', 'projects/' + encodeURIComponent(projet), a) },
  { name: 'projets_creer_tache', title: 'Créer une tâche', annotations: WRITE,
    description: 'Ajoute une tâche à un projet (colonne À faire par défaut). Créer ou assigner un agent ne lance rien : seul l’utilisateur lance une exécution, avec le bouton « Lancer » de l’interface Projets.',
    inputSchema: { type: 'object', properties: { projet: { type: 'string', description: 'Nom, code ou identifiant du projet.' }, ...TASK_FIELDS }, required: ['projet', 'title'] },
    call: ({ projet, ...a }) => send('POST', 'tasks', { ...a, project: projet }) },
  { name: 'projets_modifier_tache', title: 'Modifier une tâche', annotations: WRITE,
    description: 'Modifie une tâche (seuls les champs fournis changent), y compris sa colonne. Impossible pendant une exécution ; valider le résultat d’un agent reste un geste de l’utilisateur.',
    inputSchema: { type: 'object', properties: { tache: { type: 'string', description: 'Code ou identifiant.' }, ...TASK_FIELDS }, required: ['tache'] },
    call: ({ tache, ...a }) => send('PATCH', 'tasks/' + encodeURIComponent(tache), a) },
  { name: 'projets_joindre_fichier', title: 'Joindre un fichier à une tâche', annotations: WRITE,
    description: 'Joint un fichier de ce PC à une tâche : capture (png, jpg, gif, webp), PDF, zip ou texte (txt, md, csv, json, log), 10 Mo au maximum. Jamais de fichier contenant un secret.',
    inputSchema: { type: 'object', properties: { tache: { type: 'string', description: 'Code ou identifiant.' }, chemin: { type: 'string', description: 'Chemin du fichier sur ce PC.' }, nom: { type: 'string', description: 'Nom affiché (par défaut, celui du fichier).' } }, required: ['tache', 'chemin'] },
    call: ({ tache, chemin, nom }) => {
      const file = path.resolve(chemin), size = fs.statSync(file).size;
      if (size > 10 * 1024 * 1024) throw Error('Fichier trop lourd : 10 Mo au maximum.');
      return send('POST', 'tasks/' + encodeURIComponent(tache) + '/attachments', { name: nom || path.basename(file), data: fs.readFileSync(file).toString('base64') });
    } },
];

async function request(method, route, body) {
  let response;
  try { response = await fetch(BASE + route, { method, headers: { Authorization: 'Bearer ' + token(), ...(body ? { 'Content-Type': 'application/json' } : {}) }, body: body ? JSON.stringify(body) : undefined, signal: AbortSignal.timeout(60000) }); }
  catch (error) { if (/Clé introuvable/.test(error.message)) throw error; throw Error('Cockpit ne répond pas sur ' + BASE + ' : le service MetaBoard est-il lancé sur le PC ?'); }
  const data = await response.json().catch(() => ({}));
  if (!response.ok) throw Error(data.error || 'Cockpit a refusé la demande (' + response.status + ').');
  return data;
}
const get = (route, query = {}) => { const q = new URLSearchParams(Object.entries(query).filter(([, v]) => v !== undefined && v !== '')); return request('GET', route + (q.size ? '?' + q : '')); };
const send = (method, route, body) => request(method, route, body);

// ----- JSON-RPC sur stdio (une ligne = un message) ---------------------------------------
const VERSIONS = ['2025-11-25', '2025-06-18', '2025-03-26', '2024-11-05'];
const write = message => process.stdout.write(JSON.stringify({ jsonrpc: '2.0', ...message }) + '\n');
async function dispatch(message) {
  const { id, method, params = {} } = message;
  if (id === undefined) return; // notifications (initialized, cancelled…)
  try {
    if (method === 'initialize') return write({ id, result: { protocolVersion: VERSIONS.includes(params.protocolVersion) ? params.protocolVersion : VERSIONS[1], capabilities: { tools: {} },
      serverInfo: { name: 'cockpit-projets', title: 'Cockpit · Projets', version: '1.1.0' },
      instructions: 'Outils pour organiser les projets de l’utilisateur dans Cockpit. En arrivant dans un dépôt, appelez projets_ici pour connaître le projet et ses tâches. Vérifiez avec projets_lister avant de créer ; tout nouveau projet a un dépôt GitHub, cloné par Cockpit sur le PC. Vous ne pouvez ni lancer d’agent OpenClaw, ni valider de résultat, ni supprimer : dites à l’utilisateur de le faire dans l’onglet Projets.' } });
    if (method === 'ping') return write({ id, result: {} });
    if (method === 'tools/list') return write({ id, result: { tools: TOOLS.map(({ call, ...tool }) => tool) } });
    if (method === 'tools/call') {
      const tool = TOOLS.find(t => t.name === params.name);
      if (!tool) return write({ id, error: { code: -32602, message: 'Outil inconnu : ' + params.name } });
      try { const result = await tool.call(params.arguments || {}); return write({ id, result: { content: [{ type: 'text', text: JSON.stringify(result, null, 1) }], structuredContent: result } }); }
      catch (error) { return write({ id, result: { content: [{ type: 'text', text: error.message }], isError: true } }); }
    }
    write({ id, error: { code: -32601, message: 'Méthode inconnue : ' + method } });
  } catch (error) { write({ id, error: { code: -32603, message: error.message } }); }
}
readline.createInterface({ input: process.stdin }).on('line', line => {
  if (!line.trim()) return;
  let message; try { message = JSON.parse(line); } catch { return write({ id: null, error: { code: -32700, message: 'JSON invalide.' } }); }
  for (const m of Array.isArray(message) ? message : [message]) dispatch(m);
});
