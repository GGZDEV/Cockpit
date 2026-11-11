# World Monitor full self-host (2026-11-11)

- Upstream AGPL-3.0: https://github.com/koala73/worldmonitor, pinned `v2.11.8`.
- Dedicated unprivileged Proxmox CT114, `192.168.1.237`, 2 CPUs, 3 GiB RAM,
  1 GiB swap, 24 GiB disk. Do not add this workload to OpenClaw/CT104.
- Source `/opt/worldmonitor`, host-specific config/logs `/opt/worldmonitor-host`.
- Full UI + local API, Redis, Redis REST, AIS/public-data relay. Optional paid
  providers and the selfhost paid cloud relay remain unconfigured/disabled.
- Dockerfile here derives from upstream's root Dockerfile, reusing its locked
  dependencies and API compiler. It builds the UI with `VITE_WS_API_URL=""` to
  use local APIs. The stock GHCR frontend sets a vendor-cloud API URL; do not
  substitute it without checking custom-origin CORS and data availability.
- Runtime compose uses upstream `docker-compose.yml` + local override for the
  Dockerfile, memory/CPU bounds and log rotation. Runtime secrets are generated
  only on CT114 in `/opt/worldmonitor/.env` (0600), never in Git.
- Access: https://worldmonitor.ggz.ovh. NPM forwards to Cockpit's authenticated
  web server, which admits the exact configured Host and routes its entire
  namespace to CT114. Host isolation prevents root-relative assets and `/api/`
  from colliding with Cockpit/God's Eye. Cockpit credentials are not forwarded.
- Env (merge, preserve existing config):
  `COCKPIT_WORLDMONITOR_HOST=worldmonitor.ggz.ovh`,
  `COCKPIT_WORLDMONITOR_UPSTREAM=http://192.168.1.237:3000`, append hostname to
  `COCKPIT_ALLOWED_HOSTS`. Pre-change web.env backup is in the same config dir.
- Cockpit `/worldmonitor.html` opens the full dedicated origin. It may ask once
  for the same Cockpit password because its session cookie is host-only.
- Deployer CT113 stores `worldmonitor` as a manual, pinned custom recipe.
  Its SSH key on CT114 is restricted to `update.sh`, not a general root shell.
  Bootstrap/build runs directly on CT114. The recipe restarts built images and
  verifies health; upgrades require choosing/building a new pinned version.
- No subscription, LLM key, API charge or provider entitlement is included.
  Full software is not a promise that all third-party data is available.
- `worldmonitor-seeds.timer` refreshes selected free datasets every 10 minutes:
  earthquakes, weather alerts, military bases, prediction markets and market
  quotes. It uses a pinned builder image `worldmonitor:seeders` with the upstream
  scripts and a private `/opt/worldmonitor-host/seed.env`, generated from the
  local Redis token (0600). Each source has a 90-second cap. Optional unavailable
  providers are logged rather than stopping every later source.
- Deployment image: `worldmonitor:local-api`; compose override points to
  `/opt/worldmonitor-host/Dockerfile.local-api`. Build commands run outside the
  low-memory Deployer container, on CT114; runtime restarts are delegated.

## Verified delivery

- Public-origin authenticated browser: settings modal and Panels tab open;
  the full layer/time-range/region controls are present, unlike the old embed.
- Same-browser real requests: `/api/bootstrap?keys=earthquakes,weatherAlerts,marketQuotes`
  returns 200 with real earthquake data; `/api/news/v1/list-feed-digest?variant=full&lang=en`
  returns 200 with current source articles. Anonymous WM session mint succeeds.
  Initial bootstrap 401 responses before session mint are retried by the app.
- Four Docker services running; app and relay healthchecks healthy. Combined
  observed runtime RAM ~340 MiB; CT114 ~6.4 GiB used / ~16 GiB free.
- Deployer run `d-20261111-200421-3934` succeeded at pinned source commit
  `de602d000d9e10e7da651884bb589d2ad55f3593`. The recipe's branch is `main`
  (Deployer resolves branches as `origin/<branch>` and clones without tags).
  For manual reruns send this exact commit in `ref`, not the tag name.
- Do not silently substitute the keyless vendor map embed for this full app.
  Pro/third-party entitlements remain separate; no API keys/subscription added.
