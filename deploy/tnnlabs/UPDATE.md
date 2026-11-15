# Redeploy runbook

Pulling upstream into the `docker` branch and getting it onto the server.
Two machines: build on the **dev machine**, pull on the **server**.

```
DEV MACHINE                                   SERVER
───────────                                   ──────
git merge upstream/main                       docker compose pull
pwsh ./scripts/deploy-image.ps1               docker compose up -d
        │                                             ▲
        │  tests → build → verify → tag              │
        └──────────▶ hub.tnnlabs.space/feedzero ──────┘
```

## TL;DR

```powershell
# DEV MACHINE
cd F:\github\feedzero
git switch docker
git fetch upstream
git merge upstream/main
pwsh ./scripts/deploy-image.ps1
```

```bash
# SERVER — note the commit the script printed at the end
cd /path/to/feedzero
docker compose -f deploy/tnnlabs/docker-compose.yml pull
docker compose -f deploy/tnnlabs/docker-compose.yml up -d
curl -s https://feedzero.tnnlabs.space/api/health
```

The `commit` in that last response must equal the sha the deploy script
printed (e.g. `b248a27`). If it does, you are done.

---

## Step 1 — DEV: start clean

```powershell
cd F:\github\feedzero
git switch docker
git status
```

Expect `nothing to commit, working tree clean`. If the working tree is dirty,
commit or discard it first — the deploy script will warn that the image does
not match the commit, and `sha-<commit>` would then name the wrong tree.

## Step 2 — DEV: merge upstream

```powershell
git fetch upstream
git merge upstream/main
```

Three outcomes:

| Result | What to do |
| --- | --- |
| `Already up to date.` | Nothing new. Stop — there is nothing to deploy. |
| `Fast-forward` / a merge commit | Continue to step 3. |
| `CONFLICT` | Resolve, `git add <files>`, `git commit`. Then step 3. |

Conflicts are most likely in `Dockerfile`, `docs/self-hosting.md`,
`src/core/health/health-handler.ts`, and `tests/scripts/*` — the files this
branch changes. For docs, take either side; for code, keep the
`APP_VERSION`/`GIT_COMMIT_SHA` lines and the `GIT_COMMIT_SHA` fallback in
`resolveCommit()`, which is what makes `/api/health` prove a deploy landed.

## Step 3 — DEV: build, verify, push

```powershell
pwsh ./scripts/deploy-image.ps1
```

This is the only command that touches the registry. It:

1. runs the unit suite and both `tsc` projects (excludes three suites that
   cannot pass from Windows — see the end of this file);
2. builds `linux/amd64` with the version and commit baked in;
3. **starts the image** and asserts `/api/health` reports that version +
   commit, the SPA renders, and a vault write/read survives the volume;
4. pushes `vX.Y.Z`, `X.Y`, `latest`, and `sha-<commit>`;
5. prints the digest the registry now serves.

Expected tail:

```
==> Pushing to hub.tnnlabs.space
    No credentials in .env.deploy — pushing anonymously.
    pushed hub.tnnlabs.space/feedzero:v0.18.1
    pushed hub.tnnlabs.space/feedzero:0.18
    pushed hub.tnnlabs.space/feedzero:latest
    pushed hub.tnnlabs.space/feedzero:sha-b248a27

==> Verifying what the registry now serves
    latest -> sha256:878e0e4d...

Published. On the server:
  docker compose -f deploy/tnnlabs/docker-compose.yml pull
  docker compose -f deploy/tnnlabs/docker-compose.yml up -d
  curl -s https://feedzero.tnnlabs.space/api/health   # expect commit b248a27
```

**Nothing is pushed if any gate fails.** Fix the failure and run it again.

Optionally back up the branch: `git push --no-verify` (the pre-push hook runs
the full suite and trips on the Windows-only suites — see the end of this file).

## Step 4 — SERVER: pull and restart

```bash
cd /path/to/feedzero
docker compose -f deploy/tnnlabs/docker-compose.yml pull
docker compose -f deploy/tnnlabs/docker-compose.yml up -d
```

`pull` moves `latest` to the new build; `up -d` then recreates the container
because its image changed. If the image did not move, the running container is
left alone.

## Step 5 — SERVER: verify

```bash
curl -s https://feedzero.tnnlabs.space/api/health
# {"ok":true,"version":"0.18.1","commit":"b248a27","time":"..."}
```

`commit` must equal the sha printed in step 3. A `docker compose up -d` that
exited 0 proves only that compose ran; this response proves the new build is
the one serving traffic.

If `commit` is the *old* value, the server did not pick up the new image:

```bash
docker compose -f deploy/tnnlabs/docker-compose.yml ps      # check the image digest
docker compose -f deploy/tnnlabs/docker-compose.yml pull    # any "up to date"? tag moved?
docker buildx imagetools inspect hub.tnnlabs.space/feedzero:latest
```

## Rollback

Every build keeps an immutable `sha-<commit>` tag. Pin the previous one in the
server's `.env`:

```ini
FEEDZERO_VERSION=sha-b248a27
```

```bash
docker compose -f deploy/tnnlabs/docker-compose.yml pull
docker compose -f deploy/tnnlabs/docker-compose.yml up -d
```

Set it back to `latest` when the next good build lands. Vault data is
unaffected — the image tag changes, the volume does not.

## If something goes wrong

| Symptom | Cause and fix |
| --- | --- |
| Script stops at `vitest failed` | A real test failure. Read it; do not paper over it with `-SkipTests`. |
| Script stops at `tsc` | Type error. Fix it; the image is not built. |
| `docker push` → `unauthorized` | The registry now requires auth. Add `REGISTRY_USERNAME` + `REGISTRY_PASSWORD` to `.env.deploy`. |
| Server pull → `manifest unknown` | The tag was never pushed. Re-run step 3 and read its output. |
| Health `commit` unchanged after step 4 | Image did not move: check the tag exists and that the server is not pinned to an old `FEEDZERO_VERSION`. |
| Health `commit: "unknown"` | Image built outside `deploy-image.ps1` (no build args). Rebuild with it. |
| Sync → `EACCES ... mkdir '/data/vaults'` | Host data dir not owned by uid 1000. `sudo chown -R 1000:1000 <DATA_DIR>`. |
| Sync → `413` through NPM | Nginx Proxy Manager client body limit. Set it to 16 MB. |

## Why step 3 excludes three suites on Windows

`tests/scripts/feedzero-cli.test.ts` and `tests/scripts/release/build-feed.test.ts`
spawn a POSIX `sh`; `tests/build/ui-consistency.test.ts` compares against
`/`-separated paths that never match a Windows checkout. All three fail on
`main` for the same reason, so the script excludes exactly those three when it
runs on Windows and keeps the other ~4,260 tests as the gate. Linux CI still
runs everything.
