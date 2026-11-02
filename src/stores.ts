/**
 * Read-only metadata from secret stores, through each vendor's own CLI and the login it already has. A store reader
 * asks for names and dates only: it never calls a command that returns a secret value, and `valueCommands` is the
 * test that holds every reader to that. A new store is one more `Store` in `stores`, with no other code change.
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

/** Subcommands that print a secret value. No reader may build a command containing one of these. */
export const valueCommands = [
  ["secrets", "versions", "access"],
  ["secretsmanager", "get-secret-value"],
  ["secretsmanager", "batch-get-secret-value"],
  ["keyvault", "secret", "show"],
  ["keyvault", "secret", "download"],
];

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
        "--region",
        source.scope,
        "--output",
        "json",
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
      await run(["az", "keyvault", "secret", "list", "--vault-name", source.scope, "--output", "json"]),
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

/** Every source's observations. A store that fails stops the run, so a check never passes on a partial view. */
export async function observe(sources: readonly Source[], run: Run): Promise<Observation[]> {
  const all: Observation[] = [];
  for (const source of sources) {
    const store = stores[source.kind];
    if (!store) throw new Error(`no reader for source kind ${source.kind}`);
    all.push(...(await store.list(source, run)));
  }
  return all;
}

/** Runs a store CLI. Its stderr is not echoed, because it can quote whatever the command touched. */
export const runCommand: Run = async (argv) => {
  for (const banned of valueCommands)
    if (banned.every((word) => argv.includes(word))) throw new Error(`refusing to run a value command: ${argv[0]}`);
  const proc = Bun.spawn(argv, { stdout: "pipe", stderr: "ignore" });
  const [stdout, code] = await Promise.all([new Response(proc.stdout).text(), proc.exited]);
  if (code !== 0) throw new Error(`${argv.slice(0, 3).join(" ")} failed with exit ${code}; check its login and access`);
  return stdout;
};
