// Keep a readable recovery screen if a module cannot start, including on LAN HTTP.
(() => {
  const version = window.MB_ASSET_VERSION;
  import('./app.js' + (version ? '?v=' + encodeURIComponent(version) : '')).catch(error => {
    console.error('Démarrage de Cockpit impossible', error);
    if (window.MB_BOOT) { window.MB_BOOT.failed(error); return; }
    document.body.dataset.designReady = 'true';
    const app = document.getElementById('app');
    const message = document.createElement('div'); message.className = 'boot-status';
    const title = document.createElement('h1'); title.textContent = 'Cockpit n’a pas pu démarrer';
    const help = document.createElement('p'); help.textContent = 'Rechargez la page pour récupérer la dernière version.';
    const button = document.createElement('button'); button.className = 'button'; button.textContent = 'Recharger';
    button.onclick = () => { const url = new URL(location.href); url.searchParams.set('v', Date.now()); location.replace(url); };
    message.append(title, help, button); app.replaceChildren(message);
  });
})();
