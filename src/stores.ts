import { lstat, readdir, stat } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import { parseEntry, withheld } from "./schema";

/**
 * Read-only metadata from the places keys live: secret stores, through each vendor's own CLI and the login it already
 * has, and provider key listings, through the provider's admin API. A reader asks for names and dates only:
 * `runCommand` runs nothing outside `metadataCommands`, and a provider's `get` calls nothing but GET on that provider's
 * own key-listing paths, holding the admin token itself so reader code never sees it. A new place is one more `Store`
 * in `stores`, with no other code change.
 */

/** One `kind: scope` line under `sources:` in a tally file, such as `gcp: my-project` or `aws: eu-west-1`. */
export interface Source {
  kind: string;
  scope: string;
  /** Narrows the listing in the store's own filter syntax, such as `labels.app=web` for gcp or a name prefix for aws. */
  filter?: string;
  /** For a provider: the environment variable holding its admin token, when not the provider's default name. */
  token?: string;
}

/** What a store says about one secret. Dates are YYYY-MM-DD. */
export interface Observation {
  kind: string;
  scope: string;
  name: string;
  /** When the value last changed: the newest enabled version, the last rotation, or the last update. */
  changed?: string;
  /** A date, or `none` when a provider reports that the key never expires. */
  expires?: string;
  /** When the provider last saw the key used. */
  lastUsed?: string;
  /** The spend limit a provider reports, such as `$50 per monthly`, or `none`. */
  limit?: string;
  /** When the store deletes the secret itself. That is not the credential's expiry. */
  deletion?: string;
  /** Facts the store records about the key, which fill in a tally entry that says `unknown`. */
  owner?: string;
  service?: string;
  expiresNote?: string;
  runbook?: string;
}

/** Runs one command and returns its stdout, or throws. Injected so tests never reach a real store. */
export type Run = (argv: string[]) => Promise<string>;

/** A GET of one allowed path on a provider's API, returning parsed JSON. Built by `apiGet`; readers never see the token. */
export type Get = (path: string, query?: Record<string, string>) => Promise<unknown>;

/** Injected so tests never reach a real provider. */
export type Fetch = (url: string, init: RequestInit) => Promise<Response>;

export interface Reader {
  run: Run;
  get: Get;
  /** The injected environment, so a reader that locates files never reads `process.env` itself. */
  env: Record<string, string | undefined>;
}

/** Where a provider's key listing lives and how its admin token is sent. */
export interface Api {
  origin: string;
  /** The only paths `get` may call: key and project listings. */
  paths: RegExp[];
  /** The environment variable read for the admin token unless the source names another. */
  token: string;
  headers: (token: string) => Record<string, string>;
}

export interface Store {
  /** What the scope names, for help text and errors. */
  scope: string;
  /** What a scope may look like, when not a plain name. Never a flag or a path that escapes the listing. */
  scopePattern?: RegExp;
  api?: Api;
  /**
   * Names are case-sensitive free text and a location matches only by its exact `SCOPE/NAME` (or bare `NAME`). `init`
   * never drafts or links one, because a copy in this store is storage and not evidence of the same value elsewhere.
   */
  exact?: boolean;
  list(source: Source, read: Reader): Promise<Observation[]>;
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

const ghSecretsJq = ".secrets[] | [.name, .updated_at] | @tsv";
const ghEnvironmentsJq = ".environments[].name | @uri";
const ghPath =
  /^(repos\/[\w.-]+\/[\w.-]+\/(actions\/secrets|environments|environments\/[\w.~%-]+\/secrets)|orgs\/[\w.-]+\/actions\/secrets)\?per_page=100$/;
const ghOwnerPath = /^users\/[A-Za-z0-9-]+$/;

/**
 * Whether argv is an allowed listing. A store CLI takes its subcommand from the leading words above. `gh api` is
 * matched whole instead, because any extra argument, such as `-X` or `-f`, could turn a listing into a write.
 */
export function isMetadataCommand(argv: readonly string[]): boolean {
  if (argv[0] === "gh" && argv.length === 5 && argv[1] === "api" && argv[2] === "--jq" && argv[3] === ".type")
    return ghOwnerPath.test(argv[4] ?? "");
  if (argv[0] === "gh")
    return (
      argv.length === 6 &&
      argv[1] === "api" &&
      argv[2] === "--paginate" &&
      argv[3] === "--jq" &&
      (argv[4] === ghSecretsJq || argv[4] === ghEnvironmentsJq) &&
      ghPath.test(argv[5] ?? "")
    );
  return metadataCommands.some((words) => words.every((word, at) => argv[at] === word));
}

/** Looks up GitHub owner types, leaving out owners whose lookup fails because gh is unavailable or access is denied. */
export async function ownerTypes(owners: Iterable<string>, run: Run): Promise<Map<string, string>> {
  const types = new Map<string, string>();
  await Promise.all(
    [...new Set(owners)]
      .filter((owner) => owner !== "unknown")
      .map(async (owner) => {
        try {
          types.set(owner, (await run(["gh", "api", "--jq", ".type", `users/${owner}`])).trim());
        } catch {
          // An owner lookup is advisory. A failed lookup must not make a check fail or invent an owner type.
        }
      }),
  );
  return types;
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

/** The Secret Manager annotations tally reads. Names carry no slash, which annotation keys do not allow. */
const gcpAnnotations = {
  "tally-owner": "owner",
  "tally-service": "service",
  "tally-expires": "expires",
  "tally-expires-note": "expiresNote",
  "tally-limit": "limit",
  "tally-runbook": "runbook",
} as const;

/**
 * The credential facts a secret's annotations carry. Only the supported keys are read, and they go through the same
 * validator as a tally file entry, so a malformed or credential-shaped value fails the run without being echoed.
 */
function gcpFacts(name: string, annotations: Record<string, unknown> | undefined) {
  const raw: Record<string, unknown> = { id: "annotations", locations: [{ gcp: "annotations" }] };
  for (const [key, field] of Object.entries(gcpAnnotations))
    if (annotations && key in annotations) raw[field] = annotations[key];
  raw.service ??= "unknown";
  raw.owner ??= "unknown";
  raw.expires ??= "unknown";
  raw.limit ??= "unknown";
  const { entry, errors } = parseEntry(raw);
  if (!entry) throw new Error(`gcp secret ${withheld(name)} has invalid tally annotations: ${errors.join("; ")}`);
  const known = (value: string | undefined) => (value === "unknown" ? undefined : value);
  return {
    owner: known(entry.owner),
    service: known(entry.service),
    expires: known(entry.expires),
    expiresNote: entry.expiresNote,
    limit: known(entry.limit),
    runbook: entry.runbook,
  };
}

/**
 * Google Cloud Secret Manager: `gcp: PROJECT`. The newest enabled version's date is when the value last changed. A
 * secret's `expireTime` deletes the secret, not the credential, so it is `deletion` and never `expires`. Credential
 * facts come from `tally-*` annotations.
 */
const gcp: Store = {
  scope: "project id",
  async list(source, { run }) {
    const listing = json(
      await run([
        "gcloud",
        "secrets",
        "list",
        `--project=${source.scope}`,
        "--format=json",
        ...(source.filter ? [`--filter=${source.filter}`] : []),
      ]),
    ) as { name: string; createTime?: string; expireTime?: string; annotations?: Record<string, unknown> }[];
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
          deletion: day(secret.expireTime),
          ...gcpFacts(name, secret.annotations),
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
  async list(source, { run }) {
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
  async list(source, { run }) {
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

/**
 * GitHub Actions secrets: `github: OWNER/NAME` for a repository's secrets and its environments' secrets, named
 * `NAME` and `env:ENVIRONMENT/NAME`, or `github: ORG` for an organization's. `filter` is a comma-separated list of the
 * environments to read, for a repository with many. Read through `gh` and its login, which needs admin access: the
 * Actions token of a workflow cannot list secrets.
 */
const github: Store = {
  scope: "repository as OWNER/NAME, or an organization",
  scopePattern: /^[\w.-]+(\/[\w.-]+)?$/,
  async list(source, { run }) {
    const lines = async (jq: string, path: string) =>
      (await run(["gh", "api", "--paginate", "--jq", jq, `${path}?per_page=100`])).split("\n").filter(Boolean);
    const secrets = async (path: string, prefix = ""): Promise<Observation[]> =>
      (await lines(ghSecretsJq, path)).map((line) => {
        const [name, updated] = line.split("\t");
        return { kind: "github", scope: source.scope, name: `${prefix}${name}`, changed: day(updated) };
      });
    if (!source.scope.includes("/")) return secrets(`orgs/${source.scope}/actions/secrets`);
    const wanted = source.filter?.split(",").map((name) => name.trim());
    const observations = await secrets(`repos/${source.scope}/actions/secrets`);
    // jq URL-encodes each name, so a name holding a newline or a slash stays one path segment on one line.
    for (const encoded of await lines(ghEnvironmentsJq, `repos/${source.scope}/environments`)) {
      const environment = decodeURIComponent(encoded);
      if (!wanted || wanted.includes(environment))
        observations.push(
          ...(await secrets(`repos/${source.scope}/environments/${encoded}/secrets`, `env:${environment}/`)),
        );
    }
    return observations;
  },
};

/** A provider's listing past this many pages is cut off with an error rather than read forever. */
const maxPages = 100;

function pageLimit(kind: string): never {
  throw new Error(`${kind} listed more than ${maxPages} pages; narrow it with a filter`);
}

/**
 * The cursor for the next page, or undefined on the last one. A listing that says there is more but gives no cursor
 * fails, because stopping there would report every later key as missing.
 */
function nextCursor(kind: string, body: { has_more?: unknown; last_id?: unknown }): string | undefined {
  if (body.has_more !== true) return undefined;
  if (typeof body.last_id !== "string" || !body.last_id)
    throw new Error(`${kind} said there were more keys but gave no cursor`);
  return body.last_id;
}

/** A provider expiry: a date, or `none` when the provider says the key never expires. */
function expiry(value: unknown): string | undefined {
  return value === null ? "none" : day(value);
}

interface ProviderKey {
  name?: unknown;
  status?: unknown;
  disabled?: unknown;
  created_at?: unknown;
  expires_at?: unknown;
  last_used_at?: unknown;
  limit?: unknown;
  limit_reset?: unknown;
}

/**
 * Anthropic Admin API: `anthropic: LABEL`, where the label names the organization in locations. `filter` is a
 * workspace id. Archived and inactive keys are skipped; an expired one stays so its entry reports it.
 */
const anthropic: Store = {
  scope: "label for the organization",
  api: {
    origin: "https://api.anthropic.com",
    paths: [/^\/v1\/organizations\/api_keys$/],
    token: "TALLY_ANTHROPIC_ADMIN_KEY",
    headers: (token) => ({ "x-api-key": token, "anthropic-version": "2023-06-01" }),
  },
  async list(source, { get }) {
    const observations: Observation[] = [];
    let after: string | undefined;
    for (let page = 0; page < maxPages; page++) {
      const body = (await get("/v1/organizations/api_keys", {
        limit: "1000",
        ...(source.filter ? { workspace_id: source.filter } : {}),
        ...(after ? { after_id: after } : {}),
      })) as { data?: ProviderKey[]; has_more?: unknown; last_id?: unknown };
      for (const key of body.data ?? [])
        if (key.status === "active" || key.status === "expired")
          observations.push({
            kind: "anthropic",
            scope: source.scope,
            name: String(key.name),
            changed: day(key.created_at),
            expires: expiry(key.expires_at),
          });
      after = nextCursor("anthropic", body);
      if (!after) return observations;
    }
    return pageLimit("anthropic");
  },
};

/**
 * OpenAI Admin API: `openai: LABEL`, listing the API keys of every active project as `PROJECT_ID/KEY`, since a project
 * name can be empty or change. `filter` is a project id.
 */
const openai: Store = {
  scope: "label for the organization",
  api: {
    origin: "https://api.openai.com",
    paths: [/^\/v1\/organization\/projects$/, /^\/v1\/organization\/projects\/[\w-]+\/api_keys$/],
    token: "TALLY_OPENAI_ADMIN_KEY",
    headers: (token) => ({ authorization: `Bearer ${token}` }),
  },
  async list(source, { get }) {
    const all = async <T>(path: string, query: Record<string, string> = {}): Promise<T[]> => {
      const items: T[] = [];
      let after: string | undefined;
      for (let page = 0; page < maxPages; page++) {
        const body = (await get(path, { ...query, limit: "100", ...(after ? { after } : {}) })) as {
          data?: T[];
          has_more?: unknown;
          last_id?: unknown;
        };
        items.push(...(body.data ?? []));
        after = nextCursor("openai", body);
        if (!after) return items;
      }
      return pageLimit("openai");
    };
    const projects = (
      await all<{ id?: unknown; name?: unknown; status?: unknown }>("/v1/organization/projects")
    ).filter(
      (project) =>
        project.status === "active" &&
        typeof project.id === "string" &&
        /^[\w-]+$/.test(project.id) &&
        (!source.filter || project.id === source.filter),
    );
    const observations: Observation[] = [];
    // Without `any`, OpenAI hides keys whose owner has left the project, and they would read as missing.
    for (const project of projects)
      for (const key of await all<ProviderKey>(`/v1/organization/projects/${project.id}/api_keys`, {
        owner_project_access: "any",
      }))
        observations.push({
          kind: "openai",
          scope: source.scope,
          name: `${project.id}/${String(key.name)}`,
          changed: day(key.created_at),
          expires: expiry(key.expires_at),
          lastUsed: day(key.last_used_at),
        });
    return observations;
  },
};

/**
 * OpenRouter: `openrouter: LABEL`, read with a management key. `filter` is a workspace id. Disabled keys are skipped.
 * Each key carries its spend limit and reset period.
 */
const openrouter: Store = {
  scope: "label for the account",
  api: {
    origin: "https://openrouter.ai",
    paths: [/^\/api\/v1\/keys$/],
    token: "TALLY_OPENROUTER_MANAGEMENT_KEY",
    headers: (token) => ({ authorization: `Bearer ${token}` }),
  },
  async list(source, { get }) {
    const observations: Observation[] = [];
    let offset = 0;
    for (let page = 0; page < maxPages; page++) {
      const body = (await get("/api/v1/keys", {
        include_expired: "true",
        offset: String(offset),
        ...(source.filter ? { workspace_id: source.filter } : {}),
      })) as { data?: ProviderKey[] };
      const keys = body.data ?? [];
      if (!keys.length) return observations;
      offset += keys.length;
      for (const key of keys)
        if (key.disabled !== true)
          observations.push({
            kind: "openrouter",
            scope: source.scope,
            name: String(key.name),
            changed: day(key.created_at),
            expires: expiry(key.expires_at),
            lastUsed: day(key.last_used_at),
            limit:
              typeof key.limit === "number"
                ? `$${key.limit}${typeof key.limit_reset === "string" ? ` per ${key.limit_reset}` : ""}`
                : key.limit === null
                  ? "none"
                  : undefined,
          });
    }
    return pageLimit("openrouter");
  },
};

/**
 * Cloudflare API tokens: `cloudflare: user` for the tokens of the user the reader token belongs to, or
 * `cloudflare: ACCOUNT_ID` for an account's tokens. The reader token needs only API Tokens Read. Disabled tokens are
 * skipped.
 */
const cloudflare: Store = {
  scope: "`user` or a 32-character account id",
  api: {
    origin: "https://api.cloudflare.com",
    paths: [/^\/client\/v4\/user\/tokens$/, /^\/client\/v4\/accounts\/[0-9a-f]{32}\/tokens$/],
    token: "TALLY_CLOUDFLARE_TOKEN_READER",
    headers: (token) => ({ authorization: `Bearer ${token}` }),
  },
  async list(source, { get }) {
    if (source.scope !== "user" && !/^[0-9a-f]{32}$/i.test(source.scope))
      throw new Error(`cloudflare scope ${source.scope} must be user or a 32-character account id`);
    const path =
      source.scope === "user" ? "/client/v4/user/tokens" : `/client/v4/accounts/${source.scope.toLowerCase()}/tokens`;
    const observations: Observation[] = [];
    for (let page = 1; page <= maxPages; page++) {
      const body = (await get(path, { page: String(page), per_page: "50", include_expired: "true" })) as {
        result?: {
          name?: unknown;
          status?: unknown;
          issued_on?: unknown;
          modified_on?: unknown;
          expires_on?: unknown;
          last_used_on?: unknown;
        }[];
        result_info?: { total_count?: unknown };
      };
      const tokens = body.result ?? [];
      for (const token of tokens)
        if (token.status !== "disabled")
          observations.push({
            kind: "cloudflare",
            scope: source.scope,
            name: String(token.name),
            changed: day(token.modified_on) ?? day(token.issued_on),
            expires: token.expires_on ? day(token.expires_on) : "none",
            lastUsed: day(token.last_used_on),
          });
      // The total is optional; without it, a short page is the last one.
      const total = body.result_info?.total_count;
      if (!tokens.length || (typeof total === "number" ? page * 50 >= total : tokens.length < 50)) return observations;
    }
    return pageLimit("cloudflare");
  },
};

/**
 * Unix pass: `pass: LABEL` with an optional `filter` that is a literal prefix of the entry names. The label is only a
 * name for this store in locations. The store is `PASSWORD_STORE_DIR`, else `~/.password-store`. Only directory
 * listings and the mtime of each `.gpg` file are read: never a file's bytes, and never `pass` or `gpg`. The mtime is
 * when the ciphertext last changed, which a re-encryption or a touch moves without any rotation.
 */
const pass: Store = {
  scope: "label for this password store",
  exact: true,
  async list(source, { env }) {
    const root = env.PASSWORD_STORE_DIR || join(env.HOME || homedir(), ".password-store");
    // The root is the one path that may be a symlink, because a person chose it. Nothing below it is followed.
    try {
      if (!(await stat(root)).isDirectory()) throw new Error("not a directory");
    } catch {
      throw new Error(`pass store ${source.scope} is missing or unreadable; set PASSWORD_STORE_DIR`);
    }
    const prefix = source.filter ?? "";
    const observations: Observation[] = [];
    const walk = async (dir: string, rel: string): Promise<void> => {
      let items: import("node:fs").Dirent[];
      try {
        items = await readdir(dir, { withFileTypes: true });
      } catch {
        throw new Error(`pass store ${source.scope} has an unreadable directory ${rel || "."}`);
      }
      for (const item of items.sort((a, b) => (a.name < b.name ? -1 : 1))) {
        const path = rel ? `${rel}/${item.name}` : item.name;
        if (!rel && (item.name === ".git" || item.name === ".extensions")) continue;
        // A path is relevant when a name under it can start with the filter, or it is itself such a name.
        const relevant = `${path}/`.startsWith(prefix) || prefix.startsWith(`${path}/`) || path.startsWith(prefix);
        if (item.isSymbolicLink()) {
          // Following one could list or date files outside the store.
          if (relevant) throw new Error(`pass store ${source.scope} has a symlink at ${path}; not followed`);
        } else if (item.isDirectory()) {
          if (relevant) await walk(join(dir, item.name), path);
        } else if (item.isFile() && item.name.endsWith(".gpg") && item.name.length > 4) {
          const name = path.slice(0, -4);
          if (name.startsWith(prefix))
            observations.push({
              kind: "pass",
              scope: source.scope,
              name,
              changed: day((await lstat(join(dir, item.name))).mtime.toISOString()),
            });
        }
      }
    };
    await walk(root, "");
    return observations;
  },
};

export const stores: Record<string, Store> = {
  gcp,
  aws,
  azure,
  github,
  pass,
  anthropic,
  openai,
  openrouter,
  cloudflare,
};

/** The same secret in any letter case, so one secret listed twice is one observation and one finding id. */
export function observationKey({ kind, scope, name }: Observation): string {
  const key = `${kind}:${scope}:${name}`;
  return stores[kind]?.exact ? key : key.toLowerCase();
}

/** Responses past this size are refused, so a broken or hostile endpoint cannot exhaust memory. */
const maxBytes = 10_000_000;

/**
 * The only way a provider reader reaches the network: GET, on the provider's own origin, on a path the provider
 * allows, with no redirects and a timeout. The token is read here and sent only in the provider's own header. Errors
 * name the HTTP status and never the response, which could quote the request.
 */
export function apiGet(
  kind: string,
  api: Api,
  source: Source,
  env: Record<string, string | undefined>,
  fetcher: Fetch,
): Get {
  const variable = source.token ?? api.token;
  return async (path, query = {}) => {
    const url = new URL(path, api.origin);
    for (const [name, value] of Object.entries(query)) url.searchParams.set(name, value);
    if (url.origin !== api.origin || !api.paths.some((allowed) => allowed.test(url.pathname)))
      throw new Error(`refusing to call ${kind} ${url.pathname}: only key listings are allowed`);
    const token = env[variable];
    if (!token) throw new Error(`set ${variable} to read ${kind}: ${source.scope}`);
    let response: Response;
    try {
      response = await fetcher(url.href, {
        method: "GET",
        headers: { ...api.headers(token), accept: "application/json" },
        redirect: "error",
        signal: AbortSignal.timeout(20_000),
      });
    } catch {
      throw new Error(`${kind} could not be reached`);
    }
    if (!response.ok) throw new Error(`${kind} answered HTTP ${response.status}; check ${variable} and its access`);
    const text = await response.text();
    if (text.length > maxBytes) throw new Error(`${kind} answered with more than ${maxBytes} bytes`);
    try {
      return JSON.parse(text);
    } catch {
      throw new Error(`${kind} answered with something other than JSON`);
    }
  };
}

const offlineGet: Get = async () => {
  throw new Error("this reader has no API");
};

/**
 * Every source's observations, each secret once. A store that fails stops the run, so a check never passes on a
 * partial view.
 */
export async function observe(
  sources: readonly Source[],
  run: Run,
  fetcher: Fetch = fetch,
  env: Record<string, string | undefined> = process.env,
): Promise<Observation[]> {
  // The sources are read at once and merged in file order, so a later source still wins a shared key.
  const listed = await Promise.all(
    sources.map((source) => {
      const store = stores[source.kind];
      if (!store) throw new Error(`no reader for source kind ${source.kind}`);
      const get = store.api ? apiGet(source.kind, store.api, source, env, fetcher) : offlineGet;
      return store.list(source, { run, get, env });
    }),
  );
  const all = new Map<string, Observation>();
  for (const observation of listed.flat()) all.set(observationKey(observation), observation);
  return [...all.values()];
}

/** Runs a store CLI. Its stderr is not echoed, because it can quote whatever the command touched. */
export const runCommand: Run = async (argv) => {
  if (!isMetadataCommand(argv)) throw new Error(`refusing to run ${argv[0]}: only secret listings are allowed`);
  // `gh` would follow GH_HOST to another server and send it that host's token, so it only ever talks to github.com.
  const env = argv[0] === "gh" ? { ...process.env, GH_HOST: "github.com" } : process.env;
  const proc = Bun.spawn(argv, { stdout: "pipe", stderr: "ignore", env });
  const [stdout, code] = await Promise.all([new Response(proc.stdout).text(), proc.exited]);
  if (code !== 0) throw new Error(`${argv.slice(0, 3).join(" ")} failed with exit ${code}; check its login and access`);
  return stdout;
};
