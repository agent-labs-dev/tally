import { describe, expect, test } from "bun:test";
import type { Context } from "../src/reconcile";
import {
  daysUntil,
  expiryRule,
  idleRule,
  limitRule,
  type Rule,
  reconcile,
  staleRule,
  storeRule,
  unregisteredRule,
} from "../src/reconcile";
import type { Entry } from "../src/schema";

const today = "2026-01-01";

function entry(over: Partial<Entry> = {}): Entry {
  return {
    id: "payments-api",
    service: "example-provider",
    owner: "team-payments",
    locations: [{ kind: "vault", ref: "kv/payments" }],
    expires: "2026-12-31",
    limit: "1000/day",
    ...over,
  };
}

const context: Context = { today, warnDays: 30, ignore: [] };

function withRepo(over: Partial<Context> = {}): Context {
  return { ...context, repo: "owner/name", ...over };
}

describe("expiryRule", () => {
  test("exactly warnDays out is expiring", () => {
    expect(daysUntil("2026-01-31", today)).toBe(30);
    const findings = reconcile([entry({ expires: "2026-01-31" })], context);
    expect(findings).toHaveLength(1);
    expect(findings[0]).toMatchObject({ kind: "expiring", severity: "action", days: 30 });
  });

  test("one day past warnDays gives no finding", () => {
    expect(reconcile([entry({ expires: "2026-02-01" })], context)).toEqual([]);
  });

  test("expiring today is expiring with zero days", () => {
    const findings = reconcile([entry({ expires: today })], context);
    expect(findings).toHaveLength(1);
    expect(findings[0]).toMatchObject({ kind: "expiring", days: 0 });
  });

  test("yesterday is expired", () => {
    const findings = reconcile([entry({ expires: "2025-12-31" })], context);
    expect(findings).toHaveLength(1);
    expect(findings[0]).toMatchObject({ kind: "expired", severity: "action", days: -1 });
  });

  test("unknown gives a gap", () => {
    const findings = reconcile([entry({ expires: "unknown" })], context);
    expect(findings).toHaveLength(1);
    expect(findings[0]).toMatchObject({ id: "gap:payments-api:expiry", kind: "unknown-expiry", severity: "gap" });
  });

  test("none gives nothing", () => {
    expect(reconcile([entry({ expires: "none" })], context)).toEqual([]);
  });

  test("the finding id stays the same between expiring and expired", () => {
    const expiring = reconcile([entry({ expires: "2026-01-15" })], context);
    const expired = reconcile([entry({ expires: "2025-12-15" })], context);
    expect(expiring[0]?.id).toBe("expiry:payments-api");
    expect(expired[0]?.id).toBe(expiring[0]?.id as string);
  });

  test("every entry in the file is checked", () => {
    const findings = reconcile(
      [entry({ expires: "2026-01-05" }), entry({ id: "other-key", expires: "2026-01-06" })],
      context,
    );
    expect(findings.map((finding) => finding.key)).toEqual(["payments-api", "other-key"]);
  });
});

describe("limitRule", () => {
  test("unknown limit gives a gap", () => {
    const findings = reconcile([entry({ limit: "unknown" })], context);
    expect(findings).toHaveLength(1);
    expect(findings[0]).toMatchObject({ id: "gap:payments-api:limit", kind: "unknown-limit", severity: "gap" });
  });

  test("unknown service and owner give gaps", () => {
    const findings = reconcile([entry({ service: "unknown", owner: "unknown", limit: "unknown" })], context);
    expect(findings.map((finding) => finding.id)).toEqual([
      "gap:payments-api:limit",
      "gap:payments-api:owner",
      "gap:payments-api:service",
    ]);
    expect(findings).toContainEqual(
      expect.objectContaining({
        id: "gap:payments-api:owner",
        kind: "unknown-owner",
        severity: "gap",
        title: "payments-api has no recorded owner",
      }),
    );
    expect(findings).toContainEqual(
      expect.objectContaining({
        id: "gap:payments-api:service",
        kind: "unknown-service",
        severity: "gap",
        title: "payments-api has no recorded service",
      }),
    );
  });

  test("an organization owner gives a gap", () => {
    const findings = reconcile([entry()], { ...context, owners: new Map([["team-payments", "Organization"]]) });
    expect(findings).toEqual([
      {
        id: "gap:payments-api:owner",
        kind: "org-owner",
        severity: "gap",
        key: "payments-api",
        title: "payments-api is owned by organization team-payments, which cannot be assigned an issue",
      },
    ]);
  });

  test("an owner absent from the type map gives no organization finding", () => {
    expect(reconcile([entry()], { ...context, owners: new Map() })).toEqual([]);
  });
});

describe("unregisteredRule", () => {
  const referenced = new Map([["PAYMENTS_API_KEY", [".github/workflows/deploy.yml"]]]);

  test("a variable from an env template is declared by any location that names it", () => {
    const templated = new Map([
      ["PAYMENTS_API_KEY", [".env.example"]],
      ["MAIL_TOKEN", [".env.example"]],
    ]);
    const stored = entry({ locations: [{ kind: "vault", ref: "kv/app/PAYMENTS_API_KEY" }] });
    const findings = reconcile([stored], withRepo({ templated }));
    expect(findings.map((finding) => finding.id)).toEqual(["unregistered:MAIL_TOKEN"]);
    expect(findings[0]?.detail).toContain("`.env.example`");
  });

  test("secret names match regardless of case, as GitHub matches them", () => {
    const declared = entry({ locations: [{ kind: "github", ref: "payments_api_key" }] });
    expect(reconcile([declared], withRepo({ referenced }))).toEqual([]);
  });

  test("a referenced secret with no entry is an action finding", () => {
    const findings = reconcile([], withRepo({ referenced }));
    expect(findings).toHaveLength(1);
    expect(findings[0]).toMatchObject({
      id: "unregistered:PAYMENTS_API_KEY",
      kind: "unregistered",
      severity: "action",
      key: "PAYMENTS_API_KEY",
      title: "PAYMENTS_API_KEY is used but not declared in .tally.yaml",
    });
    expect(findings[0]?.detail).toContain(".github/workflows/deploy.yml");
  });

  test("a plain github location covers the name", () => {
    const declared = entry({ locations: [{ kind: "github", ref: "PAYMENTS_API_KEY" }] });
    expect(reconcile([declared], withRepo({ referenced }))).toEqual([]);
  });

  test("an env-scoped location covers the name", () => {
    const declared = entry({ locations: [{ kind: "github", ref: "env:production/PAYMENTS_API_KEY" }] });
    expect(reconcile([declared], withRepo({ referenced }))).toEqual([]);
  });

  test("an owner/repo location covers the name only for this repository", () => {
    const here = entry({ locations: [{ kind: "github", ref: "owner/name/PAYMENTS_API_KEY" }] });
    expect(reconcile([here], withRepo({ referenced }))).toEqual([]);
    const elsewhere = entry({ locations: [{ kind: "github", ref: "owner/other/PAYMENTS_API_KEY" }] });
    expect(reconcile([elsewhere], withRepo({ referenced }))[0]?.kind).toBe("unregistered");
    const envScoped = entry({ locations: [{ kind: "github", ref: "owner/name/env:production/PAYMENTS_API_KEY" }] });
    expect(reconcile([envScoped], withRepo({ referenced }))).toEqual([]);
  });

  test("a non-github location does not cover the name", () => {
    const declared = entry({ locations: [{ kind: "vault", ref: "kv/payments" }] });
    expect(reconcile([declared], withRepo({ referenced }))[0]?.kind).toBe("unregistered");
  });

  test("ignored names are never reported", () => {
    const names = new Map([
      ["BUILD_ID", [".github/workflows/ci.yml"]],
      ["SOME_URL", [".github/workflows/ci.yml"]],
    ]);
    expect(reconcile([], withRepo({ referenced: names, ignore: ["BUILD_ID", "SOME_URL"] }))).toEqual([]);
  });

  test("nothing is reported outside a checkout", () => {
    expect(reconcile([], context)).toEqual([]);
  });
});

describe("unusedRule", () => {
  const referenced = new Map([["USED_KEY", [".github/workflows/deploy.yml"]]]);

  test("a declared secret no workflow uses is one action finding, however many copies it has", () => {
    const declared = entry({
      locations: [
        { kind: "github", ref: "OLD_KEY" },
        { kind: "github", ref: "env:production/OLD_KEY" },
      ],
    });
    const used = entry({ id: "used-key", locations: [{ kind: "github", ref: "USED_KEY" }] });
    const findings = reconcile([declared, used], withRepo({ referenced }));
    expect(findings).toHaveLength(1);
    expect(findings[0]).toMatchObject({
      id: "unused:payments-api:OLD_KEY",
      kind: "unused",
      severity: "action",
      key: "payments-api",
      title: "payments-api: OLD_KEY is declared but no workflow uses it",
    });
    expect(findings[0]?.detail).toContain("likely safe to revoke");
  });

  test("a used secret and a secret in another repository are not reported", () => {
    const used = entry({ locations: [{ kind: "github", ref: "USED_KEY" }] });
    const elsewhere = entry({
      id: "other-key",
      locations: [{ kind: "github", ref: "owner/other/OLD_KEY" }],
    });
    expect(reconcile([used, elsewhere], withRepo({ referenced }))).toEqual([]);
  });

  test("nothing is reported outside a checkout", () => {
    const declared = entry({ locations: [{ kind: "github", ref: "OLD_KEY" }] });
    expect(reconcile([declared], context)).toEqual([]);
  });
});

describe("reconcile", () => {
  test("a custom rule sees every entry", () => {
    const custom: Rule = (entries) =>
      entries.map((candidate) => ({
        id: `custom:${candidate.id}`,
        kind: "custom",
        severity: "gap" as const,
        key: candidate.id,
        title: `${candidate.id} is custom`,
      }));
    const findings = reconcile([entry(), entry({ id: "other-key" })], context, [custom]);
    expect(findings.map((finding) => finding.id)).toEqual(["custom:other-key", "custom:payments-api"]);
  });

  test("action findings sort before gap findings", () => {
    const findings = reconcile([entry({ expires: "2026-01-10", limit: "unknown" })], context);
    expect(findings.map((finding) => finding.severity)).toEqual(["action", "gap"]);
  });
});

describe("store rules", () => {
  const sources = [{ kind: "gcp", scope: "prod" }];
  const stored = (over: Partial<Entry> = {}) =>
    entry({ locations: [{ kind: "gcp", ref: "prod/PAYMENTS_API_KEY" }], expires: "unknown", limit: "none", ...over });
  const seen = (over = {}) => ({ kind: "gcp", scope: "prod", name: "PAYMENTS_API_KEY", ...over });

  test("a value unchanged for staleDays is stale, judged by its oldest copy", () => {
    const findings = reconcile(
      [stored()],
      { ...context, staleDays: 365, sources, observed: [seen({ changed: "2024-12-01" })] },
      [staleRule],
    );
    expect(findings).toEqual([
      expect.objectContaining({ id: "stale:payments-api", kind: "stale", severity: "action" }),
    ]);
    expect(
      reconcile([stored()], { ...context, staleDays: 365, observed: [seen({ changed: "2025-06-01" })] }, [staleRule]),
    ).toEqual([]);
  });

  test("a store's expiry fills in an unknown one", () => {
    const findings = reconcile([stored()], { ...context, sources, observed: [seen({ expires: "2026-01-10" })] }, [
      expiryRule,
    ]);
    expect(findings[0]).toMatchObject({ kind: "expiring", title: "payments-api expires 2026-01-10" });
  });

  test("an undeclared stored secret is unregistered and a declared one the store lacks is missing", () => {
    const findings = reconcile(
      [
        stored({
          locations: [
            { kind: "gcp", ref: "prod/GONE_KEY" },
            { kind: "gcp", ref: "staging/OTHER_KEY" },
          ],
        }),
      ],
      { ...context, sources, observed: [seen()] },
      [storeRule],
    );
    // The staging ref is not reported: that scope was never read.
    expect(findings.map((finding) => finding.id).sort()).toEqual([
      "missing:payments-api:gcp:prod/gone_key",
      "unregistered:gcp:prod:payments_api_key",
    ]);
  });

  test("a filtered source never makes a declared secret missing", () => {
    const entry = stored({
      locations: [
        { kind: "gcp", ref: "PROD/GONE_KEY" },
        { kind: "gcp", ref: "GONE_KEY" },
      ],
    });
    const filtered = [{ kind: "gcp", scope: "prod", filter: "labels.app=web" }];
    expect(reconcile([entry], { ...context, sources: filtered, observed: [] }, [storeRule])).toEqual([]);
    const ids = reconcile([entry], { ...context, sources, observed: [] }, [storeRule]).map((finding) => finding.id);
    expect(ids.sort()).toEqual(["missing:payments-api:gcp:gone_key", "missing:payments-api:gcp:prod/gone_key"]);
  });

  test("a full store path and a bare name both match, and a same name in another scope does not", () => {
    const observed = [seen(), seen({ scope: "staging" })];
    const full = stored({ locations: [{ kind: "gcp", ref: "projects/prod/secrets/payments_api_key" }] });
    const findings = reconcile(
      [full],
      { ...context, sources: [...sources, { kind: "gcp", scope: "staging" }], observed },
      [storeRule],
    );
    expect(findings.map((finding) => finding.id)).toEqual(["unregistered:gcp:staging:payments_api_key"]);
  });

  test("a secret URL matches by the vault in its host", () => {
    const entry = stored({
      locations: [{ kind: "azure", ref: "https://my-vault.vault.azure.net/secrets/payments-api" }],
    });
    const observed = [{ kind: "azure", scope: "my-vault", name: "payments-api" }];
    const sources = [{ kind: "azure", scope: "my-vault" }];
    expect(reconcile([entry], { ...context, sources, observed }, [storeRule])).toEqual([]);
  });
});

describe("provider facts", () => {
  const key = (over: Partial<Entry> = {}) =>
    entry({ locations: [{ kind: "openrouter", ref: "team/app" }], expires: "unknown", limit: "unknown", ...over });
  const seen = (over = {}) => ({ kind: "openrouter", scope: "team", name: "app", ...over });

  test("a provider's limit fills an unknown one, and a reported none is a gap of its own", () => {
    expect(reconcile([key()], { ...context, observed: [seen({ limit: "$50 per monthly" })] }, [limitRule])).toEqual([]);
    expect(reconcile([key()], { ...context, observed: [seen({ limit: "none" })] }, [limitRule])).toEqual([
      expect.objectContaining({ id: "gap:payments-api:limit", kind: "no-limit", severity: "gap" }),
    ]);
    expect(
      reconcile([key({ limit: "none" })], { ...context, observed: [seen({ limit: "none" })] }, [limitRule]),
    ).toEqual([]);
  });

  test("a provider's none is a no-expiry gap, and a dated copy wins over it", () => {
    expect(reconcile([key()], { ...context, observed: [seen({ expires: "none" })] }, [expiryRule])).toEqual([
      expect.objectContaining({ kind: "no-expiry", severity: "gap" }),
    ]);
    const both = [seen({ expires: "none" }), { ...seen({ expires: "2026-01-05" }), scope: "other" }];
    const twoCopies = key({
      locations: [
        { kind: "openrouter", ref: "team/app" },
        { kind: "openrouter", ref: "other/app" },
      ],
    });
    expect(reconcile([twoCopies], { ...context, observed: both }, [expiryRule])[0]).toMatchObject({ kind: "expiring" });
  });

  test("a key unused for idleDays is idle, judged by its newest use", () => {
    expect(
      reconcile([key()], { ...context, idleDays: 90, observed: [seen({ lastUsed: "2025-09-01" })] }, [idleRule]),
    ).toEqual([expect.objectContaining({ id: "idle:payments-api", kind: "idle", severity: "action" })]);
    expect(
      reconcile([key()], { ...context, idleDays: 90, observed: [seen({ lastUsed: "2025-12-01" })] }, [idleRule]),
    ).toEqual([]);
    expect(reconcile([key()], { ...context, observed: [seen()] }, [idleRule])).toEqual([]);
  });
});

describe("github secrets", () => {
  const repo = "acme/app";
  const github = (ref: string) =>
    entry({ locations: [{ kind: "github", ref }], expires: "none", expiresNote: "n", limit: "none" });

  test("a location names one exact scope: repository, environment or organization", () => {
    const stale = (ref: string, name: string, scope = repo) =>
      reconcile(
        [github(ref)],
        withRepo({ repo, staleDays: 365, observed: [{ kind: "github", scope, name, changed: "2024-01-01" }] }),
        [staleRule],
      ).length;
    expect(stale("DEPLOY_TOKEN", "DEPLOY_TOKEN")).toBe(1);
    expect(stale("acme/app/DEPLOY_TOKEN", "DEPLOY_TOKEN")).toBe(1);
    expect(stale("acme/application/DEPLOY_TOKEN", "DEPLOY_TOKEN")).toBe(0);
    expect(stale("acme/app/env:prod/DEPLOY_TOKEN", "DEPLOY_TOKEN")).toBe(0);
    expect(stale("env:preview/one/DEPLOY_TOKEN", "env:preview/one/DEPLOY_TOKEN")).toBe(1);
    expect(stale("acme/DEPLOY_TOKEN", "DEPLOY_TOKEN")).toBe(0);
    expect(stale("acme/DEPLOY_TOKEN", "DEPLOY_TOKEN", "acme")).toBe(1);
  });

  test("an environment whose name holds a slash declares its workflow secret", () => {
    const referenced = new Map([["DEPLOY_TOKEN", [".github/workflows/ci.yml"]]]);
    expect(
      reconcile([github("env:preview/one/DEPLOY_TOKEN")], withRepo({ referenced, repo }), [unregisteredRule]),
    ).toEqual([]);
  });

  test("an undeclared organization copy of a declared environment secret is still reported", () => {
    const referenced = new Map([["SHARED_TOKEN", [".github/workflows/ci.yml"]]]);
    const observed = [{ kind: "github", scope: "acme", name: "SHARED_TOKEN" }];
    const findings = reconcile(
      [github("env:production/SHARED_TOKEN")],
      withRepo({ referenced, repo, observed, sources: [{ kind: "github", scope: "acme" }] }),
      [storeRule],
    );
    expect(findings.map((finding) => finding.id)).toEqual(["unregistered:github:acme:shared_token"]);
  });

  test("an organization secret declared as ORG/NAME counts for this repository's workflows", () => {
    const referenced = new Map([["SHARED_TOKEN", [".github/workflows/ci.yml"]]]);
    expect(reconcile([github("acme/SHARED_TOKEN")], withRepo({ referenced, repo }), [unregisteredRule])).toEqual([]);
    expect(reconcile([github("other/SHARED_TOKEN")], withRepo({ referenced, repo }), [unregisteredRule])).toHaveLength(
      1,
    );
  });

  test("a stored workflow secret nobody declared is reported once, by the scan", () => {
    const referenced = new Map([["DEPLOY_TOKEN", [".github/workflows/ci.yml"]]]);
    const observed = [{ kind: "github", scope: repo, name: "env:production/DEPLOY_TOKEN" }];
    const findings = reconcile(
      [],
      withRepo({ referenced, repo, observed, sources: [{ kind: "github", scope: repo }] }),
    );
    expect(findings.map((finding) => finding.id)).toEqual(["unregistered:DEPLOY_TOKEN"]);
  });
});
