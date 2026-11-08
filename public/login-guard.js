// Mode serveur : un appel refusé faute de session (401 + X-Cockpit-Login) recharge la page, qui affiche alors la connexion.
// Syntaxe volontairement ancienne, comme boot-guard.js.
(function () {
  var realFetch = window.fetch;
  if (!realFetch) return;
  function relogin() {
    try {
      // Pas de boucle de rechargement si la page revient sans session.
      if (Date.now() - Number(sessionStorage.getItem('mb.relogin') || 0) < 10000) return;
      sessionStorage.setItem('mb.relogin', String(Date.now()));
    } catch (e) { /* stockage indisponible : on recharge quand même */ }
    location.reload();
  }
  window.fetch = function () {
    return realFetch.apply(window, arguments).then(function (response) {
      if (response.status === 401 && response.headers.get('X-Cockpit-Login') === '1') relogin();
      return response;
    });
  };
})();
