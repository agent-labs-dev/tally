import { type InputRenderable, RGBA, type ScrollBoxRenderable, TextAttributes } from "@opentui/core";
import { useKeyboard, useTerminalDimensions } from "@opentui/react";
import { type ReactNode, useEffect, useRef, useState } from "react";
import type { Report } from "./cli";
import type { Finding } from "./reconcile";
import type { Entry } from "./schema";

// One fixed palette on its own background, so the dashboard looks the same in every terminal theme.
const color = {
  bg: RGBA.fromHex("#121113"),
  bg2: RGBA.fromHex("#222222"),
  fg: RGBA.fromHex("#b0b0b0"),
  fgBright: RGBA.fromHex("#d0d0d0"),
  fgDim: RGBA.fromHex("#777777"),
  comment: RGBA.fromHex("#555555"),
  orange: RGBA.fromHex("#e78a53"),
  teal: RGBA.fromHex("#5f8787"),
  peach: RGBA.fromHex("#fbcb97"),
  yellow: RGBA.fromHex("#e5c46b"),
  red: RGBA.fromHex("#c75a5a"),
  green: RGBA.fromHex("#6a9955"),
};

// The details pane (a titled top rule plus content) is the same height in both tabs, so switching tabs never moves
// a line. It shrinks on a short terminal, never below one row, and keeps the list at least MIN_LIST rows.
const DETAIL_ROWS = 8;
const MIN_LIST = 3;
// Two header rows, a status line and the hints line.
const CHROME_ROWS = 4;
// The service and expiry columns at the right of a key row.
const SERVICE_COLUMN = 16;
const EXPIRY_COLUMN = 11;

type Mode = "list" | "details" | "filter";

// Shown in this order; when the line is too narrow, the ones at the end of `keep` go first.
const hints = ["↑↓ move", "enter open", "←→ fold", "d details", "tab view", "/ filter", "s sort", "r reload", "q quit"];
const keep = ["q quit", "enter open", "/ filter", "↑↓ move", "tab view", "d details", "←→ fold", "s sort", "r reload"];

/** How urgent a key is, from its findings. The order is the default sort. */
type State = "expired" | "expiring" | "action" | "gap" | "ok";
const states: Record<State, { mark: string; label: string; fg: RGBA; rank: number }> = {
  expired: { mark: "●", label: "expired", fg: color.red, rank: 0 },
  expiring: { mark: "●", label: "expiring", fg: color.yellow, rank: 1 },
  action: { mark: "●", label: "action", fg: color.orange, rank: 2 },
  gap: { mark: "○", label: "gap", fg: color.fgDim, rank: 3 },
  ok: { mark: "●", label: "ok", fg: color.green, rank: 4 },
};
const stateOrder = Object.keys(states) as State[];

export interface KeyRow {
  entry: Entry;
  findings: Finding[];
  state: State;
  days?: number;
}

const sorts = ["urgency", "id", "service"] as const;
type Sort = (typeof sorts)[number];
type View = "keys" | "findings";

function daysUntil(date: string, today: string): number | undefined {
  const at = Date.parse(date);
  return Number.isNaN(at) ? undefined : Math.round((at - Date.parse(today)) / 86_400_000);
}

function stateOf(findings: readonly Finding[]): State {
  if (findings.some((finding) => finding.kind === "expired")) return "expired";
  if (findings.some((finding) => finding.kind === "expiring")) return "expiring";
  if (findings.some((finding) => finding.severity === "action")) return "action";
  return findings.length > 0 ? "gap" : "ok";
}

export function keyRows(report: Report): KeyRow[] {
  return report.entries.map((entry) => {
    const findings = report.findings.filter((finding) => finding.key === entry.id);
    return { entry, findings, state: stateOf(findings), days: daysUntil(entry.expires, report.today) };
  });
}

function sortRows(rows: KeyRow[], sort: Sort): KeyRow[] {
  const byId = (a: KeyRow, b: KeyRow) => a.entry.id.localeCompare(b.entry.id);
  if (sort === "id") return rows.toSorted(byId);
  if (sort === "service") return rows.toSorted((a, b) => a.entry.service.localeCompare(b.entry.service) || byId(a, b));
  return rows.toSorted(
    (a, b) =>
      states[a.state].rank - states[b.state].rank ||
      (a.days ?? Number.POSITIVE_INFINITY) - (b.days ?? Number.POSITIVE_INFINITY) ||
      byId(a, b),
  );
}

function matches(needle: string, ...fields: (string | undefined)[]): boolean {
  return !needle || fields.some((field) => field?.toLowerCase().includes(needle));
}

export type TreeRow =
  | { kind: "node"; key: string; name: string; depth: number; rows: KeyRow[]; open: boolean }
  | { kind: "key"; key: string; row: KeyRow; depth: number };

interface Node {
  key: string;
  level: number;
  name: string;
  rows: KeyRow[];
  children: Map<string, Node>;
  leaves: KeyRow[];
}

// The levels a key nests under, outermost first. A key without a group sits directly under its service.
const levels = [(entry: Entry) => entry.group, (entry: Entry) => entry.service];

/**
 * The key list as a tree: group, then service, then key. A node opens when its key is in `expanded` or a filter is
 * typed, so every node starts folded. A group always shows, since it names where its keys belong; a service holding
 * one key is that key's row, since a fold around one row hides nothing. Under the urgency sort a node sits by its most
 * urgent key; the other sorts order nodes by name.
 */
export function treeRows(sorted: readonly KeyRow[], sort: Sort, expanded: ReadonlySet<string>, open: boolean) {
  const node = (key: string, level: number, name: string): Node => ({
    key,
    level,
    name,
    rows: [],
    children: new Map(),
    leaves: [],
  });
  const root = node("", -1, "");
  for (const row of sorted) {
    let parent = root;
    levels.forEach((level, depth) => {
      const name = level(row.entry);
      if (name === undefined) return;
      const key = `${parent.key}/${depth}:${name}`;
      let child = parent.children.get(key);
      if (!child) {
        child = node(key, depth, name);
        parent.children.set(key, child);
      }
      child.rows.push(row);
      parent = child;
    });
    parent.leaves.push(row);
  }

  const out: TreeRow[] = [];
  const emit = (parent: Node, depth: number) => {
    type Item = { name: string; first: KeyRow } & ({ row: KeyRow } | { child: Node });
    const items: Item[] = [
      ...[...parent.children.values()].map((child): Item => {
        const [only] = child.rows;
        return child.level > 0 && child.rows.length === 1 && only
          ? { name: only.entry.id, first: only, row: only }
          : { name: child.name, first: child.rows[0] as KeyRow, child };
      }),
      ...parent.leaves.map((row) => ({ name: row.entry.id, first: row, row })),
    ];
    const byName = (a: Item, b: Item) => a.name.localeCompare(b.name);
    items.sort((a, b) =>
      sort === "urgency"
        ? states[a.first.state].rank - states[b.first.state].rank ||
          (a.first.days ?? Number.POSITIVE_INFINITY) - (b.first.days ?? Number.POSITIVE_INFINITY) ||
          byName(a, b)
        : byName(a, b),
    );
    for (const item of items) {
      if ("row" in item) {
        out.push({ kind: "key", key: `key:${item.row.entry.id}`, row: item.row, depth });
        continue;
      }
      const isOpen = open || expanded.has(item.child.key);
      out.push({ kind: "node", key: item.child.key, name: item.name, depth, rows: item.child.rows, open: isOpen });
      if (isOpen) emit(item.child, depth + 1);
    }
  };
  emit(root, 0);
  return out;
}

/** Counts per state, most urgent first, leaving out the keys that need nothing. */
function tally(rows: readonly KeyRow[]): { state: State; count: number }[] {
  return stateOrder
    .filter((state) => state !== "ok")
    .map((state) => ({ state, count: rows.filter((row) => row.state === state).length }))
    .filter(({ count }) => count > 0);
}

const width = (value: string) => Bun.stringWidth(value);

/** Cut to a column count, ending in an ellipsis when cut. */
function fit(value: string, columns: number): string {
  if (columns <= 0) return "";
  if (width(value) <= columns) return value;
  let out = "";
  for (const char of value) {
    if (width(`${out}${char}…`) > columns) break;
    out += char;
  }
  return `${out}…`;
}

const pad = (value: string, columns: number) => {
  const cut = fit(value, columns);
  return cut + " ".repeat(Math.max(0, columns - width(cut)));
};

/** The hints that fit, in display order, dropping from the end of `keep` first. */
function fitHints(columns: number): string {
  let shown = [...keep];
  const line = () => hints.filter((hint) => shown.includes(hint)).join(" · ");
  while (shown.length > 1 && width(line()) > columns) shown = shown.slice(0, -1);
  return fit(line(), columns);
}

/** One row, clipped. Details use `wrap` so a long runbook or location is read in the scrolling pane, not cut off. */
function Line({ children, fg, bg, wrap }: { children: ReactNode; fg?: RGBA; bg?: RGBA; wrap?: boolean }) {
  return wrap ? (
    <text flexShrink={0} wrapMode="word" fg={fg ?? color.fg}>
      {children}
    </text>
  ) : (
    <text height={1} flexShrink={0} wrapMode="none" truncate fg={fg ?? color.fg} bg={bg}>
      {children}
    </text>
  );
}

function Field({ label, value, fg }: { label: string; value?: string; fg?: RGBA }) {
  if (!value) return null;
  return (
    <Line wrap>
      <span fg={color.fgDim}>{label.padEnd(10)}</span>
      <span fg={fg}>{value}</span>
    </Line>
  );
}

function FindingLines({ findings }: { findings: readonly Finding[] }) {
  return (
    <>
      {findings.map((finding) => (
        <box key={finding.id} flexDirection="column" flexShrink={0}>
          <Line wrap>
            <span fg={finding.severity === "action" ? color.orange : color.fgDim}>
              {finding.severity === "action" ? "● " : "○ "}
            </span>
            <span>{finding.title}</span>
          </Line>
          {finding.detail ? <Line wrap fg={color.fgDim}>{`  ${finding.detail}`}</Line> : null}
        </box>
      ))}
    </>
  );
}

function expiryText(row: KeyRow): string {
  const { expires } = row.entry;
  if (row.days === undefined) return expires;
  return row.days < 0 ? `${-row.days}d ago` : `${row.days}d`;
}

function KeyDetail({ row }: { row: KeyRow }) {
  const { entry } = row;
  const expiry =
    entry.expires === "unknown" || entry.expires === "none" || row.days === undefined
      ? entry.expires
      : `${entry.expires} (${row.days < 0 ? `${-row.days} days ago` : `in ${row.days} days`})`;
  return (
    <>
      <Field label="service" value={entry.service} />
      <Field label="group" value={entry.group} />
      <Field label="owner" value={entry.owner} />
      <Field label="label" value={entry.label} />
      <Field label="ends in" value={entry.fingerprint} />
      <Field label="expires" value={expiry} fg={states[row.state].fg} />
      <Field label="" value={entry.expiresNote} />
      <Field label="limit" value={entry.limit} />
      <Field label="rotated" value={entry.rotated} />
      <Field label="runbook" value={entry.runbook} />
      <Field label="note" value={entry.note} />
      {entry.locations.map((location) => (
        <Line wrap key={`${location.kind}:${location.ref}`}>
          <span fg={color.fgDim}>{"stored in".padEnd(10)}</span>
          <span fg={color.teal}>{location.kind}</span>
          <span>{`  ${location.ref}`}</span>
        </Line>
      ))}
      <FindingLines findings={row.findings} />
    </>
  );
}

function NodeDetail({ node }: { node: Extract<TreeRow, { kind: "node" }> }) {
  const services = new Set(node.rows.map((row) => row.entry.service));
  return (
    <>
      <Field label="keys" value={String(node.rows.length)} />
      <Field label="services" value={[...services].sort().join(", ")} />
      {tally(node.rows).map(({ state, count }) => (
        <Field key={state} label={states[state].label} value={String(count)} fg={states[state].fg} />
      ))}
    </>
  );
}

/** What a node's keys need, most urgent first, so an expiring key shows without opening its group. Empty when none. */
function summary(rows: readonly KeyRow[]): { text: string; fg: RGBA }[] {
  return tally(rows).map(({ state, count }, index) => ({
    text: `${index ? " · " : `${states[state].mark} `}${count} ${states[state].label}${state === "gap" && count > 1 ? "s" : ""}`,
    fg: states[state].fg,
  }));
}

function TreeLine({ item, active, columns }: { item: TreeRow; active: boolean; columns: number }) {
  const indent = "  ".repeat(item.depth);
  const bg = active ? color.bg2 : undefined;
  if (item.kind === "node") {
    // The same columns as a key row: the name, then what the keys need under service, then the count under expiry.
    const parts = summary(item.rows);
    const needs = Math.max(SERVICE_COLUMN, width(parts.map((part) => part.text).join("")));
    const name = pad(item.name, Math.max(1, columns - width(indent) - 2 - needs - EXPIRY_COLUMN));
    return (
      <Line bg={bg}>
        <span fg={active ? color.peach : color.comment}>{`${indent}${item.open ? "⌄ " : "› "}`}</span>
        <span fg={item.depth === 0 ? color.orange : color.fgBright} attributes={TextAttributes.BOLD}>
          {name}
        </span>
        {parts.map((part) => (
          <span key={part.text} fg={part.fg}>
            {part.text}
          </span>
        ))}
        <span>{" ".repeat(Math.max(0, needs - width(parts.map((part) => part.text).join(""))))}</span>
        <span fg={color.comment}>
          {`${item.rows.length} ${item.rows.length === 1 ? "key" : "keys"}`.padStart(EXPIRY_COLUMN)}
        </span>
      </Line>
    );
  }
  const { row } = item;
  const state = states[row.state];
  const nameColumns = Math.max(1, columns - width(indent) - 4 - SERVICE_COLUMN - EXPIRY_COLUMN);
  return (
    <Line bg={bg}>
      <span fg={active ? color.peach : color.comment}>{`${indent}${active ? "› " : "  "}`}</span>
      <span fg={state.fg}>{`${state.mark} `}</span>
      <span fg={active ? color.fgBright : color.fg}>{pad(row.entry.label ?? row.entry.id, nameColumns)}</span>
      <span fg={color.fgDim}>{pad(row.entry.service, SERVICE_COLUMN)}</span>
      <span fg={row.state === "ok" ? color.comment : state.fg}>{expiryText(row).padStart(EXPIRY_COLUMN)}</span>
    </Line>
  );
}

function FindingLine({ finding, active, columns }: { finding: Finding; active: boolean; columns: number }) {
  const action = finding.severity === "action";
  const head = `${active ? "› " : "  "}${action ? "●" : "○"} ${pad(finding.kind, 14)}`;
  return (
    <Line bg={active ? color.bg2 : undefined}>
      <span fg={active ? color.peach : color.comment}>{head.slice(0, 2)}</span>
      <span fg={action ? color.orange : color.fgDim}>{head.slice(2)}</span>
      <span fg={active ? color.fgBright : color.fg}>{fit(finding.key, Math.max(1, columns - width(head)))}</span>
    </Line>
  );
}

export interface AppProps {
  initial: Report;
  load: () => Promise<Report>;
  onQuit: () => void;
  /** `initial` was read without the secret stores; read them once the screen is up. */
  stale?: boolean;
}

export function App({ initial, load, onQuit, stale }: AppProps) {
  const { width: screenWidth, height } = useTerminalDimensions();
  const [report, setReport] = useState(initial);
  const [view, setView] = useState<View>("keys");
  const [sort, setSort] = useState<Sort>("urgency");
  const [filter, setFilter] = useState("");
  const [mode, setMode] = useState<Mode>("list");
  const [expanded, setExpanded] = useState<ReadonlySet<string>>(new Set());
  const inputRef = useRef<InputRenderable>(null);
  const detailRef = useRef<ScrollBoxRenderable>(null);
  // The selected row by its key, so folding, sorting and a reload keep the same row selected.
  const [selected, setSelected] = useState<string>();
  const top = useRef(0);
  const [status, setStatus] = useState("");
  const [detailsOpen, setDetailsOpen] = useState(false);

  const needle = filter.toLowerCase();
  const keys = sortRows(keyRows(report), sort).filter(({ entry }) =>
    matches(
      needle,
      entry.id,
      entry.label,
      entry.service,
      entry.owner,
      entry.group,
      ...entry.locations.map((location) => location.ref),
    ),
  );
  const tree = treeRows(keys, sort, expanded, needle !== "");
  const findings = report.findings
    .filter((finding) => matches(needle, finding.kind, finding.key, finding.title))
    .toSorted((a, b) => Number(b.severity === "action") - Number(a.severity === "action"));
  const rowKeys = view === "keys" ? tree.map((item) => item.key) : findings.map((finding) => finding.id);
  const count = rowKeys.length;
  const at = Math.max(0, selected === undefined ? 0 : rowKeys.indexOf(selected));
  // Keys typed faster than a render read the cursor from here, so each one moves from where the last one left it.
  const cursor = useRef(at);
  cursor.current = at;
  const move = (index: number) => {
    cursor.current = Math.max(0, Math.min(count - 1, index));
    setSelected(rowKeys[cursor.current]);
  };

  // Only the newest read may land: the first store read can outlast a reload typed after it.
  const reads = useRef(0);
  const reload = () => {
    const read = ++reads.current;
    setStatus("reading…");
    load().then(
      (next) => {
        if (read !== reads.current) return;
        setReport(next);
        setStatus("");
      },
      (error: unknown) => {
        if (read === reads.current) setStatus(error instanceof Error ? error.message : String(error));
      },
    );
  };

  // biome-ignore lint/correctness/useExhaustiveDependencies: the stores are read once, when the screen first opens.
  useEffect(() => {
    if (stale) reload();
  }, []);

  // A selected row that is gone is forgotten, so the cursor stays at the top if the row comes back.
  useEffect(() => {
    if (selected !== undefined && !rowKeys.includes(selected)) setSelected(undefined);
  });

  const refilter = (value: string) => {
    setFilter(value);
    setSelected(undefined);
  };

  const toList = () => {
    setMode("list");
    inputRef.current?.blur();
    detailRef.current?.blur();
  };

  useEffect(() => {
    if (mode === "details" && detailsOpen) detailRef.current?.focus();
  }, [mode, detailsOpen]);

  const current = view === "keys" ? tree[at] : undefined;
  const fold = (key: string, open: boolean) =>
    setExpanded((was) => {
      const next = new Set(was);
      if (open) next.add(key);
      else next.delete(key);
      return next;
    });

  // The input owns editing and the scrollbox owns scrolling while focused; everything else is handled here. A key can
  // arrive in the same batch as the one before it, before React has rendered, so the widgets' own focus is the truth.
  useKeyboard((key) => {
    if (key.ctrl && key.name === "c") return onQuit();
    if (inputRef.current?.focused) {
      if (key.name === "escape") {
        key.preventDefault();
        refilter("");
        toList();
      }
      return;
    }
    if (key.ctrl || key.meta) return;
    const inDetails = detailRef.current?.focused;
    if (key.name === "escape") {
      key.preventDefault();
      if (inDetails) {
        setDetailsOpen(false);
        toList();
      } else refilter("");
    } else if (key.name === "q") onQuit();
    else if (key.name === "tab") {
      key.preventDefault();
      setView(view === "keys" ? "findings" : "keys");
      setSelected(undefined);
      toList();
    } else if (key.name === "d" && count > 0) {
      key.preventDefault();
      if (inDetails) {
        setDetailsOpen(false);
        toList();
      } else {
        setDetailsOpen(true);
        setMode("details");
        detailRef.current?.focus();
      }
    } else if (key.name === "s" && view === "keys")
      setSort(sorts[(sorts.indexOf(sort) + 1) % sorts.length] ?? "urgency");
    else if (key.name === "/") {
      key.preventDefault();
      setMode("filter");
      inputRef.current?.focus();
    } else if (key.name === "r") reload();
    else if (inDetails) return;
    else if (key.name === "down" || key.name === "j") move(cursor.current + 1);
    else if (key.name === "up" || key.name === "k") move(cursor.current - 1);
    else if (key.name === "end" || (key.name === "g" && key.shift)) move(count - 1);
    else if (key.name === "home" || key.name === "g") move(0);
    else {
      const here = view === "keys" ? tree[cursor.current] : undefined;
      if (key.name === "return" || key.name === "space") {
        if (here?.kind === "node") fold(here.key, !here.open);
        else if (count > 0) setDetailsOpen((open) => !open);
      } else if (key.name === "right" || key.name === "l") {
        if (here?.kind !== "node") return;
        if (here.open) move(cursor.current + 1);
        else fold(here.key, true);
      } else if (key.name === "left" || key.name === "h") {
        if (here?.kind === "node" && here.open) fold(here.key, false);
        else if (here && here.depth > 0) {
          const parent = tree.findLastIndex((item, index) => index < cursor.current && item.depth < here.depth);
          if (parent >= 0) move(parent);
        }
      }
    }
  });

  const action = report.findings.filter((finding) => finding.severity === "action").length;
  const gaps = report.findings.length - action;
  const groups = new Set(report.entries.map((entry) => entry.group).filter(Boolean)).size;
  const detailRows = Math.min(DETAIL_ROWS, Math.max(1, height - CHROME_ROWS - MIN_LIST));
  const listRows = Math.max(1, height - CHROME_ROWS - (detailsOpen ? detailRows : 0));
  const columns = Math.max(1, screenWidth - 2);

  // Scroll only as far as keeps the selected row on screen.
  top.current = Math.max(0, Math.min(top.current, at, Math.max(0, count - listRows)));
  if (at >= top.current + listRows) top.current = at - listRows + 1;
  const shown = { from: top.current, to: top.current + listRows };

  const selectedKey = current?.kind === "key" ? current.row : undefined;
  const selectedNode = current?.kind === "node" ? current : undefined;
  const selectedFinding = view === "findings" ? findings[at] : undefined;
  const findingEntry = selectedFinding
    ? keyRows(report).find((row) => row.entry.id === selectedFinding.key)
    : undefined;
  const title = selectedKey?.entry.label ?? selectedKey?.entry.id ?? selectedNode?.name ?? selectedFinding?.key ?? "";

  return (
    <box
      flexDirection="column"
      width={screenWidth}
      height={height}
      paddingLeft={1}
      paddingRight={1}
      overflow="hidden"
      backgroundColor={color.bg}
    >
      <Line>
        <span fg={color.fgBright} attributes={TextAttributes.BOLD}>
          tally
        </span>
        <span fg={action ? color.orange : color.green}>{`  ${action} action`}</span>
        <span fg={gaps ? color.yellow : color.comment}>{` · ${gaps} gaps`}</span>
        <span fg={color.comment}>{` · ${report.entries.length} keys${groups ? ` · ${groups} groups` : ""}`}</span>
      </Line>
      <Line>
        <span fg={view === "keys" ? color.peach : color.comment} attributes={view === "keys" ? TextAttributes.BOLD : 0}>
          keys
        </span>
        <span fg={color.comment}>{" · "}</span>
        <span
          fg={view === "findings" ? color.peach : color.comment}
          attributes={view === "findings" ? TextAttributes.BOLD : 0}
        >
          findings
        </span>
        <span fg={color.comment}>{` · sort: ${sort}`}</span>
      </Line>
      <box flexDirection="column" flexGrow={1} flexShrink={1} minHeight={0} overflow="hidden">
        {count === 0 ? (
          <Line fg={color.comment}>{filter ? "nothing matches" : "nothing here"}</Line>
        ) : view === "keys" ? (
          tree
            .slice(shown.from, shown.to)
            .map((item, index) => (
              <TreeLine key={item.key} item={item} active={shown.from + index === at} columns={columns} />
            ))
        ) : (
          findings
            .slice(shown.from, shown.to)
            .map((finding, index) => (
              <FindingLine key={finding.id} finding={finding} active={shown.from + index === at} columns={columns} />
            ))
        )}
      </box>
      <scrollbox
        ref={detailRef}
        key={`${view}:${current?.key ?? selectedFinding?.id}`}
        focused={mode === "details"}
        height={detailsOpen ? detailRows : 0}
        visible={detailsOpen}
        flexShrink={0}
        backgroundColor={color.bg}
        border={["top"]}
        borderColor={mode === "details" ? color.peach : color.comment}
        title={` ${title} `}
      >
        {selectedKey ? <KeyDetail row={selectedKey} /> : null}
        {selectedNode ? <NodeDetail node={selectedNode} /> : null}
        {selectedFinding ? (
          findingEntry ? (
            <KeyDetail row={findingEntry} />
          ) : (
            <FindingLines findings={[selectedFinding]} />
          )
        ) : null}
      </scrollbox>
      <box flexDirection="row" height={1} flexShrink={0}>
        <text wrapMode="none" fg={color.peach} flexShrink={0} visible={mode === "filter"}>
          {"filter: "}
        </text>
        <input
          ref={inputRef}
          focused={mode === "filter"}
          visible={mode === "filter"}
          flexGrow={mode === "filter" ? 1 : 0}
          placeholder="type to filter · enter keeps · esc clears"
          backgroundColor={color.bg}
          focusedBackgroundColor={color.bg}
          textColor={color.fgBright}
          focusedTextColor={color.fgBright}
          value={filter}
          onInput={refilter}
          onSubmit={toList}
        />
        {mode === "filter" ? null : (
          <Line fg={status ? color.yellow : color.peach}>
            {status || (mode === "details" ? "details · ↑↓ scroll · esc back" : filter ? `/${filter}` : " ")}
          </Line>
        )}
      </box>
      <Line fg={color.comment}>{fitHints(columns)}</Line>
    </box>
  );
}

/** Takes the screen until the user quits. Only metadata is shown: the same fields `check` prints. */
export async function showUi(initial: Report, load: () => Promise<Report>, stale: boolean): Promise<void> {
  const [{ createCliRenderer }, { createRoot }] = await Promise.all([
    import("@opentui/core"),
    import("@opentui/react"),
  ]);
  const renderer = await createCliRenderer({ exitOnCtrlC: false });
  await new Promise<void>((done) => {
    const quit = () => {
      renderer.destroy();
      done();
    };
    process.once("SIGINT", quit);
    process.once("SIGTERM", quit);
    createRoot(renderer).render(<App initial={initial} load={load} onQuit={quit} stale={stale} />);
  });
}
