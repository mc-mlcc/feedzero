#!/usr/bin/env node
/**
 * Everything `scripts/deploy-image.ps1` needs to decide which image to build,
 * what to tag it, and which registry to authenticate against.
 *
 * The script itself is deliberately thin: build, run, push. The decisions live
 * here so they are unit-tested (tests/scripts/deploy-image.test.ts) instead of
 * being shell conditions nobody exercises until a release fails.
 *
 * Tag set for a build of package.json version 0.18.1 at commit f9d0453:
 *
 *   hub.example.com/feedzero:v0.18.1    exact release — pin this on a server
 *   hub.example.com/feedzero:0.18       floating minor
 *   hub.example.com/feedzero:latest     what `docker compose pull` follows
 *   hub.example.com/feedzero:sha-f9d0453  exact commit, never moves
 *
 * `latest` is a convenience, not a version claim: two builds of the same
 * package.json version (main merged into a long-lived branch without a bump)
 * produce two different images under the same `vX.Y.Z` name. That is why the
 * sha tag is always published — it is the only tag that names one tree.
 *
 * CLI: `node scripts/lib/deploy-image.mjs --version 0.18.1 --sha <full sha>`
 * prints a JSON plan on stdout and narration on stderr. Exit 1 on an invalid
 * image path, version, or half-configured credentials.
 *
 * The option is `--deploy-env`, not `--env-file`: Node owns `--env-file` and
 * aborts with `node: .env.deploy: not found` (exit 9) before this script
 * runs, even when the flag appears after the script path.
 */
import { readFileSync } from "node:fs";
import path from "node:path";

/** A registry host: DNS name, IPv4, or localhost, optionally with a port. */
const REGISTRY_HOST = /^(?:[a-z0-9.-]+|\[[0-9a-f:]+\])(?::\d+)?$/;
/** One path component of an image name, per the Docker reference grammar. */
const PATH_COMPONENT = /^[a-z0-9]+(?:(?:[._]|__|-+)[a-z0-9]+)*$/;
const SEMVER = /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/;
const SHORT_SHA_LENGTH = 7;

/**
 * Rejects image paths the deploy script cannot safely tag.
 *
 * The script appends `:tag`, so a path that already carries a tag or digest
 * would produce `repo:old:new` and fail at push time, after the build. A
 * missing registry host would push to Docker Hub, which is the one place a
 * private image must never land by accident.
 *
 * @param {string} image
 * @returns {{ ok: true, image: string } | { ok: false, error: string }}
 */
export function validateImagePath(image) {
  const trimmed = String(image ?? "").trim();
  if (!trimmed) return { ok: false, error: "image path is empty" };
  if (/\s/.test(trimmed))
    return { ok: false, error: "image path must not contain whitespace" };
  if (trimmed.includes("@"))
    return {
      ok: false,
      error: "image path must not carry a digest; the deploy script tags the build",
    };
  if (trimmed !== trimmed.toLowerCase())
    return { ok: false, error: "image path must be lowercase" };

  const segments = trimmed.split("/");
  if (segments.length < 2)
    return {
      ok: false,
      error:
        "image path must name its registry, e.g. hub.example.com/feedzero",
    };
  if (segments.some((segment) => segment === ""))
    return { ok: false, error: "image path has an empty component" };

  const host = segments[0];
  if (!REGISTRY_HOST.test(host))
    return { ok: false, error: `invalid registry host "${host}"` };
  if (!host.includes(".") && !host.includes(":") && host !== "localhost")
    return {
      ok: false,
      error: `registry host "${host}" is not a hostname; use a dotted name or localhost`,
    };

  // Docker's grammar forbids a tag in the final component; catching it here
  // turns `docker push repo:tag:tag` into a message about the config file.
  const nameSegments = segments.slice(1);
  if (nameSegments[nameSegments.length - 1].includes(":"))
    return {
      ok: false,
      error: "image path must not carry a tag; the deploy script adds tags",
    };
  const invalid = nameSegments.find((segment) => !PATH_COMPONENT.test(segment));
  if (invalid !== undefined)
    return { ok: false, error: `invalid image path component "${invalid}"` };

  return { ok: true, image: trimmed };
}

/**
 * The registry host of a validated image path.
 *
 * @param {string} image
 * @returns {string}
 */
export function registryOf(image) {
  return image.split("/")[0];
}

/**
 * Builds the tag set for one build.
 *
 * @param {{ image: string, version: string, sha: string, includeLatest?: boolean }} params
 *   `version` is package.json's version (no `v`); `sha` is any commit id, at
 *   least 7 hex characters.
 * @returns {{ ok: true, image: string, registry: string, tags: string[], version: string, minor: string, shortSha: string } | { ok: false, error: string }}
 */
export function computeImageTags({ image, version, sha, includeLatest = true }) {
  const imageCheck = validateImagePath(image);
  if (!imageCheck.ok) return imageCheck;

  const cleanVersion = String(version ?? "").trim().replace(/^v/, "");
  if (!SEMVER.test(cleanVersion))
    return {
      ok: false,
      error: `version "${version}" is not semver; expected the package.json value, e.g. 0.18.1`,
    };

  const shortSha = String(sha ?? "")
    .trim()
    .toLowerCase()
    .slice(0, SHORT_SHA_LENGTH);
  if (!/^[0-9a-f]{7}$/.test(shortSha))
    return {
      ok: false,
      error: `sha "${sha}" is not a commit id; pass the output of \`git rev-parse HEAD\``,
    };

  const resolvedImage = imageCheck.image;
  const minor = cleanVersion.split(".").slice(0, 2).join(".");
  const tags = [
    `${resolvedImage}:v${cleanVersion}`,
    `${resolvedImage}:${minor}`,
    ...(includeLatest ? [`${resolvedImage}:latest`] : []),
    `${resolvedImage}:sha-${shortSha}`,
  ];

  return {
    ok: true,
    image: resolvedImage,
    registry: registryOf(resolvedImage),
    tags,
    version: `v${cleanVersion}`,
    minor,
    shortSha,
  };
}

/**
 * Parses `KEY=VALUE` lines from a deploy env file.
 *
 * Only the subset an env file needs: comments, blank lines, and one layer of
 * matching quotes. A line without `=` is reported rather than ignored — a
 * typo in `.env.deploy` would otherwise surface as a confusing "credentials
 * missing" error.
 *
 * @param {string} text
 * @returns {{ ok: true, values: Record<string, string> } | { ok: false, error: string }}
 */
export function parseEnvFile(text) {
  /** @type {Record<string, string>} */
  const values = {};
  const lines = String(text ?? "").split(/\r?\n/);

  for (const [index, rawLine] of lines.entries()) {
    const line = rawLine.trim();
    if (line === "" || line.startsWith("#")) continue;

    const separator = line.indexOf("=");
    if (separator === -1)
      return {
        ok: false,
        error: `line ${index + 1} is not KEY=VALUE: ${line}`,
      };

    const key = line.slice(0, separator).trim();
    if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(key))
      return {
        ok: false,
        error: `line ${index + 1} has an invalid key: ${key || "(empty)"}`,
      };

    let value = line.slice(separator + 1).trim();
    const quoted =
      value.length >= 2 &&
      ((value.startsWith('"') && value.endsWith('"')) ||
        (value.startsWith("'") && value.endsWith("'")));
    if (quoted) value = value.slice(1, -1);

    values[key] = value;
  }

  return { ok: true, values };
}

/**
 * Combines an env file with CLI overrides into the plan the deploy script
 * executes.
 *
 * Credentials are optional: an anonymous registry accepts the push without a
 * `docker login`. Half-configured credentials are rejected, because a typo'd
 * key would otherwise turn a registry that *does* require auth into a
 * confusing `unauthorized` at push time.
 *
 * @param {{
 *   envText?: string,
 *   image?: string,
 *   version: string,
 *   sha: string,
 *   includeLatest?: boolean,
 * }} params
 * @returns {{ ok: true, plan: { image: string, registry: string, tags: string[], version: string, minor: string, shortSha: string, username: string, password: string, anonymous: boolean } } | { ok: false, error: string }}
 */
export function resolveDeployPlan({
  envText = "",
  image,
  version,
  sha,
  includeLatest = true,
}) {
  const env = parseEnvFile(envText);
  if (!env.ok) return { ok: false, error: env.error };

  const imagePath = image || env.values.IMAGE || "";
  if (!imagePath) {
    return {
      ok: false,
      error:
        "No image configured — copy .env.deploy.example to .env.deploy and set IMAGE, or pass -Image on the script.",
    };
  }
  const tags = computeImageTags({
    image: imagePath,
    version,
    sha,
    includeLatest,
  });
  if (!tags.ok) return { ok: false, error: tags.error };

  const username = env.values.REGISTRY_USERNAME ?? "";
  const password = env.values.REGISTRY_PASSWORD ?? "";
  if ((username === "") !== (password === "")) {
    return {
      ok: false,
      error:
        "Set both REGISTRY_USERNAME and REGISTRY_PASSWORD, or neither for an anonymous registry",
    };
  }

  return {
    ok: true,
    plan: {
      image: tags.image,
      registry: tags.registry,
      tags: tags.tags,
      version: tags.version,
      minor: tags.minor,
      shortSha: tags.shortSha,
      username,
      password,
      anonymous: username === "",
    },
  };
}

function runCli() {
  const args = process.argv.slice(2);
  const flag = (name) => args.includes(name);
  const option = (name) => {
    const at = args.indexOf(name);
    return at === -1 ? "" : (args[at + 1] ?? "");
  };

  const envArg = option("--deploy-env") || ".env.deploy";
  let envText = "";
  if (!flag("--no-env-file")) {
    try {
      envText = readFileSync(path.resolve(process.cwd(), envArg), "utf8");
    } catch {
      console.error(
        `No ${envArg} found; continuing without registry credentials.`,
      );
    }
  }

  const resolved = resolveDeployPlan({
    envText,
    image: option("--image"),
    version: option("--version"),
    sha: option("--sha"),
    includeLatest: !flag("--no-latest"),
  });

  if (!resolved.ok) {
    console.error(resolved.error);
    console.log(JSON.stringify({ ok: false, error: resolved.error }));
    process.exit(1);
  }

  console.error(
    `Publishing ${resolved.plan.tags.length} tag(s) of ${resolved.plan.image}.`,
  );
  console.log(JSON.stringify({ ok: true, ...resolved.plan }));
}

if (
  process.argv[1] &&
  import.meta.url === new URL(`file://${process.argv[1]}`).href
) {
  runCli();
}
