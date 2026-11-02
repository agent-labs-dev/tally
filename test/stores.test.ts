import { describe, expect, test } from "bun:test";
import { observe, type Run, runCommand, stores, valueCommands } from "../src/stores";

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

  test("no reader ever builds a command that prints a secret value", async () => {
    const run: Run = async (argv) => {
      for (const banned of valueCommands) expect(banned.every((word) => argv.includes(word))).toBe(false);
      if (argv.includes("versions")) return "[]";
      if (argv[0] === "aws") return JSON.stringify({ SecretList: [{ Name: "KEY" }] });
      return JSON.stringify([{ name: "KEY", id: "https://vault.example/secrets/KEY" }]);
    };
    for (const kind of Object.keys(stores)) await observe([{ kind, scope: "scope", filter: "f" }], run);
  });

  test("runCommand refuses a value command before running anything", async () => {
    await expect(runCommand(["gcloud", "secrets", "versions", "access", "latest"])).rejects.toThrow("refusing");
  });
});
