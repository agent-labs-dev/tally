import { describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { referencedSecrets, skipping, templatedSecrets } from "../src/scan";

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

  test("a job or output named secrets is not the secrets context", () => {
    const root = repository();
    writeFileSync(
      join(root, ".github", "workflows", "ci.yml"),
      `env:\n  A: \${{ needs.secrets.result }}\n  B: \${{ steps.secrets.outputs['KEY'] }}\n`,
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

describe("templatedSecrets", () => {
  function checkout(files: Record<string, string>): string {
    const root = mkdtempSync(join(tmpdir(), "tally-env-"));
    for (const [name, text] of Object.entries(files)) {
      mkdirSync(join(root, name, ".."), { recursive: true });
      writeFileSync(join(root, name), text);
    }
    Bun.spawnSync(["git", "-C", root, "init", "-q"]);
    Bun.spawnSync([
      "git",
      "-C",
      root,
      "add",
      "--",
      ...Object.keys(files).filter((name) => name !== "untracked.env.example"),
    ]);
    return root;
  }

  test("reads credential names from tracked templates and nothing from a real .env", () => {
    const root = checkout({
      ".env.example":
        "PAYMENTS_API_KEY=replace-me\nexport DEPLOY_TOKEN=\nSERVER_PORT=8080\nCLIENT_ID=abc\n# OPTIONAL_SECRET=\n# Set MAIL_TOKEN=x in prose\nGPG_PASSPHRASE=\nGH_PAT=\nDEPLOY_HOOK=\nANDROID_KEYSTORE=\nSEARCH_PATH=\n",
      "services/web/.env.sample": "SIGNING_SECRET=\n",
      ".env": "REAL_ONLY_KEY=x\n",
      "untracked.env.example": "UNTRACKED_KEY=\n",
    });
    const found = templatedSecrets(root);
    expect([...(found?.keys() ?? [])].sort()).toEqual([
      "ANDROID_KEYSTORE",
      "DEPLOY_HOOK",
      "DEPLOY_TOKEN",
      "GH_PAT",
      "GPG_PASSPHRASE",
      "OPTIONAL_SECRET",
      "PAYMENTS_API_KEY",
      "SIGNING_SECRET",
    ]);
    expect(found?.get("SIGNING_SECRET")).toEqual(["services/web/.env.sample"]);
  });

  test("ignorePaths leaves out matching templates", () => {
    const root = checkout({ ".env.example": "LIVE_KEY=\n", "fixtures/case/.env.example": "FAKE_SECRET=\n" });
    expect([...(templatedSecrets(root, [], skipping(["fixtures/**"]))?.keys() ?? [])]).toEqual(["LIVE_KEY"]);
  });

  test("a tally file adds its own credential naming conventions", () => {
    const root = checkout({ ".env.example": "DATABASE_URL=\nSERVER_PORT=\n" });
    expect([...(templatedSecrets(root, ["^DATABASE_URL$"])?.keys() ?? [])]).toEqual(["DATABASE_URL"]);
  });

  test("returns undefined outside a git checkout", () => {
    expect(templatedSecrets(mkdtempSync(join(tmpdir(), "tally-env-")))).toBeUndefined();
  });
});
