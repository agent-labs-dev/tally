import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

/** Whether a repository-relative path is one the scans leave out. */
export type Skip = (file: string) => boolean;

/** `ignorePaths` as a test: a file is skipped when any glob matches it. */
export function skipping(globs: readonly string[]): Skip {
  const matchers = globs.map((glob) => new Bun.Glob(glob));
  return (file) => matchers.some((matcher) => matcher.match(file));
}

const expression = /\$\{\{([\s\S]*?)\}\}/g;
const dotted = /(?<![\w.])secrets\.([A-Za-z_][A-Za-z0-9_]*)/g;
const indexed = /(?<![\w.])secrets\[\s*['"]([A-Za-z_][A-Za-z0-9_]*)['"]\s*\]/g;
const automatic = "GITHUB_TOKEN";

/** Every string in a parsed YAML document, keys included, so no comment ever reaches the scan. */
function strings(value: unknown): string[] {
  if (typeof value === "string") return [value];
  if (Array.isArray(value)) return value.flatMap(strings);
  if (value && typeof value === "object")
    return Object.entries(value).flatMap(([key, item]) => [key, ...strings(item)]);
  return [];
}

/**
 * Secret names the repository's workflows reference, mapped to the files that name them. Workflows are parsed, so
 * comments never count, and only `${{ }}` expressions do, so prose that mentions a secret is not a reference. Names are
 * upper-cased because GitHub treats them case-insensitively. Composite actions cannot read the `secrets` context, so
 * workflows are the only place to look. A workflow that is not valid YAML cannot run, so it references nothing.
 * `undefined` means there is no `.github/workflows` directory, so the root is not a checkout with anything to compare.
 */
export function referencedSecrets(root: string, skip: Skip = () => false): Map<string, string[]> | undefined {
  const workflows = join(root, ".github", "workflows");
  if (!existsSync(workflows)) return undefined;
  const files = readdirSync(workflows)
    .filter((name) => name.endsWith(".yml") || name.endsWith(".yaml"))
    .sort()
    .map((name) => `.github/workflows/${name}`)
    .filter((file) => !skip(file));

  const referenced = new Map<string, string[]>();
  for (const file of files) {
    let document: unknown;
    try {
      document = Bun.YAML.parse(readFileSync(join(root, file), "utf8"));
    } catch {
      continue;
    }
    for (const text of strings(document)) {
      for (const [, inner = ""] of text.matchAll(expression)) {
        for (const pattern of [dotted, indexed]) {
          for (const [, found] of inner.matchAll(pattern)) {
            const name = found?.toUpperCase();
            // The runner always provides this one, so nobody declares or rotates it.
            if (!name || name === automatic) continue;
            const places = referenced.get(name) ?? [];
            if (!places.includes(file)) places.push(file);
            referenced.set(name, places);
          }
        }
      }
    }
  }
  return referenced;
}

/**
 * Names that hold a credential by convention. Identifiers, hosts and flags (`*_ID`, `*_HOST`, `*_ENABLED`) do not
 * match. A tally file adds its own conventions in `credentialNames` and silences false matches with `ignore`.
 */
export const credentialName = /(KEY|TOKEN|SECRET|PASSWORD|PASSWD|PASSPHRASE|PAT|KEYSTORE|HOOK|DSN|CREDENTIALS?)$/;

/** Committed templates that list the variables an app reads. A real `.env` is never opened. */
const template = /(^|\/)(\.?env\.(example|sample|template|dist)|[\w.-]+\.env\.example|[\w.-]+\.example\.env)$/;
// A commented-out line is an optional key the template still documents, so it counts too.
const assignment = /^\s*(?:#\s*)?(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=/;

/**
 * Credential-named variables the code reads, from the env templates git tracks, mapped to the templates that list
 * them. Only the name left of `=` is read, never the value. `undefined` means the root is not a git checkout.
 */
export function templatedSecrets(
  root: string,
  extra: readonly string[] = [],
  skip: Skip = () => false,
): Map<string, string[]> | undefined {
  const listed = Bun.spawnSync(["git", "-C", root, "ls-files", "-z"], { stdout: "pipe", stderr: "ignore" });
  if (listed.exitCode !== 0) return undefined;
  const patterns = [credentialName, ...extra.map((pattern) => new RegExp(pattern))];
  const files = listed.stdout
    .toString()
    .split("\0")
    .filter((file) => template.test(file) && !skip(file))
    .sort();

  const found = new Map<string, string[]>();
  for (const file of files) {
    for (const line of readFileSync(join(root, file), "utf8").split("\n")) {
      const name = assignment.exec(line)?.[1]?.toUpperCase();
      if (!name || !patterns.some((pattern) => pattern.test(name))) continue;
      const places = found.get(name) ?? [];
      if (!places.includes(file)) places.push(file);
      found.set(name, places);
    }
  }
  return found;
}
