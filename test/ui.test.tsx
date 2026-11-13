import { expect, test } from "bun:test";
import { testRender } from "@opentui/react/test-utils";
import { act } from "react";
import type { Report } from "../src/cli";
import { App } from "../src/ui";

const report: Report = {
  path: "/repo/.tally.yaml",
  repo: "owner/name",
  today: "2026-11-02",
  warnDays: 30,
  entries: [
    {
      id: "payments-api",
      service: "payments",
      owner: "team-payments",
      locations: [{ kind: "github", ref: "PAYMENTS_API_KEY" }],
      expires: "2026-11-10",
      limit: "$200/mo",
    },
    {
      id: "mail-token",
      service: "mail",
      owner: "team-mail",
      locations: [{ kind: "env", ref: "MAIL_TOKEN" }],
      expires: "2028-01-01",
      limit: "none",
    },
  ],
  findings: [
    {
      id: "expiring:payments-api",
      kind: "expiring",
      severity: "action",
      key: "payments-api",
      title: "payments-api expires 2026-11-10",
      days: 8,
    },
    {
      id: "unregistered:NEW_TOKEN",
      kind: "unregistered",
      severity: "action",
      key: "NEW_TOKEN",
      title: "NEW_TOKEN is used but not declared in .tally.yaml",
    },
  ],
};

async function render(load: () => Promise<Report> = async () => report, expanded = true) {
  let setup!: Awaited<ReturnType<typeof testRender>>;
  await act(async () => {
    setup = await testRender(<App initial={report} load={load} onQuit={() => {}} />, { width: 100, height: 16 });
  });
  await setup.renderOnce();
  if (expanded) {
    await act(async () => setup.mockInput.pressKeys(["RETURN"]));
    await setup.renderOnce();
  }
  return setup;
}

async function press(setup: Awaited<ReturnType<typeof testRender>>, keys: string[]) {
  await act(async () => {
    await setup.mockInput.pressKeys(keys);
  });
  await setup.renderOnce();
}

const rowOf = (frame: string, text: string) => frame.split("\n").findIndex((line) => line.includes(text));

test("lists the most urgent key first, and enter opens its detail below", async () => {
  const setup = await render();
  try {
    const frame = setup.captureCharFrame();
    expect(frame).toContain("2 action");
    expect(frame).toContain("› ● payments-api");
    expect(rowOf(frame, "payments-api")).toBeLessThan(rowOf(frame, "mail-token"));
    expect(rowOf(frame, "in 8 days")).toBeGreaterThan(rowOf(frame, "mail-token"));
    expect(frame).toContain("PAYMENTS_API_KEY");
  } finally {
    await act(async () => setup.renderer.destroy());
  }
});

test("moving the selection moves the detail with it", async () => {
  const setup = await render();
  try {
    await press(setup, ["j"]);
    const frame = setup.captureCharFrame();
    expect(frame).toContain("› ● mail-token");
    expect(frame).toContain("MAIL_TOKEN");
    expect(frame).not.toContain("PAYMENTS_API_KEY");
  } finally {
    await act(async () => setup.renderer.destroy());
  }
});

test("tab shows findings, including secrets no key declares, with the list and detail in place", async () => {
  const setup = await render();
  try {
    const listRow = rowOf(setup.captureCharFrame(), "mail-token");
    const detailRow = rowOf(setup.captureCharFrame(), "service ");
    await press(setup, ["\t"]);
    expect(rowOf(setup.captureCharFrame(), "service ")).toBe(detailRow);
    await press(setup, ["j"]);
    const frame = setup.captureCharFrame();
    expect(frame).toContain("findings");
    expect(frame).toContain("NEW_TOKEN is used but not declared");
    expect(rowOf(frame, "› ● unregistered")).toBe(listRow);
  } finally {
    await act(async () => setup.renderer.destroy());
  }
});

test("a filter narrows the list, and ctrl-c still quits while filtering", async () => {
  let quit = 0;
  let setup!: Awaited<ReturnType<typeof testRender>>;
  await act(async () => {
    setup = await testRender(<App initial={report} load={async () => report} onQuit={() => quit++} />, {
      width: 100,
      height: 16,
    });
  });
  await setup.renderOnce();
  try {
    // Slash and the text arrive before React renders, as when typed or pasted quickly.
    await act(async () => {
      for (const key of ["/", "m", "a", "i", "l", "\r"]) setup.mockInput.pressKey(key);
    });
    await setup.renderOnce();
    const frame = setup.captureCharFrame();
    expect(frame).toContain("mail-token");
    expect(frame).not.toContain("payments-api");
    await press(setup, ["/"]);
    await act(async () => {
      setup.mockInput.pressCtrlC();
    });
    expect(quit).toBe(1);
  } finally {
    await act(async () => setup.renderer.destroy());
  }
});

function longReport(): Report {
  const entry = report.entries[0];
  if (!entry) throw new Error("fixture");
  return {
    ...report,
    entries: [
      {
        ...entry,
        runbook: "https://example.com/runbooks/rotate-payments-key-end-of-details",
        locations: Array.from({ length: 14 }, (_, i) => ({ kind: "env" as const, ref: `LOCATION_${i}` })),
      },
    ],
    findings: [],
  };
}

async function renderReport(initial: Report, width = 100, height = 16, stale = false) {
  let setup!: Awaited<ReturnType<typeof testRender>>;
  await act(async () => {
    setup = await testRender(<App initial={initial} load={async () => initial} onQuit={() => {}} stale={stale} />, {
      width,
      height,
    });
  });
  await setup.renderOnce();
  return setup;
}

test("d focuses the details, which scroll to the last location, and esc returns to the list", async () => {
  const setup = await renderReport(longReport());
  try {
    expect(setup.captureCharFrame()).not.toContain("LOCATION_13");
    await press(setup, ["d"]);
    await press(
      setup,
      Array.from({ length: 20 }, () => "j"),
    );
    const frame = setup.captureCharFrame();
    expect(frame).toContain("LOCATION_13");
    expect(frame).toContain("details");
    await act(async () => {
      setup.mockInput.pressEscape();
      await Bun.sleep(50);
    });
    await setup.renderOnce();
    expect(setup.captureCharFrame()).not.toContain("esc back");
  } finally {
    await act(async () => setup.renderer.destroy());
  }
});

test("a long runbook wraps in the details instead of being cut off", async () => {
  const setup = await renderReport(longReport(), 40, 24);
  try {
    await press(setup, ["RETURN"]);
    expect(setup.captureCharFrame().replace(/\s+/g, "")).toContain("end-of-details");
  } finally {
    await act(async () => setup.renderer.destroy());
  }
});

test("a narrow terminal drops hints whole and keeps q quit", async () => {
  const setup = await renderReport(longReport(), 30, 16);
  try {
    const frame = setup.captureCharFrame();
    expect(frame).toContain("q quit");
    expect(frame).not.toContain("r reload");
    expect(frame).not.toMatch(/q qu\s*$/m);
  } finally {
    await act(async () => setup.renderer.destroy());
  }
});

test("on a short terminal the details shrink and the list keeps a row", async () => {
  const setup = await renderReport(longReport(), 100, 8);
  try {
    await press(setup, ["RETURN"]);
    const frame = setup.captureCharFrame();
    expect(frame).toContain("payments-api");
    expect(frame).toContain("q quit");
  } finally {
    await act(async () => setup.renderer.destroy());
  }
});

test("keys typed in the same batch as the slash are filter text, not app actions", async () => {
  let quit = 0;
  let setup!: Awaited<ReturnType<typeof testRender>>;
  await act(async () => {
    setup = await testRender(<App initial={report} load={async () => report} onQuit={() => quit++} />, {
      width: 100,
      height: 16,
    });
  });
  await setup.renderOnce();
  try {
    await act(async () => {
      for (const key of ["/", "q", "s", "r"]) setup.mockInput.pressKey(key);
    });
    await setup.renderOnce();
    expect(quit).toBe(0);
    const frame = setup.captureCharFrame();
    expect(frame).toContain("filter: qsr");
    expect(frame).toContain("nothing matches");
  } finally {
    await act(async () => setup.renderer.destroy());
  }
});

const many = (count: number): Report => {
  const template = report.entries[1];
  if (!template) throw new Error("fixture");
  return {
    ...report,
    entries: Array.from({ length: count }, (_, i) => ({
      ...template,
      id: `key-${i}`,
      service: `service-${i}`,
      runbook: `book-${i}`,
    })),
    findings: [],
  };
};

test("moves typed faster than a render each move one row", async () => {
  const setup = await renderReport(many(6), 100, 24);
  try {
    await act(async () => {
      for (const key of ["j", "j", "j"]) setup.mockInput.pressKey(key);
    });
    await setup.renderOnce();
    expect(setup.captureCharFrame()).toContain("› ● key-3");
  } finally {
    await act(async () => setup.renderer.destroy());
  }
});

test("a reload keeps the selected key, and starts over when that key is gone", async () => {
  const full = many(6);
  let next = full;
  let setup!: Awaited<ReturnType<typeof testRender>>;
  await act(async () => {
    setup = await testRender(<App initial={full} load={async () => next} onQuit={() => {}} />, {
      width: 100,
      height: 24,
    });
  });
  await setup.renderOnce();
  try {
    await press(setup, ["RETURN", "j", "j", "j", "j"]);
    await press(setup, ["r"]);
    expect(setup.captureCharFrame()).toContain("book-4");
    next = { ...full, entries: full.entries.slice(0, 3) };
    await press(setup, ["r"]);
    const frame = setup.captureCharFrame();
    expect(frame).toContain("› ● key-0");
    expect(frame).toContain("book-0");
  } finally {
    await act(async () => setup.renderer.destroy());
  }
});

test("groups start folded with what their keys need, and open into services and keys", async () => {
  const [payments, mail] = report.entries;
  if (!payments || !mail) throw new Error("fixture");
  const grouped: Report = {
    ...report,
    entries: [
      { ...payments, group: "owner-name" },
      { ...mail, id: "mail-a", group: "owner-name" },
      { ...mail, id: "mail-b", group: "owner-name" },
      { ...mail, id: "solo", group: "other-repo" },
    ],
    findings: report.findings.slice(0, 1),
  };
  const setup = await renderReport(grouped);
  try {
    let frame = setup.captureCharFrame();
    expect(frame.split("\n")[0]).toContain("1 action · 0 gaps · 4 keys · 2 groups");
    expect(frame).toMatch(/› owner-name\s+● 1 expiring\s+3 keys/);
    expect(frame).toMatch(/› other-repo\s+1 key/);
    expect(frame).not.toContain("mail-a");
    await press(setup, ["RETURN"]);
    frame = setup.captureCharFrame();
    // A service with one key is that key's row; a service with more is its own fold.
    expect(frame).toContain("payments-api");
    expect(frame).toMatch(/› mail\s+2 keys/);
    expect(frame).not.toContain("mail-a");
    await press(setup, ["j", "j", "l"]);
    frame = setup.captureCharFrame();
    expect(rowOf(frame, "mail-a")).toBeGreaterThan(rowOf(frame, "⌄ mail"));
    await press(setup, ["j", "h", "h"]);
    expect(setup.captureCharFrame()).not.toContain("mail-a");
  } finally {
    await act(async () => setup.renderer.destroy());
  }
});

test("a filter opens every group so a match is never hidden", async () => {
  const entry = report.entries[1];
  if (!entry) throw new Error("fixture");
  const grouped: Report = {
    ...report,
    entries: [
      { ...entry, group: "owner-name" },
      { ...entry, id: "other", group: "owner-name" },
    ],
    findings: [],
  };
  const setup = await renderReport(grouped);
  try {
    expect(setup.captureCharFrame()).not.toContain("mail-token");
    await press(setup, ["/", "o", "w", "n", "e", "r", "\r"]);
    expect(setup.captureCharFrame()).toContain("mail-token");
  } finally {
    await act(async () => setup.renderer.destroy());
  }
});

test("a screen opened from the file alone reads the stores once it is up", async () => {
  let loads = 0;
  let setup!: Awaited<ReturnType<typeof testRender>>;
  const read = { ...report, findings: [] };
  await act(async () => {
    setup = await testRender(
      <App
        initial={report}
        load={async () => {
          loads++;
          return read;
        }}
        onQuit={() => {}}
        stale
      />,
      { width: 100, height: 16 },
    );
  });
  await setup.renderOnce();
  try {
    expect(loads).toBe(1);
    expect(setup.captureCharFrame()).toContain("0 action");
  } finally {
    await act(async () => setup.renderer.destroy());
  }
});

test("details start collapsed and enter toggles them without changing selection", async () => {
  const setup = await render(async () => report, false);
  try {
    expect(setup.captureCharFrame()).not.toContain("PAYMENTS_API_KEY");
    await press(setup, ["RETURN"]);
    expect(setup.captureCharFrame()).toContain("PAYMENTS_API_KEY");
    await press(setup, ["RETURN"]);
    expect(setup.captureCharFrame()).not.toContain("PAYMENTS_API_KEY");
    expect(setup.captureCharFrame()).toContain("› ● payments-api");
  } finally {
    await act(async () => setup.renderer.destroy());
  }
});
