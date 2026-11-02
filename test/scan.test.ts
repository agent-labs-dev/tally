import { describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { referencedSecrets } from "../src/scan";

function repository(): string {
  const root = mkdtempSync(join(tmpdir(), "tally-scan-"));
  mkdirSync(join(root, ".github", "workflows"), { recursive: true });
  return root;
}

describe("referencedSecrets", () => {
  test("finds both syntaxes and names the files that use them", () => {
    const root = repository();
    writeFileSync(
      join(root, ".github", "workflows", "deploy.yml"),
      `env:\n  A: \${{ secrets.PAYMENTS_API_KEY }}\n  B: \${{ secrets['DEPLOY_TOKEN'] }}\n  C: \${{ secrets["SIGNING_KEY"] }}\n`,
    );
    writeFileSync(join(root, ".github", "workflows", "ci.yaml"), `env:\n  A: \${{ secrets.PAYMENTS_API_KEY }}\n`);
    const referenced = referencedSecrets(root);
    expect(referenced).toBeDefined();
    expect(referenced?.get("PAYMENTS_API_KEY")).toEqual([".github/workflows/ci.yaml", ".github/workflows/deploy.yml"]);
    expect(referenced?.get("DEPLOY_TOKEN")).toEqual([".github/workflows/deploy.yml"]);
    expect(referenced?.get("SIGNING_KEY")).toEqual([".github/workflows/deploy.yml"]);
  });

  test("excludes GITHUB_TOKEN", () => {
    const root = repository();
    writeFileSync(
      join(root, ".github", "workflows", "ci.yml"),
      `env:\n  A: \${{ secrets.GITHUB_TOKEN }}\n  B: \${{ secrets["GITHUB_TOKEN"] }}\n`,
    );
    expect(referencedSecrets(root)?.size).toBe(0);
  });

  test("ignores comments and text outside expressions", () => {
    const root = repository();
    writeFileSync(
      join(root, ".github", "workflows", "ci.yml"),
      `# \${{ secrets.COMMENTED_OUT }}\nname: uses secrets.IN_PROSE\nenv:\n  A: \${{ secrets.real_key }} # \${{ secrets.INLINE }}\n`,
    );
    expect([...(referencedSecrets(root)?.keys() ?? [])]).toEqual(["REAL_KEY"]);
  });

  test("ignores files that are not workflows", () => {
    const root = repository();
    writeFileSync(join(root, ".github", "workflows", "notes.md"), "secrets.NOT_A_WORKFLOW\n");
    expect(referencedSecrets(root)?.size).toBe(0);
  });

  test("returns undefined when there is no workflows directory", () => {
    const root = mkdtempSync(join(tmpdir(), "tally-scan-"));
    expect(referencedSecrets(root)).toBeUndefined();
  });
});
