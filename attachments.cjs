'use strict';
// Pièces jointes des tâches : captures, PDF, zip, textes. Stockées dans data/attachments/<tâche>/ (hors dépôt).
// Le nom de fichier sur disque est un identifiant : le nom d'origine n'est jamais utilisé comme chemin.
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');

const TYPES = { png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg', gif: 'image/gif', webp: 'image/webp', pdf: 'application/pdf', zip: 'application/zip',
  txt: 'text/plain; charset=utf-8', md: 'text/markdown; charset=utf-8', csv: 'text/csv; charset=utf-8', json: 'application/json', log: 'text/plain; charset=utf-8' };
// Signature des formats binaires : un fichier renommé (ex. .exe en .png) est refusé.
const MAGIC = { png: [[0x89, 0x50, 0x4e, 0x47]], jpg: [[0xff, 0xd8, 0xff]], jpeg: [[0xff, 0xd8, 0xff]], gif: [[0x47, 0x49, 0x46, 0x38]], webp: [[0x52, 0x49, 0x46, 0x46]],
  pdf: [[0x25, 0x50, 0x44, 0x46]], zip: [[0x50, 0x4b, 0x03, 0x04], [0x50, 0x4b, 0x05, 0x06]] };
const MAX_SIZE = 10 * 1024 * 1024, MAX_COUNT = 20, MAX_TOTAL = 60 * 1024 * 1024;
const INLINE = new Set(['png', 'jpg', 'jpeg', 'gif', 'webp', 'pdf']);

class AttachmentError extends Error { constructor(status, message) { super(message); this.status = status; } }

function cleanName(value) {
  const base = String(value || '').split(/[\\/]/).pop().normalize('NFC').replace(/[\u0000-\u001f\u007f<>:"|?*]/g, '').replace(/^[.\s]+|[.\s]+$/g, '');
  return base.slice(-120) || 'fichier';
}

function createAttachments({ dir }) {
  const folder = taskId => path.join(dir, taskId.replace(/[^\w-]/g, ''));
  const fileOf = (taskId, meta) => path.join(folder(taskId), meta.id + '.' + meta.ext);

  function add(task, { name, data, by = '' }) {
    const clean = cleanName(name), ext = path.extname(clean).slice(1).toLowerCase();
    if (!TYPES[ext]) throw new AttachmentError(415, 'Type de fichier refusé : ' + (ext || 'sans extension') + '. Acceptés : ' + Object.keys(TYPES).join(', ') + '.');
    if (!Buffer.isBuffer(data) || !data.length) throw new AttachmentError(400, 'Le fichier est vide.');
    if (data.length > MAX_SIZE) throw new AttachmentError(413, 'Fichier trop lourd : 10 Mo au maximum.');
    const list = task.attachments || [];
    if (list.length >= MAX_COUNT) throw new AttachmentError(409, 'Cette tâche a déjà ' + MAX_COUNT + ' pièces jointes.');
    if (list.reduce((sum, a) => sum + a.size, 0) + data.length > MAX_TOTAL) throw new AttachmentError(413, 'Les pièces jointes de cette tâche dépassent 60 Mo.');
    if (MAGIC[ext] && !MAGIC[ext].some(sig => sig.every((byte, i) => data[i] === byte))) throw new AttachmentError(415, 'Le contenu ne correspond pas à un fichier .' + ext + '.');
    const meta = { id: crypto.randomUUID(), name: clean, ext, type: TYPES[ext], size: data.length, at: new Date().toISOString(), by };
    fs.mkdirSync(folder(task.id), { recursive: true });
    fs.writeFileSync(fileOf(task.id, meta), data);
    task.attachments = [...list, meta];
    return meta;
  }
  function find(task, attachmentId) {
    const meta = (task.attachments || []).find(a => a.id === attachmentId);
    if (!meta) throw new AttachmentError(404, 'Pièce jointe introuvable.');
    return { meta, file: fileOf(task.id, meta) };
  }
  function remove(task, attachmentId) {
    const { meta, file } = find(task, attachmentId);
    fs.rmSync(file, { force: true });
    task.attachments = task.attachments.filter(a => a !== meta);
  }
  const removeAll = task => fs.rmSync(folder(task.id), { recursive: true, force: true });
  // Envoie le fichier avec des en-têtes qui empêchent tout script de s'exécuter depuis une pièce jointe.
  function send(res, task, attachmentId, extra = {}) {
    const { meta, file } = find(task, attachmentId);
    const disposition = (INLINE.has(meta.ext) ? 'inline' : 'attachment') + "; filename*=UTF-8''" + encodeURIComponent(meta.name);
    res.writeHead(200, { ...extra, 'Content-Type': meta.type, 'Content-Length': meta.size, 'Content-Disposition': disposition, 'X-Content-Type-Options': 'nosniff',
      'Content-Security-Policy': "sandbox; default-src 'none'; img-src 'self'; style-src 'unsafe-inline'", 'Cache-Control': 'no-store' });
    fs.createReadStream(file).on('error', () => res.destroy()).pipe(res);
  }
  return { add, find, remove, removeAll, send, localPath: fileOf };
}

module.exports = { createAttachments, cleanName, AttachmentError, TYPES, MAX_SIZE };
