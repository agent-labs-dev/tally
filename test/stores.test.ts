import { describe, expect, test } from "bun:test";
import { type Api, apiGet, type Fetch, isMetadataCommand, observe, type Run, runCommand, stores } from "../src/stores";

/** A fake store CLI: answers by the command's first words and records every call. */
function fake(answers: Record<string, unknown>) {
  const calls: string[][] = [];
  const run: Run = async (argv) => {
    calls.push(argv);
    const key = Object.keys(answers).find((prefix) => argv.join(" ").startsWith(prefix));
    if (!key) throw new Error(`unexpected command ${argv.join(" ")}`);
    return JSON.stringify(answers[key]);
  };
  return { calls, run };
}

describe("store readers", () => {
  test("gcp reads each secret's newest enabled version and its expiry", async () => {
    const { calls, run } = fake({
      "gcloud secrets list": [
        {
          name: "projects/1/secrets/PAYMENTS_API_KEY",
          createTime: "2024-01-01T00:00:00Z",
          expireTime: "2027-03-01T00:00:00Z",
        },
        { name: "projects/1/secrets/MAIL_TOKEN", createTime: "2025-05-05T00:00:00Z" },
      ],
      "gcloud secrets versions list PAYMENTS_API_KEY": [{ createTime: "2026-06-01T10:00:00Z" }],
      "gcloud secrets versions list MAIL_TOKEN": [],
    });
    const observed = await observe([{ kind: "gcp", scope: "my-project", filter: "labels.app=web" }], run);
    expect(observed).toEqual([
      { kind: "gcp", scope: "my-project", name: "PAYMENTS_API_KEY", changed: "2026-06-01", expires: "2027-03-01" },
      { kind: "gcp", scope: "my-project", name: "MAIL_TOKEN", changed: "2025-05-05", expires: undefined },
    ]);
    expect(calls[0]).toContain("--filter=labels.app=web");
  });

  test("aws prefers the last rotation and skips deleted secrets", async () => {
    const { run } = fake({
      "aws secretsmanager list-secrets": {
        SecretList: [
          { Name: "payments/api", LastChangedDate: "2026-01-02T00:00:00Z", LastRotatedDate: "2026-03-04T00:00:00Z" },
          { Name: "old", LastChangedDate: 1_700_000_000, DeletedDate: "2026-01-01T00:00:00Z" },
          { Name: "mail", LastChangedDate: 1_700_000_000 },
        ],
      },
    });
    expect(await observe([{ kind: "aws", scope: "eu-west-1" }], run)).toEqual([
      { kind: "aws", scope: "eu-west-1", name: "payments/api", changed: "2026-03-04" },
      { kind: "aws", scope: "eu-west-1", name: "mail", changed: "2023-11-14" },
    ]);
  });

  test("azure reads update and expiry dates from the listing", async () => {
    const { run } = fake({
      "az keyvault secret list": [
        {
          id: "https://vault.example/secrets/payments-api",
          attributes: { updated: "2026-02-02T00:00:00Z", expires: "2026-12-01T00:00:00Z" },
        },
      ],
    });
    expect(await observe([{ kind: "azure", scope: "my-vault" }], run)).toEqual([
      { kind: "azure", scope: "my-vault", name: "payments-api", changed: "2026-02-02", expires: "2026-12-01" },
    ]);
  });

  test("every reader command is an allowed listing", async () => {
    const run: Run = async (argv) => {
      expect(isMetadataCommand(argv)).toBe(true);
      if (argv.includes("versions")) return "[]";
      if (argv[0] === "aws") return JSON.stringify({ SecretList: [{ Name: "KEY" }] });
      return JSON.stringify([{ name: "KEY", id: "https://vault.example/secrets/KEY" }]);
    };
    for (const [kind, store] of Object.entries(stores))
      if (!store.api) await observe([{ kind, scope: "scope", filter: "f" }], run);
  });

  test("runCommand refuses anything but a listing before running it", async () => {
    for (const argv of [
      ["gcloud", "secrets", "versions", "access", "latest"],
      ["aws", "secretsmanager", "get-random-password"],
      ["az", "keyvault", "secret", "backup"],
      ["gcloud", "--project=p", "secrets", "list"],
    ])
      await expect(runCommand(argv)).rejects.toThrow("refusing");
  });

  test("one secret listed twice in different case is one observation", async () => {
    const run: Run = async () => JSON.stringify({ SecretList: [{ Name: "mail" }] });
    const observed = await observe(
      [
        { kind: "aws", scope: "eu-west-1" },
        { kind: "aws", scope: "EU-WEST-1" },
      ],
      run,
    );
    expect(observed).toHaveLength(1);
  });
});

const noRun: Run = async () => {
  throw new Error("a provider reader ran a command");
};

/** A fake provider API: answers by path, and records each request's URL, method and headers. */
function api(answer: (url: URL) => unknown) {
  const requests: { url: URL; init: RequestInit }[] = [];
  const fetcher: Fetch = async (href, init) => {
    const url = new URL(href);
    requests.push({ url, init });
    return new Response(JSON.stringify(answer(url)));
  };
  return { requests, fetcher };
}

const env = {
  TALLY_ANTHROPIC_ADMIN_KEY: "admin-a",
  TALLY_OPENAI_ADMIN_KEY: "admin-o",
  TALLY_OPENROUTER_MANAGEMENT_KEY: "admin-r",
  TALLY_CLOUDFLARE_TOKEN_READER: "admin-c",
  OTHER_TOKEN: "admin-x",
};

describe("provider readers", () => {
  test("anthropic pages by cursor, keeps active and expired keys, and reads a null expiry as none", async () => {
    const { requests, fetcher } = api((url) =>
      url.searchParams.get("after_id")
        ? {
            data: [
              {
                name: "old",
                status: "expired",
                created_at: "2025-01-01T00:00:00Z",
                expires_at: "2026-01-01T00:00:00Z",
              },
            ],
            has_more: false,
          }
        : {
            data: [
              {
                name: "ci",
                status: "active",
                created_at: "2026-02-03T00:00:00Z",
                expires_at: null,
                partial_key_hint: "hint",
              },
              { name: "gone", status: "archived", created_at: "2026-02-03T00:00:00Z" },
            ],
            has_more: true,
            last_id: "k2",
          },
    );
    const observed = await observe([{ kind: "anthropic", scope: "org", filter: "ws1" }], noRun, fetcher, env);
    expect(observed).toEqual([
      { kind: "anthropic", scope: "org", name: "ci", changed: "2026-02-03", expires: "none" },
      { kind: "anthropic", scope: "org", name: "old", changed: "2025-01-01", expires: "2026-01-01" },
    ]);
    expect(requests[0]?.url.searchParams.get("workspace_id")).toBe("ws1");
    expect(requests[0]?.init.headers).toMatchObject({ "x-api-key": "admin-a" });
  });

  test("openai lists each active project's keys as PROJECT/KEY with their last use", async () => {
    const { requests, fetcher } = api((url) =>
      url.pathname.endsWith("/projects")
        ? {
            data: [
              { id: "proj_1", name: "web", status: "active" },
              { id: "proj_2", name: "old", status: "archived" },
            ],
            has_more: false,
          }
        : {
            data: [
              { name: "server", created_at: 1_767_225_600, last_used_at: 1_770_000_000, redacted_value: "sk-...x" },
            ],
            has_more: false,
          },
    );
    expect(await observe([{ kind: "openai", scope: "org" }], noRun, fetcher, env)).toEqual([
      {
        kind: "openai",
        scope: "org",
        name: "proj_1/server",
        changed: "2026-01-01",
        expires: undefined,
        lastUsed: "2026-02-02",
      },
    ]);
    expect(requests.map((request) => request.url.pathname)).toEqual([
      "/v1/organization/projects",
      "/v1/organization/projects/proj_1/api_keys",
    ]);
    expect(requests[1]?.url.searchParams.get("owner_project_access")).toBe("any");
  });

  test("openrouter reads limits and pages by offset until an empty page", async () => {
    const { fetcher } = api((url) =>
      url.searchParams.get("offset") === "0"
        ? {
            data: [
              {
                name: "app",
                disabled: false,
                created_at: "2026-03-01T00:00:00Z",
                expires_at: "2027-03-01T00:00:00Z",
                last_used_at: "2026-10-30T00:00:00Z",
                limit: 50,
                limit_reset: "monthly",
                label: "sk-or-v1-abc...xyz",
              },
              { name: "free", disabled: false, created_at: "2026-03-01T00:00:00Z", expires_at: null, limit: null },
              { name: "off", disabled: true },
            ],
          }
        : { data: [] },
    );
    expect(await observe([{ kind: "openrouter", scope: "team" }], noRun, fetcher, env)).toEqual([
      {
        kind: "openrouter",
        scope: "team",
        name: "app",
        changed: "2026-03-01",
        expires: "2027-03-01",
        lastUsed: "2026-10-30",
        limit: "$50 per monthly",
      },
      {
        kind: "openrouter",
        scope: "team",
        name: "free",
        changed: "2026-03-01",
        expires: "none",
        lastUsed: undefined,
        limit: "none",
      },
    ]);
  });

  test("cloudflare reads account tokens with a named token variable and refuses a scope that is not an account", async () => {
    const { requests, fetcher } = api(() => ({
      result: [
        {
          name: "deploy",
          status: "active",
          issued_on: "2026-01-01T00:00:00Z",
          expires_on: "2026-12-01T00:00:00Z",
          last_used_on: "2026-11-01T00:00:00Z",
        },
      ],
      result_info: { total_count: 1 },
    }));
    const account = "0123456789abcdef0123456789abcdef";
    expect(await observe([{ kind: "cloudflare", scope: account, token: "OTHER_TOKEN" }], noRun, fetcher, env)).toEqual([
      {
        kind: "cloudflare",
        scope: account,
        name: "deploy",
        changed: "2026-01-01",
        expires: "2026-12-01",
        lastUsed: "2026-11-01",
      },
    ]);
    expect(requests[0]?.url.pathname).toBe(`/client/v4/accounts/${account}/tokens`);
    expect(requests[0]?.init.headers).toMatchObject({ authorization: "Bearer admin-x" });
    await expect(observe([{ kind: "cloudflare", scope: "../user" }], noRun, fetcher, env)).rejects.toThrow(
      "must be user",
    );
  });

  test("apiGet sends GET only to the provider's listing paths, with no redirects", async () => {
    const { requests, fetcher } = api(() => ({ data: [] }));
    const anthropic = stores.anthropic?.api as Api;
    const get = apiGet("anthropic", anthropic, { kind: "anthropic", scope: "org" }, env, fetcher);
    for (const path of [
      "/v1/organizations/api_keys/k1",
      "https://example.com/v1/organizations/api_keys",
      "/v1/messages",
      "/v1/organizations/api_keys/../users",
    ])
      await expect(get(path)).rejects.toThrow("refusing");
    expect(requests).toHaveLength(0);
    await get("/v1/organizations/api_keys");
    expect(requests[0]?.init).toMatchObject({ method: "GET", redirect: "error" });
  });

  test("a failing provider names the status and the variable, never the token or the response", async () => {
    const fetcher: Fetch = async () => new Response("token admin-a rejected", { status: 401 });
    const failure = observe([{ kind: "anthropic", scope: "org" }], noRun, fetcher, env);
    await expect(failure).rejects.toThrow(
      "anthropic answered HTTP 401; check TALLY_ANTHROPIC_ADMIN_KEY and its access",
    );
    await expect(observe([{ kind: "anthropic", scope: "org" }], noRun, fetcher, {})).rejects.toThrow(
      "set TALLY_ANTHROPIC_ADMIN_KEY",
    );
    const thrown = await observe([{ kind: "anthropic", scope: "org" }], noRun, fetcher, env).catch(
      (error: Error) => error.message,
    );
    expect(thrown).not.toContain("admin-a");
  });
});

test("a listing that says there is more but gives no cursor fails instead of stopping short", async () => {
  const { fetcher } = api(() => ({ data: [{ name: "ci", status: "active" }], has_more: true }));
  await expect(observe([{ kind: "anthropic", scope: "org" }], noRun, fetcher, env)).rejects.toThrow("gave no cursor");
});

test("cloudflare without a total keeps paging until a short page", async () => {
  const full = Array.from({ length: 50 }, (_, at) => ({ name: `t${at}`, status: "active" }));
  const { requests, fetcher } = api((url) => ({
    result: url.searchParams.get("page") === "1" ? full : [{ name: "last", status: "active" }],
  }));
  expect(await observe([{ kind: "cloudflare", scope: "user" }], noRun, fetcher, env)).toHaveLength(51);
  expect(requests).toHaveLength(2);
});
