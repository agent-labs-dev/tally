import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

const expression = /\$\{\{([\s\S]*?)\}\}/g;
const dotted = /\bsecrets\.([A-Za-z_][A-Za-z0-9_]*)/g;
const indexed = /\bsecrets\[\s*['"]([A-Za-z_][A-Za-z0-9_]*)['"]\s*\]/g;
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
export function referencedSecrets(root: string): Map<string, string[]> | undefined {
  const workflows = join(root, ".github", "workflows");
  if (!existsSync(workflows)) return undefined;
  const files = readdirSync(workflows)
    .filter((name) => name.endsWith(".yml") || name.endsWith(".yaml"))
    .sort()
    .map((name) => `.github/workflows/${name}`);

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
