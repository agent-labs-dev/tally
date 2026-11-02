/** The tally file holds facts about keys, never keys. Everything here exists to keep it that way. */

export const schemaVersion = 1;

/**
 * Services, groups and location kinds are open slugs, not enums: a new provider, team or secret store is a new entry
 * or location, never a code change. Collectors claim the location kinds they can verify; other kinds are recorded but
 * not checked against a source.
 */
export type Location = { kind: string; ref: string };

export interface Entry {
  id: string;
  service: string;
  group?: string;
  owner: string;
  label?: string;
  fingerprint?: string;
  locations: Location[];
  /** A date, `unknown` (nobody has looked yet) or `none` (the provider sets none, with a reason in the note). */
  expires: string;
  expiresNote?: string;
  limit: string;
  rotated?: string;
  runbook?: string;
  note?: string;
}

const fields = new Set([
  "id",
  "service",
  "group",
  "owner",
  "label",
  "fingerprint",
  "locations",
  "expires",
  "expiresNote",
  "limit",
  "rotated",
  "runbook",
  "note",
]);

/** GitHub logins ignore case, so requiring lowercase also rules out mixed-case tokens pasted by mistake. */
const handle = /^[a-z0-9](?:[a-z0-9-]{0,38})$/;
const slug = /^[a-z0-9]+(-[a-z0-9]+)*$/;
const isoDate = /^\d{4}-\d{2}-\d{2}$/;

/**
 * Prefixes that providers put on live credentials. This list is a fast first check, not the whole guard: the entropy
 * test below catches formats nobody listed, and `secretPatterns` in the tally file adds more without a code change.
 */
const builtinSecretPatterns = [
  // The lookbehind keeps ordinary words such as "risk-assessment" from matching `sk-`.
  /(?<![A-Za-z0-9])(sk-|sk_live_|sk_test_|rk_live_|rk_test_|pk_live_|whsec_|ghp_|gho_|ghs_|ghu_|ghr_|github_pat_|npm_|glpat-|xox[abpors]-|hf_|AIza|AKIA|ASIA|eyJ|-----BEGIN)[A-Za-z0-9_\-+/=]{6,}/,
];
let secretPatterns: RegExp[] = builtinSecretPatterns;

export function addSecretPatterns(patterns: readonly string[]): void {
  secretPatterns = [...builtinSecretPatterns, ...patterns.map((pattern) => new RegExp(pattern))];
}

function entropy(text: string): number {
  const counts = new Map<string, number>();
  for (const char of text) counts.set(char, (counts.get(char) ?? 0) + 1);
  let bits = 0;
  for (const count of counts.values()) bits -= (count / text.length) * Math.log2(count / text.length);
  return bits;
}

/**
 * Thresholds measured against real identifiers: CamelCase and SCREAMING_SNAKE names stay near 4.1 bits, while
 * random 40-character tokens sit above 4.6 even when they are letters only.
 */
function randomLooking(token: string): boolean {
  if (token.length < 24) return false;
  const bits = entropy(token);
  const letters = /[A-Za-z]/.test(token);
  const digits = /\d/.test(token);
  if (letters && digits && /[a-z]/.test(token) && /[A-Z]/.test(token) && bits > 4) return true;
  if (token.length < 32) return false;
  return letters && digits ? bits > 3.5 : bits > 4.3;
}

/** True for text that could be a credential: a known prefix, or a long random-looking token. */
export function looksSecret(text: string): boolean {
  if (secretPatterns.some((pattern) => pattern.test(text))) return true;
  return text.split(/[\s/:,#;="'`]+/).some(randomLooking);
}

/** Error messages echo user input; this keeps a pasted key out of them. */
export function withheld(text: string): string {
  return looksSecret(text) || text.length > 80 ? "(value withheld)" : text;
}

/** Round-trips through Date, because Date.parse quietly turns 2026-02-30 into March 2. */
export function validDate(text: string): boolean {
  if (!isoDate.test(text)) return false;
  const parsed = new Date(`${text}T00:00:00Z`);
  return !Number.isNaN(parsed.getTime()) && parsed.toISOString().slice(0, 10) === text;
}

function parseLocation(raw: unknown, errors: string[]): Location | undefined {
  if (!raw || typeof raw !== "object" || Array.isArray(raw) || Object.keys(raw).length !== 1) {
    errors.push("each location is one `kind: ref` pair");
    return undefined;
  }
  const [kind, ref] = Object.entries(raw)[0] as [string, unknown];
  if (!slug.test(kind)) {
    errors.push(`location kind ${withheld(kind)} must be lowercase words joined by hyphens`);
    return undefined;
  }
  if (typeof ref !== "string" || !ref) {
    errors.push(`location ${withheld(kind)} needs a reference`);
    return undefined;
  }
  return { kind, ref };
}

function strings(value: unknown): string[] {
  if (typeof value === "string") return [value];
  if (Array.isArray(value)) return value.flatMap(strings);
  if (value && typeof value === "object") return Object.values(value).flatMap(strings);
  return [];
}

/** Parse one entry. Ids only have to be unique within the file, because a file can hold many keys. */
export function parseEntry(raw: unknown): { entry?: Entry; errors: string[] } {
  const errors: string[] = [];
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return { errors: ["an entry is a mapping"] };
  const record = raw as Record<string, unknown>;

  if ([...Object.keys(record), ...strings(record)].some(looksSecret))
    errors.push("contains text that looks like a credential, so it was rejected");
  for (const key of Object.keys(record)) if (!fields.has(key)) errors.push(`unknown field ${withheld(key)}`);

  const text = (key: string, required: boolean) => {
    const value = record[key];
    if (value === undefined) {
      if (required) errors.push(`${key} is required`);
      return undefined;
    }
    if (typeof value !== "string" || !value) {
      errors.push(`${key} must be text`);
      return undefined;
    }
    return value;
  };

  const id = text("id", true);
  if (id && !slug.test(id)) errors.push("id must be lowercase words joined by hyphens");
  const service = text("service", true);
  if (service && !slug.test(service)) errors.push("service must be lowercase words joined by hyphens");
  const group = text("group", false);
  if (group && !slug.test(group)) errors.push("group must be lowercase words joined by hyphens");
  const owner = text("owner", true);
  if (owner && !handle.test(owner)) errors.push("owner must be a lowercase GitHub handle, or unknown");
  const fingerprint = text("fingerprint", false);
  if (fingerprint && fingerprint.replace(/^…/, "").length > 6)
    errors.push("fingerprint is the provider's redacted suffix, at most 6 characters");

  const expires = text("expires", true);
  if (expires && expires !== "unknown" && expires !== "none" && !validDate(expires))
    errors.push("expires must be YYYY-MM-DD, unknown or none");
  const expiresNote = text("expiresNote", false);
  if (expires === "none" && !expiresNote) errors.push("expires: none needs an expiresNote saying why");
  const limit = text("limit", true);
  const rotated = text("rotated", false);
  if (rotated && !validDate(rotated)) errors.push("rotated must be YYYY-MM-DD");

  const locations: Location[] = [];
  if (!Array.isArray(record.locations) || record.locations.length === 0) errors.push("locations needs at least one");
  else
    for (const item of record.locations) {
      const location = parseLocation(item, errors);
      if (location) locations.push(location);
    }

  const label = text("label", false);
  const runbook = text("runbook", false);
  const note = text("note", false);

  if (errors.length > 0) return { errors };
  return {
    entry: {
      id: id as string,
      service: service as string,
      group,
      owner: owner as string,
      label,
      fingerprint,
      locations,
      expires: expires as string,
      expiresNote,
      limit: limit as string,
      rotated,
      runbook,
      note,
    },
    errors,
  };
}

/** The YAML shape, with fields in reading order and unset ones left out. */
export function serialise(entry: Entry): Record<string, unknown> {
  const out: Record<string, unknown> = {
    id: entry.id,
    service: entry.service,
    group: entry.group,
    owner: entry.owner,
    label: entry.label,
    fingerprint: entry.fingerprint,
    locations: entry.locations.map((location) => ({ [location.kind]: location.ref })),
    expires: entry.expires,
    expiresNote: entry.expiresNote,
    limit: entry.limit,
    rotated: entry.rotated,
    runbook: entry.runbook,
    note: entry.note,
  };
  for (const key of Object.keys(out)) if (out[key] === undefined) delete out[key];
  return out;
}
