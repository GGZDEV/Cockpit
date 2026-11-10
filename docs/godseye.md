# God’s Eye View

Cockpit links to `/godseye.html` (original application in an iframe) and
`/godseye-app.html` (full screen). Both use Cockpit's existing authentication.
The globe is unloaded when leaving the page, so it does not run in the dashboard
background. Root-relative assets and API calls are routed by `godseye.cjs` only
in server mode with `COCKPIT_GODSEYE_PORT` set. Existing Cockpit API routes take
precedence. Cookies and Authorization are never forwarded to the backend.
Provider key management is deliberately unavailable through this proxy.

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
