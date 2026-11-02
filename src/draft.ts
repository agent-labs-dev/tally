import { type Context, isStored } from "./reconcile";
import { credentialName } from "./scan";
import type { Entry, Location } from "./schema";
import { stores } from "./stores";

export interface Draft {
  entries: Entry[];
  /** New entries, one per secret no key names. */
  drafted: { id: string; secret: string }[];
  /** Locations added to the one key whose other locations already name the same secret. */
  linked: { id: string; location: Location }[];
  /** Secrets more than one key names, so which one holds this copy is left to a person. */
  unsure: string[];
}

/** A secret name turned into an id: lowercase, underscores to hyphens, and nothing a slug cannot hold. */
function draftId(secret: string, used: Set<string>): string {
  const base =
    secret
      .toLowerCase()
      .replaceAll("_", "-")
      .replace(/[^a-z0-9-]+/g, "-")
      .replace(/-{2,}/g, "-")
      .replace(/^-+|-+$/g, "") || "key";
  let id = base;
  for (let n = 2; used.has(id); n++) id = `${base}-${n}`;
  used.add(id);
  return id;
}

function lastSegment(ref: string): string {
  return (ref.split("/").pop() ?? ref).toUpperCase();
}

/**
 * Everything the code and the stores hold that the entries do not record yet. A workflow secret becomes a `github`
 * location, a template variable an `env` one, and a stored secret a `KIND: SCOPE/NAME` one. A location goes onto the
 * one entry that already names the same secret elsewhere; with none, a new entry is drafted. A stored secret whose name
 * is not credential-shaped is never drafted, because stores hold ids and URLs too; `check` still lists it.
 */
export function draft(existing: readonly Entry[], context: Context, owner: string): Draft {
  const entries = existing.map((entry) => ({ ...entry, locations: [...entry.locations] }));
  const used = new Set(entries.map((entry) => entry.id));
  const ignored = new Set(context.ignore.map((name) => name.toUpperCase()));
  const result: Draft = { entries, drafted: [], linked: [], unsure: [] };

  const found: { secret: string; location: Location; has: (entry: Entry) => boolean; draftable: boolean }[] = [];
  for (const secret of [...(context.referenced?.keys() ?? [])].sort())
    found.push({
      secret,
      location: { kind: "github", ref: secret },
      has: (entry) => entry.locations.some((at) => at.kind === "github" && lastSegment(at.ref) === secret),
      draftable: true,
    });
  for (const secret of [...(context.templated?.keys() ?? [])].sort())
    found.push({
      secret,
      location: { kind: "env", ref: secret },
      has: (entry) => entry.locations.some((at) => lastSegment(at.ref) === secret),
      draftable: true,
    });
  for (const observation of context.observed ?? [])
    found.push({
      secret: observation.name.toUpperCase(),
      location: { kind: observation.kind, ref: `${observation.scope}/${observation.name}` },
      has: (entry) => entry.locations.some((at) => isStored(at, observation)),
      // A provider key's name is free text, not a variable name, so it is linked by hand rather than drafted.
      draftable: !stores[observation.kind]?.api && credentialName.test(observation.name.toUpperCase()),
    });

  for (const { secret, location, has, draftable } of found) {
    if (ignored.has(secret) || entries.some(has)) continue;
    const named = entries.filter((entry) => entry.locations.some((at) => lastSegment(at.ref) === secret));
    const [only] = named;
    if (named.length > 1) {
      if (!result.unsure.includes(secret)) result.unsure.push(secret);
    } else if (only) {
      only.locations.push(location);
      result.linked.push({ id: only.id, location });
    } else if (draftable) {
      const id = draftId(secret, used);
      entries.push({ id, service: "unknown", owner, locations: [location], expires: "unknown", limit: "unknown" });
      result.drafted.push({ id, secret });
    }
  }
  return result;
}
