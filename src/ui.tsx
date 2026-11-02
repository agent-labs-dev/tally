import type { KeyEvent } from "@opentui/core";
import { useKeyboard, useTerminalDimensions } from "@opentui/react";
import { useRef, useState } from "react";
import type { Report } from "./cli";
import type { Finding } from "./reconcile";
import { type Entry, withheld } from "./schema";

const color = {
  bg: "#121113",
  bg2: "#222222",
  fg: "#b0b0b0",
  fgBright: "#d0d0d0",
  fgDim: "#777777",
  comment: "#555555",
  orange: "#e78a53",
  peach: "#fbcb97",
  yellow: "#e5c46b",
  red: "#c75a5a",
  green: "#6a9955",
};

/** How urgent a key is, from its findings. The order is the default sort. */
type State = "expired" | "expiring" | "action" | "gap" | "ok";
const states: Record<State, { mark: string; fg: string; rank: number }> = {
  expired: { mark: "✗", fg: color.red, rank: 0 },
  expiring: { mark: "!", fg: color.yellow, rank: 1 },
  action: { mark: "!", fg: color.orange, rank: 2 },
  gap: { mark: "?", fg: color.fgDim, rank: 3 },
  ok: { mark: "✓", fg: color.green, rank: 4 },
};

interface KeyRow {
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

/** Text cut to `width` columns, with an ellipsis when it did not fit. */
function fit(text: string, width: number): string {
  if (width <= 0) return "";
  return text.length <= width ? text.padEnd(width) : `${text.slice(0, width - 1)}…`;
}

function printable(key: KeyEvent): string | undefined {
  if (key.ctrl || key.meta) return undefined;
  return key.sequence.length === 1 && key.sequence >= " " ? key.sequence : undefined;
}

function Field({ label, value, fg }: { label: string; value?: string; fg?: string }) {
  if (!value) return null;
  return (
    <text wrapMode="word">
      <span fg={color.comment}>{label.padEnd(10)}</span>
      <span fg={fg ?? color.fg}>{value}</span>
    </text>
  );
}

function FindingLines({ findings }: { findings: readonly Finding[] }) {
  return (
    <>
      {findings.map((finding) => (
        <box key={finding.id} flexDirection="column">
          <text wrapMode="word">
            <span fg={finding.severity === "action" ? color.orange : color.fgDim}>
              {finding.severity === "action" ? "! " : "? "}
            </span>
            <span fg={color.fgBright}>{finding.title}</span>
          </text>
          {finding.detail ? (
            <text wrapMode="word" fg={color.fgDim}>
              {`  ${finding.detail}`}
            </text>
          ) : null}
        </box>
      ))}
    </>
  );
}

function KeyDetail({ row }: { row: KeyRow }) {
  const { entry } = row;
  const expiry =
    entry.expires === "unknown" || entry.expires === "none" || row.days === undefined
      ? entry.expires
      : `${entry.expires} (${row.days < 0 ? `${-row.days} days ago` : `in ${row.days} days`})`;
  return (
    <box flexDirection="column">
      <text fg={states[row.state].fg} attributes={1}>
        {entry.id}
      </text>
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
      <text fg={color.comment}>stored in</text>
      {entry.locations.map((location) => (
        <text key={`${location.kind}:${location.ref}`} wrapMode="none">
          <span fg={color.peach}>{`  ${location.kind}`}</span>
          <span fg={color.fg}>{`  ${location.ref}`}</span>
        </text>
      ))}
      {row.findings.length > 0 ? <text> </text> : null}
      <FindingLines findings={row.findings} />
    </box>
  );
}

export interface AppProps {
  initial: Report;
  load: () => Promise<Report>;
  onQuit: () => void;
}

export function App({ initial, load, onQuit }: AppProps) {
  const { width, height } = useTerminalDimensions();
  const [report, setReport] = useState(initial);
  const [view, setView] = useState<View>("keys");
  const [sort, setSort] = useState<Sort>("urgency");
  const [filter, setFilter] = useState("");
  const [typing, setTypingState] = useState(false);
  // Keys that arrive together, as in a paste, are handled before the next render, so the mode they read is a ref.
  const typingNow = useRef(false);
  const setTyping = (value: boolean) => {
    typingNow.current = value;
    setTypingState(value);
  };
  const [cursor, setCursor] = useState(0);
  const [status, setStatus] = useState("");

  const needle = filter.toLowerCase();
  const keys = sortRows(keyRows(report), sort).filter(({ entry }) =>
    matches(
      needle,
      entry.id,
      entry.service,
      entry.owner,
      entry.group,
      ...entry.locations.map((location) => location.ref),
    ),
  );
  const findings = report.findings.filter((finding) => matches(needle, finding.kind, finding.key, finding.title));
  const count = view === "keys" ? keys.length : findings.length;
  const last = Math.max(0, count - 1);
  const at = Math.min(cursor, last);

  const reload = () => {
    setStatus("reading…");
    load().then(
      (next) => {
        setReport(next);
        setStatus("");
      },
      (error: unknown) => setStatus(error instanceof Error ? error.message : String(error)),
    );
  };

  useKeyboard((key) => {
    if (typingNow.current) {
      if (key.name === "return" || key.name === "escape") setTyping(false);
      if (key.name === "escape") setFilter("");
      else if (key.name === "backspace") setFilter((value) => value.slice(0, -1));
      else {
        const char = printable(key);
        if (char) setFilter((value) => value + char);
      }
      setCursor(0);
      return;
    }
    if (key.name === "q" || (key.ctrl && key.name === "c")) onQuit();
    else if (key.name === "down" || key.name === "j") setCursor((value) => Math.min(Math.min(value, last) + 1, last));
    else if (key.name === "up" || key.name === "k") setCursor((value) => Math.max(Math.min(value, last) - 1, 0));
    else if (key.name === "pagedown") setCursor((value) => Math.min(Math.min(value, last) + 10, last));
    else if (key.name === "pageup") setCursor((value) => Math.max(Math.min(value, last) - 10, 0));
    else if (key.name === "g") setCursor(0);
    else if (key.name === "tab") {
      setView(view === "keys" ? "findings" : "keys");
      setCursor(0);
    } else if (key.name === "s" && view === "keys")
      setSort(sorts[(sorts.indexOf(sort) + 1) % sorts.length] ?? "urgency");
    else if (key.name === "/") setTyping(true);
    else if (key.name === "escape") setFilter("");
    else if (key.name === "r") reload();
  });

  const action = report.findings.filter((finding) => finding.severity === "action").length;
  const gaps = report.findings.length - action;
  const listWidth = Math.max(30, Math.min(64, Math.floor(width * 0.45)));
  // Header, footer and the two border rows: the list keeps one fixed height whichever tab is shown.
  const rows = Math.max(1, height - 4);
  const first = Math.max(0, Math.min(at - Math.floor(rows / 2), count - rows));
  const inner = listWidth - 2;

  const selectedKey = view === "keys" ? keys[at] : undefined;
  const selectedFinding = view === "findings" ? findings[at] : undefined;
  const findingEntry = selectedFinding
    ? keyRows(report).find((row) => row.entry.id === selectedFinding.key)
    : undefined;

  return (
    <box flexDirection="column" backgroundColor={color.bg} flexGrow={1}>
      <text wrapMode="none">
        <span fg={color.fgBright} attributes={1}>
          tally
        </span>
        <span
          fg={color.comment}
        >{` ${withheld(report.repo ?? report.path)} · ${report.today} · ${report.entries.length} keys · `}</span>
        <span fg={action ? color.orange : color.green}>{`${action} action`}</span>
        <span fg={color.comment}>{` · ${gaps} gaps`}</span>
        {filter || typing ? <span fg={color.peach}>{`  /${filter}${typing ? "▏" : ""}`}</span> : null}
        {status ? <span fg={color.yellow}>{`  ${status}`}</span> : null}
      </text>
      <box flexDirection="row" flexGrow={1}>
        <box
          width={listWidth}
          border
          borderStyle="rounded"
          borderColor={color.comment}
          title={view === "keys" ? ` keys · ${sort} ` : " findings "}
          titleColor={color.fgDim}
          flexDirection="column"
        >
          {count === 0 ? (
            <text fg={color.comment}>{filter ? "nothing matches" : "nothing here"}</text>
          ) : view === "keys" ? (
            keys.slice(first, first + rows).map((row, index) => {
              const active = first + index === at;
              const when = row.days === undefined ? row.entry.expires : `${row.days}d`;
              return (
                <box key={row.entry.id} backgroundColor={active ? color.bg2 : undefined}>
                  <text wrapMode="none">
                    <span fg={states[row.state].fg}>{`${states[row.state].mark} `}</span>
                    <span fg={active ? color.fgBright : color.fg}>{fit(row.entry.id, inner - 11)}</span>
                    <span fg={row.days !== undefined ? states[row.state].fg : color.comment}>{when.padStart(9)}</span>
                  </text>
                </box>
              );
            })
          ) : (
            findings.slice(first, first + rows).map((finding, index) => {
              const active = first + index === at;
              return (
                <box key={finding.id} backgroundColor={active ? color.bg2 : undefined}>
                  <text wrapMode="none">
                    <span fg={finding.severity === "action" ? color.orange : color.fgDim}>
                      {finding.severity === "action" ? "! " : "? "}
                    </span>
                    <span fg={color.comment}>{fit(finding.kind, 15)}</span>
                    <span fg={active ? color.fgBright : color.fg}>{fit(finding.key, inner - 17)}</span>
                  </text>
                </box>
              );
            })
          )}
        </box>
        <box
          flexGrow={1}
          border
          borderStyle="rounded"
          borderColor={color.comment}
          flexDirection="column"
          paddingLeft={1}
        >
          {selectedKey ? <KeyDetail row={selectedKey} /> : null}
          {selectedFinding ? (
            findingEntry ? (
              <KeyDetail row={findingEntry} />
            ) : (
              <box flexDirection="column">
                <text fg={color.orange} attributes={1}>
                  {selectedFinding.key}
                </text>
                <FindingLines findings={[selectedFinding]} />
              </box>
            )
          ) : null}
        </box>
      </box>
      <text wrapMode="none" fg={color.comment}>
        {typing
          ? "type to filter · enter keep · esc clear"
          : `↑↓ move · tab ${view === "keys" ? "findings" : "keys"} · / filter${view === "keys" ? " · s sort" : ""} · r reload · q quit`}
      </text>
    </box>
  );
}

/** Takes the screen until the user quits. Only metadata is shown: the same fields `check` prints. */
export async function showUi(initial: Report, load: () => Promise<Report>): Promise<void> {
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
    createRoot(renderer).render(<App initial={initial} load={load} onQuit={quit} />);
  });
}
