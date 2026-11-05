import { describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Entry } from "../src/schema";
import { findTallyFile, loadTallyFile, userTallyFile, writeTallyFile } from "../src/tallyfile";

function temp(): string {
  return mkdtempSync(join(tmpdir(), "tally-file-"));
}

function entry(over: Partial<Entry> = {}): Entry {
  return {
    id: "payments-api",
    service: "example-provider",
    owner: "team-payments",
    locations: [{ kind: "github", ref: "PAYMENTS_API_KEY" }],
    expires: "2027-01-01",
    limit: "unknown",
    ...over,
  };
}

const document = `warnDays: 7
keys:
  - id: payments-api
    service: example-provider
    owner: team-payments
    locations:
      - github: PAYMENTS_API_KEY
    expires: 2027-01-01
    limit: unknown
`;

describe("findTallyFile", () => {
  test("TALLY_CONFIG wins over everything", () => {
    const root = temp();
    writeFileSync(join(root, ".tally.yaml"), "keys: []\n");
    expect(findTallyFile(root, { TALLY_CONFIG: "elsewhere/custom.yaml" })).toBe(join(root, "elsewhere", "custom.yaml"));
  });

  test("the nearest .tally.yaml up to the repository root is used", () => {
    const root = temp();
    mkdirSync(join(root, ".git"));
    writeFileSync(join(root, ".tally.yaml"), "keys: []\n");
    const nested = join(root, "src", "deep");
    mkdirSync(nested, { recursive: true });
    expect(findTallyFile(nested, {})).toBe(join(root, ".tally.yaml"));
  });

  test("a nearer file wins over the repository root", () => {
    const root = temp();
    mkdirSync(join(root, ".git"));
    writeFileSync(join(root, ".tally.yaml"), "keys: []\n");
    const packageDir = join(root, "packages", "api");
    mkdirSync(packageDir, { recursive: true });
    writeFileSync(join(packageDir, ".tally.yaml"), "keys: []\n");
    expect(findTallyFile(packageDir, {})).toBe(join(packageDir, ".tally.yaml"));
  });

  test("with no file the repository root path is returned, even though it does not exist yet", () => {
    const root = temp();
    mkdirSync(join(root, ".git"));
    const nested = join(root, "nested");
    mkdirSync(nested);
    expect(findTallyFile(nested, {})).toBe(join(root, ".tally.yaml"));
  });

  test("a file above the repository root is never used", () => {
    const outside = temp();
    writeFileSync(join(outside, ".tally.yaml"), "keys: []\n");
    const root = join(outside, "checkout");
    mkdirSync(join(root, ".git"), { recursive: true });
    expect(findTallyFile(root, {})).toBe(join(root, ".tally.yaml"));
  });

  test("outside a repository it falls back to the user config directory", () => {
    const root = temp();
    expect(findTallyFile(root, { XDG_CONFIG_HOME: "/xdg" })).toBe("/xdg/tally/tally.yaml");
    expect(findTallyFile(root, { HOME: "/home/tester" })).toBe("/home/tester/.config/tally/tally.yaml");
  });
});

describe("loadTallyFile", () => {
  test("reads settings and keys from one file", async () => {
    const root = temp();
    const path = join(root, ".tally.yaml");
    writeFileSync(path, document);
    const { config, entries, errors } = await loadTallyFile(path);
    expect(errors).toEqual([]);
    expect(config.warnDays).toBe(7);
    expect(config.ignore).toEqual([]);
    expect(entries).toHaveLength(1);
    expect(entries[0]?.id).toBe("payments-api");
  });

  test("a missing file is an error that says how to create one", async () => {
    const { errors, entries } = await loadTallyFile(join(temp(), ".tally.yaml"));
    expect(entries).toEqual([]);
    expect(errors[0]?.message).toContain("tally init");
  });

  test("a missing user fallback explains that there is no repository", async () => {
    const root = temp();
    const path = userTallyFile({ XDG_CONFIG_HOME: root });
    const { errors } = await loadTallyFile(path, { fallback: true });
    expect(errors[0]?.message).toBe(
      "no repository found here, and the user-level tally file does not exist yet; create it with `tally init` or `tally add`",
    );
  });

  test("unknown top-level keys are errors", async () => {
    const root = temp();
    const path = join(root, ".tally.yaml");
    writeFileSync(path, "warnDays: 30\ncolour: red\nkeys: []\n");
    const { errors } = await loadTallyFile(path);
    expect(errors.map((error) => error.message)).toContain("unknown setting colour");
  });

  test("a duplicate id is rejected", async () => {
    const root = temp();
    const path = join(root, ".tally.yaml");
    const one = document.slice(document.indexOf("  - id:"));
    writeFileSync(path, `keys:\n${one}${one}`);
    const { entries, errors } = await loadTallyFile(path);
    expect(entries).toHaveLength(1);
    expect(errors.map((error) => error.message)).toContain("duplicate id payments-api");
  });

  test("credential-shaped raw text is rejected before parsing", async () => {
    const root = temp();
    const path = join(root, ".tally.yaml");
    // Built at runtime so this file never holds a key-shaped literal for a secret scanner to flag.
    const fake = "ghp" + "_" + "A1b2C3d4E5f6G7h8I9j0";
    writeFileSync(path, `# ${fake}\nkeys: []\n`);
    const { errors } = await loadTallyFile(path);
    expect(errors[0]?.message).toBe("contains text that looks like a credential, so it was rejected");
    expect(JSON.stringify(errors)).not.toContain(fake);
  });

  test("settings are validated and the file's own secret patterns apply", async () => {
    const root = temp();
    const path = join(root, ".tally.yaml");
    writeFileSync(
      path,
      `warnDays: 0\nsecretPatterns: ["tally-file-[0-9]{8}"]\nkeys:\n  - id: payments-api\n    service: example-provider\n    owner: tally-file-12345678\n    locations:\n      - github: PAYMENTS_API_KEY\n    expires: unknown\n    limit: unknown\n`,
    );
    const { errors } = await loadTallyFile(path);
    expect(errors.map((error) => error.message)).toContain("warnDays must be a positive whole number");
    expect(errors.map((error) => error.message)).toContain(
      "contains text that looks like a credential, so it was rejected",
    );
  });

  test("a comment only the file's own patterns catch is still rejected", async () => {
    const path = join(temp(), ".tally.yaml");
    writeFileSync(path, `secretPatterns: ["tally-file-[0-9]{8}"]\n# pasted tally-file-${"1234"}5678\nkeys: []\n`);
    const { errors } = await loadTallyFile(path);
    expect(errors.map((error) => error.message)).toEqual([
      "contains text that looks like a credential, so it was rejected",
    ]);
  });
});

test("a setting written twice is an error, not a silent override", async () => {
  const path = join(temp(), ".tally.yaml");
  writeFileSync(path, 'sources:\n  - gcp: prod\n"sources": []\nkeys: []\n');
  const loaded = await loadTallyFile(path);
  expect(loaded.errors.map((error) => error.message)).toEqual(["sources is set more than once"]);
});

describe("writeTallyFile", () => {
  test("round-trips settings and every entry", async () => {
    const root = temp();
    const path = join(root, ".tally.yaml");
    const config = {
      warnDays: 14,
      secretPatterns: [],
      ignore: ["BUILD_ID"],
      credentialNames: [],
      ignorePaths: [],
      sources: [],
      staleDays: 365,
      idleDays: 90,
      issueRepo: "owner/name",
    };
    await writeTallyFile(path, config, [entry(), entry({ id: "other-key", group: "team" })]);
    const text = await Bun.file(path).text();
    expect(text.endsWith("\n")).toBe(true);
    expect(text.indexOf("warnDays")).toBeLessThan(text.indexOf("keys:"));
    const loaded = await loadTallyFile(path);
    expect(loaded.errors).toEqual([]);
    expect(loaded.config).toEqual(config);
    expect(loaded.entries.map((item) => item.id)).toEqual(["payments-api", "other-key"]);
    expect(loaded.entries[1]?.group).toBe("team");
  });

  test("refuses to write a duplicate id", async () => {
    const path = join(temp(), ".tally.yaml");
    await expect(
      writeTallyFile(
        path,
        {
          warnDays: 30,
          secretPatterns: [],
          ignore: [],
          credentialNames: [],
          ignorePaths: [],
          sources: [],
          staleDays: 365,
          idleDays: 90,
        },
        [entry(), entry()],
      ),
    ).rejects.toThrow("duplicate id");
  });

  test("creates missing parent directories", async () => {
    const path = join(temp(), "nested", "dir", "tally.yaml");
    await writeTallyFile(
      path,
      {
        warnDays: 30,
        secretPatterns: [],
        ignore: [],
        credentialNames: [],
        ignorePaths: [],
        sources: [],
        staleDays: 365,
        idleDays: 90,
      },
      [],
    );
    expect((await loadTallyFile(path)).errors).toEqual([]);
  });
});

test("a source token is an upper-case variable name, and only for a provider", async () => {
  const path = join(temp(), ".tally.yaml");
  for (const [source, message] of [
    ["- openrouter: team\n    token: router_admin", "NAME of an environment variable"],
    ["- gcp: prod\n    token: GCP_TOKEN", "takes no token"],
  ]) {
    writeFileSync(path, `sources:\n  ${source}\nkeys: []\n`);
    expect((await loadTallyFile(path)).errors.map((error) => error.message).join()).toContain(message ?? "");
  }
  writeFileSync(path, "sources:\n  - openrouter: team\n    token: ROUTER_ADMIN\nkeys: []\n");
  const loaded = await loadTallyFile(path);
  expect(loaded.errors).toEqual([]);
  expect(loaded.config.sources).toEqual([{ kind: "openrouter", scope: "team", token: "ROUTER_ADMIN" }]);
});
