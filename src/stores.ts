/**
 * Read-only metadata from secret stores, through each vendor's own CLI and the login it already has. A store reader
 * asks for names and dates only: `runCommand` runs nothing outside `metadataCommands`, so no reader can call a
 * command that prints, sets or backs up a value. A new store is one more `Store` in `stores`, with no other code change.
 */

/** One `kind: scope` line under `sources:` in a tally file, such as `gcp: my-project` or `aws: eu-west-1`. */
export interface Source {
  kind: string;
  scope: string;
  /** Narrows the listing in the store's own filter syntax, such as `labels.app=web` for gcp or a name prefix for aws. */
  filter?: string;
}

/** What a store says about one secret. Dates are YYYY-MM-DD. */
export interface Observation {
  kind: string;
  scope: string;
  name: string;
  /** When the value last changed: the newest enabled version, the last rotation, or the last update. */
  changed?: string;
  expires?: string;
}

/** Runs one command and returns its stdout, or throws. Injected so tests never reach a real store. */
export type Run = (argv: string[]) => Promise<string>;

export interface Store {
  /** What the scope names, for help text and errors. */
  scope: string;
  list(source: Source, run: Run): Promise<Observation[]>;
}

/**
 * The only commands a reader may run: listings that print names and dates. Anything else, including every command
 * that prints, sets or backs up a value, is refused by `runCommand` before it starts.
 */
export const metadataCommands = [
  ["gcloud", "secrets", "list"],
  ["gcloud", "secrets", "versions", "list"],
  ["aws", "secretsmanager", "list-secrets"],
  ["az", "keyvault", "secret", "list"],
];

/** Whether argv starts with one of those listings. Each CLI takes its subcommand from these leading words. */
export function isMetadataCommand(argv: readonly string[]): boolean {
  return metadataCommands.some((words) => words.every((word, at) => argv[at] === word));
}

function day(value: unknown): string | undefined {
  if (typeof value !== "string" && typeof value !== "number") return undefined;
  // AWS can print epoch seconds; everything else prints ISO 8601.
  const date = new Date(typeof value === "number" ? value * 1000 : value);
  return Number.isNaN(date.getTime()) ? undefined : date.toISOString().slice(0, 10);
}

function latest(...dates: (string | undefined)[]): string | undefined {
  return dates
    .filter((date): date is string => date !== undefined)
    .sort()
    .at(-1);
}

function json(text: string): unknown {
  return JSON.parse(text || "[]");
}

/** Google Cloud Secret Manager: `gcp: PROJECT`. The newest enabled version's date is when the value last changed. */
const gcp: Store = {
  scope: "project id",
  async list(source, run) {
    const listing = json(
      await run([
        "gcloud",
        "secrets",
        "list",
        `--project=${source.scope}`,
        "--format=json",
        ...(source.filter ? [`--filter=${source.filter}`] : []),
      ]),
    ) as { name: string; createTime?: string; expireTime?: string }[];
    const observations: Observation[] = [];
    // A few at a time: one call per secret is the only metadata-only way to see its newest version.
    for (let at = 0; at < listing.length; at += 8) {
      const batch = listing.slice(at, at + 8).map(async (secret) => {
        const name = secret.name.split("/").pop() ?? secret.name;
        const versions = json(
          await run([
            "gcloud",
            "secrets",
            "versions",
            "list",
            name,
            `--project=${source.scope}`,
            "--filter=state:ENABLED",
            "--sort-by=~createTime",
            "--limit=1",
            "--format=json",
          ]),
        ) as { createTime?: string }[];
        return {
          kind: "gcp",
          scope: source.scope,
          name,
          changed: day(versions[0]?.createTime) ?? day(secret.createTime),
          expires: day(secret.expireTime),
        };
      });
      observations.push(...(await Promise.all(batch)));
    }
    return observations;
  },
};

/** AWS Secrets Manager: `aws: REGION`, with `filter` as a name prefix. */
const aws: Store = {
  scope: "region",
  async list(source, run) {
    const listing = json(
      await run([
        "aws",
        "secretsmanager",
        "list-secrets",
        `--region=${source.scope}`,
        "--output=json",
        ...(source.filter ? ["--filters", `Key=name,Values=${source.filter}`] : []),
      ]),
    ) as { SecretList?: Record<string, unknown>[] };
    return (listing.SecretList ?? [])
      .filter((secret) => secret.DeletedDate === undefined)
      .map((secret) => ({
        kind: "aws",
        scope: source.scope,
        name: String(secret.Name),
        changed: latest(day(secret.LastRotatedDate), day(secret.LastChangedDate)) ?? day(secret.CreatedDate),
      }));
  },
};

/** Azure Key Vault: `azure: VAULT-NAME`. The listing carries each secret's update and expiry dates. */
const azure: Store = {
  scope: "vault name",
  async list(source, run) {
    const listing = json(
      await run(["az", "keyvault", "secret", "list", `--vault-name=${source.scope}`, "--output=json"]),
    ) as { id: string; attributes?: { updated?: string; expires?: string } }[];
    return listing.map((secret) => ({
      kind: "azure",
      scope: source.scope,
      name: secret.id.split("/").pop() ?? secret.id,
      changed: day(secret.attributes?.updated),
      expires: day(secret.attributes?.expires),
    }));
  },
};

export const stores: Record<string, Store> = { gcp, aws, azure };

/** The same secret in any letter case, so one secret listed twice is one observation and one finding id. */
export function observationKey({ kind, scope, name }: Observation): string {
  return `${kind}:${scope}:${name}`.toLowerCase();
}

/**
 * Every source's observations, each secret once. A store that fails stops the run, so a check never passes on a
 * partial view.
 */
export async function observe(sources: readonly Source[], run: Run): Promise<Observation[]> {
  const all = new Map<string, Observation>();
  for (const source of sources) {
    const store = stores[source.kind];
    if (!store) throw new Error(`no reader for source kind ${source.kind}`);
    for (const observation of await store.list(source, run)) all.set(observationKey(observation), observation);
  }
  return [...all.values()];
}

/** Runs a store CLI. Its stderr is not echoed, because it can quote whatever the command touched. */
export const runCommand: Run = async (argv) => {
  if (!isMetadataCommand(argv)) throw new Error(`refusing to run ${argv[0]}: only secret listings are allowed`);
  const proc = Bun.spawn(argv, { stdout: "pipe", stderr: "ignore" });
  const [stdout, code] = await Promise.all([new Response(proc.stdout).text(), proc.exited]);
  if (code !== 0) throw new Error(`${argv.slice(0, 3).join(" ")} failed with exit ${code}; check its login and access`);
  return stdout;
};
