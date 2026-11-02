import { describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { main } from "../src/cli";
import type { Gh } from "../src/issues";
import type { Run } from "../src/stores";
import { loadTallyFile } from "../src/tallyfile";

interface Reply {
  code: number;
  text: string;
  json: Record<string, unknown>;
}

interface RunOptions {
  gh?: Gh;
  isTTY?: boolean;
  env?: Record<string, string | undefined>;
  notify?: (message: string) => Promise<void>;
  run?: Run;
}

function harness() {
  const root = mkdtempSync(join(tmpdir(), "tally-cli-"));
  mkdirSync(join(root, ".git"));
  const config = join(root, ".tally.yaml");
  const run = async (args: string[], options: RunOptions = {}): Promise<Reply> => {
    const out: string[] = [];
    const code = await main(args, {
      isTTY: options.isTTY ?? false,
      env: options.env ?? {},
      cwd: root,
      gh: options.gh,
      notify: options.notify,
      run: options.run,
      stdout: (text: string) => out.push(text),
    });
    const text = out.join("\n");
    let json: Record<string, unknown> = {};
    try {
      json = JSON.parse(text) as Record<string, unknown>;
    } catch {
      json = {};
    }
    return { code, text, json };
  };
  return { root, config, run };
}

function addArgs(id: string, extra: string[] = []): string[] {
  return [
    "add",
    id,
    "--service",
    "example-provider",
    "--owner",
    "team-payments",
    "--location",
    "vault:kv/svc",
    ...extra,
  ];
}

/** A GitHub expression, built at runtime so a linter never reads it as a template placeholder. */
function expression(name: string): string {
  return ["$", "{{ secrets.", name, " }}"].join("");
}

describe("cli", () => {
  test("add creates the tally file and validate accepts it", async () => {
    const { config, run } = harness();
    const added = await run(addArgs("payments-api", ["--expires", "2027-01-01", "--limit", "1000/min"]));
    expect(added.code).toBe(0);
    expect(added.json.id).toBe("payments-api");
    expect(added.json.path).toBe(config);

    const validated = await run(["validate"]);
    expect(validated.code).toBe(0);
    expect(validated.json).toEqual({ ok: true, entries: 1 });
  });

  test("add refuses to overwrite an existing entry", async () => {
    const { run } = harness();
    expect((await run(addArgs("payments-api"))).code).toBe(0);
    const again = await run(addArgs("payments-api"));
    expect(again.code).toBe(1);
    expect((again.json.error as { code: string }).code).toBe("error");
  });

  test("group is optional on add and filters list when present", async () => {
    const { run } = harness();
    expect((await run(addArgs("one"))).code).toBe(0);
    expect((await run(addArgs("two", ["--group", "payments"]))).code).toBe(0);
    const filtered = await run(["list", "--group", "payments"]);
    const entries = filtered.json.entries as { id: string }[];
    expect(entries.map((entry) => entry.id)).toEqual(["two"]);
  });

  test("add preserves the file's settings", async () => {
    const { config, run } = harness();
    writeFileSync(config, 'warnDays: 7\nissueRepo: owner/name\nsecretPatterns: []\nignore: ["BUILD_ID"]\nkeys: []\n');
    expect((await run(addArgs("payments-api"))).code).toBe(0);
    const loaded = await loadTallyFile(config);
    expect(loaded.config).toEqual({
      warnDays: 7,
      secretPatterns: [],
      ignore: ["BUILD_ID"],
      credentialNames: [],
      ignorePaths: [],
      sources: [],
      staleDays: 365,
      idleDays: 90,
      issueRepo: "owner/name",
    });
    expect(loaded.entries.map((entry) => entry.id)).toEqual(["payments-api"]);
  });

  test("rotated updates expires and rotated, and drops the old expiry note", async () => {
    const { config, run } = harness();
    await run(addArgs("payments-api", ["--expires", "2026-12-31", "--expires-note", "from the dashboard"]));
    const result = await run(["rotated", "payments-api", "--expires", "2027-03-01", "--today", "2026-11-02"]);
    expect(result.code).toBe(0);
    const { entries, errors } = await loadTallyFile(config);
    expect(errors).toEqual([]);
    expect(entries[0]?.expires).toBe("2027-03-01");
    expect(entries[0]?.rotated).toBe("2026-11-02");
    expect(entries[0]?.expiresNote).toBeUndefined();
  });

  test("rotated fails for a missing entry", async () => {
    const { run } = harness();
    expect((await run(addArgs("payments-api"))).code).toBe(0);
    expect((await run(["rotated", "nope", "--expires", "2027-03-01"])).code).toBe(1);
  });

  test("check exits 3 for an expired entry", async () => {
    const { run } = harness();
    await run(addArgs("old-key", ["--expires", "2020-01-01", "--limit", "1000/min"]));
    const result = await run(["check", "--today", "2026-11-02"]);
    expect(result.code).toBe(3);
    expect(result.json.today).toBe("2026-11-02");
    expect(result.json.summary).toEqual({ action: 1, gap: 0 });
  });

  test("check reads the configured stores, and --offline skips them", async () => {
    const { config, run } = harness();
    writeFileSync(
      config,
      "sources:\n  - aws: eu-west-1\nkeys:\n  - id: payments-api\n    service: example-provider\n    owner: unknown\n    locations:\n      - aws: payments/api\n    expires: none\n    expiresNote: never set\n    limit: none\n",
    );
    const calls: string[][] = [];
    const store: Run = async (argv) => {
      calls.push(argv);
      return JSON.stringify({ SecretList: [{ Name: "payments/api", LastChangedDate: "2020-01-01T00:00:00Z" }] });
    };
    const result = await run(["check", "--today", "2026-11-02"], { run: store });
    expect(result.code).toBe(3);
    expect((result.json.findings as { id: string }[]).map((finding) => finding.id)).toEqual(["stale:payments-api"]);
    expect((await run(["check", "--offline", "--today", "2026-11-02"], { run: store })).code).toBe(0);
    expect(calls).toHaveLength(1);
    expect((await run(["issues", "sync", "--offline"], { run: store })).code).toBe(2);
  });

  test("check exits 0 when every expiry is far out", async () => {
    const { run } = harness();
    await run(addArgs("new-key", ["--expires", "2099-01-01", "--limit", "1000/min"]));
    const result = await run(["check", "--today", "2026-11-02"]);
    expect(result.code).toBe(0);
    expect(result.json.findings).toEqual([]);
  });

  test("check reports an undeclared workflow secret", async () => {
    const { root, config, run } = harness();
    writeFileSync(config, "keys: []\n");
    mkdirSync(join(root, ".github", "workflows"), { recursive: true });
    writeFileSync(join(root, ".github", "workflows", "deploy.yml"), `env:\n  KEY: ${expression("UNDECLARED_KEY")}\n`);
    const result = await run(["check", "--today", "2026-11-02"]);
    expect(result.code).toBe(3);
    expect((result.json.findings as { id: string }[])[0]?.id).toBe("unregistered:UNDECLARED_KEY");
  });

  test("text mode prints one line per finding, action findings first", async () => {
    const { run } = harness();
    await run(addArgs("old-key", ["--expires", "2020-01-01"]));
    const result = await run(["check", "--today", "2026-11-02"], { isTTY: true });
    expect(result.code).toBe(3);
    const lines = result.text.split("\n");
    expect(lines[0]).toContain("expired");
    expect(lines[0]).toContain("old-key");
    expect(result.text).toContain("next: tally rotated");
  });

  test("check reports tally file errors and exits 1", async () => {
    const { config, run } = harness();
    writeFileSync(config, "keys:\n  - id: broken\n    locations: []\n");
    const result = await run(["check"]);
    expect(result.code).toBe(1);
    expect((result.json.errors as unknown[]).length).toBeGreaterThan(0);
  });

  test("issues sync --dry-run plans without calling gh to write", async () => {
    const { run } = harness();
    await run(addArgs("old-key", ["--expires", "2020-01-01", "--limit", "1000/min"]));
    const calls: string[][] = [];
    const gh: Gh = async (args) => {
      calls.push(args);
      return args[1] === "list" ? "[]" : "";
    };
    const result = await run(["issues", "sync", "--repo", "owner/repo", "--dry-run", "--today", "2026-11-02"], { gh });
    expect(result.code).toBe(0);
    expect(result.json.repo).toBe("owner/repo");
    expect(result.json.dryRun).toBe(true);
    expect((result.json.actions as unknown[]).length).toBe(1);
    expect(calls).toHaveLength(1);
  });

  test("issues sync without a repo leaves repository discovery to gh", async () => {
    const { run } = harness();
    await run(addArgs("old-key", ["--expires", "2020-01-01", "--limit", "1000/min"]));
    const calls: string[][] = [];
    const gh: Gh = async (args) => {
      calls.push(args);
      return args[1] === "list" ? "[]" : "";
    };
    const result = await run(["issues", "sync", "--today", "2026-11-02"], { gh });
    expect(result.code).toBe(0);
    expect(result.json.repo).toBeNull();
    expect(calls.every((args) => !args.includes("--repo"))).toBe(true);
  });

  test("issues sync uses GITHUB_REPOSITORY when nothing else names a repository", async () => {
    const { run } = harness();
    await run(addArgs("old-key", ["--expires", "2020-01-01", "--limit", "1000/min"]));
    const gh: Gh = async (args) => (args[1] === "list" ? "[]" : "");
    const result = await run(["issues", "sync", "--dry-run", "--today", "2026-11-02"], {
      gh,
      env: { GITHUB_REPOSITORY: "owner/name" },
    });
    expect(result.json.repo).toBe("owner/name");
  });

  test("a usage error returns 2", async () => {
    const { run } = harness();
    const result = await run(["nonsense"]);
    expect(result.code).toBe(2);
    expect(result.json).toEqual({ error: { code: "usage", message: "unknown command nonsense" } });
  });

  test("schema describes the CLI", async () => {
    const { run } = harness();
    const result = await run(["schema"]);
    expect(result.code).toBe(0);
    expect(result.json.schemaVersion).toBe(1);
    expect(result.json.exitCodes).toEqual({ ok: 0, error: 1, usage: 2, findings: 3 });
    expect(result.json.configFields).toBe(
      "warnDays, staleDays, idleDays, issueRepo, secretPatterns, ignore, credentialNames, ignorePaths, sources, keys",
    );
  });
});

describe("init", () => {
  test("drafts an entry per secret the workflows reference", async () => {
    const { root, run } = harness();
    mkdirSync(join(root, ".github", "workflows"), { recursive: true });
    writeFileSync(
      join(root, ".github", "workflows", "deploy.yml"),
      `env:\n  A: ${expression("PAYMENTS_API_KEY")}\n  B: ${expression("DEPLOY_TOKEN")}\n  C: ${expression("GITHUB_TOKEN")}\n`,
    );
    const result = await run(["init", "--owner", "team-payments"]);
    expect(result.code).toBe(0);
    expect((result.json.drafted as { id: string }[]).map((draft) => draft.id)).toEqual([
      "deploy-token",
      "payments-api-key",
    ]);
    expect(result.text).toContain("payments-api-key");

    const loaded = await loadTallyFile(join(root, ".tally.yaml"));
    expect(loaded.errors).toEqual([]);
    expect(loaded.entries.map((entry) => entry.id)).toEqual(["deploy-token", "payments-api-key"]);
    expect(loaded.entries[0]).toMatchObject({
      service: "unknown",
      owner: "team-payments",
      locations: [{ kind: "github", ref: "DEPLOY_TOKEN" }],
      expires: "unknown",
      limit: "unknown",
    });
  });

  test("writes an empty keys list when there is nothing to scan", async () => {
    const { root, run } = harness();
    const result = await run(["init"]);
    expect(result.code).toBe(0);
    expect(result.json.drafted).toEqual([]);
    const text = await Bun.file(join(root, ".tally.yaml")).text();
    expect(text).toContain("keys: []");
  });

  test("run again, it links stored copies to their keys and drafts only what nobody names", async () => {
    const { root, config, run } = harness();
    mkdirSync(join(root, ".github", "workflows"), { recursive: true });
    mkdirSync(join(root, "fixtures", ".github", "workflows"), { recursive: true });
    writeFileSync(join(root, ".github", "workflows", "deploy.yml"), `env:\n  A: ${expression("PAYMENTS_API_KEY")}\n`);
    writeFileSync(
      config,
      [
        "ignore: [BUILD_ID]",
        "ignorePaths: ['fixtures/**']",
        "sources:",
        "  - gcp: prod",
        "keys:",
        "  - id: payments",
        "    service: payments",
        "    owner: team-payments",
        "    locations: [{ github: PAYMENTS_API_KEY }]",
        "    expires: unknown",
        "    limit: unknown",
        "",
      ].join("\n"),
    );
    const listing = [
      { name: "PAYMENTS_API_KEY" },
      { name: "MAIL_TOKEN" },
      { name: "DATABASE_URL" },
      { name: "BUILD_ID" },
    ];
    const store: Run = async (argv) => JSON.stringify(argv.includes("versions") ? [] : listing);

    const result = await run(["init", "--owner", "team-mail"], { run: store });
    expect(result.code).toBe(0);
    expect(result.json.linked).toEqual([{ id: "payments", location: { kind: "gcp", ref: "prod/PAYMENTS_API_KEY" } }]);
    // A URL is not credential-shaped and BUILD_ID is ignored, so neither becomes a key.
    expect(result.json.drafted).toEqual([{ id: "mail-token", secret: "MAIL_TOKEN" }]);

    const loaded = await loadTallyFile(config);
    expect(loaded.config.ignorePaths).toEqual(["fixtures/**"]);
    expect(loaded.entries.find((entry) => entry.id === "payments")?.locations).toHaveLength(2);
    expect((await run(["init", "--offline"])).json).toMatchObject({ drafted: [], linked: [] });
  });
});

describe("notify", () => {
  test("notifies once per action finding and keeps the check exit code", async () => {
    const { run } = harness();
    await run(addArgs("old-key", ["--expires", "2020-01-01", "--limit", "1000/min"]));
    await run(addArgs("new-key", ["--expires", "2099-01-01", "--limit", "1000/min"]));
    const sent: string[] = [];
    const result = await run(["notify", "--today", "2026-11-02"], {
      notify: async (message) => {
        sent.push(message);
      },
    });
    expect(result.code).toBe(3);
    expect(result.json.notified).toBe(1);
    expect(sent).toEqual(["old-key expired 2020-01-01"]);
  });

  test("exits 0 when nothing needs action", async () => {
    const { run } = harness();
    await run(addArgs("new-key", ["--expires", "2099-01-01", "--limit", "1000/min"]));
    let called = 0;
    const result = await run(["notify", "--today", "2026-11-02"], {
      notify: async () => {
        called++;
      },
    });
    expect(result.code).toBe(0);
    expect(called).toBe(0);
  });
});

describe("cli guard regressions", () => {
  const fake = ["f9e8d7c6b5a4", "f9e8d7c6b5a4", "f9e8d7c6b5a4"].join("");

  test("a credential-shaped YAML comment fails validate", async () => {
    const { config, run } = harness();
    expect((await run(addArgs("key-one"))).code).toBe(0);
    writeFileSync(config, `# ${fake}\n${await Bun.file(config).text()}`);
    const reply = await run(["validate"]);
    expect(reply.code).toBe(1);
    expect(reply.text).not.toContain(fake);
  });

  test("errors never echo a pasted key", async () => {
    const { run } = harness();
    const reply = await run(["rotated", fake, "--expires", "2027-01-01"]);
    expect(reply.code).toBe(1);
    expect(reply.text).not.toContain(fake);
  });

  test("--dry-run outside issues sync is a usage error", async () => {
    const { run } = harness();
    expect((await run(["rotated", "key-one", "--expires", "2027-01-01", "--dry-run"])).code).toBe(2);
  });

  test("an unsupported global flag is a usage error", async () => {
    const { run } = harness();
    expect((await run(["--registry", "registry", "validate"])).code).toBe(2);
  });
});
