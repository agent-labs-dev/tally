import type { Context, Finding, Severity } from "./reconcile";
import type { Entry } from "./schema";

/** Runs `gh` with these arguments and returns stdout. Injected so tests never touch GitHub. */
export type Gh = (args: string[]) => Promise<string>;

export const label = "tally";
/** Kinds are open, so a label's colour follows its severity rather than a list of known kinds. */
const colours: Record<Severity | "base", string> = { base: "5319e7", action: "b60205", gap: "c5def5" };

export interface Desired {
  marker: string;
  title: string;
  body: string;
  /** The `tally` label plus one `tally:<kind>` label. */
  labels: string[];
  severity: Severity;
  /** The entry's owner, when the finding describes an entry. gh rejects an owner who cannot be assigned. */
  assignee?: string;
}

export type Action =
  | { do: "create"; marker: string; title: string; unassigned?: string }
  | { do: "edit"; marker: string; number: number; title: string; assignOnly?: true; unassigned?: string }
  | { do: "close"; marker: string; number: number; title: string };

const markerPattern = /<!-- tally:(\S+) -->/;
const gapsMarker = "gaps";

function runbookLink(runbook: string): string {
  const target = /^https?:\/\//.test(runbook) ? runbook : `../blob/main/${runbook.replace(/^\.\//, "")}`;
  return `[${runbook}](${target})`;
}

function describe(entry: Entry): string {
  const lines = [
    `| | |`,
    `|---|---|`,
    `| Service | ${entry.service} |`,
    `| Owner | ${entry.owner} |`,
    `| Expires | ${entry.expires}${entry.expiresNote ? ` (${entry.expiresNote})` : ""} |`,
    `| Limit | ${entry.limit} |`,
  ];
  if (entry.group) lines.splice(3, 0, `| Group | ${entry.group} |`);
  if (entry.label) lines.push(`| Provider label | ${entry.label} |`);
  if (entry.fingerprint) lines.push(`| Fingerprint | \`${entry.fingerprint}\` |`);
  if (entry.rotated) lines.push(`| Last rotated | ${entry.rotated} |`);
  if (entry.runbook) lines.push(`| Runbook | ${runbookLink(entry.runbook)} |`);
  lines.push("", "**Stored in**", "", ...entry.locations.map((location) => `- ${location.kind}: \`${location.ref}\``));
  if (entry.note) lines.push("", entry.note);
  return lines.join("\n");
}

function rotationSteps(entry: Entry): string[] {
  return [
    "After rotating, record the new expiry so this issue closes on the next check:",
    "",
    "```sh",
    `tally rotated ${entry.id} --expires YYYY-MM-DD`,
    "```",
  ];
}

/** One issue per action finding, plus one digest for every gap. */
export function desiredIssues(
  findings: readonly Finding[],
  entries: readonly Entry[],
  { owners, orgAssignee }: Pick<Context, "owners" | "orgAssignee"> = {},
): Desired[] {
  const byId = new Map(entries.map((entry) => [entry.id, entry]));
  // gh always rejects an organization assignee, so an organization's keys go to orgAssignee, or to nobody.
  const assignee = (owner: string | undefined) =>
    owner === undefined || owner === "unknown"
      ? undefined
      : owners?.get(owner) === "Organization"
        ? orgAssignee
        : owner;
  const desired: Desired[] = [];
  for (const finding of findings) {
    if (finding.severity !== "action") continue;
    const entry = byId.get(finding.key);
    const header = `<!-- tally:${finding.id} -->`;
    desired.push({
      marker: finding.id,
      title: finding.title,
      labels: [label, `tally:${finding.kind}`],
      severity: "action",
      assignee: assignee(entry?.owner),
      body: entry
        ? [header, describe(entry), "", ...rotationSteps(entry)].join("\n")
        : [header, finding.detail ?? finding.title].join("\n\n"),
    });
  }
  const gaps = findings.filter((finding) => finding.severity === "gap");
  if (gaps.length > 0) {
    // Grouped by whatever kinds the rules produced, so a new gap rule shows up here without a code change.
    const kinds = [...new Set(gaps.map((finding) => finding.kind))].sort();
    const sections = kinds.flatMap((kind) => [
      `**${kind}**`,
      "",
      ...gaps.filter((finding) => finding.kind === kind).map((finding) => `- ${finding.title}`),
      "",
    ]);
    desired.push({
      marker: gapsMarker,
      title: `${new Set(gaps.map((finding) => finding.key)).size} keys are missing facts`,
      labels: [label, "tally:gaps"],
      severity: "gap",
      body: [
        `<!-- tally:${gapsMarker} -->`,
        "Alerts only work for facts the tally file records. Look each one up in the provider dashboard and edit its entry, or set `none` with a reason.",
        "",
        ...sections,
      ].join("\n"),
    });
  }
  return desired;
}

interface Open {
  number: number;
  title: string;
  body: string;
  labels?: { name: string }[];
  assignees?: { login: string }[];
}

/**
 * One gh call. `assign` names an owner to add afterwards, and `number` identifies an existing issue or the issue
 * created by this write. The action records an assignment failure without stopping later writes.
 */
interface Write {
  args: string[];
  assign?: string;
  number?: string;
  action: Action;
}

/** gh pages through results up to this; far above any tally file, so every open tally issue is seen. */
const listLimit = 10_000;

/**
 * Make the repository's open `tally` issues match `desired`: create, edit what changed, close what cleared.
 * With no repo, every gh call omits `--repo`, so gh infers the repository from the working directory.
 */
export async function syncIssues(gh: Gh, repo: string | undefined, desired: readonly Desired[], dryRun: boolean) {
  const at = repo === undefined ? [] : ["--repo", repo];
  const open = JSON.parse(
    await gh([
      "issue",
      "list",
      ...at,
      "--label",
      label,
      "--state",
      "open",
      "--limit",
      String(listLimit),
      "--json",
      "number,title,body,labels,assignees",
    ]),
  ) as Open[];

  // The oldest issue for a marker is the one to keep; later copies are closed as duplicates.
  const byMarker = new Map<string, Open>();
  const duplicates: { marker: string; issue: Open }[] = [];
  for (const issue of [...open].sort((a, b) => a.number - b.number)) {
    const marker = markerPattern.exec(issue.body)?.[1];
    if (!marker) continue;
    if (byMarker.has(marker)) duplicates.push({ marker, issue });
    else byMarker.set(marker, issue);
  }

  const actions: Action[] = [];
  const writes: Write[] = [];
  const usedLabels = new Map<string, string>();
  const addLabels = (want: Desired, names: readonly string[]) => {
    for (const name of names) usedLabels.set(name, name === label ? colours.base : colours[want.severity]);
  };

  for (const want of desired) {
    const existing = byMarker.get(want.marker);
    if (!existing) {
      const action: Action = { do: "create", marker: want.marker, title: want.title };
      actions.push(action);
      addLabels(want, want.labels);
      const call = [
        "issue",
        "create",
        ...at,
        "--title",
        want.title,
        "--body",
        want.body,
        ...want.labels.flatMap((name) => ["--label", name]),
      ];
      writes.push({ args: call, assign: want.assignee, action });
      continue;
    }
    const current = (existing.labels ?? []).map((item) => item.name);
    const stale = current.filter((name) => name.startsWith("tally:") && !want.labels.includes(name));
    const missing = want.labels.filter((name) => !current.includes(name));
    // The body names the owner, so an owner change always lands here and the new owner is added.
    const assigned =
      want.assignee === undefined ||
      (existing.assignees ?? []).some((item) => item.login.toLowerCase() === want.assignee?.toLowerCase());
    const unchanged =
      existing.title === want.title && existing.body.trim() === want.body.trim() && !stale.length && !missing.length;
    if (unchanged && assigned) continue;
    const action: Action = {
      do: "edit",
      marker: want.marker,
      number: existing.number,
      title: want.title,
      ...(unchanged ? { assignOnly: true as const } : {}),
    };
    actions.push(action);
    const assign = assigned ? {} : { assign: want.assignee, number: String(existing.number) };
    if (unchanged) {
      writes.push({ args: [], ...assign, action });
      continue;
    }
    addLabels(want, missing);
    writes.push({
      args: [
        "issue",
        "edit",
        String(existing.number),
        ...at,
        "--title",
        want.title,
        "--body",
        want.body,
        ...missing.flatMap((name) => ["--add-label", name]),
        ...stale.flatMap((name) => ["--remove-label", name]),
      ],
      ...assign,
      action,
    });
  }

  const wanted = new Set(desired.map((want) => want.marker));
  const closing = [
    ...[...byMarker]
      .filter(([marker]) => !wanted.has(marker))
      .map(([marker, issue]) => ({ marker, issue, why: "Resolved: `tally check` no longer reports this." })),
    ...duplicates.map(({ marker, issue }) => ({
      marker,
      issue,
      why: "Duplicate of an older tally issue for the same finding.",
    })),
  ];
  for (const { marker, issue, why } of closing) {
    const action: Action = { do: "close", marker, number: issue.number, title: issue.title };
    actions.push(action);
    writes.push({ args: ["issue", "close", String(issue.number), ...at, "--comment", why], action });
  }

  if (!dryRun) {
    // Labels are created only when this run attaches them, so a quiet day makes no writes beyond pending assignments.
    for (const [name, color] of usedLabels) await gh(["label", "create", name, ...at, "--color", color, "--force"]);
    for (const write of writes) {
      const output = write.args.length > 0 ? await gh(write.args) : "";
      // `issue create` prints the new issue's URL, which ends in its number.
      const number = write.number ?? /\/issues\/(\d+)\s*$/.exec(output)?.[1];
      if (write.assign && number) {
        try {
          await gh(["issue", "edit", number, ...at, "--add-assignee", write.assign]);
        } catch (error) {
          if (write.action.do !== "close")
            write.action.unassigned = `${write.assign}: ${error instanceof Error ? error.message : String(error)}`;
        }
      }
    }
  }
  return actions;
}

export const runGh: Gh = async (args) => {
  const proc = Bun.spawn(["gh", ...args], { stdout: "pipe", stderr: "pipe" });
  const [stdout, stderr, code] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
    proc.exited,
  ]);
  if (code !== 0) throw new Error(`gh ${args.slice(0, 2).join(" ")} failed: ${stderr.trim()}`);
  return stdout;
};
