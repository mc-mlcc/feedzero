/** Type surface for scripts/lib/deploy-image.mjs. */

export interface ImagePathResult {
  ok: boolean;
  image: string;
  /** Present when ok is false. */
  error?: string;
}

export interface ImageTagsResult {
  ok: boolean;
  image: string;
  registry: string;
  /** Every tag for one build: vX.Y.Z, X.Y, (latest), sha-<commit>. */
  tags: string[];
  /** `v`-prefixed, e.g. v0.18.1. */
  version: string;
  /** Major.minor, e.g. 0.18. */
  minor: string;
  /** First 7 characters of the commit id. */
  shortSha: string;
  /** Present when ok is false. */
  error?: string;
}

export interface EnvFileResult {
  ok: boolean;
  values: Record<string, string>;
  /** Present when ok is false. */
  error?: string;
}

export interface DeployPlanConfig {
  image: string;
  registry: string;
  tags: string[];
  version: string;
  minor: string;
  shortSha: string;
  username: string;
  password: string;
}

export interface DeployPlanResult {
  ok: boolean;
  plan: DeployPlanConfig;
  /** Present when ok is false. */
  error?: string;
}

export function validateImagePath(image: string): ImagePathResult;

export function registryOf(image: string): string;

export function computeImageTags(params: {
  image: string;
  version: string;
  sha: string;
  includeLatest?: boolean;
}): ImageTagsResult;

export function parseEnvFile(text: string): EnvFileResult;

export function resolveDeployPlan(params: {
  envText?: string;
  image?: string;
  version: string;
  sha: string;
  requireAuth?: boolean;
  includeLatest?: boolean;
}): DeployPlanResult;
