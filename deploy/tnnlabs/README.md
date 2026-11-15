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
docker compose pull
docker compose up -d
```

The compose file joins the existing `macvlan_net` (`external: true`), so the
network must already exist and the reverse proxy must be able to reach the
container.

## The update loop

Whenever upstream moves:

```powershell
git switch docker
git fetch upstream
git merge upstream/main          # resolve conflicts, run npm test if you like
pwsh ./scripts/deploy-image.ps1
```

The script refuses to publish anything unless the built image answers
`/api/health` with **the version and commit it was built from**, serves the
SPA, and round-trips a vault through the mounted volume. It prints the tags it
pushed at the end.

Then on the server:

```bash
docker compose -f deploy/tnnlabs/docker-compose.yml pull
docker compose -f deploy/tnnlabs/docker-compose.yml up -d
```

## Verifying that a deploy actually landed

A `docker compose up -d` that exits 0 does not prove the new build is serving.
Ask the deployment itself:

```bash
curl -s https://feedzero.tnnlabs.space/api/health
# {"ok":true,"version":"0.18.1","commit":"f9d0453","time":"..."}
```

`commit` is the short SHA baked in at build time. It must match the commit the
deploy script printed. If it reads `"unknown"`, the image was built without
`GIT_COMMIT_SHA` (i.e. not through `scripts/deploy-image.ps1`).

## Rolling back

Every build publishes an immutable `sha-<commit>` tag. Pin one:

```bash
# deploy/tnnlabs/.env
FEEDZERO_VERSION=sha-f9d0453
```

…then `docker compose up -d` (no `pull` needed if the image is already local,
otherwise `pull` first). Release tags (`v0.18.1`) work too.

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
| Browser: "Web Crypto refused to run" | You opened `http://`. Use the NPM HTTPS URL. |
| `413` when syncing | NPM `client_max_body_size` too small — set 16 MB. |
| `denied: requested access to the resource is denied` | The registry now requires auth — set `REGISTRY_USERNAME` and `REGISTRY_PASSWORD` in `.env.deploy`. |
| `npm test` fails on a Windows dev machine | Three suites (POSIX `sh`, `/`-separated allowlist paths) fail on `main` too; the deploy script excludes exactly those on Windows. |
