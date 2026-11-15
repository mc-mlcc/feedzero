# FeedZero on the tnnlabs server

This is the fork's own deployment path: images are **built on the dev machine**
and pulled by the **home server** from `hub.tnnlabs.space/feedzero`. Nothing is
compiled on the NAS, and no GitHub Actions runner or public registry is
involved.

```
 dev machine (F:\github\feedzero)              home server
 ───────────────────────────────              ─────────────────────────────
 git merge main                                    docker compose pull
 scripts/deploy-image.ps1  ──push──▶ registry ──▶  docker compose up -d
   ├─ npm test + tsc                                │
   ├─ docker build (linux/amd64)                    └─ feedzero:3000
   ├─ run image: health + SPA + vault round-trip       ▲
   └─ push vX.Y.Z, X.Y, latest, sha-<commit>           │
                                              Nginx Proxy Manager
                                          https://feedzero.tnnlabs.space
```

The app is served over plain HTTP inside the network. TLS is terminated by
Nginx Proxy Manager, which is the only thing exposed publicly — FeedZero
itself needs an `https://` origin (Web Crypto refuses to run on `http://`),
so never point a browser at `http://<nas>:3000`.

## Files

| File | Lives on | Purpose |
| --- | --- | --- |
| `.env.deploy` | dev machine | Registry credentials + image path. Gitignored. |
| `scripts/deploy-image.ps1` | dev machine | Build, verify, tag, push. |
| `scripts/lib/deploy-image.mjs` | dev machine | Tag/credential logic (unit-tested). |
| `deploy/tnnlabs/docker-compose.yml` | server | Pull-only compose matching `macvlan_net`. |
| `deploy/tnnlabs/.env` | server | Pinned version, data path, port. |
| `deploy/tnnlabs/UPDATE.md` | both | Step-by-step redeploy runbook. |

## One-time setup

**Dev machine** — copy the settings template:

```powershell
Copy-Item .env.deploy.example .env.deploy
```

`IMAGE=hub.tnnlabs.space/feedzero` (no tag — the script adds tags) is all this
registry needs. Add `REGISTRY_USERNAME` / `REGISTRY_PASSWORD` only if it starts
requiring auth; setting one without the other is rejected. `.env.deploy` is
gitignored and never enters the Docker build context.

**Server** — copy this directory over, then create its `.env`:

```bash
cp .env.example .env
# edit FEEDZERO_VERSION / DATA_DIR / HOST_PORT if needed
```

**Give the data directory to the container's user before starting.** The image
runs as `node` (uid **1000**), and a bind mount replaces `/data` with your host
directory — including its ownership. Docker creates a missing host directory as
`root`, so the first vault write fails with
`EACCES: permission denied, mkdir '/data/vaults'`:

```bash
sudo mkdir -p /mnt/Olympus/Docker/feedzero/data
sudo chown -R 1000:1000 /mnt/Olympus/Docker/feedzero/data
```

Then start:

```bash
docker compose pull
docker compose up -d
docker exec feedzero sh -c 'touch /data/vaults/.probe && rm /data/vaults/.probe && echo writable'
```

That last line is the check that matters — `docker compose ps` showing
`healthy` does **not** prove the volume is writable, because `/api/health` only
reports liveness. If `chown` fails or doesn't stick, the host path is a network
share without POSIX ownership (SMB/NFS); use a local disk path instead.

The compose file joins the existing `macvlan_net` (`external: true`), so the
network must already exist and the reverse proxy must be able to reach the
container.

## Updating

Every update is the same two-machine loop. The step-by-step runbook — merge,
deploy, pull, verify, rollback, and what to do when a step fails — is
**[UPDATE.md](./UPDATE.md)**.

```powershell
# DEV MACHINE
git switch docker && git fetch upstream && git merge upstream/main
pwsh ./scripts/deploy-image.ps1
```

```bash
# SERVER
docker compose -f deploy/tnnlabs/docker-compose.yml pull
docker compose -f deploy/tnnlabs/docker-compose.yml up -d
curl -s https://feedzero.tnnlabs.space/api/health   # commit must match the build
```

The deploy script publishes nothing unless the built image answers
`/api/health` with the version and commit it was built from, serves the SPA,
and round-trips a vault through the mounted volume.

## Reverse proxy (Nginx Proxy Manager)

- **Forward hostname/IP:** `feedzero`, port `3000` (same Docker network), or
  the NAS IP and published `HOST_PORT`.
- **Scheme:** `http`.
- **Force SSL** + **HTTP/2**: on. NPM terminates TLS.
- **Websockets:** not used.
- **Client max body size:** at least **16 MB**. Vault pushes are gzipped in
  transit but decode up to the 8 MB ceiling; NPM's 1 MB default would reject
  a large vault with a 413 before FeedZero ever sees it.

## Backups

`DATA_DIR` (default `/mnt/Olympus/Docker/feedzero/data`) holds one JSON file
per encrypted vault under `vaults/`. Back up that directory. The files are
useless without the user's passphrase, which never leaves the browser.

## Troubleshooting

| Symptom | Cause |
| --- | --- |
| `/api/health` fails, container healthy locally | NPM cannot reach `feedzero:3000` — check both containers share a network. |
| `version: "unknown"` in health | Image built outside `deploy-image.ps1`, or with `-SkipLocalTest` and stale tags. |
| Sync fails: `EACCES: permission denied, mkdir '/data/vaults'` | Host data directory is not owned by uid 1000 (Docker created it as root). `sudo chown -R 1000:1000 /mnt/Olympus/Docker/feedzero/data`. |
| Browser: "Web Crypto refused to run" | You opened `http://`. Use the NPM HTTPS URL. |
| `413` when syncing | NPM `client_max_body_size` too small — set 16 MB. |
| `denied: requested access to the resource is denied` | The registry now requires auth — set `REGISTRY_USERNAME` and `REGISTRY_PASSWORD` in `.env.deploy`. |
| `npm test` fails on a Windows dev machine | Three suites (POSIX `sh`, `/`-separated allowlist paths) fail on `main` too; the deploy script excludes exactly those on Windows. |
