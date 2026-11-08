// Reconnexion Home Assistant au démarrage (hors mode servi par HA) : jeton de cet appareil, puis celui mémorisé par le serveur Cockpit.
// Un jeton n'est enregistré, ici ou sur le serveur, qu'après avoir fonctionné ; une coupure réseau ne jette aucun jeton.
export const refused = error => !!error?.auth || /^(Jeton|Session) refusée? :/.test(String(error?.message || ''));

// Résultat : { ok, source: 'local'|'server' } ou { ok: false, reason: 'none'|'refused'|'network', error }.
export async function restoreHA({ local, loadServer, connect, probe, saveLocal, dropLocal, saveServer }) {
  const pending = Promise.resolve().then(loadServer).catch(() => null);
  const remoteOf = saved => saved?.token && saved.url ? { url: String(saved.url), token: String(saved.token) } : null;
  async function useServer(remote) {
    try { await connect(remote.url, remote.token); } catch (error) { return { ok: false, reason: refused(error) ? 'refused' : 'network', error }; }
    saveLocal(remote); return { ok: true, source: 'server' };
  }
  if (local?.token) {
    try { await connect(local.url, local.token); }
    catch (error) {
      if (!refused(error)) return { ok: false, reason: 'network', error };
      dropLocal();
      const remote = remoteOf(await pending);
      return remote && remote.token !== local.token ? useServer(remote) : { ok: false, reason: 'refused', error };
    }
    const remote = remoteOf(await pending);
    if (!remote) { await saveServer(local); return { ok: true, source: 'local' }; }
    if (remote.token !== local.token) {
      // Un autre appareil a enregistré un jeton : on le reprend s'il fonctionne, sinon (révoqué) le jeton qui marche le remplace.
      try { await probe(remote.url, remote.token); saveLocal(remote); }
      catch (error) { if (refused(error)) await saveServer(local); }
    }
    return { ok: true, source: 'local' };
  }
  const remote = remoteOf(await pending);
  return remote ? useServer(remote) : { ok: false, reason: 'none' };
}
