import {
  type InputRenderable,
  RGBA,
  type ScrollBoxRenderable,
  type SelectOption,
  type SelectRenderable,
  TextAttributes,
} from "@opentui/core";
import { useKeyboard, useTerminalDimensions } from "@opentui/react";
import { type ReactNode, useRef, useState } from "react";
import type { Report } from "./cli";
import type { Finding } from "./reconcile";
import { type Entry, withheld } from "./schema";

// Terminal palette entries, so the colours follow the terminal's theme. Unset text is the terminal's own
// foreground rather than OpenTUI's fixed white.
const color = {
  text: RGBA.defaultForeground(),
  accent: RGBA.fromIndex(6),
  peach: RGBA.fromIndex(3),
  yellow: RGBA.fromIndex(3),
  red: RGBA.fromIndex(1),
  green: RGBA.fromIndex(2),
  orange: RGBA.fromIndex(9),
  none: RGBA.fromValues(0, 0, 0, 0),
};

// The details pane is the same height in both tabs, so switching tabs never moves a line. It shrinks on a short
// terminal, never below one row, and keeps the list at least MIN_LIST rows.
const DETAIL_ROWS = 9;
const MIN_LIST = 3;
// Header, status line and at least one hints row.
const CHROME_ROWS = 3;

type Mode = "list" | "details" | "filter";

// The same units in every mode and tab, so the hints wrap to the same rows and nothing below the list moves.
const hints = ["↑↓ move", "d details", "tab view", "/ filter", "s sort", "r reload", "esc back", "q quit"];

/** How urgent a key is, from its findings. The order is the default sort. */
type State = "expired" | "expiring" | "action" | "gap" | "ok";
const states: Record<State, { mark: string; fg: RGBA; rank: number }> = {
  expired: { mark: "✗", fg: color.red, rank: 0 },
  expiring: { mark: "!", fg: color.yellow, rank: 1 },
  action: { mark: "!", fg: color.orange, rank: 2 },
  gap: { mark: "?", fg: color.text, rank: 3 },
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

const DIM = TextAttributes.DIM;

/** One row, clipped. Details use `wrap` so a long runbook or location is read in the scrolling pane, not cut off. */
function Line({ children, fg, wrap }: { children: ReactNode; fg?: RGBA; wrap?: boolean }) {
  return wrap ? (
    <text flexShrink={0} wrapMode="word" fg={fg ?? color.text}>
      {children}
    </text>
  ) : (
    <text height={1} flexShrink={0} wrapMode="none" truncate fg={fg ?? color.text}>
      {children}
    </text>
  );
}

function Field({ label, value, fg }: { label: string; value?: string; fg?: RGBA }) {
  if (!value) return null;
  return (
    <Line wrap>
      <span attributes={DIM}>{label.padEnd(10)}</span>
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
            <span fg={finding.severity === "action" ? color.orange : undefined}>
              {finding.severity === "action" ? "! " : "? "}
            </span>
            <span>{finding.title}</span>
          </Line>
          {finding.detail ? <Line wrap>{`  ${finding.detail}`}</Line> : null}
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
    <>
      <Line wrap fg={states[row.state].fg}>
        <b>{entry.id}</b>
      </Line>
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
          <span fg={color.peach}>{`${"stored in".padEnd(10)}${location.kind}`}</span>
          <span>{`  ${location.ref}`}</span>
        </Line>
      ))}
      <FindingLines findings={row.findings} />
    </>
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
  const [mode, setMode] = useState<Mode>("list");
  const inputRef = useRef<InputRenderable>(null);
  const selectRef = useRef<SelectRenderable>(null);
  const detailRef = useRef<ScrollBoxRenderable>(null);
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
  const at = Math.min(cursor, Math.max(0, count - 1));

  const reload = () => {
    setStatus("reading…");
    load().then(
      (next) => {
        setReport(next);
        setCursor(0);
        setStatus("");
      },
      (error: unknown) => setStatus(error instanceof Error ? error.message : String(error)),
    );
  };

  const refilter = (value: string) => {
    setFilter(value);
    setCursor(0);
  };

  const toList = () => {
    setMode("list");
    selectRef.current?.focus();
  };

  // Application actions only: the select owns navigation, the input owns editing and the scrollbox owns scrolling.
  // A key can arrive in the same batch as the one before it, before React has rendered, so the widgets' own focus
  // is the truth. Moving focus here and calling preventDefault keeps the key from also reaching the old widget.
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
    if (key.name === "escape") {
      key.preventDefault();
      if (detailRef.current?.focused) toList();
      else refilter("");
    } else if (key.name === "q") onQuit();
    else if (key.name === "tab") {
      key.preventDefault();
      setView(view === "keys" ? "findings" : "keys");
      setCursor(0);
      toList();
    } else if (key.name === "d" && count > 0) {
      key.preventDefault();
      setMode("details");
      detailRef.current?.focus();
    } else if (key.name === "s" && view === "keys") {
      setSort(sorts[(sorts.indexOf(sort) + 1) % sorts.length] ?? "urgency");
      setCursor(0);
    } else if (key.name === "/") {
      key.preventDefault();
      setMode("filter");
      inputRef.current?.focus();
    } else if (key.name === "r") reload();
  });

  const action = report.findings.filter((finding) => finding.severity === "action").length;
  const gaps = report.findings.length - action;
  const detailRows = Math.min(DETAIL_ROWS, Math.max(1, height - CHROME_ROWS - MIN_LIST));

  const options: SelectOption[] =
    view === "keys"
      ? keys.map((row) => ({
          name: `${states[row.state].mark} ${row.entry.id}  ${row.days === undefined ? row.entry.expires : `${row.days}d`}`,
          description: "",
        }))
      : findings.map((finding) => ({
          name: `${finding.severity === "action" ? "!" : "?"} ${finding.kind}  ${finding.key}`,
          description: "",
        }));

  const selectedKey = view === "keys" ? keys[at] : undefined;
  const selectedFinding = view === "findings" ? findings[at] : undefined;
  const findingEntry = selectedFinding
    ? keyRows(report).find((row) => row.entry.id === selectedFinding.key)
    : undefined;

  return (
    <box flexDirection="column" width={width} height={height} paddingLeft={1} paddingRight={1} overflow="hidden">
      <Line>
        <span fg={color.accent}>
          <b>tally</b>
        </span>
        <span attributes={DIM}>{` ${view === "keys" ? `keys · ${sort}` : "findings"} · `}</span>
        <span>{`${withheld(report.repo ?? report.path)} · ${report.today} · ${report.entries.length} keys · `}</span>
        <span fg={action ? color.orange : color.green}>{`${action} action`}</span>
        <span attributes={DIM}>{` · ${gaps} gaps`}</span>
      </Line>
      <box flexDirection="column" flexGrow={1} flexShrink={1} minHeight={0} overflow="hidden">
        {count === 0 ? (
          <Line>
            <span attributes={DIM}>{filter ? "nothing matches" : "nothing here"}</span>
          </Line>
        ) : (
          <select
            ref={selectRef}
            key={`${view}:${sort}:${filter}`}
            focused={mode === "list"}
            flexGrow={1}
            options={options}
            selectedIndex={at}
            showDescription={false}
            backgroundColor={color.none}
            focusedBackgroundColor={color.none}
            selectedBackgroundColor={color.none}
            textColor={color.text}
            focusedTextColor={color.text}
            selectedTextColor={color.accent}
            onChange={(index) => setCursor(index)}
          />
        )}
      </box>
      <scrollbox
        ref={detailRef}
        key={`${view}:${selectedKey?.entry.id ?? selectedFinding?.id}`}
        focused={mode === "details"}
        height={detailRows}
        flexShrink={0}
        backgroundColor={color.none}
      >
        {selectedKey ? <KeyDetail row={selectedKey} /> : null}
        {selectedFinding ? (
          findingEntry ? (
            <KeyDetail row={findingEntry} />
          ) : (
            <>
              <Line wrap fg={color.orange}>
                <b>{selectedFinding.key}</b>
              </Line>
              <FindingLines findings={[selectedFinding]} />
            </>
          )
        ) : null}
      </scrollbox>
      <box flexDirection="row" height={1} flexShrink={0}>
        <text wrapMode="none" fg={color.accent} flexShrink={0} visible={mode === "filter"}>
          {"filter: "}
        </text>
        <input
          ref={inputRef}
          focused={mode === "filter"}
          visible={mode === "filter"}
          flexGrow={mode === "filter" ? 1 : 0}
          placeholder="type to filter · enter keeps · esc clears"
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
      <box flexDirection="row" flexWrap="wrap" columnGap={3} flexShrink={0}>
        {hints.map((hint) => (
          <text key={hint} wrapMode="none" flexShrink={0} attributes={DIM} fg={color.text}>
            {hint}
          </text>
        ))}
      </box>
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
