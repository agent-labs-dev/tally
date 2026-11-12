import { afterEach, describe, expect, test } from "bun:test";
import { chmodSync, mkdirSync, mkdtempSync, rmSync, symlinkSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  type Api,
  apiGet,
  type Fetch,
  isMetadataCommand,
  observationKey,
  observe,
  ownerTypes,
  type Run,
  runCommand,
  stores,
} from "../src/stores";

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
  test("gcp reads versions, treats expireTime as deletion and reads tally annotations", async () => {
    const { calls, run } = fake({
      "gcloud secrets list": [
        {
          name: "projects/1/secrets/PAYMENTS_API_KEY",
          createTime: "2024-01-01T00:00:00Z",
          expireTime: "2027-03-01T00:00:00Z",
          rotation: { nextRotationTime: "2026-02-01T00:00:00Z" },
          annotations: {
            "tally-owner": "team-payments",
            "tally-service": "example-provider",
            "tally-expires": "2026-09-09",
            "tally-limit": "$50 per monthly",
            "tally-runbook": "docs/rotate.md",
            unrelated: "ignored",
          },
        },
        {
          name: "projects/1/secrets/MAIL_TOKEN",
          createTime: "2025-05-05T00:00:00Z",
          annotations: { "tally-expires": "none", "tally-expires-note": "set by the vendor" },
        },
      ],
      "gcloud secrets versions list PAYMENTS_API_KEY": [{ createTime: "2026-06-01T10:00:00Z" }],
      "gcloud secrets versions list MAIL_TOKEN": [],
    });
    const observed = await observe([{ kind: "gcp", scope: "my-project", filter: "labels.app=web" }], run);
    expect(observed).toEqual([
      {
        kind: "gcp",
        scope: "my-project",
        name: "PAYMENTS_API_KEY",
        changed: "2026-06-01",
        deletion: "2027-03-01",
        owner: "team-payments",
        service: "example-provider",
        expires: "2026-09-09",
        limit: "$50 per monthly",
        runbook: "docs/rotate.md",
      },
      {
        kind: "gcp",
        scope: "my-project",
        name: "MAIL_TOKEN",
        changed: "2025-05-05",
        expires: "none",
        expiresNote: "set by the vendor",
      },
    ]);
    expect(calls[0]).toContain("--filter=labels.app=web");
  });

  test("gcp rejects bad or credential-shaped annotations without echoing them", async () => {
    const secret = ["sk", "invalid-example-fixture"].join("-");
    for (const annotations of [
      { "tally-expires": "next week" },
      { "tally-expires": "none" },
      { "tally-owner": "Not A Handle" },
      { "tally-runbook": secret },
    ]) {
      const { run } = fake({
        "gcloud secrets list": [{ name: "projects/1/secrets/KEY", annotations }],
        "gcloud secrets versions list": [],
      });
      const failure = await observe([{ kind: "gcp", scope: "p" }], run).catch((error: Error) => error);
      expect(failure).toBeInstanceOf(Error);
      expect((failure as Error).message).toContain("invalid tally annotations");
      expect((failure as Error).message).not.toContain(secret);
    }
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
    for (const kind of ["gcp", "aws", "azure", "github"]) await observe([{ kind, scope: "scope", filter: "f" }], run);
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

describe("github reader", () => {
  const secrets = ".secrets[] | [.name, .updated_at] | @tsv";
  test("reads repository, chosen environment and organization secrets as names and dates", async () => {
    const answers: Record<string, string> = {
      "repos/acme/app/actions/secrets?per_page=100": "PAYMENTS_API_KEY\t2026-01-02T00:00:00Z\n",
      // jq's @uri output: a name with a slash, a newline or a `!` is still one encoded line.
      "repos/acme/app/environments?per_page=100": "production\npreview%2Fone\nprod%0Ablue\nprod%21\n",
      "repos/acme/app/environments/production/secrets?per_page=100": "DEPLOY_TOKEN\t2026-03-04T00:00:00Z\n",
      "repos/acme/app/environments/preview%2Fone/secrets?per_page=100": "PREVIEW_TOKEN\t2026-03-05T00:00:00Z\n",
      "repos/acme/app/environments/prod%21/secrets?per_page=100": "LOUD_TOKEN\t2026-03-06T00:00:00Z\n",
      "orgs/acme/actions/secrets?per_page=100": "SHARED_TOKEN\t2025-05-06T00:00:00Z\n",
    };
    const calls: string[] = [];
    const run: Run = async (argv) => {
      expect(isMetadataCommand(argv)).toBe(true);
      calls.push(argv[5] ?? "");
      return answers[argv[5] ?? ""] ?? "";
    };
    const observed = await observe(
      [
        { kind: "github", scope: "acme/app", filter: "production, preview/one, prod!" },
        { kind: "github", scope: "acme" },
      ],
      run,
    );
    expect(observed).toEqual([
      { kind: "github", scope: "acme/app", name: "PAYMENTS_API_KEY", changed: "2026-01-02" },
      { kind: "github", scope: "acme/app", name: "env:production/DEPLOY_TOKEN", changed: "2026-03-04" },
      { kind: "github", scope: "acme/app", name: "env:preview/one/PREVIEW_TOKEN", changed: "2026-03-05" },
      { kind: "github", scope: "acme/app", name: "env:prod!/LOUD_TOKEN", changed: "2026-03-06" },
      { kind: "github", scope: "acme", name: "SHARED_TOKEN", changed: "2025-05-06" },
    ]);
    expect(calls).toHaveLength(6);
  });

  test("gh is allowed only as an exact listing, never with a flag that could write", () => {
    const ok = ["gh", "api", "--paginate", "--jq", secrets, "repos/acme/app/actions/secrets?per_page=100"];
    expect(isMetadataCommand(ok)).toBe(true);
    expect(isMetadataCommand(["gh", "api", "--jq", ".type", "users/team-payments"])).toBe(true);
    for (const argv of [
      [...ok, "-X", "PUT"],
      ["gh", "api", "-X", "DELETE", "--jq", secrets, "repos/acme/app/actions/secrets?per_page=100"],
      ["gh", "api", "--paginate", "--jq", ".", "repos/acme/app/actions/secrets?per_page=100"],
      ["gh", "api", "--paginate", "--jq", secrets, "repos/acme/app/actions/secrets/NAME?per_page=100"],
      ["gh", "api", "--paginate", "--jq", secrets, "repos/acme/app/actions/runners?per_page=100"],
      ["gh", "api", "--jq", ".type", "users/team/payments"],
      ["gh", "api", "--jq", ".type", "users/team-payments", "extra"],
      ["gh", "secret", "set", "NAME"],
    ])
      expect(isMetadataCommand(argv)).toBe(false);
  });

  test("ownerTypes deduplicates owners and ignores lookup failures", async () => {
    const calls: string[][] = [];
    const run: Run = async (argv) => {
      calls.push(argv);
      if (argv[4] === "users/team-payments") return "User\n";
      if (argv[4] === "users/org-owner") return "Organization\n";
      throw new Error("not found");
    };
    const types = await ownerTypes(["team-payments", "unknown", "team-payments", "org-owner", "missing"], run);
    expect(types).toEqual(
      new Map([
        ["team-payments", "User"],
        ["org-owner", "Organization"],
      ]),
    );
    expect(calls).toEqual([
      ["gh", "api", "--jq", ".type", "users/team-payments"],
      ["gh", "api", "--jq", ".type", "users/org-owner"],
      ["gh", "api", "--jq", ".type", "users/missing"],
    ]);
  });
});

describe("pass reader", () => {
  const temporary: string[] = [];
  const temp = (prefix: string) => {
    const path = mkdtempSync(join(tmpdir(), prefix));
    temporary.push(path);
    return path;
  };
  afterEach(() => {
    for (const path of temporary.splice(0)) rmSync(path, { recursive: true, force: true });
  });
  const noRun: Run = async (argv) => {
    throw new Error(`pass must not run ${argv.join(" ")}`);
  };
  /** No encryption is needed to exercise directory and timestamp discovery. */
  function store(files: Record<string, string> = {}) {
    const root = temp("tally-pass-");
    for (const [path, date] of Object.entries(files)) {
      mkdirSync(join(root, path, ".."), { recursive: true });
      writeFileSync(join(root, path), "");
      utimesSync(join(root, path), new Date(`${date}T12:00:00Z`), new Date(`${date}T12:00:00Z`));
    }
    return { root, env: { PASSWORD_STORE_DIR: root } };
  }
  const read = (env: Record<string, string>, filter?: string) =>
    observe([{ kind: "pass", scope: "local", ...(filter ? { filter } : {}) }], noRun, fetch, env);

  test("lists nested entries by name with the ciphertext mtime, skipping .git and .extensions", async () => {
    const { env } = store({
      "wow/a.gpg": "2026-01-02",
      "wow/deep/b.gpg": "2026-02-03",
      "other/c.gpg": "2026-03-04",
      "wow/notes.txt": "2026-01-01",
      ".gpg-id": "2026-01-01",
      ".git/x.gpg": "2026-01-01",
      ".extensions/y.gpg": "2026-01-01",
    });
    expect((await read(env)).map(({ name, changed }) => [name, changed])).toEqual([
      ["other/c", "2026-03-04"],
      ["wow/a", "2026-01-02"],
      ["wow/deep/b", "2026-02-03"],
    ]);
  });

  test("the filter is a case-sensitive literal prefix of the entry name", async () => {
    const { env } = store({ "wow/a.gpg": "2026-01-02", "WOW/a.gpg": "2026-01-02", "wow/deep/b.gpg": "2026-01-02" });
    expect((await read(env, "wow/")).map(({ name }) => name)).toEqual(["wow/a", "wow/deep/b"]);
    expect((await read(env, "wow/d")).map(({ name }) => name)).toEqual(["wow/deep/b"]);
    expect((await read(env, "wow/a")).map(({ name }) => name)).toEqual(["wow/a"]);
    expect((await read(env, "WOW")).map(({ name }) => name)).toEqual(["WOW/a"]);
  });

  test("names differing only by case are distinct observations", async () => {
    const { env } = store({ "wow/Key.gpg": "2026-01-02", "wow/key.gpg": "2026-01-02" });
    const observed = await read(env);
    expect(observed).toHaveLength(2);
    expect(new Set(observed.map(observationKey)).size).toBe(2);
  });

  test("an empty store is empty and a missing or non-directory one fails the run", async () => {
    expect(await read(store().env)).toEqual([]);
    const { root } = store({ "f.gpg": "2026-01-01" });
    await expect(read({ PASSWORD_STORE_DIR: join(root, "nope") })).rejects.toThrow("missing or unreadable");
    await expect(read({ PASSWORD_STORE_DIR: join(root, "f.gpg") })).rejects.toThrow("missing or unreadable");
  });

  test("the default store is under HOME", async () => {
    const home = temp("tally-home-");
    mkdirSync(join(home, ".password-store"));
    writeFileSync(join(home, ".password-store", "k.gpg"), "");
    expect((await read({ HOME: home })).map(({ name }) => name)).toEqual(["k"]);
  });

  test("a symlink under the root fails the run, but the root may be one", async () => {
    const { root } = store({ "wow/a.gpg": "2026-01-01" });
    const outside = store({ "secret.gpg": "2026-01-01" }).root;
    symlinkSync(join(outside, "secret.gpg"), join(root, "wow", "linked.gpg"));
    await expect(read({ PASSWORD_STORE_DIR: root })).rejects.toThrow("symlink at wow/linked.gpg");
    // A symlinked directory is not entered, and one outside the filter does not matter.
    const dirs = store({ "wow/a.gpg": "2026-01-01" });
    symlinkSync(outside, join(dirs.root, "linked"));
    await expect(read(dirs.env)).rejects.toThrow("symlink at linked");
    expect((await read(dirs.env, "wow/")).map(({ name }) => name)).toEqual(["wow/a"]);
    const alias = join(temp("tally-alias-"), "store");
    symlinkSync(dirs.root, alias);
    expect((await read({ PASSWORD_STORE_DIR: alias }, "wow/")).map(({ name }) => name)).toEqual(["wow/a"]);
  });

  test("never reads file contents or runs a command", async () => {
    const { root, env } = store({ "wow/a.gpg": "2026-01-01" });
    // Mode 000 lets only a listing and a stat succeed: opening the file would throw.
    chmodSync(join(root, "wow/a.gpg"), 0);
    expect((await read(env)).map(({ name }) => name)).toEqual(["wow/a"]);
    expect(isMetadataCommand(["pass", "show", "wow/a"])).toBe(false);
    expect(isMetadataCommand(["gpg", "--decrypt", "wow/a.gpg"])).toBe(false);
  });
});
