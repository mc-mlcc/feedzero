/**
 * Contract for the private-registry publish path.
 *
 * `scripts/deploy-image.ps1` builds and pushes an image to the fork owner's
 * registry. The decisions (which tags, which credentials, is the image path
 * pushable) are pure functions in `scripts/lib/deploy-image.mjs`; this suite
 * is what stops a typo in `.env.deploy` from becoming `docker push
 * repo:tag:tag`, or from publishing an image to Docker Hub by accident.
 */
import { describe, it, expect } from "vitest";
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import path from "node:path";
import {
  computeImageTags,
  parseEnvFile,
  registryOf,
  resolveDeployPlan,
  validateImagePath,
} from "../../scripts/lib/deploy-image.mjs";

const REPO = path.resolve(__dirname, "../..");
const IMAGE = "hub.tnnlabs.space/feedzero";
const SHA = "f9d0453b63c47a48652e8f352dc3edc669050c01";

describe("computeImageTags", () => {
  it("publishes the version, minor, latest and sha tags for one build", () => {
    const result = computeImageTags({
      image: IMAGE,
      version: "0.18.1",
      sha: SHA,
    });

    expect(result.ok).toBe(true);
    expect(result.tags).toEqual([
      "hub.tnnlabs.space/feedzero:v0.18.1",
      "hub.tnnlabs.space/feedzero:0.18",
      "hub.tnnlabs.space/feedzero:latest",
      "hub.tnnlabs.space/feedzero:sha-f9d0453",
    ]);
    expect(result.registry).toBe("hub.tnnlabs.space");
    expect(result.minor).toBe("0.18");
    expect(result.shortSha).toBe("f9d0453");
  });

  it("uses the sha tag alone as the immutable name for a tree", () => {
    // Two builds can share a package.json version (main merged into the
    // docker branch without a release). Only the sha tag names one tree, so
    // it must always be present even when the caller opts out of `latest`.
    const result = computeImageTags({
      image: IMAGE,
      version: "0.18.1",
      sha: SHA,
      includeLatest: false,
    });

    expect(result.ok).toBe(true);
    expect(result.tags).toContain("hub.tnnlabs.space/feedzero:sha-f9d0453");
    expect(result.tags).not.toContain("hub.tnnlabs.space/feedzero:latest");
  });

  it("accepts a leading v in the version input", () => {
    const result = computeImageTags({
      image: IMAGE,
      version: "v0.18.1",
      sha: SHA,
    });

    expect(result.version).toBe("v0.18.1");
    expect(result.tags[0]).toBe("hub.tnnlabs.space/feedzero:v0.18.1");
  });

  it("rejects a version that is not semver", () => {
    const result = computeImageTags({
      image: IMAGE,
      version: "main",
      sha: SHA,
    });

    expect(result.ok).toBe(false);
    expect(result.error).toMatch(/not semver/);
  });

  it("rejects a sha that is not a commit id", () => {
    const result = computeImageTags({ image: IMAGE, version: "0.18.1", sha: "" });

    expect(result.ok).toBe(false);
    expect(result.error).toMatch(/not a commit id/);
  });
});

describe("validateImagePath", () => {
  it.each([
    ["hub.tnnlabs.space/feedzero", true],
    ["hub.tnnlabs.space/tnnlabs/feedzero", true],
    ["localhost:5000/feedzero", true],
    // Tag already present — the script appends `:tag`, producing an
    // unusable reference that would only fail after the build.
    ["hub.tnnlabs.space/feedzero:latest", false],
    ["hub.tnnlabs.space/feedzero@sha256:abc", false],
    ["hub.tnnlabs.space", false],
    ["feedzero", false],
    ["Hub.TNNLabs.space/feedzero", false],
    ["hub.tnnlabs.space//feedzero", false],
    ["hub.tnnlabs.space/feed zero", false],
  ])("%s → %s", (image, valid) => {
    expect(validateImagePath(image).ok).toBe(valid);
  });

  it("normalises surrounding whitespace", () => {
    const result = validateImagePath("  hub.tnnlabs.space/feedzero  ");
    expect(result).toEqual({ ok: true, image: "hub.tnnlabs.space/feedzero" });
  });

  it("extracts the registry host", () => {
    expect(registryOf("hub.tnnlabs.space/feedzero")).toBe("hub.tnnlabs.space");
    expect(registryOf("localhost:5000/a/b")).toBe("localhost:5000");
  });
});

describe("parseEnvFile", () => {
  it("reads KEY=VALUE pairs, ignoring comments and blank lines", () => {
    const result = parseEnvFile(
      [
        "# deploy credentials",
        "",
        "IMAGE=hub.tnnlabs.space/feedzero",
        "REGISTRY_USERNAME=deploy",
        "REGISTRY_PASSWORD='p@ss=word'",
        'QUOTED="spaced value"',
      ].join("\r\n"),
    );

    expect(result.ok).toBe(true);
    expect(result.values).toEqual({
      IMAGE: "hub.tnnlabs.space/feedzero",
      REGISTRY_USERNAME: "deploy",
      REGISTRY_PASSWORD: "p@ss=word",
      QUOTED: "spaced value",
    });
  });

  it("reports a line that is not KEY=VALUE instead of silently skipping it", () => {
    const result = parseEnvFile("IMAGE=ok\nREGISTRY_PASSWORD\n");

    expect(result.ok).toBe(false);
    expect(result.error).toMatch(/line 2 is not KEY=VALUE/);
  });

  it("reports an invalid key", () => {
    const result = parseEnvFile("1BAD=value\n");

    expect(result.ok).toBe(false);
    expect(result.error).toMatch(/invalid key/);
  });
});

describe("resolveDeployPlan", () => {
  const env = [
    "IMAGE=hub.tnnlabs.space/feedzero",
    "REGISTRY_USERNAME=deploy",
    "REGISTRY_PASSWORD=s3cret",
  ].join("\n");

  it("reads image and credentials from the deploy env file", () => {
    const result = resolveDeployPlan({
      envText: env,
      version: "0.18.1",
      sha: SHA,
    });

    expect(result.ok).toBe(true);
    expect(result.plan.image).toBe(IMAGE);
    expect(result.plan.registry).toBe("hub.tnnlabs.space");
    expect(result.plan.username).toBe("deploy");
    expect(result.plan.password).toBe("s3cret");
  });

  it("lets an explicit image override the env file", () => {
    const result = resolveDeployPlan({
      envText: env,
      image: "hub.tnnlabs.space/other",
      version: "0.18.1",
      sha: SHA,
    });

    expect(result.plan.image).toBe("hub.tnnlabs.space/other");
  });

  it("plans an anonymous push when the registry has no credentials", () => {
    // The tnnlabs registry accepts unauthenticated pushes, so credentials
    // cannot be a hard requirement — but the plan has to say so explicitly,
    // because `docker login` with an empty password is a confusing failure.
    const result = resolveDeployPlan({
      envText: "IMAGE=hub.tnnlabs.space/feedzero",
      version: "0.18.1",
      sha: SHA,
    });

    expect(result.ok).toBe(true);
    expect(result.plan.anonymous).toBe(true);
    expect(result.plan.username).toBe("");
    expect(result.plan.password).toBe("");
  });

  it("rejects half-configured credentials", () => {
    // A typo'd key leaves exactly one half set; that must not quietly become
    // an anonymous push against a registry that does require auth.
    const result = resolveDeployPlan({
      envText: "IMAGE=hub.tnnlabs.space/feedzero\nREGISTRY_USERNAME=deploy",
      version: "0.18.1",
      sha: SHA,
    });

    expect(result.ok).toBe(false);
    expect(result.error).toMatch(/both REGISTRY_USERNAME and REGISTRY_PASSWORD/);
  });

  it("is not anonymous when both credentials are present", () => {
    const result = resolveDeployPlan({
      envText: env,
      version: "0.18.1",
      sha: SHA,
    });

    expect(result.ok).toBe(true);
    expect(result.plan.anonymous).toBe(false);
  });

  it("fails when no image is configured anywhere", () => {
    const result = resolveDeployPlan({
      envText: "",
      version: "0.18.1",
      sha: SHA,
    });

    expect(result.ok).toBe(false);
    expect(result.error).toMatch(/No image configured/);
  });
});

/**
 * The PowerShell script consumes this CLI's stdout as JSON and its exit code
 * as success/failure. That is a process boundary, so it needs its own
 * assertion — importing the module (as above) would not catch a broken CLI.
 */
describe("deploy-image CLI", () => {
  const cli = path.join(REPO, "scripts/lib/deploy-image.mjs");

  it("prints a JSON plan the script can parse", () => {
    const stdout = execFileSync(
      "node",
      [
        cli,
        "--version",
        "0.18.1",
        "--sha",
        SHA,
        "--image",
        IMAGE,
        "--no-env-file",
      ],
      { cwd: REPO, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] },
    );

    const plan = JSON.parse(stdout);
    expect(plan.ok).toBe(true);
    expect(plan.tags).toContain("hub.tnnlabs.space/feedzero:latest");
  });

  it("survives a missing deploy env file when credentials are not needed", () => {
    // `--deploy-env` is deliberately NOT `--env-file`: Node owns that flag and
    // aborts with `node: <path>: not found` (exit 9) before the script runs,
    // even when it appears after the script path. This was found by running
    // the PowerShell script, not by the unit tests — hence the assertion.
    const stdout = execFileSync(
      "node",
      [
        cli,
        "--version",
        "0.18.1",
        "--sha",
        SHA,
        "--image",
        IMAGE,
        "--deploy-env",
        ".env.deploy.does-not-exist",
      ],
      { cwd: REPO, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] },
    );

    expect(JSON.parse(stdout).ok).toBe(true);
  });

  it("exits non-zero with a parseable error when the image path is unusable", () => {
    let status = 0;
    let stdout = "";
    try {
      execFileSync(
        "node",
        [
          cli,
          "--version",
          "0.18.1",
          "--sha",
          SHA,
          "--image",
          "hub.tnnlabs.space/feedzero:latest",
          "--no-env-file",
        ],
        { cwd: REPO, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] },
      );
    } catch (error) {
      const failure = error as { status?: number; stdout?: string };
      status = failure.status ?? 0;
      stdout = failure.stdout ?? "";
    }

    expect(status).not.toBe(0);
    expect(JSON.parse(stdout).ok).toBe(false);
  });
});

describe(".env.deploy.example", () => {
  const example = readFileSync(
    path.join(REPO, ".env.deploy.example"),
    "utf8",
  );

  it("documents the image and the optional credential keys", () => {
    expect(example).toMatch(/^IMAGE=hub\.tnnlabs\.space\/feedzero$/m);
    for (const key of ["REGISTRY_USERNAME", "REGISTRY_PASSWORD"]) {
      expect(example, `missing ${key}`).toContain(key);
    }
  });

  it("plans an anonymous push from the template as-is", () => {
    // The tnnlabs registry has no auth. The shipped template must be usable
    // without uncommenting anything, or the first deploy fails on a doc step.
    const plan = resolveDeployPlan({
      envText: example,
      version: "0.18.1",
      sha: SHA,
    });

    expect(plan.ok).toBe(true);
    expect(plan.plan.image).toBe("hub.tnnlabs.space/feedzero");
    expect(plan.plan.anonymous).toBe(true);
  });

  it("is parsed cleanly by the same parser the script uses", () => {
    const parsed = parseEnvFile(example);
    expect(parsed.ok).toBe(true);
  });
});
