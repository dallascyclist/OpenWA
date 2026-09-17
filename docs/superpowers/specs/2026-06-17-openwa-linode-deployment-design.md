# OpenWA + LibreTranslate — Dedicated Linode VM Deployment

_Design spec. Date: 2026-06-17. Move the WhatsApp group-translation stack off the laptop onto a dedicated cloud VM so it survives laptop reboots and runs unattended._

## Goal

Run OpenWA (API + dashboard) and its LibreTranslate dependency as a self-contained docker-compose stack on a dedicated Linode VM, reachable only from the dev network's static IP, surviving VM reboots, with the existing WhatsApp session and translation state carried over. This is a personal, time-boxed project (expected spin-down in a few months).

## Target VM (already provisioned)

- Host: `45.33.120.227` / `openwa.dldavis.com`, root SSH ready (keys in laptop `~/.ssh`).
- Ubuntu 24.04.4 LTS, x86_64, **2 vCPU / 3.8 GiB RAM / 79 GB disk** (72 GB free), swap 495 MiB.
- Docker **not installed**; `git` present; `ufw` present but inactive; `/opt` empty.

## Sizing (validated empirically)

Measured on the laptop: OpenWA's node ~36 MB; its Puppeteer Chromium ~0.4–0.7 GB. LibreTranslate's 3.8 GB came entirely from loading all ~50 languages — a throwaway instance limited to the target set measured **255 MB idle / ~935 MB under active translation**, with ~931 MB of models on disk. Simplified Chinese (`zh-Hans`) is marginally smaller than Traditional.

| Component (1 session, active) | RAM |
|---|---|
| Ubuntu + Docker | ~0.8 GB |
| `openwa-api` (node + Chromium) | ~0.7 GB |
| `dashboard` (nginx static) | ~0.05 GB |
| `libretranslate` (`en,es,ru,zh-Hans`) | ~0.95 GB |
| **Total** | **~2.5 GB** |

The 4 GB plan (3.8 GiB usable) leaves ~1.3 GB free; a **2 GB swapfile** absorbs Chromium spikes. Disk use ~12–15 GB of 79. 2 vCPU is adequate for one chat's translation volume. **No upsize needed.**

## Architecture

Single `docker compose` stack, all services `restart: unless-stopped`, on the repo's `openwa-network`:

- **`openwa-api`** — built from the repo `Dockerfile`. `DATABASE_TYPE=sqlite`, `STORAGE_TYPE=local`. Deployed from the **`feat/whatsapp-translation-plugin`** branch (PR #300 head — includes the Phase-2 sender-attribution resilience fix and `onConfigChange` live-config). Exposed on `127.0.0.1`-style binding gated by firewall (see Networking).
- **`dashboard`** — repo `with-dashboard` profile, built from `dashboard/Dockerfile` (the **standalone** nginx variant, which proxies `/api` + `/socket.io` to the backend itself; the repo's separate `dashboard/Dockerfile.traefik` is the traefik-fronted variant we are *not* using). ~50 MB. Used for login, QR scan, plugin/session management. Host-published on the firewalled port.
- **`libretranslate`** (new service, not in the repo compose) — `libretranslate/libretranslate`, `LT_LOAD_ONLY=en,es,ru,zh-Hans`, models on a persistent bind mount. Reached internally at `http://libretranslate:5000`.

**Not activated** (unneeded for SQLite + local single-session): `traefik`, `postgres`, `redis`, `minio` — their profiles simply aren't passed to `docker compose`. **`docker-proxy` is kept** (it's a core/auto-start service that `openwa-api` hard-`depends_on`; ~20 MB, socket mounted read-only on an isolated internal network per the repo's hardening) — fighting that dependency is more fragile than keeping the tiny proxy; the Infrastructure page is simply unused. The dashboard is built from the standalone `dashboard/Dockerfile` (its `nginx.conf` proxies `/api/` + `/socket.io/` to `openwa-api:2785`), so **only port `2886` is published** dev-facing; `openwa-api` stays on its localhost-only `2785` bind and is reached either over the compose network or via the dashboard's `/api` proxy. **No Caddy/TLS layer** (accepted risk: single BGP hop to Linode, provider owns the hardware, personal time-boxed project).

The repo `docker-compose.yml` is **not modified**; a local **`docker-compose.override.yml`** adds `libretranslate`, repoints the `openwa-data` volume to a `/opt` bind mount, and selects the `with-dashboard` profile.

**Plugin → LibreTranslate wiring:** the translation plugin defaults to `http://localhost:7001`, which is wrong inside the compose network. After first boot, set `libretranslateUrl=http://libretranslate:5000` via `PUT /api/plugins/translation/config` (persisted; `onConfigChange` applies it live). Verify it survives a restart.

## Filesystem layout (`/opt` convention)

Everything lives under `/opt`; system config files are canonical in `/opt/etc/...` and symlinked from their real locations (e.g. `/etc/...`), matching the operator's standard.

```
/opt/openwa/                      # git checkout (feat/whatsapp-translation-plugin)
/opt/openwa/docker-compose.override.yml
/opt/openwa/.env                  # API_MASTER_KEY etc. (0600)
/opt/openwa/data/                 # bind mount -> container /app/data (sessions, sqlite, plugins, media)
/opt/openwa/lt-models/            # bind mount -> LibreTranslate models
/opt/swapfile                     # 2 GB; referenced from /etc/fstab
/opt/etc/sysctl.d/99-openwa.conf  # only if tuning is needed; symlink <- /etc/sysctl.d/99-openwa.conf
/opt/etc/docker/daemon.json       # only if Docker data-root is relocated; symlink <- /etc/docker/daemon.json
```

Docker's data-root stays default (`/var/lib/docker`, same disk) unless we choose to relocate it under `/opt` — optional; called out in the plan, default is "leave it."

## Data migration (preserve the session, fall back to re-scan)

1. On the laptop, stop writers (or snapshot) and `tar` `data/` — `sessions/` (LocalAuth/Chromium profile), `openwa.sqlite`, `plugins/` (translation group state), `.api-key`, `media/`.
2. `scp` to the VM, extract into `/opt/openwa/data/` with correct ownership for the container's `openwa` uid.
3. `docker compose up -d`; watch logs. If WhatsApp resumes the copied session → done. If it rejects it cross-arch (mac arm64 → linux x64) → scan the QR once in the dashboard. Group/translation state and the API key carry over regardless.

## Networking & security

- **Linode Cloud Firewall + host `ufw`**, both: inbound allowed only from `47.190.78.199/32`, only on `22` (SSH) and `2886` (dashboard, which also proxies `/api`); default-deny all other inbound. (`2785` is not published dev-facing; reach the API via `…:2886/api/...`.) Egress open (WhatsApp Web, image pulls, model downloads, webhooks). `ufw` is the enforced layer; the Linode Cloud Firewall is documented as a manual UI step (defense-in-depth).
- `API_MASTER_KEY` set in `/opt/openwa/.env` (migrated from `data/.api-key`) as defense-in-depth behind the allowlist.
- No TLS (accepted): API key + dashboard login + message content cross the internet in cleartext between the allowed IP and the VM.

## Backups & reboot survival

- `systemctl enable docker` + `restart: unless-stopped` → the stack auto-starts on VM boot. Laptop reboots are irrelevant; VM reboots self-heal.
- Nightly `cron` `tar` of `/opt/openwa/data` (~200 MB) to a timestamped archive with N-day retention; optional off-box copy. Linode's backup add-on optional.

## Validation (done-criteria)

- From `47.190.78.199`: dashboard loads at `http://45.33.120.227:2886`, API via `…:2886/api/docs` → 200; from any other IP: refused.
- Session shows connected (resumed or re-scanned); a Spanish/Russian/Chinese test message round-trips a translation (LibreTranslate reachable at `libretranslate:5000`).
- `docker compose restart` and a full VM `reboot` both bring the stack back automatically.
- `free -h` shows headroom (~1+ GB free) under active translation.

## Out of scope

TLS/Caddy; postgres/redis/minio; docker-proxy/traefik/Infrastructure page; the #303 dashboard config-form; multi-session scaling; using the VM for other development; reboot-survivable model auto-refresh beyond `LT_LOAD_ONLY`.

## Risks / notes

- Cross-arch LocalAuth migration may force a one-time QR re-scan (mitigated: fallback is trivial).
- Plaintext-over-internet accepted by the operator for this time-boxed personal project.
- If the dev-network static exit IP changes, update both firewalls.
- VM hostname is currently `localhost`; optionally set to `openwa` (cosmetic).
- **Verify in the plan (no-traefik standalone routing):** confirm `dashboard/Dockerfile`'s nginx proxies `/api` + `/socket.io` to `openwa-api:2785` without traefik (the existence of a separate `Dockerfile.traefik` strongly implies the plain one is standalone); if not, add a minimal nginx proxy snippet or fall back to including traefik. Also confirm `openwa-api` boots cleanly with `docker-proxy` excluded and `DOCKER_HOST` unset.
- Deploy source is the fork `dallascyclist/OpenWA`, branch `feat/whatsapp-translation-plugin` (PR #300 head, carries the Phase-2 resilience fix). The `data/.env.generated` / dashboard config-form (#303) is absent; LibreTranslate URL is set via the config API, not the UI.
