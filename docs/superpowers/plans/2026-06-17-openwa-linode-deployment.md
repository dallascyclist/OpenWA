# OpenWA + LibreTranslate Linode Deployment Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax. This is an **infrastructure** plan: each task ends with a **verification command + expected output** instead of a unit test, and there are no in-repo git commits (artifacts live on the VM). Several steps require the **operator** (Doug): scanning a QR if the session doesn't resume, applying the Linode Cloud Firewall in the UI, and sending a live test message.

**Goal:** Run the OpenWA WhatsApp group-translation gateway + LibreTranslate as a self-contained docker-compose stack on a dedicated Linode VM, reachable only from the dev network's static IP, surviving VM reboots, with the existing session and translation state migrated from the laptop.

**Architecture:** Single `docker compose` project at `/opt/openwa` (a checkout of the fork branch). Core services `docker-proxy` + `openwa-api` auto-start; a thin `docker-compose.override.yml` adds `libretranslate`, builds the dashboard from its standalone `Dockerfile`, publishes only `2886`, and repoints the data volume to a `/opt` bind mount. SQLite + local storage; no postgres/redis/minio/traefik. `ufw` enforces the IP allowlist; `restart: unless-stopped` + `systemctl enable docker` give reboot survival.

**Tech Stack:** Ubuntu 24.04.4 LTS (x86_64), Docker CE + compose plugin, the repo's `Dockerfile`/`dashboard/Dockerfile`, `libretranslate/libretranslate`.

## Global Constraints

- VM: `root@45.33.120.227` (`openwa.dldavis.com`), Ubuntu 24.04.4 LTS x86_64, 2 vCPU / 3.8 GiB / 79 GB. SSH keys already on the laptop.
- Everything under `/opt`; system config files are canonical in `/opt/etc/...` and symlinked from `/etc/...` (per operator convention).
- LibreTranslate languages **exactly** `LT_LOAD_ONLY=en,es,ru,zh-Hans` (Simplified Chinese).
- Deploy source: fork `https://github.com/dallascyclist/OpenWA.git`, branch `feat/whatsapp-translation-plugin` (PR #300 head — carries the Phase-2 resilience fix).
- Access: inbound only from `47.190.78.199/32`, on `22` (SSH) + `2886` (dashboard, which proxies `/api`). **No TLS.**
- `docker-proxy` is kept (core; `openwa-api` hard-depends on it); traefik/postgres/redis/minio profiles are **not** activated.
- Plugin → LibreTranslate URL is set via `PUT /api/plugins/translation/config` (not the UI; #303 form is absent on this branch).
- Cutover sequencing: the laptop OpenWA instance MUST be stopped before the VM brings up the copied session (one WhatsApp linked-device instance at a time).
- `API_MASTER_KEY` comes from the laptop's `data/.api-key` (keeps the key stable); never paste the secret into this plan or any committed file.

---

### Task 1: VM system prep (Docker, swap, /opt)

**Files:** none committed. Creates `/opt/swapfile`, `/opt/openwa/...`, Docker apt repo.

**Interfaces:**
- Produces: Docker CE + compose plugin running and enabled at boot; a 2 GB swapfile; the `/opt/openwa/{data,lt-models,backups}` + `/opt/etc/cron.d` directories.

- [ ] **Step 1: SSH in and install Docker CE + compose plugin**

Run (on the laptop, into the VM):
```bash
ssh root@45.33.120.227 'bash -s' <<'EOF'
set -e
apt-get update
apt-get install -y ca-certificates curl
install -m 0755 -d /etc/apt/keyrings
curl -fsSL https://download.docker.com/linux/ubuntu/gpg -o /etc/apt/keyrings/docker.asc
chmod a+r /etc/apt/keyrings/docker.asc
echo "deb [arch=$(dpkg --print-architecture) signed-by=/etc/apt/keyrings/docker.asc] https://download.docker.com/linux/ubuntu $(. /etc/os-release && echo $VERSION_CODENAME) stable" > /etc/apt/sources.list.d/docker.list
apt-get update
apt-get install -y docker-ce docker-ce-cli containerd.io docker-buildx-plugin docker-compose-plugin
systemctl enable --now docker
EOF
```

- [ ] **Step 2: Verify Docker works and is enabled at boot**

Run:
```bash
ssh root@45.33.120.227 'docker run --rm hello-world | grep -q "working correctly" && docker compose version && systemctl is-enabled docker'
```
Expected: the `hello-world` success line is matched, `Docker Compose version v2.x`, and `enabled`.

- [ ] **Step 3: Create a 2 GB swapfile under /opt and persist it**

Run:
```bash
ssh root@45.33.120.227 'bash -s' <<'EOF'
set -e
if ! swapon --show=NAME --noheadings | grep -q /opt/swapfile; then
  fallocate -l 2G /opt/swapfile || dd if=/dev/zero of=/opt/swapfile bs=1M count=2048
  chmod 600 /opt/swapfile
  mkswap /opt/swapfile
  swapon /opt/swapfile
fi
grep -q '/opt/swapfile' /etc/fstab || echo '/opt/swapfile none swap sw 0 0' >> /etc/fstab
EOF
```

- [ ] **Step 4: Verify swap is active (~2 GB total)**

Run: `ssh root@45.33.120.227 'swapon --show && free -h | awk "/Swap/{print}"'`
Expected: `/opt/swapfile` listed at 2G; `free` Swap total ≈ 2.4Gi (2 GB file + the pre-existing 495 MiB).

- [ ] **Step 5: Create the /opt directory layout (and chown the LT model dir)**

The LibreTranslate image runs as `uid=1032(libretranslate):gid=65534(nogroup)` and writes models under its bind mount; the dir must be owned by that uid or LT crash-loops with `PermissionError: .../argos-translate/packages`.

Run: `ssh root@45.33.120.227 'mkdir -p /opt/openwa/data /opt/openwa/lt-models /opt/openwa/backups /opt/etc/cron.d && chown -R 1032:65534 /opt/openwa/lt-models && ls -ld /opt/openwa /opt/openwa/data /opt/openwa/lt-models /opt/openwa/backups /opt/etc/cron.d'`
Expected: all five directories listed; `lt-models` owned by `1032 65534`.

---

### Task 2: Host firewall (ufw) — IP allowlist

**Files:** `ufw` rules (managed by ufw in `/etc/ufw`).

**Interfaces:**
- Consumes: SSH access from Task 1.
- Produces: `ufw` active, default-deny inbound, allow `22` + `2886` only from `47.190.78.199/32`.

- [ ] **Step 1: Confirm the SSH source IP matches the allowlist (lockout safety)**

Run: `ssh root@45.33.120.227 'echo $SSH_CLIENT'`
Expected: the first field is `47.190.78.199`. **If it is not, stop** — use the actual address shown in every rule below, or you will lock yourself out.

- [ ] **Step 2: Apply ufw rules and enable**

Run:
```bash
ssh root@45.33.120.227 'bash -s' <<'EOF'
set -e
ufw default deny incoming
ufw default allow outgoing
ufw allow from 47.190.78.199/32 to any port 22 proto tcp
ufw allow from 47.190.78.199/32 to any port 2886 proto tcp
ufw --force enable
EOF
```

- [ ] **Step 3: Verify rules and that SSH still works**

Run: `ssh root@45.33.120.227 'ufw status verbose | grep -E "Status|22|2886|deny \(incoming\)"'`
Expected: `Status: active`, default `deny (incoming)`, and ALLOW rules for `22` and `2886` from `47.190.78.199`. (The fact this SSH command returned proves you are not locked out.)

- [ ] **Step 4 (operator): Mirror the rules in the Linode Cloud Firewall**

Doug: in the Linode UI (or `linode-cli`), attach a Cloud Firewall to this VM with inbound ACCEPT for TCP `22` and `2886` from `47.190.78.199/32`, default DROP inbound, ACCEPT all outbound. This is defense-in-depth; `ufw` already enforces it. No automated verification — confirm in the UI.

---

### Task 3: Deploy artifacts + smoke-boot (empty data)

**Files:**
- Create on VM: `/opt/openwa` (git checkout), `/opt/openwa/docker-compose.override.yml`, `/opt/openwa/.env`

**Interfaces:**
- Consumes: Docker (Task 1).
- Produces: a built, bootable stack; validates the no-traefik dashboard `/api` proxy and that `openwa-api` + `libretranslate` come up healthy, BEFORE the real session is migrated.

- [ ] **Step 1: Clone the fork branch into /opt/openwa**

The data dirs from Task 1 are siblings created earlier; clone into the same root (git clones into an existing dir if it only contains ignored/extra dirs — to be safe, clone then move data dirs in, or clone to a temp and rsync). Use this order:
```bash
ssh root@45.33.120.227 'bash -s' <<'EOF'
set -e
# /opt/openwa already has data/ lt-models/ backups/; clone needs an empty target, so clone to a temp and move in.
git clone --branch feat/whatsapp-translation-plugin --single-branch https://github.com/dallascyclist/OpenWA.git /opt/openwa-src
shopt -s dotglob
cp -a /opt/openwa-src/* /opt/openwa/
rm -rf /opt/openwa-src
cd /opt/openwa && git rev-parse --abbrev-ref HEAD && git log --oneline -1
EOF
```
Expected: branch `feat/whatsapp-translation-plugin`, HEAD `54c6c1a …` (the resilience commit).

- [ ] **Step 2: Write the compose override**

Run:
```bash
ssh root@45.33.120.227 "cat > /opt/openwa/docker-compose.override.yml" <<'EOF'
# Local deployment override — NOT committed upstream.
services:
  # Dashboard: use the STANDALONE Dockerfile (its nginx.conf proxies /api + /socket.io
  # to openwa-api:2785), and publish it dev-facing (ufw restricts the source IP).
  dashboard:
    build:
      dockerfile: Dockerfile
    ports:
      - "0.0.0.0:2886:80"

  # LibreTranslate — the translation plugin's backend, restricted to the 4 languages.
  libretranslate:
    image: libretranslate/libretranslate
    container_name: openwa-libretranslate
    restart: unless-stopped
    networks:
      - openwa-network
    environment:
      - LT_LOAD_ONLY=en,es,ru,zh-Hans
      - LT_UPDATE_MODELS=false
    volumes:
      - /opt/openwa/lt-models:/home/libretranslate/.local/share/argos-translate

# Repoint the named volume the openwa-api service mounts at /app/data to a /opt bind mount.
volumes:
  openwa-data:
    driver: local
    driver_opts:
      type: none
      o: bind
      device: /opt/openwa/data
EOF
```

- [ ] **Step 3: Write the .env (placeholder key for the smoke test)**

Run:
```bash
ssh root@45.33.120.227 "umask 077; cat > /opt/openwa/.env" <<'EOF'
NODE_ENV=production
LOG_LEVEL=info
# Smoke-test placeholder; replaced with the migrated key in Task 4.
API_MASTER_KEY=smoketest-temporary-key
EOF
```

- [ ] **Step 4: Confirm the dashboard standalone nginx proxies /api (flagged verification)**

Run: `ssh root@45.33.120.227 'grep -E "proxy_pass|/api|/socket.io" /opt/openwa/dashboard/nginx.conf'`
Expected: `location /api/` and `location /socket.io/` both `proxy_pass http://openwa-api:2785;`. (Confirms traefik isn't needed.)

- [ ] **Step 5: Render the effective config and confirm the intended services only**

Run: `ssh root@45.33.120.227 'cd /opt/openwa && docker compose --profile with-dashboard config --services | sort'`
Expected: exactly `dashboard`, `docker-proxy`, `libretranslate`, `openwa-api` (no postgres/redis/minio/traefik).

- [ ] **Step 6: Build + boot the stack with EMPTY data (smoke test)**

Run:
```bash
ssh root@45.33.120.227 'cd /opt/openwa && docker compose --profile with-dashboard up -d --build'
```
Then wait for readiness and check (LibreTranslate model download can take a few minutes):
```bash
ssh root@45.33.120.227 'cd /opt/openwa && for i in $(seq 1 60); do curl -fsS -o /dev/null http://localhost:2886/api/health/ready && break; sleep 5; done; docker compose --profile with-dashboard ps'
```
Expected: all four services `Up`; the health curl (through the dashboard `/api` proxy) eventually succeeds.

- [ ] **Step 7: Verify openwa-api reaches LibreTranslate over the compose network**

Run:
```bash
ssh root@45.33.120.227 'cd /opt/openwa && docker compose exec -T openwa-api node -e "require(\"http\").get(\"http://libretranslate:5000/languages\",r=>{let d=\"\";r.on(\"data\",c=>d+=c);r.on(\"end\",()=>{console.log(r.statusCode); console.log(d.slice(0,80))})}).on(\"error\",e=>{console.error(e.message);process.exit(1)})"'
```
Expected: `200` then a JSON snippet containing the 4 codes (`en`,`es`,`ru`,`zh-Hans`).

- [ ] **Step 8: Tear down and wipe the smoke-test data (so the real session migrates clean)**

Run:
```bash
ssh root@45.33.120.227 'cd /opt/openwa && docker compose --profile with-dashboard down && rm -rf /opt/openwa/data/* /opt/openwa/data/.[!.]* 2>/dev/null; ls -A /opt/openwa/data'
```
Expected: containers removed; `/opt/openwa/data` empty. (LibreTranslate models in `/opt/openwa/lt-models` are kept.)

---

### Task 4: Cutover + data migration

**Files:** transfers `data/` from the laptop to `/opt/openwa/data` on the VM.

**Interfaces:**
- Consumes: the prepared (empty-data) stack from Task 3.
- Produces: the real session + sqlite + plugin state + API key on the VM; the laptop instance stopped.

- [ ] **Step 1: Stop the laptop OpenWA (free the WhatsApp session, ensure a clean copy)**

Run (on the laptop): `/Users/dougd/OpenWA/OpenWA/scripts/owa.sh stop`
Expected: API + Dashboard report stopped. (The bot is now down until the VM is up — brief.)

- [ ] **Step 2: Tar the laptop data dir**

Run (on the laptop): `tar -czf /tmp/owa-data.tgz -C /Users/dougd/OpenWA/OpenWA data && ls -lh /tmp/owa-data.tgz`
Expected: an archive ~150–200 MB.

- [ ] **Step 3: Copy to the VM and extract into /opt/openwa/data**

Run (on the laptop):
```bash
scp /tmp/owa-data.tgz root@45.33.120.227:/tmp/
ssh root@45.33.120.227 'set -e; tar -xzf /tmp/owa-data.tgz -C /opt/openwa && rm /tmp/owa-data.tgz && ls -A /opt/openwa/data'
```
Expected: `/opt/openwa/data` now contains `sessions`, `openwa.sqlite`, `main.sqlite`, `plugins`, `.api-key` (and `media` if present). (Root ownership is fine — the container entrypoint `chown`s `/app/data` to the `openwa` user on start.)

- [ ] **Step 4: Set the real API_MASTER_KEY in .env from the migrated key**

Run:
```bash
ssh root@45.33.120.227 'bash -s' <<'EOF'
set -e
KEY=$(cat /opt/openwa/data/.api-key)
umask 077
cat > /opt/openwa/.env <<ENV
NODE_ENV=production
LOG_LEVEL=info
API_MASTER_KEY=$KEY
ENV
echo "API_MASTER_KEY set (len=${#KEY})"
EOF
```
Expected: prints a non-zero key length. (Does not print the key.)

---

### Task 5: Bring up, wire LibreTranslate, verify the session + translation

**Interfaces:**
- Consumes: migrated data (Task 4), built images (Task 3).
- Produces: the live, translating gateway on the VM.

- [ ] **Step 1: Start the stack**

Run: `ssh root@45.33.120.227 'cd /opt/openwa && docker compose --profile with-dashboard up -d'`
Then wait for health: `ssh root@45.33.120.227 'cd /opt/openwa && for i in $(seq 1 60); do curl -fsS -o /dev/null http://localhost:2886/api/health/ready && break; sleep 5; done; docker compose --profile with-dashboard ps'`
Expected: all four services `Up`.

- [ ] **Step 2: Point the translation plugin at the in-network LibreTranslate and enable it**

Run:
```bash
ssh root@45.33.120.227 'bash -s' <<'EOF'
set -e
KEY=$(cat /opt/openwa/data/.api-key)
curl -s -X PUT -H "X-API-Key: $KEY" -H "Content-Type: application/json" \
  -d "{\"libretranslateUrl\":\"http://libretranslate:5000\"}" \
  http://localhost:2785/api/plugins/translation/config
echo
curl -s -X POST -H "X-API-Key: $KEY" http://localhost:2785/api/plugins/translation/enable
echo
EOF
```
Expected: the config PUT returns success; enable returns `{"success":true,...}`.

- [ ] **Step 3: Verify the config persisted and the session state**

Run:
```bash
ssh root@45.33.120.227 'KEY=$(cat /opt/openwa/data/.api-key); curl -s -H "X-API-Key: $KEY" http://localhost:2785/api/plugins/translation | head -c 400; echo; docker compose -f /opt/openwa/docker-compose.yml logs --since 5m openwa-api 2>/dev/null | grep -iE "Session ready|QR|authenticated|disconnected" | tail -5'
```
Expected: plugin shows `status: enabled` and config with `libretranslateUrl: http://libretranslate:5000`; logs show either `Session ready` (session resumed) **or** a QR event.

- [ ] **Step 4 (operator if needed): Scan the QR**

If Step 3 shows a QR rather than `Session ready`, Doug opens `http://45.33.120.227:2886` from the dev network, logs in with the API key, and scans the QR from the phone (`14697748333`). Group/translation state is already migrated. Re-run Step 3's log check until `Session ready` appears.

- [ ] **Step 5: Verify dashboard + API reachable from the dev network (not elsewhere)**

Run (on the laptop): `curl -s -o /dev/null -w "%{http_code}\n" http://45.33.120.227:2886/api/health/ready`
Expected: `200`. (Optional negative check: the same curl from any non-allowlisted host times out / is refused.)

- [ ] **Step 6 (operator): Live end-to-end translation check**

Doug sends a Spanish/Russian/Chinese message in the test group (or has Liz send one). Confirm a translation reply appears, and check the log:
Run: `ssh root@45.33.120.227 'docker compose -f /opt/openwa/docker-compose.yml logs --since 3m openwa-api 2>/dev/null | grep -iE "translation_decision|translate decision|translation_backstop" | tail -3'`
Expected: a decision/translation log line, and the reply visible in WhatsApp. Also confirm headroom: `ssh root@45.33.120.227 'free -h | awk "/Mem/{print}"'` shows ≳1 GB free.

---

### Task 6: Backups + reboot survival

**Files:**
- Create on VM: `/opt/openwa/backup.sh`, `/opt/etc/cron.d/openwa-backup` (symlinked to `/etc/cron.d/openwa-backup`)

**Interfaces:**
- Consumes: a running, verified stack.
- Produces: a nightly data backup and confirmed auto-start after reboot.

- [ ] **Step 1: Write the backup script**

Run:
```bash
ssh root@45.33.120.227 "cat > /opt/openwa/backup.sh" <<'EOF'
#!/usr/bin/env bash
# Nightly backup of OpenWA data (sessions + sqlite + plugin state). Keeps 7 days.
set -euo pipefail
BK=/opt/openwa/backups
mkdir -p "$BK"
ts=$(date +%Y%m%d-%H%M%S)
tar -czf "$BK/data-$ts.tar.gz" -C /opt/openwa data
ls -1t "$BK"/data-*.tar.gz | tail -n +8 | xargs -r rm -f
EOF
ssh root@45.33.120.227 'chmod +x /opt/openwa/backup.sh'
```

- [ ] **Step 2: Install the cron entry under /opt and symlink into /etc (operator convention)**

Run:
```bash
ssh root@45.33.120.227 'bash -s' <<'EOF'
set -e
cat > /opt/etc/cron.d/openwa-backup <<CRON
0 4 * * * root /opt/openwa/backup.sh >> /opt/openwa/backups/backup.log 2>&1
CRON
ln -sfn /opt/etc/cron.d/openwa-backup /etc/cron.d/openwa-backup
EOF
```

- [ ] **Step 3: Run the backup once and verify an archive is produced**

Run: `ssh root@45.33.120.227 '/opt/openwa/backup.sh && ls -lh /opt/openwa/backups/data-*.tar.gz | tail -1 && readlink /etc/cron.d/openwa-backup'`
Expected: a `data-<timestamp>.tar.gz` (~150–200 MB) and the symlink resolves to `/opt/etc/cron.d/openwa-backup`.

- [ ] **Step 4: Reboot the VM and confirm the stack auto-starts**

Run:
```bash
ssh root@45.33.120.227 'nohup reboot >/dev/null 2>&1 &' ; sleep 45
ssh -o ConnectTimeout=20 root@45.33.120.227 'cd /opt/openwa && for i in $(seq 1 60); do curl -fsS -o /dev/null http://localhost:2886/api/health/ready && break; sleep 5; done; docker compose --profile with-dashboard ps; docker compose -f docker-compose.yml logs --since 3m openwa-api 2>/dev/null | grep -i "Session ready" | tail -1'
```
Expected: after the reboot, all four services `Up` (via `restart: unless-stopped`) and `Session ready` in the logs — no manual start needed.

- [ ] **Step 5: Final report**

Summarize: services up, dashboard reachable from the dev IP only, session connected, a live translation confirmed, backup + cron in place, reboot survived. Note that after a reboot the stack returns automatically; the laptop is now retired from this role (its `scripts/owa.sh` stays available but unused).

---

## Self-Review

**Spec coverage:**
- VM prep (Docker, swap, /opt) → Task 1 ✓
- IP-allowlist firewall (ufw + Linode CF) → Task 2 ✓
- Stack: openwa-api + dashboard(standalone) + libretranslate; docker-proxy kept; traefik/db/cache/storage not activated; `LT_LOAD_ONLY=en,es,ru,zh-Hans`; `/opt` bind mounts → Task 3 ✓
- Data migration (preserve session, QR fallback) + cutover sequencing → Tasks 4 & 5 ✓
- LibreTranslate URL via config API → Task 5 Step 2 ✓
- No-traefik `/api` proxy verification + LT reachability → Task 3 Steps 4/7 ✓
- Backups + reboot survival → Task 6 ✓
- `/opt`-canonical + `/etc` symlink convention → Task 1 (swapfile/fstab) + Task 6 (cron symlink) ✓
- Validation criteria (dashboard from dev IP, translation round-trip, reboot) → Tasks 5 & 6 ✓
- No TLS, API key from migrated `data/.api-key` → Global Constraints + Task 4 Step 4 ✓

**Placeholder scan:** none — every step has exact commands/file contents. The smoke-test key in Task 3 is an explicit temporary value, replaced in Task 4.

**Consistency:** service set (`dashboard`, `docker-proxy`, `libretranslate`, `openwa-api`) is identical across Tasks 3/5/6; the `openwa-data` bind device (`/opt/openwa/data`), LT model path (`/home/libretranslate/.local/share/argos-translate`), languages (`en,es,ru,zh-Hans`), branch (`feat/whatsapp-translation-plugin`), and ports (`2886` dev-facing, `2785` internal) match the spec throughout. Cutover order (stop laptop → tar → migrate → up) is enforced by Task 4 preceding Task 5.

---

## Execution notes — fixes applied during the real deployment (2026-06-17, COMPLETE & reboot-verified)

The plan above was executed inline; these issues surfaced and were fixed. Fold them into the plan for any redo:

1. **LibreTranslate model dir ownership** (Task 1/3): the `libretranslate/libretranslate` image runs as `uid=1032(libretranslate):gid=65534(nogroup)`; the `/opt/openwa/lt-models` bind mount must be `chown -R 1032:65534` or LT crash-loops with `PermissionError: …/argos-translate/packages`. (Now in Task 1 Step 5.)
2. **`AUTO_START_SESSIONS` not in the repo compose** (Task 5): the compose env list doesn't include it, so authenticated sessions don't auto-relaunch on boot. Added `AUTO_START_SESSIONS=true` to the `openwa-api` service in `docker-compose.override.yml` (required for reboot survival).
3. **Session stalled at `authenticating`** (Task 5): whatsapp-web.js auto-selected an incompatible WA-Web version. Fixed by `WWEBJS_WEB_VERSION=2.3000.1023204257` in `/opt/openwa/.env` (the compose already passes this var). Session then resumed the migrated LocalAuth **without a QR re-scan**.
4. **Config `PUT` body shape** (Task 5): the endpoint expects `{"config":{...}}` (wrapped), not the bare object — unwrapped returns 400.
5. **Extension-plugin enable-state is NOT persisted** (Task 5/6): `translation` registers DISABLED every boot (no `registry.json` for built-in/extension plugins; not a write failure). Added a systemd oneshot **`owa-plugin-config.service`** (`/opt/openwa/enable-plugin.sh`, canonical unit in `/opt/etc/systemd/system/`, symlinked into `/etc`) that waits for `/api/health/ready` then POSTs enable + PUTs the LibreTranslate config on every boot. Required for reboot survival.
6. **`ufw` does NOT filter Docker-published ports** (Task 2/5): Docker's FORWARD/DNAT rules run before the `ufw` chains (ufw forward chains saw 0 packets), so the `ufw allow 2886` rule is cosmetic for the dashboard. Host-level enforcement is a **`DOCKER-USER`** rule instead — `/opt/openwa/docker-fw.sh` applied via systemd oneshot **`owa-docker-fw.service`**. The rule MUST match only NEW, original-direction connections (`--ctstate NEW`) or it also drops the container's REPLY packets (which carry the same `ctorigdstport 2886`), causing client timeouts. Allowlist matches the operator's Linode cloud-FW profile `open508`: `47.190.78.199/32` + `45.248.25.5/32`.
7. **macOS `tar` AppleDouble** (Task 4): `tar -czf` on macOS embeds `._*` xattr sidecars; `find /opt/openwa/data -name '._*' -delete` after extraction (or `COPYFILE_DISABLE=1 tar …` on the laptop).

**Final validated state:** all 4 services `running`; session `ready` (`14697748333`, migrated, no QR); plugin `enabled` + `libretranslateUrl=http://libretranslate:5000`; live English→target translation confirmed in-group; dashboard reachable from the dev IPs (`200`), world blocked at the host; **full VM reboot self-recovers the entire stack** (session ready + plugin enabled + firewall + dashboard) with no manual steps. Memory ~700 MiB of 3.8 GiB. Nightly data backup via cron. Linode cloud FW (`open508`) is the operator's edge layer (toggle in the Linode UI); the host `DOCKER-USER` rule is the second layer.
