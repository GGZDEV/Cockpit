# God’s Eye View

Cockpit links to `/godseye.html` (original application in an iframe) and
`/godseye-app.html` (full screen). Both use Cockpit's existing authentication.
The globe is unloaded when leaving the page, so it does not run in the dashboard
background. Root-relative assets and API calls are routed by `godseye.cjs` only
in server mode with `COCKPIT_GODSEYE_PORT` set. Existing Cockpit API routes take
precedence. Cookies and Authorization are never forwarded to the backend.
Provider settings are accessible through the authenticated « Clés API » link.
Only admitted setup status/keys calls are adapted to upstream loopback;
Cockpit retains authentication and same-origin checks on API writes.
Read-only app navigation accepts external links after authentication.

## Host installation

- Official upstream: <https://github.com/bilawalsidhu/gods-eye-view>
- Checkout: `/home/openclaw/services/gods-eye-view`
- Node: `/home/openclaw/.openclaw/tools/node-v24.19.0/bin`
- Install locked dependencies with `PUPPETEER_SKIP_DOWNLOAD=1 npm ci`.
- Build: `npm run build`. Run the upstream Vite **preview** server, not just a
  static file server: its middleware provides the live-data APIs.
- User service `godseye.service` binds **127.0.0.1:4173 only**, starts at boot,
  restarts on exit, and sets `GEV_ALLOWED_HOSTS=cockpit.ggz.ovh` and
  `GEV_EMBED_FRAME_ANCESTORS='self'`. The proxy permits same-origin framing of
  the app document only. It deliberately does not use `?embed=1`, which hides
  the original controls. Other CSP directives remain unchanged.
- `cockpit-web.service.d/godseye.conf` sets `COCKPIT_GODSEYE_PORT=4173`.
- No provider keys configured and no paid functions enabled by installation.

For upstream updates, inspect changes, install from lockfile, rebuild, restart
`godseye.service`, and verify assets/API routes and iframe. Preserve its `.env`
and runtime cache if keys are configured later. Root-relative upstream public
namespaces may change: update the explicit allowlist if necessary.

Rollback: remove the Cockpit service drop-in and restart Cockpit; stop/disable
`godseye.service`. No project/task data or HA/session files are changed.

## Other exploration apps (2026-11-11)

- `/worldmonitor.html` now opens the full self-hosted application at
  `https://worldmonitor.ggz.ovh`, protected by Cockpit authentication.
  The initial limited official embed was rejected by the user and replaced.
  See `deploy/worldmonitor/README.md` for the full deployment.
- Radio opens OpenRadio via `/openradio.html` (CO-40, replaces Radio Garden):
  self-hosted origin when `COCKPIT_OPENRADIO_HOST` is set, otherwise the public
  `https://openradio.space/`. See `deploy/openradio/README.md`. Saved docks still
  pointing to `https://radio.garden/` are migrated.
- Shell navigation exposes these alongside God's Eye. They run only on navigation;
  the main dashboard does not pre-load the map or start radio playback.
- CT104 rootfs expanded online from 20 GiB to 40 GiB; config backup on Proxmox:
  `/root/ct104-before-disk-20261111.conf`. CT113 Deployer remains 8 GiB with ~6.7 GiB
  free at installation. Deployer orchestrates publication; a custom deployment
  recipe may target another host (Cockpit itself targets CT104).
