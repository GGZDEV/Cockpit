// Fil de discussion d'une tâche : consignes, réponses de l'agent et vos messages, dans l'ordre.
// Fonctions pures (aucun accès au DOM) : le panneau de projects.js les met en forme.
import { esc, safeUrl } from './core.js';

const OPEN = ['pending', 'started'];

// Messages du fil, du plus ancien au plus récent.
// role : 'user' (vous), 'agent' (réponse ou exécution) ou 'system' (repère discret).
export function chatItems(task) {
  const items = [{ role: 'user', type: 'brief', at: task.createdAt, text: task.instructions || '', attachments: task.attachments || [] }];
  const agentName = run => run.agent?.name || task.agent?.name || 'l’agent';
  for (const run of task.runs || []) {
    if (['reprise', 'answer'].includes(run.kind) && run.note) items.push({ role: 'user', type: run.kind, at: run.createdAt, text: run.note, run });
    else if (run.kind === 'retry') items.push(run.note ? { role: 'user', type: 'retry', at: run.createdAt, text: run.note, run } : { role: 'system', type: 'retry', at: run.createdAt, text: 'Relance envoyée à ' + agentName(run) });
    else items.push({ role: 'system', type: 'launch', at: run.createdAt, text: 'Confiée à ' + agentName(run) });
    if (OPEN.includes(run.status)) items.push({ role: 'agent', type: 'live', at: run.startedAt || run.createdAt, text: run.liveText || '', run });
    else if (run.status === 'succeeded' && run.outcome === 'question') items.push({ role: 'agent', type: 'question', at: run.endedAt, text: run.result || '', run });
    else if (run.status === 'succeeded') items.push({ role: 'agent', type: 'result', at: run.endedAt, text: run.result || '', run });
    else items.push({ role: 'agent', type: 'error', at: run.endedAt, text: run.error || '', run });
    if (run.accepted) items.push({ role: 'system', type: 'accepted', at: run.accepted, text: 'Résultat accepté · tâche close' });
  }
  if (task.status === 'done' && !task.runs?.at(-1)?.accepted) items.push({ role: 'system', type: 'closed', at: task.acceptedAt || task.movedAt || task.updatedAt, text: 'Tâche close' });
  return items;
}

// Ce que la zone de saisie propose, selon l'état de la tâche.
// kind = type de lancement envoyé au serveur ; needsText = message obligatoire.
export function composerMode(task, { busy = false } = {}) {
  const runs = task.runs || [], last = runs.at(-1), done = task.status === 'done';
  if (!task.agent) return { mode: 'manual' };
  if (busy || runs.some(r => OPEN.includes(r.status))) return { mode: 'busy' };
  if (!runs.length) return task.instructions
    ? { mode: 'send', kind: 'initial', needsText: false, label: 'Lancer' }
    : { mode: 'send', kind: 'initial', needsText: true, setsInstructions: true, label: 'Envoyer', placeholder: 'Décrivez ce que l’agent doit faire…' };
  if (!done && ['failed', 'interrupted'].includes(last.status)) return { mode: 'send', kind: 'retry', needsText: false, label: 'Relancer', placeholder: 'Précisions pour la relance (facultatif)…' };
  if (!done && last.outcome === 'question') return { mode: 'send', kind: 'answer', needsText: true, label: 'Répondre', placeholder: 'Votre réponse à sa question…' };
  return { mode: 'send', kind: 'reprise', needsText: true, label: 'Envoyer', placeholder: 'Une correction, une suite, une précision…', quick: true };
}

// « Clore la tâche » : possible tant qu'elle n'est pas terminée et qu'aucun agent n'y travaille.
export function canClose(task) {
  return task.status !== 'done' && !(task.runs || []).some(r => OPEN.includes(r.status));
}

// Mise en forme légère des réponses (gras, code, listes, liens), toujours échappée.
const strong = raw => esc(raw).replace(/\*\*(.+?)\*\*/g, '<strong>$1</strong>');
const linkify = raw => raw.split(/(https?:\/\/[^\s<>()"'`\]]*[^\s<>()"'`\].,;:!?*])/)
  .map((part, i) => i % 2 ? `<a href="${esc(safeUrl(part))}" target="_blank" rel="noopener noreferrer">${esc(part)}</a>` : strong(part)).join('');
const inline = raw => String(raw).split(/(`[^`\n]+`)/).map((part, i) => i % 2 ? `<code>${esc(part.slice(1, -1))}</code>` : linkify(part)).join('');

export function richText(value) {
  const lines = String(value ?? '').replace(/\r\n/g, '\n').split('\n');
  let html = '', list = null, para = [], code = null;
  const flush = () => { if (para.length) html += `<p>${para.map(inline).join('<br>')}</p>`; para = []; };
  const closeList = () => { if (list) html += `</${list}>`; list = null; };
  for (const line of lines) {
    if (/^\s*```/.test(line)) {
      if (code) { html += `<pre><code>${esc(code.join('\n'))}</code></pre>`; code = null; } else { flush(); closeList(); code = []; }
      continue;
    }
    if (code) { code.push(line); continue; }
    const item = /^\s*(?:([-*•])|(\d+)[.)])\s+(.*)$/.exec(line);
    if (item) {
      flush();
      const tag = item[1] ? 'ul' : 'ol';
      if (list !== tag) { closeList(); html += tag === 'ol' && item[2] !== '1' ? `<ol start="${Number(item[2])}">` : `<${tag}>`; list = tag; }
      html += `<li>${inline(item[3])}</li>`; continue;
    }
    closeList();
    const head = /^\s*#{1,6}\s+(.*)$/.exec(line);
    if (head) { flush(); html += `<p class="pj-md-h">${inline(head[1])}</p>`; }
    else if (line.trim()) para.push(line);
    else flush();
  }
  if (code) html += `<pre><code>${esc(code.join('\n'))}</code></pre>`;
  flush(); closeList();
  return html;
}
