import { describe, expect, test } from "bun:test";
import { addSecretPatterns, looksSecret, parseEntry, withheld } from "../src/schema";

function valid(over: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id: "payments-api",
    service: "example-provider",
    owner: "team-payments",
    locations: [{ vault: "kv/payments" }],
    expires: "2026-12-31",
    limit: "1000 requests per minute",
    ...over,
  };
}

function rejects(raw: Record<string, unknown>): string[] {
  return parseEntry(raw).errors;
}

describe("parseEntry", () => {
  test("accepts a valid entry", () => {
    const { entry, errors } = parseEntry(valid());
    expect(errors).toEqual([]);
    expect(entry?.id).toBe("payments-api");
    expect(entry?.service).toBe("example-provider");
    expect(entry?.locations).toEqual([{ kind: "vault", ref: "kv/payments" }]);
  });

  test("group is optional and still an open slug when present", () => {
    expect(parseEntry(valid()).entry?.group).toBeUndefined();
    const raw = valid({ group: "some-new-team", locations: [{ "new-store": "apps/payments" }] });
    const { entry, errors } = parseEntry(raw);
    expect(errors).toEqual([]);
    expect(entry?.group).toBe("some-new-team");
    expect(entry?.locations).toEqual([{ kind: "new-store", ref: "apps/payments" }]);
  });

  test("rejects an unknown field", () => {
    expect(rejects(valid({ colour: "red" }))).toContain("unknown field colour");
  });

  test("rejects a bad date", () => {
    expect(rejects(valid({ expires: "2026-13-01" }))).toContain("expires must be YYYY-MM-DD, unknown or none");
    expect(rejects(valid({ rotated: "31-12-2026" }))).toContain("rotated must be YYYY-MM-DD");
  });

  test("rejects a fingerprint over 6 characters", () => {
    expect(rejects(valid({ fingerprint: "abcdefg" }))).toContain(
      "fingerprint is the provider's redacted suffix, at most 6 characters",
    );
    expect(rejects(valid({ fingerprint: "…abc123" }))).toEqual([]);
  });

  test("rejects expires none without a note, and accepts it with one", () => {
    expect(rejects(valid({ expires: "none" }))).toContain("expires: none needs an expiresNote saying why");
    expect(rejects(valid({ expires: "none", expiresNote: "the provider sets no expiry" }))).toEqual([]);
  });

  test("an id has no file to match, so any slug is accepted", () => {
    expect(rejects(valid({ id: "another-key" }))).toEqual([]);
    expect(rejects(valid({ id: "Not-A-Slug" }))).toContain("id must be lowercase words joined by hyphens");
  });

  test("rejects empty locations", () => {
    expect(rejects(valid({ locations: [] }))).toContain("locations needs at least one");
  });

  test("rejects credential-shaped text in any field", () => {
    // Built at runtime so this file never holds a key-shaped literal for a secret scanner to flag.
    const fakePrefixed = "sk-" + "or-v1-" + "abc123def456";
    const fakeGithub = "ghp" + "_" + "A1b2C3d4E5f6G7h8I9j0";
    const fakeRandom = "aB3xY7qW" + "mN2pR8sT" + "vK4jH9gF" + "dC6bA1zX" + "eL0uI5oS";
    const message = "contains text that looks like a credential, so it was rejected";
    for (const fake of [fakePrefixed, fakeGithub, fakeRandom]) {
      for (const field of ["owner", "label", "note", "limit", "runbook"]) {
        expect(rejects(valid({ [field]: fake }))).toContain(message);
      }
      expect(rejects(valid({ locations: [{ vault: fake }] }))).toContain(message);
    }
  });

  test("addSecretPatterns rejects a new custom format", () => {
    addSecretPatterns(["tally-test-[0-9]{8}"]);
    const fake = "tally-test-" + "12345678";
    expect(rejects(valid({ note: fake }))).toContain("contains text that looks like a credential, so it was rejected");
    expect(rejects(valid())).toEqual([]);
  });
});

describe("guard regressions", () => {
  test("rejects long single-case and hex tokens", () => {
    expect(looksSecret("a1b2c3d4e5f6a7b8c9d0e1f2a3b4c5d6e7f8")).toBe(true);
    expect(looksSecret(`note ${"q7w3e9r2t5y8u1i4o6p0a2s5d8f1g4h7"}`)).toBe(true);
    expect(looksSecret("owner/name/PAYMENTS_API_KEY")).toBe(false);
  });

  test("rejects long letters-only random tokens but not long identifiers", () => {
    expect(looksSecret(["qWeRtYuIoPaSdFgHjK", "lZxCvBnMqWeRtYuIoPaSdF"].join(""))).toBe(true);
    expect(looksSecret("ExampleProviderSecretKeyProduction PAYMENTS_API_KEY_PRODUCTION")).toBe(false);
  });

  test("a bad optional field returns errors and no entry", () => {
    const result = parseEntry(valid({ note: 7 }));
    expect(result.entry).toBeUndefined();
    expect(result.errors).toContain("note must be text");
  });

  test("prefixes only match at the start of a token", () => {
    expect(looksSecret("risk-assessment for the desk-booking key")).toBe(false);
    expect(looksSecret(`key ${"sk-"}abcdef123456`)).toBe(true);
  });

  test("withheld hides credential-shaped input", () => {
    expect(withheld("a1b2c3d4e5f6a7b8c9d0e1f2a3b4c5d6e7f8")).toBe("(value withheld)");
    expect(withheld("payments-api")).toBe("payments-api");
  });
});
