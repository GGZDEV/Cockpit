'use strict';
// Session web par cookie signé : le téléphone (et l'appli écran d'accueil iOS) reste connecté d'un déploiement à l'autre.
// Le secret de signature vit hors du dépôt (dossier d'état) ; la clé dépend aussi du mot de passe web : le changer déconnecte tout le monde.
const crypto = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const COOKIE = 'cockpit_session', VERSION = 'v1', MAX_AGE = 400 * 86400, RENEW_AFTER = 86400;
const FAILURE_LIMIT = 8, FAILURE_WINDOW = 15 * 60000, GLOBAL_LIMIT = 100;

const defaultStateDir = (env = process.env) => env.COCKPIT_STATE_DIR || path.join(env.XDG_CONFIG_HOME || path.join(os.homedir(), '.config'), 'cockpit');
function ensureStateDir(dir) {
  try { fs.mkdirSync(dir, { mode: 0o700 }); } catch (error) { if (error.code === 'ENOENT') fs.mkdirSync(dir, { recursive: true, mode: 0o700 }); else if (error.code !== 'EEXIST') throw error; }
  return dir;
}
// Créé une seule fois (32 octets, 0600) ; jamais régénéré : un fichier abîmé est une erreur, pas une raison de déconnecter tout le monde.
function loadSecret(dir) {
  const file = path.join(ensureStateDir(dir), 'session-secret');
  try { fs.writeFileSync(file, crypto.randomBytes(32), { flag: 'wx', mode: 0o600 }); } catch (error) { if (error.code !== 'EEXIST') throw error; }
  const secret = fs.readFileSync(file);
  if (secret.length < 32) throw new Error('Secret de session illisible : ' + file);
  return secret;
}
const sameText = (a, b) => crypto.timingSafeEqual(crypto.createHash('sha256').update(String(a)).digest(), crypto.createHash('sha256').update(String(b)).digest());
function cookies(header) {
  const out = {};
  for (const part of String(header || '').split(';')) { const at = part.indexOf('='); if (at > 0) out[part.slice(0, at).trim()] = part.slice(at + 1).trim(); }
  return out;
}

function createWebSession({ stateDir = defaultStateDir(), password, now = Date.now } = {}) {
  let key;
  // Lecture paresseuse : un serveur qui ne voit jamais de navigateur ne crée rien.
  const signingKey = () => key ||= crypto.createHmac('sha256', loadSecret(stateDir)).update('cockpit-session\0' + password).digest();
  const sign = payload => crypto.createHmac('sha256', signingKey()).update(payload).digest('base64url');
  const attributes = (secure, maxAge) => '; Path=/; Max-Age=' + maxAge + '; HttpOnly; SameSite=Lax' + (secure ? '; Secure' : '');
  function issue(secure) {
    const at = Math.floor(now() / 1000), payload = [VERSION, at.toString(36), (at + MAX_AGE).toString(36)].join('.');
    return COOKIE + '=' + payload + '.' + sign(payload) + attributes(secure, MAX_AGE);
  }
  const clear = secure => COOKIE + '=' + attributes(secure, 0);
  // { ok, renew } : renew quand le cookie a plus d'un jour (prolongation glissante).
  function verify(header) {
    const value = cookies(header)[COOKIE];
    if (!value) return { ok: false };
    const parts = value.split('.');
    if (parts.length !== 4 || parts[0] !== VERSION || !/^[0-9a-z]{1,12}$/.test(parts[1]) || !/^[0-9a-z]{1,12}$/.test(parts[2])) return { ok: false };
    const expected = Buffer.from(sign(parts.slice(0, 3).join('.'))), supplied = Buffer.from(parts[3]);
    if (expected.length !== supplied.length || !crypto.timingSafeEqual(expected, supplied)) return { ok: false };
    const at = parseInt(parts[1], 36), expires = parseInt(parts[2], 36), current = now() / 1000;
    if (!(expires > current) || at > current + 300 || expires - at > MAX_AGE) return { ok: false };
    return { ok: true, renew: current - at > RENEW_AFTER };
  }
  const checkPassword = supplied => sameText(supplied, password);
  const checkBasic = header => sameText(header, 'Basic ' + Buffer.from('cockpit:' + password).toString('base64'));
  // Formulaire et Basic comptés à part : un navigateur qui renvoie d'anciens identifiants Basic ne bloque pas le formulaire.
  return { issue, clear, verify, checkPassword, checkBasic, limiter: createLimiter(now), basicLimiter: createLimiter(now) };
}
// Échecs par adresse en mémoire, plus un plafond global contre une rotation d'adresses.
function createLimiter(now = Date.now) {
  const failures = new Map(); let global = { count: 0, since: now() };
  const fresh = entry => entry && now() - entry.since < FAILURE_WINDOW;
  return {
    blocked(ip) { return (fresh(failures.get(ip)) && failures.get(ip).count >= FAILURE_LIMIT) || (fresh(global) && global.count >= GLOBAL_LIMIT); },
    fail(ip) {
      if (failures.size > 1000) for (const [k, v] of failures) if (!fresh(v)) failures.delete(k);
      const entry = fresh(failures.get(ip)) ? failures.get(ip) : { count: 0, since: now() };
      entry.count++; failures.set(ip, entry);
      if (!fresh(global)) global = { count: 0, since: now() };
      global.count++;
    },
    succeed(ip) { failures.delete(ip); }
  };
}

// Adresse du client : celle du socket, et derrière le proxy l'adresse qu'il a ajoutée en dernier (non falsifiable par le client).
function clientAddress(req) {
  const forwarded = String(req.headers['x-forwarded-for'] || '').split(',').map(x => x.trim()).filter(Boolean);
  return (req.socket.remoteAddress || '') + (forwarded.length ? '>' + forwarded.at(-1) : '');
}
// Retour après connexion : chemin local seulement, jamais une autre origine.
function safeNext(value) {
  const next = String(value || '/');
  if (!/^\/(?![/\\])/.test(next) || /[\0-\x1f\\]/.test(next) || /^\/(login|logout)(?:[?#]|$)/.test(next) || next.length > 2000) return '/';
  try { return new URL(next, 'http://cockpit.invalid').origin === 'http://cockpit.invalid' ? next : '/'; } catch { return '/'; }
}
const escapeHtml = value => String(value).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
function loginPage({ next = '/', error = '' } = {}) {
  return `<!doctype html>
<html lang="fr"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1,viewport-fit=cover">
<meta name="apple-mobile-web-app-capable" content="yes"><meta name="mobile-web-app-capable" content="yes"><meta name="apple-mobile-web-app-title" content="Cockpit"><meta name="theme-color" content="#18171b">
<link rel="manifest" href="/manifest.json"><link rel="apple-touch-icon" href="/brand/apple-touch-icon.png"><title>Connexion · Cockpit</title>
<style>
*{box-sizing:border-box}html,body{margin:0;min-height:100%;background:#18171b;color:#f3f1f5;font:16px/1.5 system-ui,-apple-system,"Segoe UI",Roboto,sans-serif}
body{display:flex;min-height:100vh;min-height:100dvh;align-items:center;justify-content:center;padding:max(24px,env(safe-area-inset-top)) 20px max(24px,env(safe-area-inset-bottom))}
main{width:100%;max-width:360px}img{display:block;width:64px;height:64px;border-radius:16px;margin:0 auto 16px}
h1{font-size:22px;font-weight:600;text-align:center;margin:0 0 24px}label{display:block;font-size:14px;color:#b9b4c0;margin-bottom:6px}
input{width:100%;font:inherit;font-size:17px;padding:13px 14px;border:1px solid #3a3740;border-radius:12px;background:#232127;color:inherit}
input:focus{outline:2px solid #8b7cf6;outline-offset:1px;border-color:transparent}
button{width:100%;margin-top:16px;padding:14px;font:inherit;font-weight:600;border:0;border-radius:12px;background:#8b7cf6;color:#fff;cursor:pointer}
.error{margin:0 0 16px;padding:10px 12px;border-radius:10px;background:#3b1f24;color:#ffb4bd;font-size:14px}.hidden{position:absolute;width:1px;height:1px;opacity:0;pointer-events:none}
</style></head><body><main>
<img src="/brand/icon-192.png" alt=""><h1>Cockpit</h1>
${error ? `<p class="error" role="alert">${escapeHtml(error)}</p>` : ''}<form method="post" action="/login">
<input class="hidden" type="text" name="username" value="cockpit" autocomplete="username" tabindex="-1" aria-hidden="true">
<input type="hidden" name="next" value="${escapeHtml(safeNext(next))}">
<label for="password">Mot de passe</label><input id="password" type="password" name="password" autocomplete="current-password" required autofocus>
<button type="submit">Se connecter</button></form></main></body></html>`;
}
const PAGE_HEADERS = { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff', 'Referrer-Policy': 'no-referrer', 'X-Frame-Options': 'DENY',
  'Content-Security-Policy': "default-src 'none'; style-src 'unsafe-inline'; img-src 'self'; manifest-src 'self'; form-action 'self'; frame-ancestors 'none'; base-uri 'none'" };

module.exports = { COOKIE, MAX_AGE, createWebSession, defaultStateDir, ensureStateDir, clientAddress, safeNext, loginPage, PAGE_HEADERS };
