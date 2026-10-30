'use strict';
const frame = document.getElementById('dashboard'), connection = document.getElementById('connection');
const heading = document.getElementById('heading'), message = document.getElementById('message'), retry = document.getElementById('retry');
let origin = null, checking = false, frameTimeout, ready = false;
function disconnected(title, detail) {
  clearTimeout(frameTimeout); ready = false; origin = null; frame.hidden = true; frame.removeAttribute('src');
  connection.classList.remove('loading'); connection.hidden = false; heading.textContent = title; message.textContent = detail;
}
async function connect() {
  if (checking || document.hidden) return;
  checking = true; retry.disabled = true;
  try {
    if (origin && await MetaBoardConnection.probe(origin)) return;
    const found = await MetaBoardConnection.discover();
    if (!found) { disconnected('Cockpit n’est pas démarré', 'Lancez « Cockpit pour Brave.vbs ». Le panneau se reconnectera automatiquement.'); return; }
    origin = found; ready = false; connection.hidden = false; connection.classList.add('loading');
    heading.textContent = 'Ouverture de votre bureau…'; message.textContent = 'Le service Cockpit est connecté.';
    frame.src = origin + '/?surface=compact'; frame.hidden = false;
    frameTimeout = setTimeout(() => disconnected('Le panneau ne répond pas', 'Cliquez sur Réessayer ou relancez Cockpit sur cet ordinateur.'), 15000);
  } finally { checking = false; retry.disabled = false; }
}
window.addEventListener('message', event => {
  if (event.source !== frame.contentWindow || event.origin !== origin || event.data?.type !== 'metaboard:ready') return;
  clearTimeout(frameTimeout); ready = true; connection.hidden = true; connection.classList.remove('loading');
});
frame.addEventListener('error', () => disconnected('Impossible d’ouvrir Cockpit', 'Relancez le service, puis cliquez sur Réessayer.'));
retry.addEventListener('click', () => { disconnected('Connexion à Cockpit…', 'Recherche du service local.'); connect(); });
document.addEventListener('visibilitychange', () => { if (!document.hidden) connect(); });
setInterval(connect, 10000); connect();
