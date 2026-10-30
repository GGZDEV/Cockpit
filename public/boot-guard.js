// Deliberately old syntax: report startup failures even if the main app cannot parse.
(function () {
  var finished = false, lastError = '';
  function reveal() {
    document.body.setAttribute('data-design-ready', 'true');
  }
  function show(message) {
    if (finished) return;
    reveal();
    var panel = document.getElementById('boot-recovery');
    if (!panel) return;
    panel.hidden = false;
    document.getElementById('boot-error').textContent = message;
    document.getElementById('boot-browser').textContent = navigator.userAgent;
  }
  window.MB_BOOT = {
    ready: function () {
      finished = true; reveal();
      var panel = document.getElementById('boot-recovery');
      if (panel) panel.hidden = true;
    },
    failed: function (error) {
      lastError = error && error.message ? error.message : String(error || 'Erreur de chargement');
      show(lastError);
    }
  };
  window.addEventListener('error', function (event) {
    if (event.message) lastError = event.message;
    else if (event.target && event.target.tagName === 'SCRIPT') lastError = 'Un fichier de l’application ne s’est pas chargé.';
    if (document.readyState !== 'loading' && lastError) show(lastError);
  }, true);
  document.addEventListener('DOMContentLoaded', function () {
    document.getElementById('boot-reload').onclick = function () {
      var url = new URL(location.href); url.searchParams.set('v', Date.now()); location.replace(url.href);
    };
    if (lastError) show(lastError);
    setTimeout(function () { show(lastError || 'Le chargement prend trop de temps. Rechargez la page ; si cela persiste, transmettez le message ci-dessous.'); }, 15000);
  });
})();
