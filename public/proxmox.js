import { roomModel } from './rooms.js';
  const PVE_RE = /proxmox|(^|[._ ])pve([._ ]|$)/i;
  function fmtDur(sec) {
    if (sec == null || !isFinite(sec) || sec < 0) return '';
    const d = Math.floor(sec / 86400), h = Math.floor((sec % 86400) / 3600), mn = Math.floor((sec % 3600) / 60);
    return d ? d + ' j ' + h + ' h' : h ? h + ' h ' + mn + ' min' : mn + ' min';
  }
export function proxmoxModel(sources) {
    const model=roomModel(sources), app={index:model.index,states:model.states}, M=HD.Model;
    const idx = app.index;
    const empty = { nodes: [], guests: [], storage: [] };
    if (!idx || !idx.reg) return empty;
    const groups = new Map();
    for (const st of app.states.values()) {
      const r = idx.reg.get(st.entity_id) || {};
      if (r.disabled_by || !['sensor', 'binary_sensor', 'button', 'switch'].includes(M.domainOf(st.entity_id))) continue;
      const dev = r.device_id ? idx.devices.get(r.device_id) : null;
      const hay = (r.platform || '') + ' ' + st.entity_id + ' ' + (dev ? (dev.manufacturer || '') + ' ' + (dev.model || '') : '');
      if (!PVE_RE.test(hay)) continue;
      const key = r.device_id || st.entity_id.split('.')[1].replace(/_(cpu|memory|mem|disk|status|uptime|network|net|start|stop|shutdown|reboot|restart|swap|health|state)(_.*)?$/, '');
      if (!groups.has(key)) groups.set(key, { id: key, dev, ents: [] });
      groups.get(key).ents.push(st);
    }
    const out = { nodes: [], guests: [], storage: [] };
    for (const g of groups.values()) {
      const rawName = g.dev ? g.dev.name_by_user || g.dev.name || '' : g.id.replace(/_/g, ' ');
      const model = g.dev ? g.dev.model || '' : '';
      const txt = (rawName + ' ' + model).toLowerCase();
      const kind = /lxc|container|conteneur/.test(txt) ? 'lxc' : /qemu|virtual|\bvm\b|machine/.test(txt) ? 'qemu' : /storage|stockage/.test(txt) ? 'storage' : 'node';
      const vm = rawName.match(/\((\d{2,})\)/) || rawName.match(/\b(\d{3,})\b/);
      const name = rawName.replace(/^(node|nœud|vm|qemu|lxc|ct|storage|stockage)\s*:?\s*/i, '').replace(/\s*\(\d{2,}\)\s*/, ' ').replace(/^\d{3,}\s+/, '').trim() || rawName;
      const hayOf = (s) => (s.entity_id + ' ' + ((idx.reg.get(s.entity_id) || {}).translation_key || '') + ' ' + (s.attributes.friendly_name || '')).toLowerCase();
      const sensors = g.ents.filter((s) => M.domainOf(s.entity_id) === 'sensor');
      const pct = (s) => s.attributes.unit_of_measurement === '%';
      const find = (re, pred) => sensors.find((s) => re.test(hayOf(s)) && (!pred || pred(s)));
      const num = (s) => { if (!s || !M.isAvail(s)) return null; const v = Number(s.state); return isFinite(v) ? v : null; };
      const cpu = num(find(/cpu/, pct));
      const memUsedS = find(/(mem|ram).*(used|utilis)|(used|utilis).*(mem|ram)/, (s) => !pct(s));
      const memTotS = find(/(mem|ram).*(total|max)|(total|max).*(mem|ram)/, (s) => !pct(s));
      let mem = num(find(/mem|ram/, (s) => pct(s) && !/swap|free|libre/.test(hayOf(s))));
      const memUsed = num(memUsedS), memTotal = num(memTotS);
      if (mem == null && memUsed != null && memTotal) mem = (memUsed / memTotal) * 100;
      const disk = num(find(/disk|rootfs|storage|stockage|used/, (s) => pct(s) && !/swap|mem|ram|cpu/.test(hayOf(s))));
      const upS = find(/uptime|durée|en ligne depuis/);
      let uptime = '';
      if (upS && M.isAvail(upS)) {
        if (upS.attributes.device_class === 'timestamp') uptime = fmtDur((Date.now() - Date.parse(upS.state)) / 1000);
        else {
          const u = upS.attributes.unit_of_measurement || 's';
          const mult = { s: 1, min: 60, h: 3600, d: 86400, j: 86400 }[u] || 1;
          uptime = fmtDur(Number(upS.state) * mult);
        }
      }
      const rate = (s) => (s && M.isAvail(s) ? M.fmtNum(Number(s.state), 1) + ' ' + (s.attributes.unit_of_measurement || '') : '');
      const netIn = rate(find(/network_in|net_?in|in_rate|download|reçu|entrant/));
      const netOut = rate(find(/network_out|net_?out|out_rate|upload|envoy|sortant/));
      const statusS = g.ents.find((s) => M.domainOf(s.entity_id) === 'binary_sensor' && (/status|running|state|etat|état/.test(hayOf(s)) || s.attributes.device_class === 'running'))
        || sensors.find((s) => /status|state|etat|état/.test(hayOf(s)) && !/%/.test(s.attributes.unit_of_measurement || ''));
      let running;
      if (statusS) running = statusS.state === 'on' || /running|online|en marche|started/i.test(statusS.state);
      else running = cpu != null;
      const buttons = {};
      for (const s of g.ents) {
        if (M.domainOf(s.entity_id) !== 'button') continue;
        const h = hayOf(s);
        if (/reboot|restart|redémarr/.test(h)) buttons.reboot = s.entity_id;
        else if (/shutdown|éteindre|arrêt propre/.test(h)) buttons.shutdown = s.entity_id;
        else if (/(^|[._ ])stop|arrêter/.test(h)) buttons.stop = s.entity_id;
        else if (/(^|[._ ])start|démarr/.test(h)) buttons.start = s.entity_id;
      }
      const memUnit = (memTotS && memTotS.attributes.unit_of_measurement) || (memUsedS && memUsedS.attributes.unit_of_measurement) || '';
      const item = { id: g.id, name, kind, vmid: vm ? vm[1] : '', cpu, mem, memUsed, memTotal, memUnit, disk, uptime, netIn, netOut, running, online: statusS ? running : true, buttons };
      if (kind === 'storage') {
        const p = disk != null ? disk : num(find(/./, pct));
        out.storage.push({ name, pct: p, sub: memUsed != null && memTotal ? '' : '' });
      } else if (kind === 'node') { if (cpu != null || mem != null || disk != null || statusS) out.nodes.push(item); }
      else out.guests.push(item);
    }
    return out;
  }
