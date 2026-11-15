# Self-hosting FeedZero

You need a server with **Docker** (Engine + Compose v2) and either a
**hostname** pointing at it (for automatic HTTPS) or just a **LAN IP**.
Deploy is three steps.

## Deploy

```bash
# 1. Get the files
git clone https://github.com/forcingfx/feedzero.git && cd feedzero

# 2. Configure — set HOSTNAME (and ACME_EMAIL)
cp .env.example .env && nano .env

# 3. Start
./scripts/feedzero up
```

Windows (PowerShell): `Copy-Item .env.example .env; notepad .env; pwsh .\scripts\feedzero.ps1 up`.

Then open `https://<your HOSTNAME>` and **save the 4-word passphrase** it
shows — it's the only thing that can decrypt your data on another device,
and the server never sees it.

- **Public domain:** point an A/AAAA DNS record at the server first. Caddy
  fetches a Let's Encrypt cert automatically. Ports 80 and 443 must be open.
- **LAN / no domain:** set `HOSTNAME` to the IP or a `.local` name (e.g.
  `192.168.1.42`). `up` serves a self-signed cert automatically — see
  [LAN setup](#lan--no-domain) to trust it.

The first `up` builds the image locally (1–2 min on a VPS, longer on a Pi).
`./scripts/feedzero doctor` checks your setup; `help` lists every command.

## LAN / no domain

A public CA can't issue a cert for an IP or `.local` name, so `up`
auto-selects a self-signed cert (`Caddyfile.lan`). Trust its root once per
device, or the browser blocks the page (FeedZero needs HTTPS for Web Crypto).

```bash
# Export Caddy's root certificate
docker exec feedzero-caddy cat /data/caddy/pki/authorities/local/root.crt > caddy-root.crt
```

Install `caddy-root.crt` as a trusted root:

- **macOS:** open it → Keychain Access → System → set *Always Trust*.
- **Linux:** `sudo cp caddy-root.crt /usr/local/share/ca-certificates/ && sudo update-ca-certificates`
- **Windows:** right-click → *Install Certificate* → *Local Machine* → *Trusted Root Certification Authorities*.
- **iOS / Android:** install the file as a CA certificate in Settings, then enable full trust.

Then visit `https://<your IP>`.

## Day-2 operations

```bash
./scripts/feedzero update     # pull/rebuild the latest and restart
./scripts/feedzero backup     # write backups/feedzero-<ts>.tar.gz (move it off-box)
./scripts/feedzero restore <archive>
./scripts/feedzero logs [feedzero|caddy]
```

Pin a version with `FEEDZERO_VERSION=v0.11.0` in `.env`; otherwise updates
track `latest`. Backups contain the encrypted vault — they need the same
passphrase to restore.

## Troubleshooting

- **`SSL_ERROR_RX_RECORD_TOO_LONG` / cert error on a LAN IP** — you're on the
  LAN path; confirm with `./scripts/feedzero config <host>` (should show
  `CADDYFILE=./Caddyfile.lan`) and trust the root CA above.
- **TLS cert error on a public domain** — DNS hasn't propagated, or port 80
  is blocked (Let's Encrypt needs it). Check `./scripts/feedzero logs caddy`.
- **"Web Crypto refused to run"** — you opened `http://`. Use the `https://`
  URL Caddy serves.
- **`up` fails while building** — see the real error with
  `docker compose build --no-cache --progress=plain feedzero`.
- **Sync not working across devices** — both need the *same passphrase* and
  network access to `HOSTNAME` (a `.local` name won't resolve off-LAN).
- **Sync fails with `EACCES: permission denied, mkdir '/data/vaults'`** — the
  container runs as `node` (uid 1000) and your host data directory, which the
  bind mount puts at `/data`, is owned by root. `docker compose up` creates a
  missing directory as root. Fix it on the host:
  `sudo chown -R 1000:1000 ./data` (or your `DATA_DIR`). A `healthy` container
  does not mean the volume is writable — `/api/health` only reports liveness,
  so check with
  `docker exec feedzero sh -c 'touch /data/vaults/.probe && rm /data/vaults/.probe && echo writable'`.

### Portainer

Don't paste the compose file into Portainer's web editor — the `Caddyfile`
bind mount needs the repo files on disk, and Portainer pulls (it won't build).
Deploy via Portainer's **Repository** stack method pointing at this repo, or
SSH in and run `./scripts/feedzero up`.

## Private registry (fork) images

If you run your own registry and fork of this repo, build and publish from the
fork instead of pulling GHCR:

```powershell
Copy-Item .env.deploy.example .env.deploy   # IMAGE (+ credentials if required)
pwsh ./scripts/deploy-image.ps1             # test, build, tag, push
```

The script publishes `vX.Y.Z`, `X.Y`, `latest` and an immutable `sha-<commit>`
tag, and refuses to push until the built image has answered `/api/health` with
the version and commit it was built from, served the SPA, and round-tripped a
vault through its data volume. The server then only needs to pull:

```bash
docker compose pull && docker compose up -d
```

A pull-only compose for this workflow, with the TLS left to an existing
reverse proxy, lives in [deploy/tnnlabs/](../deploy/tnnlabs/README.md); its
step-by-step update runbook is
[deploy/tnnlabs/UPDATE.md](../deploy/tnnlabs/UPDATE.md).

## What you give up vs. the hosted version

- **IP reputation / rate-limiting** — fresh server IPs can hit upstream WAFs
  or 429s that the hosted deployment's shared IPs and Upstash buffer avoid.
- **Managed backups & updates** — you run `backup` and `update` yourself.

See [ADR 014: self-host is first-class](./decisions/014-self-host-first-class.md)
for the rationale.
