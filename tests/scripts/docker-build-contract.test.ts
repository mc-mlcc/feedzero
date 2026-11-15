/**
 * Regression contract for issue #212: a production dependency install
 * (`npm ci --omit=dev`) must not abort on the package's own `prepare`
 * lifecycle script.
 *
 * `"prepare": "husky"` runs during every `npm ci` — including the Docker
 * runtime stage and any non-Docker prod install. With --omit=dev, husky
 * (a devDependency) is absent, so the script fails with `husky: not found`
 * → npm exit code 127, which aborted `docker compose build` and produced
 * the reporter's "Can't deploy with docker" error.
 *
 * Two independent guards must both hold (defense in depth):
 *   1. The Dockerfile runtime stage installs with --ignore-scripts.
 *   2. The `prepare` script tolerates husky being absent.
 */
import { describe, it, expect } from "vitest";
import { existsSync, readFileSync } from "node:fs";
import path from "node:path";

const REPO = path.resolve(__dirname, "../..");

function readRepoFile(relativePath: string): string {
  const fullPath = path.join(REPO, relativePath);
  if (!existsSync(fullPath)) {
    throw new Error(`expected deployment artifact ${relativePath} to exist`);
  }
  return readFileSync(fullPath, "utf8");
}

describe("docker build / prod install contract (#212)", () => {
  it("Dockerfile installs prod deps with --ignore-scripts", () => {
    const dockerfile = readFileSync(path.join(REPO, "Dockerfile"), "utf8");
    const prodInstall = dockerfile
      .split("\n")
      .find((l) => l.includes("npm ci") && l.includes("--omit=dev"));
    expect(prodInstall, "no `npm ci --omit=dev` line in Dockerfile").toBeTruthy();
    expect(
      prodInstall,
      "prod install must use --ignore-scripts so the husky `prepare` script can't fail with exit 127",
    ).toContain("--ignore-scripts");
  });

  it("the prepare script tolerates husky being absent (non-Docker prod installs)", () => {
    const pkg = JSON.parse(
      readFileSync(path.join(REPO, "package.json"), "utf8"),
    ) as { scripts?: Record<string, string> };
    const prepare = pkg.scripts?.prepare ?? "";
    // If prepare invokes husky, it must not hard-fail when husky is missing.
    if (prepare.includes("husky")) {
      expect(
        /\|\|\s*(true|exit 0)/.test(prepare),
        `prepare script "${prepare}" must guard husky (e.g. "husky || true") so npm ci --omit=dev can't exit 127`,
      ).toBe(true);
    }
  });

  it("Dockerfile runtime stage copies packages/ (server imports @feedzero/core at runtime)", () => {
    // Omitting it crashes the server at boot with
    // ERR_MODULE_NOT_FOUND for packages/core/src/... (issue #212).
    const dockerfile = readFileSync(path.join(REPO, "Dockerfile"), "utf8");
    expect(
      /COPY\s+--from=build\s+\/app\/packages\b/.test(dockerfile),
      "runtime stage must `COPY --from=build /app/packages ./packages`",
    ).toBe(true);
  });

  it("default Caddyfile quotes the ACME email so a blank value still parses", () => {
    // Unquoted `email {$ACME_EMAIL}` with a blank ACME_EMAIL (the documented
    // default) expands to zero tokens → Caddy "wrong argument count" → the
    // reverse proxy never starts (issue #212).
    const caddyfile = readFileSync(path.join(REPO, "Caddyfile"), "utf8");
    expect(
      caddyfile.includes('email "{$ACME_EMAIL}"'),
      'Caddyfile must use quoted `email "{$ACME_EMAIL}"`',
    ).toBe(true);
  });

  it("Caddyfile.lan binds all interfaces and sets default_sni for IP hosts", () => {
    // An IP HOSTNAME needs `bind 0.0.0.0` (the container doesn't own the IP)
    // and `default_sni` (clients omit SNI for IP literals, so the internal
    // cert won't match without it) — issue #212.
    const lan = readFileSync(path.join(REPO, "Caddyfile.lan"), "utf8");
    expect(lan, "Caddyfile.lan must bind 0.0.0.0").toContain("bind 0.0.0.0");
    expect(lan, "Caddyfile.lan must set default_sni").toContain("default_sni");
    expect(lan, "Caddyfile.lan must use internal TLS").toContain("tls internal");
  });
});

/**
 * Regression contract for issue #224: enabling sync in the Docker image
 * failed with `EACCES: permission denied, mkdir 'data/vaults'`.
 *
 * The vault directory is chosen by `resolveAdapter`, which reads `DATA_DIR`
 * and falls back to the RELATIVE "./data". Both the Dockerfile and
 * docker-compose.yml instead set `SYNC_FILESYSTEM_DIR`, which nothing in the
 * codebase reads. So the container resolved "./data" against WORKDIR /app and
 * tried to mkdir /app/data/vaults as the unprivileged `node` user — which
 * cannot write there. The /data volume it was supposed to use sat empty.
 *
 * These assert the deployment artefacts configure the variable the code
 * actually reads, and that it points at the prepared, writable volume.
 */
describe("self-host sync storage contract (#224)", () => {
  const dockerfile = readFileSync(path.join(REPO, "Dockerfile"), "utf8");
  const compose = readFileSync(path.join(REPO, "docker-compose.yml"), "utf8");

  it("Dockerfile sets DATA_DIR — the variable resolveAdapter reads", () => {
    expect(dockerfile).toMatch(/DATA_DIR=\/data\b/);
  });

  it("Dockerfile prepares that directory and gives it to the runtime user", () => {
    expect(dockerfile).toMatch(/mkdir -p \/data/);
    expect(dockerfile).toMatch(/chown -R node:node \/data/);
    expect(dockerfile).toMatch(/^USER node$/m);
  });

  it("docker-compose sets DATA_DIR for the container", () => {
    expect(compose).toMatch(/DATA_DIR:\s*\/data\b/);
  });

  it("neither artefact SETS SYNC_FILESYSTEM_DIR, which nothing reads", () => {
    // A variable no code consumes reads as configuration while doing nothing,
    // which is what hid this bug. Match assignment (`NAME=` / `NAME:`) rather
    // than any mention, so the comments explaining the history don't trip it.
    expect(dockerfile).not.toMatch(/SYNC_FILESYSTEM_DIR\s*=/);
    expect(compose).not.toMatch(/^\s*SYNC_FILESYSTEM_DIR\s*:/m);
  });
});

/**
 * The private-registry deployment (deploy/tnnlabs) runs the image built by
 * scripts/deploy-image.ps1 behind an existing Nginx Proxy Manager instance.
 *
 * It is a *different* contract from the root docker-compose.yml: the server
 * never builds, never terminates TLS itself, and persists vaults on a host
 * path the owner backs up. Those differences are the point of the file, so
 * they are asserted rather than left to the reader.
 */
describe("private-registry compose (deploy/tnnlabs)", () => {
  const compose = readRepoFile("deploy/tnnlabs/docker-compose.yml");

  it("pulls the published image instead of building on the server", () => {
    // A `build:` section would make `docker compose up` compile the app on a
    // NAS, and `pull` would silently stop updating anything.
    expect(compose).toMatch(
      /image:\s*hub\.tnnlabs\.space\/feedzero:\$\{FEEDZERO_VERSION:-latest\}/,
    );
    expect(compose).not.toMatch(/^\s*build:/m);
  });

  it("publishes the port the reverse proxy targets", () => {
    // Host port stays overridable (NPM may already own 3000 on the box), but
    // the container side is fixed at 3000 — that's what the server binds.
    expect(compose).toMatch(/\$\{HOST_PORT:-3000\}:3000/);
  });

  it("persists vaults on a host path mounted at /data", () => {
    // resolveAdapter writes {DATA_DIR}/vaults; DATA_DIR must be the mount
    // point, not a relative path inside the image.
    expect(compose).toMatch(/DATA_DIR:\s*\/data\b/);
    expect(compose).toMatch(/\$\{DATA_DIR:-[^}]*\}:\/data/);
    expect(compose).not.toMatch(/^\s*SYNC_FILESYSTEM_DIR\s*:/m);
  });

  it("runs in self-hosted mode with filesystem sync", () => {
    expect(compose).toMatch(/SELF_HOSTED:\s*"?1"?/);
    expect(compose).toMatch(/SYNC_STORAGE:\s*filesystem/);
    expect(compose).toMatch(/PORT:\s*"?3000"?/);
  });

  it("joins the existing macvlan network without creating one", () => {
    expect(compose).toMatch(/name:\s*macvlan_net/);
    expect(compose).toMatch(/external:\s*true/);
  });

  it("restarts after a host reboot", () => {
    expect(compose).toMatch(/restart:\s*unless-stopped/);
  });
});

/**
 * `/api/health` is how a deploy is verified ("did MY commit go live?"). The
 * Hono server reads APP_VERSION/GIT_COMMIT_SHA from the process environment;
 * without them baked in at build time, a self-hosted image reports
 * `version: "unknown", commit: "unknown"` and no deploy can be proven.
 */
describe("image build identity", () => {
  const dockerfile = readRepoFile("Dockerfile");

  it("accepts APP_VERSION and GIT_COMMIT_SHA as build args", () => {
    expect(dockerfile).toMatch(/^ARG APP_VERSION=/m);
    expect(dockerfile).toMatch(/^ARG GIT_COMMIT_SHA=/m);
  });

  it("exposes those build args to the running server", () => {
    expect(dockerfile).toMatch(/APP_VERSION=\$\{?APP_VERSION\}?/);
    expect(dockerfile).toMatch(/GIT_COMMIT_SHA=\$\{?GIT_COMMIT_SHA\}?/);
  });
});
