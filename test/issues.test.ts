import { describe, expect, test } from "bun:test";
import { desiredIssues, type Gh, syncIssues } from "../src/issues";
import type { Finding } from "../src/reconcile";
import type { Entry } from "../src/schema";

function entry(over: Partial<Entry> = {}): Entry {
  return {
    id: "payments-api",
    service: "example-provider",
    owner: "team-payments",
    locations: [{ kind: "vault", ref: "kv/payments" }],
    expires: "2025-01-01",
    limit: "1000/day",
    ...over,
  };
}

const expired: Finding = {
  id: "expiry:payments-api",
  kind: "expired",
  severity: "action",
  key: "payments-api",
  title: "payments-api expired 2025-01-01",
  days: -1,
};

const unregistered: Finding = {
  id: "unregistered:OLD_KEY",
  kind: "unregistered",
  severity: "action",
  key: "OLD_KEY",
  title: "OLD_KEY is used but not declared in .tally.yaml",
  detail: "Referenced in:\n\n- `.github/workflows/deploy.yml`",
};

function fakeGh(open: unknown, fail?: (args: string[]) => boolean) {
  const calls: string[][] = [];
  const gh: Gh = async (args) => {
    calls.push(args);
    if (fail?.(args)) throw new Error("gh issue create failed: not a collaborator");
    if (args[0] === "issue" && args[1] === "list") return JSON.stringify(open);
    if (args[0] === "issue" && args[1] === "create") return "https://github.com/owner/repo/issues/12\n";
    return "";
  };
  return { calls, gh };
}

function writes(calls: readonly string[][]): string[][] {
  return calls.filter((args) => args[0] === "issue" && args[1] !== "list");
}

function only(desired: ReturnType<typeof desiredIssues>) {
  const [want] = desired;
  if (want === undefined) throw new Error("expected one desired issue");
  return want;
}

describe("desiredIssues", () => {
  test("an entry finding describes the entry and names its owner as assignee", () => {
    const [want] = desiredIssues([expired], [entry()]);
    expect(want?.assignee).toBe("team-payments");
    expect(want?.body).toContain("| Service | example-provider |");
    expect(want?.body).toContain("tally rotated payments-api");
  });

  test("an organization owner is not named as assignee", () => {
    const owners = new Map([["team-payments", "Organization"]]);
    const [want] = desiredIssues([expired], [entry()], { owners });
    expect(want?.assignee).toBeUndefined();
  });

  test("an organization owner's issue goes to the org assignee", () => {
    const owners = new Map([["team-payments", "Organization"]]);
    const [want] = desiredIssues([expired], [entry()], { owners, orgAssignee: "on-call" });
    expect(want?.assignee).toBe("on-call");
  });

  test("a finding with no entry uses its title and detail instead of a table", () => {
    const want = only(desiredIssues([unregistered], []));
    expect(want.assignee).toBeUndefined();
    expect(want.title).toBe(unregistered.title);
    expect(want.body).toContain("<!-- tally:unregistered:OLD_KEY -->");
    expect(want.body).toContain(".github/workflows/deploy.yml");
    expect(want.body).not.toContain("| Service |");
    expect(want.body).not.toContain("tally rotated");
  });

  test("all gap findings produce one digest issue", () => {
    const gaps: Finding[] = [
      { id: "gap:payments-api:limit", kind: "unknown-limit", severity: "gap", key: "payments-api", title: "no limit" },
      {
        id: "gap:payments-api:expiry",
        kind: "unknown-expiry",
        severity: "gap",
        key: "payments-api",
        title: "no expiry",
      },
      { id: "gap:other-key:limit", kind: "unknown-limit", severity: "gap", key: "other-key", title: "no limit" },
    ];
    const other = entry({ id: "other-key", expires: "unknown", limit: "unknown" });
    const desired = desiredIssues(gaps, [entry({ expires: "unknown", limit: "unknown" }), other]);
    expect(desired).toHaveLength(1);
    const digest = only(desired);
    expect(digest.marker).toBe("gaps");
    expect(digest.title).toBe("2 keys are missing facts");
    expect(digest.body).toContain("**unknown-limit**");
  });

  test("a gap kind no built-in rule produces still gets its own digest section", () => {
    const gaps: Finding[] = [
      {
        id: "gap:payments-api:runbook",
        kind: "missing-runbook",
        severity: "gap",
        key: "payments-api",
        title: "payments-api has no runbook",
      },
    ];
    const digest = only(desiredIssues(gaps, [entry()]));
    expect(digest.body).toContain("**missing-runbook**");
    expect(digest.body).toContain("payments-api has no runbook");
  });
});

describe("syncIssues", () => {
  test("creates the issue when it is missing", async () => {
    const desired = desiredIssues([expired], [entry()]);
    const { calls, gh } = fakeGh([]);
    const actions = await syncIssues(gh, "owner/repo", desired, false);
    expect(actions).toEqual([
      { do: "create", marker: "expiry:payments-api", title: expired.title, assignee: "team-payments" },
    ]);
    expect(writes(calls).filter((args) => args[1] === "create")).toHaveLength(1);
  });

  test("assigns the owner after creating the issue", async () => {
    const { calls, gh } = fakeGh([]);
    await syncIssues(gh, "owner/repo", desiredIssues([expired], [entry()]), false);
    const [create, assign] = writes(calls);
    expect(create).not.toContain("--assignee");
    expect(assign).toEqual(["issue", "edit", "12", "--repo", "owner/repo", "--add-assignee", "team-payments"]);
  });

  test("an owner gh cannot assign still leaves exactly one issue", async () => {
    const { calls, gh } = fakeGh([], (args) => args.includes("--add-assignee"));
    const actions = await syncIssues(gh, "owner/repo", desiredIssues([expired], [entry()]), false);
    expect(actions).toHaveLength(1);
    expect(actions[0]).toMatchObject({
      unassigned: "team-payments: gh issue create failed: not a collaborator",
    });
    expect(writes(calls).filter((args) => args[1] === "create")).toHaveLength(1);
  });

  test("a failed create without an assignee is not retried", async () => {
    const { calls, gh } = fakeGh([], (args) => args[0] === "issue" && args[1] === "create");
    await expect(syncIssues(gh, "owner/repo", desiredIssues([unregistered], []), false)).rejects.toThrow(
      "not a collaborator",
    );
    expect(writes(calls).filter((args) => args[1] === "create")).toHaveLength(1);
  });

  test("edits the issue when the title or body changed", async () => {
    const { gh } = fakeGh([{ number: 7, title: "stale title", body: "<!-- tally:expiry:payments-api -->" }]);
    const actions = await syncIssues(gh, "owner/repo", desiredIssues([expired], [entry()]), false);
    expect(actions).toEqual([
      { do: "edit", marker: "expiry:payments-api", number: 7, title: expired.title, assignee: "team-payments" },
    ]);
  });

  test("reports a failed assignment after editing the issue", async () => {
    const { gh } = fakeGh([{ number: 7, title: "stale title", body: "<!-- tally:expiry:payments-api -->" }], (args) =>
      args.includes("--add-assignee"),
    );
    const actions = await syncIssues(gh, "owner/repo", desiredIssues([expired], [entry()]), false);
    expect(actions).toEqual([
      {
        do: "edit",
        marker: "expiry:payments-api",
        number: 7,
        title: expired.title,
        assignee: "team-payments",
        unassigned: "team-payments: gh issue create failed: not a collaborator",
      },
    ]);
  });

  test("makes no write when the issue is unchanged", async () => {
    const want = only(desiredIssues([expired], [entry()]));
    const labels = want.labels.map((name) => ({ name }));
    const { calls, gh } = fakeGh([
      { number: 7, title: want.title, body: want.body, labels, assignees: [{ login: "team-payments" }] },
    ]);
    const actions = await syncIssues(gh, "owner/repo", [want], false);
    expect(actions).toEqual([]);
    expect(writes(calls)).toEqual([]);
  });

  test("retries an assignment for an unchanged unassigned issue", async () => {
    const want = only(desiredIssues([expired], [entry()]));
    const labels = want.labels.map((name) => ({ name }));
    const { calls, gh } = fakeGh([{ number: 7, title: want.title, body: want.body, labels, assignees: [] }], (args) =>
      args.includes("--add-assignee"),
    );
    const actions = await syncIssues(gh, "owner/repo", [want], false);
    expect(actions).toEqual([
      {
        do: "edit",
        marker: "expiry:payments-api",
        number: 7,
        title: expired.title,
        assignee: "team-payments",
        assignOnly: true,
        unassigned: "team-payments: gh issue create failed: not a collaborator",
      },
    ]);
    expect(writes(calls)).toEqual([["issue", "edit", "7", "--repo", "owner/repo", "--add-assignee", "team-payments"]]);
  });

  test("replaces the assignee tally set before and keeps one a person added", async () => {
    const owners = new Map([["team-payments", "Organization"]]);
    const before = only(desiredIssues([expired], [entry()], { owners, orgAssignee: "old-oncall" }));
    const after = only(desiredIssues([expired], [entry()], { owners, orgAssignee: "new-oncall" }));
    const labels = before.labels.map((name) => ({ name }));
    const assignees = [{ login: "old-oncall" }, { login: "reviewer" }];
    const { calls, gh } = fakeGh([{ number: 7, title: before.title, body: before.body, labels, assignees }]);
    await syncIssues(gh, "owner/repo", [after], false);
    const [edit, assign] = writes(calls);
    expect(edit).toContain("--remove-assignee");
    expect(edit?.slice(-2)).toEqual(["--remove-assignee", "old-oncall"]);
    expect(edit).not.toContain("reviewer");
    expect(assign).toEqual(["issue", "edit", "7", "--repo", "owner/repo", "--add-assignee", "new-oncall"]);
  });

  test("unsetting the org assignee removes the person tally assigned", async () => {
    const owners = new Map([["team-payments", "Organization"]]);
    const before = only(desiredIssues([expired], [entry()], { owners, orgAssignee: "old-oncall" }));
    const after = only(desiredIssues([expired], [entry()], { owners }));
    const labels = before.labels.map((name) => ({ name }));
    const { calls, gh } = fakeGh([
      { number: 7, title: before.title, body: before.body, labels, assignees: [{ login: "old-oncall" }] },
    ]);
    await syncIssues(gh, "owner/repo", [after], false);
    expect(writes(calls)).toHaveLength(1);
    expect(writes(calls)[0]?.slice(-2)).toEqual(["--remove-assignee", "old-oncall"]);
  });

  test("closes an open issue whose marker is no longer wanted", async () => {
    const { gh } = fakeGh([{ number: 9, title: "old key", body: "<!-- tally:expiry:gone -->" }]);
    const actions = await syncIssues(gh, "owner/repo", [], false);
    expect(actions).toEqual([{ do: "close", marker: "expiry:gone", number: 9, title: "old key" }]);
  });

  test("dryRun makes no write calls, including no label calls", async () => {
    const { calls, gh } = fakeGh([]);
    const actions = await syncIssues(gh, "owner/repo", desiredIssues([expired], [entry()]), true);
    expect(actions).toEqual([
      { do: "create", marker: "expiry:payments-api", title: expired.title, assignee: "team-payments" },
    ]);
    expect(calls).toHaveLength(1);
    expect(calls.every((args) => args[0] === "issue" && args[1] === "list")).toBe(true);
  });

  test("with no repo every gh call omits --repo", async () => {
    const { calls, gh } = fakeGh([]);
    await syncIssues(gh, undefined, desiredIssues([expired], [entry()]), false);
    expect(calls.length).toBeGreaterThan(1);
    expect(calls.some((args) => args.includes("--repo"))).toBe(false);
  });
});

describe("syncIssues edge cases", () => {
  const issue = (number: number, marker: string) => ({
    number,
    title: "t",
    body: `<!-- tally:${marker} -->`,
    labels: [{ name: "tally" }],
  });

  test("closes later duplicates of one marker and keeps the oldest", async () => {
    const { calls, gh } = fakeGh([issue(9, "gone"), issue(4, "gone")]);
    const actions = await syncIssues(gh, "o/r", [], false);
    expect(actions.map((action) => ("number" in action ? action.number : 0)).sort()).toEqual([4, 9]);
    expect(writes(calls).filter((args) => args[1] === "close")).toHaveLength(2);
  });

  test("a run with nothing to change makes no writes, including labels", async () => {
    const [want] = desiredIssues([expired], [entry()]);
    if (!want) throw new Error("expected one desired issue");
    const { calls, gh } = fakeGh([
      {
        number: 1,
        title: want.title,
        body: want.body,
        labels: want.labels.map((name) => ({ name })),
        assignees: [{ login: "team-payments" }],
      },
    ]);
    expect(await syncIssues(gh, "o/r", [want], false)).toEqual([]);
    expect(calls.filter((args) => args[0] !== "issue" || args[1] !== "list")).toEqual([]);
  });
});
