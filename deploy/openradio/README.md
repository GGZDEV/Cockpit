# OpenRadio self-host (CO-40, 2026-11-12)

Replaces the Radio Garden link. Status: **prepared in Cockpit, not yet installed**.
Until `COCKPIT_OPENRADIO_HOST` is set, `/openradio.html` redirects to the public
site `https://openradio.space/`; once set, it opens the self-hosted origin.

- Upstream MIT: https://github.com/raj-khan/openradio. No tags/releases; pin the
  commit `ed1f398fdc5b0eeba7c591d25856f6f2c9af6695` (main, 2026-10-19).
- Next.js 16 server app (`next build` / `next start`, Node >= 20.9). No database:
  favourites and history stay in the browser. Station data comes from the public
  Radio Browser API; streams play directly from each station in the browser.
- Planned host: CT114 (`192.168.1.237`, already runs World Monitor in Docker),
  container `openradio`, port `3100`, 512 MiB / 1 CPU cap. Do not add it to
  OpenClaw/CT104. Another host works: adjust the upstream and `update.sh`.
- Source `/opt/openradio` (pinned checkout), host files `/opt/openradio-host`
  (`Dockerfile`, `docker-compose.yml`, `update.sh` from this folder).
- No AI key (`/discover` falls back to keyword parsing), no GoatCounter/GA,
  no search-console verification.
- Access: `https://openradio.ggz.ovh`. NPM forwards to Cockpit's authenticated web
  server, which admits the exact configured Host and proxies the whole namespace
  to CT114 (`hosted-apps.cjs`, shared with World Monitor). Cockpit credentials
  are not forwarded. It may ask once for the Cockpit password (host-only cookie).

## Installation (manual, on CT114 then on CT104)

1. CT114:
   ```sh
   git clone https://github.com/raj-khan/openradio /opt/openradio
   git -C /opt/openradio checkout ed1f398fdc5b0eeba7c591d25856f6f2c9af6695
   mkdir -p /opt/openradio-host   # copy Dockerfile, docker-compose.yml, update.sh here
   docker build -f /opt/openradio-host/Dockerfile -t openradio:local /opt/openradio
   sh /opt/openradio-host/update.sh
   ```
2. DNS `openradio.ggz.ovh` + NPM proxy host to Cockpit (same as World Monitor).
3. Cockpit `~/.config/cockpit/web.env` (merge, keep existing values):
   `COCKPIT_OPENRADIO_HOST=openradio.ggz.ovh`,
   `COCKPIT_OPENRADIO_UPSTREAM=http://192.168.1.237:3100`, append the hostname
   to `COCKPIT_ALLOWED_HOSTS`, then restart `cockpit-web`.
4. Optional Deployer recipe: like World Monitor, an SSH key restricted to
   `update.sh` (`deploy` / `rollback`); builds run on CT114.

Upgrade: checkout a new pinned commit, rebuild `openradio:local`, run `update.sh`.
