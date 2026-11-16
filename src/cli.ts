import { existsSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { parseArgs } from "node:util";
import packageJson from "../package.json";
import { draft } from "./draft";
import { desiredIssues, type Gh, runGh, syncIssues } from "./issues";
import { type Context, type Finding, reconcile, resolveEntries, todayUtc } from "./reconcile";
import { referencedSecrets, skipping, templatedSecrets } from "./scan";
import { type Entry, type Location, schemaVersion, validDate, withheld } from "./schema";
import { type Fetch, observe, ownerTypes, type Run, runCommand } from "./stores";
import {
  type Config,
  findTallyFile,
  freshConfig,
  type LoadedTallyFile,
  loadTallyFile,
  userTallyFile,
  writeTallyFile,
} from "./tallyfile";

/** Each code past 2 tells the caller one thing to do next, so an agent can branch without reading prose. */
export const exit = { ok: 0, error: 1, usage: 2, findings: 3 } as const;

const help = `tally tracks a repository's API keys: owner, where each one is stored, its limit and its expiry. It never reads, stores or prints a key.
Commands print JSON when stdout is not a terminal or with --json. Help and version print text unless --json is given.

  tally init [--owner HANDLE] [--offline]
                                 write .tally.yaml, or add to it: a draft entry per secret the workflows, env templates
                                 and stores hold that no key names, and each stored copy of a key as a location
  tally check [--today YYYY-MM-DD] [--offline]
                                 report expiring, stale, undeclared and missing keys and missing facts, action findings exit 3
  tally [--today YYYY-MM-DD] [--offline]
  tally ui [--today YYYY-MM-DD] [--offline]
                                 browse keys and findings in the terminal; r reloads, q quits
                                 without a terminal, bare tally prints schema JSON
  tally notify [--today YYYY-MM-DD] [--offline]
                                 run check, then send a desktop notification per action finding
  tally list [--group G] [--service S]
                                 list declared keys, filtered
  tally validate                report tally file errors
  tally add ID --service S --owner O --location KIND:REF [--location ...] [--group G]
         [--expires DATE|unknown|none] [--expires-note T] [--limit L] [--label T]
         [--fingerprint F] [--runbook PATH] [--note T]
                                 add a key's metadata
  tally locate ID --location KIND:REF [--location ...]
                                 add stored copies to an existing key
  tally rotated ID --expires DATE [--fingerprint F] [--today DATE]
                                 record a rotation
  tally issues sync [--repo OWNER/NAME] [--dry-run] [--today DATE]
                                 create, edit and close tracking issues
  tally schema                  machine-readable description of this CLI
  tally --version               print the version

Global flags: --config PATH, --json.
Defaults: --config from TALLY_CONFIG, then the nearest .tally.yaml up to the repository root, then
$XDG_CONFIG_HOME/tally/tally.yaml (~/.config/tally/tally.yaml) for keys that live on one machine.
Expiry and limit default to unknown, which check reports as a gap.
sources: in the tally file names secret stores (gcp, aws, azure, github), read through their own CLI and login, a local
Unix pass store (pass, read from the filesystem: names and file dates only), and provider key listings
(anthropic, openai, openrouter, cloudflare), read with an admin token from the environment. Only names,
dates and limits are read, never a value. --offline skips them all.
Exit codes: 0 ok, 1 error, 2 usage, 3 action findings, so rotate the keys they name.`;

interface Flags {
  positional: string[];
  json: boolean;
  help: boolean;
  version: boolean;
  config?: string;
  today?: string;
  group?: string;
  service?: string;
  owner?: string;
  locations: string[];
  expires?: string;
  expiresNote?: string;
  limit?: string;
  label?: string;
  fingerprint?: string;
  runbook?: string;
  note?: string;
  repo?: string;
  dryRun: boolean;
  offline: boolean;
}

class UsageError extends Error {}

export interface IO {
  gh?: Gh;
  stdout?: (text: string) => void;
  isTTY?: boolean;
  env?: Record<string, string | undefined>;
  /** Where the repository, and so the tally file, is found. */
  cwd?: string;
  /** Sends a desktop notification. Injected so tests never touch the desktop. */
  notify?: (message: string) => Promise<void>;
  /** Runs a secret store's CLI. Injected so tests never reach a real store. */
  run?: Run;
  fetch?: Fetch;
}

interface Result {
  value: unknown;
  text?: string;
  code?: number;
  /** The command drew its own screen, so nothing is printed after it. */
  silent?: boolean;
}

/** What `check` sees, for the interactive view: the file, its keys and every finding about them. */
export interface Report {
  path: string;
  repo?: string;
  today: string;
  warnDays: number;
  entries: Entry[];
  findings: Finding[];
}

function usageDate(flag: string, value: string): string {
  if (!validDate(value)) throw new UsageError(`${flag} must be YYYY-MM-DD`);
  return value;
}

function parse(args: readonly string[]): Flags {
  let parsed: ReturnType<typeof options>;
  try {
    parsed = options(args);
  } catch (error) {
    throw new UsageError(withheld(error instanceof Error ? error.message : String(error)));
  }
  const { values, positionals } = parsed;
  return {
    positional: positionals,
    json: values.json ?? false,
    help: values.help ?? false,
    version: values.version ?? false,
    dryRun: values["dry-run"] ?? false,
    offline: values.offline ?? false,
    config: values.config,
    today: values.today === undefined ? undefined : usageDate("--today", values.today),
    group: values.group,
    service: values.service,
    owner: values.owner,
    locations: values.location ?? [],
    expires: values.expires,
    expiresNote: values["expires-note"],
    limit: values.limit,
    label: values.label,
    fingerprint: values.fingerprint,
    runbook: values.runbook,
    note: values.note,
    repo: values.repo,
  };
}

const cliOptions = {
  json: { type: "boolean" },
  help: { type: "boolean", short: "h" },
  version: { type: "boolean" },
  "dry-run": { type: "boolean" },
  offline: { type: "boolean" },
  config: { type: "string" },
  today: { type: "string" },
  group: { type: "string" },
  service: { type: "string" },
  owner: { type: "string" },
  location: { type: "string", multiple: true },
  expires: { type: "string" },
  "expires-note": { type: "string" },
  limit: { type: "string" },
  label: { type: "string" },
  fingerprint: { type: "string" },
  runbook: { type: "string" },
  note: { type: "string" },
  repo: { type: "string" },
} as const;

function options(args: readonly string[]) {
  return parseArgs({
    args: [...args],
    allowPositionals: true,
    strict: true,
    options: cliOptions,
  });
}

/** The nearest directory with `.git`, which is where a repository's `.tally.yaml` belongs. */
function repositoryRoot(cwd: string): string {
  let dir = resolve(cwd);
  for (;;) {
    if (existsSync(join(dir, ".git"))) return dir;
    const parent = dirname(dir);
    if (parent === dir) return resolve(cwd);
    dir = parent;
  }
}

function configPath(flags: Flags, env: Record<string, string | undefined>, cwd: string): string {
  return flags.config === undefined ? findTallyFile(cwd, env) : resolve(cwd, flags.config);
}

/** The config loads with the entries: its secret patterns have to be registered before any entry is checked. */
async function loadAll(flags: Flags, env: Record<string, string | undefined>, cwd: string) {
  const path = configPath(flags, env, cwd);
  const fallback = flags.config === undefined && env.TALLY_CONFIG === undefined && path === userTallyFile(env);
  const loaded = await loadTallyFile(path, { fallback });
  return { path, ...loaded };
}

/** `owner/name` from a GitHub remote URL, in either the HTTPS or the SSH form. */
const remotePattern = /github\.com[:/]([\w.-]+\/[\w.-]+?)(?:\.git)?\/?$/;

/** The repository being checked: the runner names it, and a local checkout names it through its origin remote. */
function scannedRepo(root: string, env: Record<string, string | undefined>): string | undefined {
  if (env.GITHUB_REPOSITORY) return env.GITHUB_REPOSITORY;
  const proc = Bun.spawnSync(["git", "-C", root, "remote", "get-url", "origin"], { stdout: "pipe", stderr: "ignore" });
  return proc.exitCode === 0 ? remotePattern.exec(proc.stdout.toString().trim())?.[1] : undefined;
}

/**
 * The checkout holding the tally file is the one whose workflows are scanned, wherever the file sits inside it.
 * The configured stores are read here too, unless `--offline` asks to skip them.
 */
async function buildContext(
  flags: Flags,
  loaded: { path: string; config: Config; entries: Entry[] },
  env: Record<string, string | undefined>,
  io: IO,
): Promise<{ context: Context; entries: Entry[] }> {
  const root = repositoryRoot(dirname(loaded.path));
  const sources = flags.offline ? [] : loaded.config.sources;
  const skip = skipping(loaded.config.ignorePaths);
  const repo = scannedRepo(root, env);
  const observed =
    sources.length > 0 ? await observe(sources, io.run ?? runCommand, io.fetch ?? fetch, env) : undefined;
  // The stores complete unknown facts before anything reads an owner, so lookups, findings and issues agree.
  const entries = resolveEntries(loaded.entries, observed, repo);
  const context: Context = {
    today: flags.today ?? todayUtc(),
    warnDays: loaded.config.warnDays,
    staleDays: loaded.config.staleDays,
    idleDays: loaded.config.idleDays,
    referenced: referencedSecrets(root, skip),
    templated: templatedSecrets(root, loaded.config.credentialNames, skip),
    ignore: loaded.config.ignore,
    repo,
    sources,
    observed,
    owners: flags.offline
      ? undefined
      : await ownerTypes(
          entries.map((entry) => entry.owner),
          io.run ?? runCommand,
        ),
    orgAssignee: env.TALLY_ORG_ASSIGNEE || undefined,
  };
  return { context, entries };
}

async function report(
  flags: Flags,
  loaded: Awaited<ReturnType<typeof loadAll>>,
  env: Record<string, string | undefined>,
  io: IO,
): Promise<Report> {
  const { context, entries } = await buildContext(flags, loaded, env, io);
  return {
    path: loaded.path,
    repo: context.repo,
    today: context.today,
    warnDays: context.warnDays,
    entries,
    findings: reconcile(entries, context),
  };
}

function failed(errors: readonly { path: string; message: string }[]): Result {
  // A path can come from the environment, so it goes through the same guard as any other echoed input.
  const shown = errors.map((error) => ({ path: withheld(error.path), message: error.message }));
  return {
    value: { errors: shown },
    text: shown.map((error) => `${error.path}: ${error.message}`).join("\n"),
    code: exit.error,
  };
}

function expectNoArgs(rest: readonly string[], command: string): void {
  const [extra] = rest;
  if (extra !== undefined) throw new UsageError(`unexpected argument ${withheld(extra)} after ${command}`);
}

function location(value: string): Location {
  const colon = value.indexOf(":");
  if (colon <= 0 || colon === value.length - 1) throw new UsageError(`--location ${withheld(value)} must be KIND:REF`);
  return { kind: value.slice(0, colon), ref: value.slice(colon + 1) };
}

function table(header: string[], rows: string[][]): string {
  const widths = header.map((cell, column) => Math.max(cell.length, ...rows.map((row) => row[column]?.length ?? 0)));
  return [header, ...rows]
    .map((row) =>
      row
        .map((cell, column) => cell.padEnd(widths[column] ?? cell.length))
        .join("  ")
        .trimEnd(),
    )
    .join("\n");
}

/** reconcile already puts action findings first. */
function findingsText(findings: readonly Finding[]): string {
  if (findings.length === 0) return "no findings";
  return table(
    ["SEVERITY", "KIND", "FINDING"],
    findings.map((finding) => [
      finding.severity,
      finding.kind,
      `${finding.title}${finding.days === undefined ? "" : ` (${finding.days} days)`}`,
    ]),
  );
}

function entriesText(entries: readonly Entry[]): string {
  if (entries.length === 0) return "no entries";
  return table(
    ["ID", "SERVICE", "GROUP", "OWNER", "EXPIRES", "LIMIT"],
    entries.map((entry) => [
      entry.id,
      entry.service,
      entry.group ?? "-",
      entry.owner,
      entry.expires || "-",
      entry.limit || "-",
    ]),
  );
}

/** A desktop notification, only when the desktop has a notifier on PATH. */
function notifierOnPath(): ((message: string) => Promise<void>) | undefined {
  if (!Bun.which("notify-send")) return undefined;
  return async (message) => {
    const proc = Bun.spawn(["notify-send", "tally", message], { stdout: "ignore", stderr: "ignore" });
    await proc.exited;
  };
}

function schema() {
  return {
    schemaVersion,
    version: packageJson.version,
    exitCodes: exit,
    commands: help,
    options: cliOptions,
    defaults: { terminal: "ui", nonTerminal: "schema" },
    entryFields:
      "id, service, group, owner, label, fingerprint, locations, expires, expiresNote, limit, rotated, runbook, note",
    findingFields: "id, kind, severity (action or gap), key, title, days, detail",
    configFields:
      "warnDays, staleDays, idleDays, issueRepo, secretPatterns, ignore, credentialNames, ignorePaths, sources, keys",
  };
}

async function dispatch(
  flags: Flags,
  command: string,
  rest: string[],
  io: IO,
  env: Record<string, string | undefined>,
  cwd: string,
): Promise<Result> {
  switch (command) {
    case "init": {
      expectNoArgs(rest, command);
      const path = configPath(flags, env, cwd);
      const loaded = existsSync(path)
        ? { path, ...(await loadTallyFile(path)) }
        : { path, config: freshConfig(), entries: [], errors: [] };
      if (loaded.errors.length > 0) return failed(loaded.errors);
      const { context } = await buildContext(flags, loaded, env, io);
      const plan = draft(loaded.entries, context, flags.owner ?? "unknown");
      await writeTallyFile(path, loaded.config, plan.entries);
      const lines = [
        ...plan.drafted.map(({ id, secret }) => `  drafted ${id}  ${secret}`),
        ...plan.linked.map(({ id, location }) => `  linked  ${id}  ${location.kind}: ${location.ref}`),
        ...plan.unsure.map((name) => `  unsure  ${name} matches more than one key, so add its location by hand`),
      ];
      const text =
        lines.length === 0
          ? `${withheld(path)} already names every key the code and stores hold`
          : [`wrote ${withheld(path)}`, ...lines].join("\n");
      return { value: { path, drafted: plan.drafted, linked: plan.linked, unsure: plan.unsure }, text };
    }
    case "check":
    case "notify": {
      expectNoArgs(rest, command);
      const loaded = await loadAll(flags, env, cwd);
      if (loaded.errors.length > 0) return failed(loaded.errors);
      const { context, entries } = await buildContext(flags, loaded, env, io);
      const findings = reconcile(entries, context);
      const summary = {
        action: findings.filter((finding) => finding.severity === "action").length,
        gap: findings.filter((finding) => finding.severity === "gap").length,
      };
      const code = summary.action > 0 ? exit.findings : exit.ok;
      let notified = 0;
      if (command === "notify") {
        const notifier = io.notify ?? notifierOnPath();
        if (notifier)
          for (const finding of findings) {
            if (finding.severity !== "action") continue;
            await notifier(finding.title);
            notified++;
          }
      }
      const value =
        command === "notify"
          ? { schemaVersion, today: context.today, findings, summary, notified }
          : { schemaVersion, today: context.today, findings, summary };
      if (command === "notify") return { value, text: findingsText(findings), code };
      const text =
        summary.action > 0
          ? `${findingsText(findings)}\nnext: tally rotated ID --expires YYYY-MM-DD`
          : findingsText(findings);
      return { value, text, code };
    }
    case "list": {
      expectNoArgs(rest, command);
      const loaded = await loadAll(flags, env, cwd);
      if (loaded.errors.length > 0) return failed(loaded.errors);
      const entries = loaded.entries.filter(
        (entry) =>
          (flags.group === undefined || entry.group === flags.group) &&
          (flags.service === undefined || entry.service === flags.service),
      );
      return { value: { entries }, text: entriesText(entries) };
    }
    case "validate": {
      expectNoArgs(rest, command);
      const loaded = await loadAll(flags, env, cwd);
      if (loaded.errors.length > 0) return failed(loaded.errors);
      const value = { ok: true, entries: loaded.entries.length };
      return { value, text: `${loaded.entries.length} entries valid` };
    }
    case "add": {
      const [id, ...extra] = rest;
      if (id === undefined) throw new UsageError("usage: tally add ID --service S --owner O --location KIND:REF");
      if (extra.length > 0) throw new UsageError(`unexpected argument ${withheld(extra[0] ?? "")} after add`);
      if (!flags.service || !flags.owner || flags.locations.length === 0)
        throw new UsageError("add needs --service, --owner and at least one --location");
      const path = configPath(flags, env, cwd);
      const loaded: LoadedTallyFile = existsSync(path)
        ? await loadTallyFile(path)
        : { config: freshConfig(), entries: [], errors: [] };
      if (loaded.errors.length > 0) return failed(loaded.errors);
      if (loaded.entries.some((entry) => entry.id === id)) throw new Error(`${withheld(id)} already exists`);
      const expires = flags.expires ?? "unknown";
      if (expires !== "unknown" && expires !== "none") usageDate("--expires", expires);
      const entry: Entry = {
        id,
        service: flags.service,
        group: flags.group,
        owner: flags.owner,
        label: flags.label,
        fingerprint: flags.fingerprint,
        locations: flags.locations.map(location),
        expires,
        expiresNote: flags.expiresNote,
        limit: flags.limit ?? "unknown",
        runbook: flags.runbook,
        note: flags.note,
      };
      await writeTallyFile(path, loaded.config, [...loaded.entries, entry]);
      return { value: { id, path, entry }, text: `added ${id} to ${path}` };
    }
    case "rotated": {
      const [id, ...extra] = rest;
      if (id === undefined) throw new UsageError("usage: tally rotated ID --expires DATE");
      if (extra.length > 0) throw new UsageError(`unexpected argument ${withheld(extra[0] ?? "")} after rotated`);
      if (flags.expires === undefined) throw new UsageError("rotated needs --expires YYYY-MM-DD");
      const expires = usageDate("--expires", flags.expires);
      const loaded = await loadAll(flags, env, cwd);
      // A rewrite of a file with errors could drop a field the parser rejected.
      if (loaded.errors.length > 0) return failed(loaded.errors);
      const entry = loaded.entries.find((candidate) => candidate.id === id);
      if (!entry) throw new Error(`no entry ${withheld(id)} in ${withheld(loaded.path)}`);
      entry.expires = expires;
      entry.rotated = flags.today ?? todayUtc();
      delete entry.expiresNote;
      if (flags.fingerprint !== undefined) entry.fingerprint = flags.fingerprint;
      await writeTallyFile(loaded.path, loaded.config, loaded.entries);
      return {
        value: { id, expires: entry.expires, rotated: entry.rotated },
        text: `rotated ${id}: expires ${entry.expires}, rotated ${entry.rotated}`,
      };
    }
    case "locate": {
      const [id, ...extra] = rest;
      if (id === undefined) throw new UsageError("usage: tally locate ID --location KIND:REF [--location ...]");
      if (extra.length > 0) throw new UsageError(`unexpected argument ${withheld(extra[0] ?? "")} after locate`);
      if (flags.locations.length === 0) throw new UsageError("locate needs at least one --location");
      const loaded = await loadAll(flags, env, cwd);
      if (loaded.errors.length > 0) return failed(loaded.errors);
      const entry = loaded.entries.find((candidate) => candidate.id === id);
      if (!entry) throw new Error(`no entry ${withheld(id)} in ${withheld(loaded.path)}`);
      const additions = flags.locations.map(location);
      const existing = new Set(entry.locations.map((item) => `${item.kind}:${item.ref}`));
      for (const item of additions) {
        const key = `${item.kind}:${item.ref}`;
        if (!existing.has(key)) {
          entry.locations.push(item);
          existing.add(key);
        }
      }
      await writeTallyFile(loaded.path, loaded.config, loaded.entries);
      return { value: { id, locations: entry.locations }, text: `located ${id} in ${withheld(loaded.path)}` };
    }
    case "issues": {
      const [verb, ...extra] = rest;
      if (verb !== "sync") throw new UsageError("usage: tally issues sync [--repo OWNER/NAME] [--dry-run]");
      if (extra.length > 0) throw new UsageError(`unexpected argument ${withheld(extra[0] ?? "")} after issues sync`);
      const loaded = await loadAll(flags, env, cwd);
      if (loaded.errors.length > 0) return failed(loaded.errors);
      // With no repo at all, gh infers it from the working directory.
      const repo = flags.repo ?? loaded.config.issueRepo ?? env.GITHUB_REPOSITORY;
      const { context, entries } = await buildContext(flags, loaded, env, io);
      const findings = reconcile(entries, context);
      const actions = await syncIssues(io.gh ?? runGh, repo, desiredIssues(findings, entries, context), flags.dryRun);
      const text = actions
        .map((action) => {
          const unassigned = action.do !== "close" && action.unassigned ? ` (not assigned: ${action.unassigned})` : "";
          const assignOnly = action.do === "edit" && action.assignOnly ? " (assign only)" : "";
          return `${action.do} ${action.marker}${"number" in action ? ` #${action.number}` : ""}${assignOnly}${unassigned}`;
        })
        .join("\n");
      return { value: { repo: repo ?? null, dryRun: flags.dryRun, actions }, text: text || "no changes" };
    }
    case "ui": {
      expectNoArgs(rest, command);
      if (!(io.isTTY ?? process.stdout.isTTY) || flags.json)
        throw new UsageError("tally ui needs a terminal; use tally check --json");
      // The first read happens before the screen is taken, so a broken file is reported like any other command's.
      const loaded = await loadAll(flags, env, cwd);
      if (loaded.errors.length > 0) return failed(loaded.errors);
      // The screen opens on the file alone, which reads in milliseconds; the stores fill in once it is up.
      const first = await report({ ...flags, offline: true }, loaded, env, io);
      const reload = async () => {
        const again = await loadAll(flags, env, cwd);
        if (again.errors.length > 0) throw new Error(again.errors.map((error) => error.message).join("; "));
        return report(flags, again, env, io);
      };
      // Loaded only here, so every other command, and the CI action, runs without the UI's dependencies installed.
      const { showUi } = await import("./ui");
      await showUi(first, reload, !flags.offline);
      return { value: null, silent: true };
    }
    case "schema":
      expectNoArgs(rest, command);
      return { value: schema(), text: JSON.stringify(schema(), null, 2) };
    default:
      throw new UsageError(`unknown command ${withheld(command)}`);
  }
}

export async function main(args: string[], io: IO = {}): Promise<number> {
  const env = io.env ?? process.env;
  const cwd = io.cwd ?? process.cwd();
  const write = io.stdout ?? ((text: string) => process.stdout.write(`${text}\n`));
  const isTTY = io.isTTY ?? process.stdout.isTTY;
  let json = !isTTY || args.includes("--json");
  try {
    const flags = parse(args);
    if (flags.help || flags.version) json = flags.json;
    if (flags.help) {
      write(json ? JSON.stringify({ help }) : help);
      return exit.ok;
    }
    if (flags.version) {
      write(json ? JSON.stringify({ version: packageJson.version }) : `tally ${packageJson.version}`);
      return exit.ok;
    }
    const [command = isTTY && !flags.json ? "ui" : "schema", ...rest] = flags.positional;
    if (flags.dryRun && command !== "issues") throw new UsageError("--dry-run only applies to issues sync");
    // A sync that skipped the stores would close their issues as if the findings had cleared.
    if (flags.offline && !["check", "notify", "init", "ui"].includes(command))
      throw new UsageError("--offline only applies to check, notify, init and ui");
    const result = await dispatch(flags, command, rest, io, env, cwd);
    if (!result.silent) write(json ? JSON.stringify(result.value) : (result.text ?? JSON.stringify(result.value)));
    return result.code ?? exit.ok;
  } catch (error) {
    const usage = error instanceof UsageError;
    const message = error instanceof Error ? error.message : String(error);
    write(json ? JSON.stringify({ error: { code: usage ? "usage" : "error", message } }) : `tally: ${message}`);
    return usage ? exit.usage : exit.error;
  }
}
