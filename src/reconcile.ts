import type { Entry, Location } from "./schema";
import { type Observation, observationKey, type Source } from "./stores";

/**
 * `action` findings each get their own issue and make `check` exit 3.
 * `gap` findings are missing facts, and all of them share one digest issue.
 */
export type Severity = "action" | "gap";

export interface Finding {
  /** Stable across days, so the same issue is edited as a key moves from weeks out to expired. */
  id: string;
  /** Open slug chosen by the rule (`expired`, `expiring`, `unknown-expiry`, ...). It also names the issue label. */
  kind: string;
  severity: Severity;
  key: string;
  title: string;
  days?: number;
  /** Markdown for the issue when there is no entry to describe, such as an undeclared secret name. */
  detail?: string;
}

export interface Context {
  today: string;
  warnDays: number;
  /** Days without a change before a stored value is reported as stale. */
  staleDays?: number;
  /** The stores that were read, so a declared secret can be missing only from a store that was looked at. */
  sources?: Source[];
  /** What those stores hold: names and dates, never values. */
  observed?: Observation[];
  /** Secret names the repository references, or undefined outside a checkout. Both scan rules stay quiet then. */
  referenced?: Map<string, string[]>;
  /** Credential-named variables the code reads from its env templates, or undefined outside a git checkout. */
  templated?: Map<string, string[]>;
  /** Secret names workflows use that are not credentials, so they are neither declared nor reported. */
  ignore: string[];
  /** `owner/name` of the repository being checked, used to tell `github: owner/name/NAME` from this repo's secrets. */
  repo?: string;
}

/**
 * A rule turns the whole tally file into findings, because a check can span every entry: an undeclared secret is only
 * visible next to the declared ones. New checks are new rules, and a rule never writes.
 */
export type Rule = (entries: readonly Entry[], context: Context) => Finding[];

const dayMs = 86_400_000;

export function daysUntil(date: string, today: string): number {
  return Math.round((Date.parse(`${date}T00:00:00Z`) - Date.parse(`${today}T00:00:00Z`)) / dayMs);
}

export function todayUtc(now = new Date()): string {
  return now.toISOString().slice(0, 10);
}

/**
 * The secret name is the last path segment of a location's ref, and everything before it is a scope: nothing (this
 * repository's plain secret), `env:ENV` (an environment secret), `owner/name`, or `owner/name/env:ENV`.
 * Returns the name only when the scope is this repository; a secret in another repository returns undefined.
 */
function localSecret(ref: string, repo: string | undefined): string | undefined {
  const slash = ref.lastIndexOf("/");
  // GitHub stores secret names upper-cased and matches them case-insensitively, and the scan reports them that way.
  if (slash < 0) return ref.toUpperCase();
  const name = ref.slice(slash + 1).toUpperCase();
  if (!name) return undefined;
  const scope = ref.slice(0, slash);
  if (/^env:[^/]+$/.test(scope)) return name;
  if (/^[^/]+\/[^/]+$/.test(scope)) return scope === repo ? name : undefined;
  const scoped = /^([^/]+\/[^/]+)\/env:[^/]+$/.exec(scope);
  if (scoped) return scoped[1] === repo ? name : undefined;
  return undefined;
}

function githubRefs(entry: Entry): string[] {
  return entry.locations.filter((location) => location.kind === "github").map((location) => location.ref);
}

/**
 * A location is this observation when the kinds match and the ref is the observed name, or ends in `/NAME` after a
 * path that includes the observed scope. So `NAME`, `SCOPE/NAME` and the store's own full path
 * (`projects/SCOPE/secrets/NAME`, or a secret URL) all match, names may hold slashes, and a same name in another
 * scope does not. Names compare case-insensitively, so one key's env name and its stored name match in any case.
 */
function isStored(location: Location, observation: Observation): boolean {
  if (location.kind !== observation.kind) return false;
  const ref = storePath(location.ref).toUpperCase();
  const name = observation.name.toUpperCase();
  if (ref === name) return true;
  if (!ref.endsWith(`/${name}`)) return false;
  return ref
    .slice(0, -name.length - 1)
    .split("/")
    .includes(observation.scope.toUpperCase());
}

/** A secret URL such as `https://VAULT.vault.azure.net/secrets/NAME` as the path `VAULT/secrets/NAME`. */
function storePath(ref: string): string {
  return ref.replace(/^https:\/\/([^./]+)[^/]*/i, "$1");
}

function observationsOf(entry: Entry, observed: readonly Observation[] = []): Observation[] {
  return observed.filter((observation) => entry.locations.some((location) => isStored(location, observation)));
}

/** The recorded expiry, or the earliest one a store reports when nobody recorded it. */
function expiryOf(entry: Entry, observed?: readonly Observation[]): string {
  if (entry.expires !== "unknown") return entry.expires;
  const dates = observationsOf(entry, observed).flatMap((observation) => observation.expires ?? []);
  return dates.sort()[0] ?? "unknown";
}

export const expiryRule: Rule = (entries, { today, warnDays, observed }): Finding[] =>
  entries.flatMap((entry): Finding[] => {
    const expires = expiryOf(entry, observed);
    if (expires === "none") return [];
    if (expires === "unknown")
      return [
        {
          id: `gap:${entry.id}:expiry`,
          kind: "unknown-expiry",
          severity: "gap",
          key: entry.id,
          title: `${entry.id} has no recorded expiry`,
        },
      ];
    const days = daysUntil(expires, today);
    if (days > warnDays) return [];
    const expired = days < 0;
    return [
      {
        id: `expiry:${entry.id}`,
        kind: expired ? "expired" : "expiring",
        severity: "action",
        key: entry.id,
        title: `${entry.id} ${expired ? "expired" : "expires"} ${expires}`,
        days,
      },
    ];
  });

export const limitRule: Rule = (entries) =>
  entries.flatMap((entry) =>
    entry.limit === "unknown"
      ? [
          {
            id: `gap:${entry.id}:limit`,
            kind: "unknown-limit",
            severity: "gap",
            key: entry.id,
            title: `${entry.id} has no recorded limit`,
          },
        ]
      : [],
  );

/** The last segment of any location's ref, which is the variable or secret name in every store convention. */
function storedName(ref: string): string {
  return (ref.split(/[/:]/).pop() ?? ref).toUpperCase();
}

/**
 * A secret the code reads that nobody declared is a key with no owner, limit or expiry on record. A workflow secret
 * counts as declared only by a `github` location in this repository; a variable from an env template counts as
 * declared by any location that names it, because the template says nothing about where the value is stored.
 */
export const unregisteredRule: Rule = (entries, { referenced, templated, ignore, repo }) => {
  const ignored = new Set(ignore.map((name) => name.toUpperCase()));
  const inGithub = new Set(entries.flatMap(githubRefs).map((ref) => localSecret(ref, repo)));
  const anywhere = new Set(entries.flatMap((entry) => entry.locations.map((location) => storedName(location.ref))));
  const missing = new Map<string, string[]>();
  for (const [name, files] of referenced ?? []) if (!inGithub.has(name)) missing.set(name, [...files]);
  for (const [name, files] of templated ?? [])
    if (!anywhere.has(name)) missing.set(name, [...(missing.get(name) ?? []), ...files]);
  return [...missing]
    .filter(([name]) => !ignored.has(name))
    .map(([name, files]) => ({
      id: `unregistered:${name}`,
      kind: "unregistered",
      severity: "action" as const,
      key: name,
      title: `${name} is used but not declared in .tally.yaml`,
      detail: ["Referenced in:", "", ...files.map((file) => `- \`${file}\``)].join("\n"),
    }));
};

/** A declared Actions secret no workflow reads is one nobody can use, so it is a candidate to revoke. */
export const unusedRule: Rule = (entries, { referenced, repo }) => {
  if (!referenced) return [];
  const findings: Finding[] = [];
  for (const entry of entries) {
    // Plain and environment-scoped copies share a name, so each name is reported once per entry.
    const names = new Set(githubRefs(entry).map((ref) => localSecret(ref, repo)));
    for (const name of names) {
      if (name === undefined || referenced.has(name)) continue;
      findings.push({
        id: `unused:${entry.id}:${name}`,
        kind: "unused",
        severity: "action",
        key: entry.id,
        title: `${entry.id}: ${name} is declared but no workflow uses it`,
        detail: "Actions secrets are only readable by workflows, so it is likely safe to revoke after checking.",
      });
    }
  }
  return findings;
};

/** A stored value nobody has changed in `staleDays` is a key nobody has rotated. The oldest copy decides. */
export const staleRule: Rule = (entries, { today, staleDays = 365, observed }) =>
  entries.flatMap((entry): Finding[] => {
    const changed = observationsOf(entry, observed)
      .flatMap((observation) => observation.changed ?? [])
      .sort()[0];
    if (!changed) return [];
    const age = -daysUntil(changed, today);
    if (age < staleDays) return [];
    return [
      {
        id: `stale:${entry.id}`,
        kind: "stale",
        severity: "action",
        key: entry.id,
        title: `${entry.id} last changed ${changed}, ${age} days ago`,
        detail: `Rotate it, or raise \`staleDays\` if a key this old is expected.`,
      },
    ];
  });

/**
 * Compares the stores that were read with the declarations: a secret a store holds that no entry names is
 * `unregistered`, and a declared location in a store that was read but does not hold it is `missing`.
 */
export const storeRule: Rule = (entries, { observed, sources, ignore }) => {
  if (!observed || !sources?.length) return [];
  const ignored = new Set(ignore.map((name) => name.toUpperCase()));
  const locations = entries.flatMap((entry) => entry.locations.map((location) => ({ entry, location })));
  const findings: Finding[] = [];
  for (const observation of observed) {
    if (ignored.has(observation.name.toUpperCase())) continue;
    if (locations.some(({ location }) => isStored(location, observation))) continue;
    const where = `${observation.kind}: ${observation.scope}`;
    findings.push({
      id: `unregistered:${observationKey(observation)}`,
      kind: "unregistered",
      severity: "action",
      key: observation.name,
      title: `${observation.name} is in ${where} but not declared in .tally.yaml`,
      detail: `Declare it with a \`${observation.kind}: ${observation.scope}/${observation.name}\` location, or list it under \`ignore\`.`,
    });
  }
  for (const { entry, location } of locations) {
    const ofKind = sources.filter((source) => source.kind === location.kind);
    if (!ofKind.length) continue;
    if (observed.some((observation) => isStored(location, observation))) continue;
    // Missing only when that is certain. A filtered source lists part of its store, so it proves nothing is gone. A
    // bare name needs every source of its kind read whole; a ref with a path needs a scope it names read whole, since
    // without one it may be another scope's secret or a name that holds a slash.
    const segments = storePath(location.ref).toLowerCase().split("/");
    const whole = ofKind.filter((source) => !source.filter).map((source) => source.scope.toLowerCase());
    const certain =
      segments.length === 1
        ? whole.length === ofKind.length
        : whole.some((scope) => segments.slice(0, -1).includes(scope));
    if (!certain) continue;
    findings.push({
      id: `missing:${entry.id}:${location.kind}:${location.ref.toLowerCase()}`,
      kind: "missing",
      severity: "action",
      key: entry.id,
      title: `${entry.id}: ${location.kind} ${location.ref} is declared but not in the store`,
      detail: "It was deleted or renamed. Remove the location, or put the key back.",
    });
  }
  return findings;
};

export const defaultRules: Rule[] = [expiryRule, limitRule, unregisteredRule, unusedRule, staleRule, storeRule];

export function reconcile(entries: readonly Entry[], context: Context, rules = defaultRules): Finding[] {
  return rules
    .flatMap((rule) => rule(entries, context))
    .sort(
      (a, b) =>
        Number(a.severity !== "action") - Number(b.severity !== "action") ||
        (a.days ?? Infinity) - (b.days ?? Infinity) ||
        a.id.localeCompare(b.id),
    );
}
