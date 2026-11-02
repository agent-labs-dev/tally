import { existsSync, mkdirSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { addSecretPatterns, type Entry, looksSecret, parseEntry, serialise, withheld } from "./schema";

/** Settings that differ between repositories, kept in the tally file so none of them is a code change. */
export interface Config {
  /** A dated key raises an issue this many days before it expires. */
  warnDays: number;
  /** Extra regular expressions for credential formats the built-in guard does not know. */
  secretPatterns: string[];
  /** Secret names workflows reference that are not credentials, such as ids and URLs. */
  ignore: string[];
  /** Where `issues sync` files issues when `--repo` is not given. */
  issueRepo?: string;
}

export const defaultConfig: Config = { warnDays: 30, secretPatterns: [], ignore: [] };

export interface LoadProblem {
  path: string;
  message: string;
}

export interface LoadedTallyFile {
  config: Config;
  entries: Entry[];
  errors: LoadProblem[];
}

const settings = new Set(["warnDays", "issueRepo", "secretPatterns", "ignore", "keys"]);
const repoName = /^[\w.-]+\/[\w.-]+$/;

function stringList(value: unknown): string[] | undefined {
  if (!Array.isArray(value) || !value.every((item) => typeof item === "string")) return undefined;
  return value as string[];
}

function freshConfig(): Config {
  return { warnDays: defaultConfig.warnDays, secretPatterns: [], ignore: [] };
}

/**
 * Read one `.tally.yaml`. The raw text is scanned before parsing, because YAML comments and quoting never reach the
 * parsed entry, and the secret patterns it declares are registered before any entry is validated.
 */
export async function loadTallyFile(path: string): Promise<LoadedTallyFile> {
  const config = freshConfig();
  const errors: LoadProblem[] = [];
  if (!existsSync(path)) {
    addSecretPatterns(config.secretPatterns);
    errors.push({ path, message: "no tally file here, so create one with `tally init` or `tally add`" });
    return { config, entries: [], errors };
  }
  const text = await Bun.file(path).text();
  if (looksSecret(text)) {
    addSecretPatterns(config.secretPatterns);
    errors.push({ path, message: "contains text that looks like a credential, so it was rejected" });
    return { config, entries: [], errors };
  }
  let raw: unknown;
  try {
    raw = Bun.YAML.parse(text) ?? {};
  } catch (error) {
    addSecretPatterns(config.secretPatterns);
    errors.push({ path, message: `not valid YAML: ${(error as Error).message}` });
    return { config, entries: [], errors };
  }
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
    addSecretPatterns(config.secretPatterns);
    errors.push({ path, message: "a tally file is a mapping of settings and keys" });
    return { config, entries: [], errors };
  }
  const record = raw as Record<string, unknown>;
  for (const key of Object.keys(record)) {
    if (!settings.has(key)) errors.push({ path, message: `unknown setting ${withheld(key)}` });
  }

  const warnDays = record.warnDays;
  if (warnDays !== undefined) {
    if (Number.isInteger(warnDays) && (warnDays as number) > 0) config.warnDays = warnDays as number;
    else errors.push({ path, message: "warnDays must be a positive whole number" });
  }
  const issueRepo = record.issueRepo;
  if (issueRepo !== undefined) {
    if (typeof issueRepo === "string" && repoName.test(issueRepo)) config.issueRepo = issueRepo;
    else errors.push({ path, message: "issueRepo must be OWNER/NAME" });
  }
  if (record.secretPatterns !== undefined) {
    const list = stringList(record.secretPatterns);
    if (list) config.secretPatterns = list;
    else errors.push({ path, message: "secretPatterns must be a list of regular expressions" });
  }
  if (record.ignore !== undefined) {
    const list = stringList(record.ignore);
    if (list) config.ignore = list;
    else errors.push({ path, message: "ignore must be a list of secret names" });
  }
  // Before the entries: every one of them is checked against these patterns. The raw text is checked again too,
  // because a comment that only this file's own patterns catch never reaches a parsed entry.
  addSecretPatterns(config.secretPatterns);
  if (config.secretPatterns.length > 0 && looksSecret(text)) {
    errors.push({ path, message: "contains text that looks like a credential, so it was rejected" });
    return { config, entries: [], errors };
  }

  const entries: Entry[] = [];
  if (record.keys !== undefined) {
    if (!Array.isArray(record.keys)) errors.push({ path, message: "keys must be a list of entries" });
    else {
      const seen = new Set<string>();
      for (const item of record.keys) {
        const parsed = parseEntry(item);
        for (const message of parsed.errors) errors.push({ path, message });
        const entry = parsed.entry;
        if (!entry) continue;
        if (seen.has(entry.id)) {
          errors.push({ path, message: `duplicate id ${withheld(entry.id)}` });
          continue;
        }
        seen.add(entry.id);
        entries.push(entry);
      }
    }
  }
  return { config, entries, errors };
}

/** Validates every entry, then rewrites the whole file: settings first, then `keys:`. */
export async function writeTallyFile(path: string, config: Config, entries: readonly Entry[]): Promise<void> {
  const problems: string[] = [];
  const seen = new Set<string>();
  const keys = entries.map((entry) => {
    const shape = serialise(entry);
    for (const message of parseEntry(shape).errors) problems.push(message);
    if (seen.has(entry.id)) problems.push(`duplicate id ${withheld(entry.id)}`);
    seen.add(entry.id);
    return shape;
  });
  if (problems.length > 0) throw new Error(problems.join("; "));

  const document: Record<string, unknown> = {
    warnDays: config.warnDays,
    issueRepo: config.issueRepo,
    secretPatterns: config.secretPatterns,
    ignore: config.ignore,
    keys,
  };
  if (document.issueRepo === undefined) delete document.issueRepo;
  mkdirSync(dirname(path), { recursive: true });
  await Bun.write(path, `${Bun.YAML.stringify(document, null, 2).trimEnd()}\n`);
}

/**
 * Where the tally file is. A repository declares its keys in `.tally.yaml` at its root; one machine's keys live in the
 * user config directory instead. A path that does not exist yet is still a valid answer, because `tally add` creates it.
 */
export function findTallyFile(cwd: string, env: Record<string, string | undefined> = {}): string {
  if (env.TALLY_CONFIG) return resolve(cwd, env.TALLY_CONFIG);
  let dir = resolve(cwd);
  for (;;) {
    const candidate = join(dir, ".tally.yaml");
    if (existsSync(candidate)) return candidate;
    // The repository root is the last directory to look in, so a parent checkout never wins over this one.
    if (existsSync(join(dir, ".git"))) return candidate;
    const parent = dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  const configHome = env.XDG_CONFIG_HOME ?? join(env.HOME ?? homedir(), ".config");
  return join(configHome, "tally", "tally.yaml");
}
