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

async function render(load: () => Promise<Report> = async () => report) {
  let setup!: Awaited<ReturnType<typeof testRender>>;
  await act(async () => {
    setup = await testRender(<App initial={report} load={load} onQuit={() => {}} />, { width: 100, height: 16 });
  });
  await setup.renderOnce();
  return setup;
}

async function press(setup: Awaited<ReturnType<typeof testRender>>, keys: string[]) {
  await act(async () => {
    await setup.mockInput.pressKeys(keys);
  });
  await setup.renderOnce();
}

const rowOf = (frame: string, text: string) => frame.split("\n").findIndex((line) => line.includes(text));

test("lists the most urgent key first with its detail below", async () => {
  const setup = await render();
  try {
    const frame = setup.captureCharFrame();
    expect(frame).toContain("2 action");
    expect(frame).toContain("▶ ! payments-api");
    expect(rowOf(frame, "payments-api")).toBeLessThan(rowOf(frame, "mail-token"));
    expect(rowOf(frame, "in 8 days")).toBeGreaterThan(rowOf(frame, "mail-token"));
    expect(frame).toContain("PAYMENTS_API_KEY");
  } finally {
    await act(async () => setup.renderer.destroy());
  }
});

test("the select moves the selection and the detail follows", async () => {
  const setup = await render();
  try {
    await press(setup, ["j"]);
    const frame = setup.captureCharFrame();
    expect(frame).toContain("▶ ✓ mail-token");
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
    const detailRow = rowOf(setup.captureCharFrame(), "service");
    await press(setup, ["\t"]);
    expect(rowOf(setup.captureCharFrame(), "service")).toBe(detailRow);
    await press(setup, ["j"]);
    const frame = setup.captureCharFrame();
    expect(frame).toContain("findings");
    expect(frame).toContain("NEW_TOKEN is used but not declared");
    expect(rowOf(frame, "NEW_TOKEN is used")).toBeGreaterThan(listRow);
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

async function renderLong(width: number, height: number) {
  let setup!: Awaited<ReturnType<typeof testRender>>;
  await act(async () => {
    setup = await testRender(<App initial={longReport()} load={async () => longReport()} onQuit={() => {}} />, {
      width,
      height,
    });
  });
  await setup.renderOnce();
  return setup;
}

test("d focuses the details, which scroll to the last location, and esc returns to the list", async () => {
  const setup = await renderLong(100, 16);
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
    expect(setup.captureCharFrame()).not.toContain("details ·");
  } finally {
    await act(async () => setup.renderer.destroy());
  }
});

test("a long runbook wraps in the details instead of being cut off", async () => {
  const setup = await renderLong(40, 24);
  try {
    expect(setup.captureCharFrame().replace(/\s+/g, "")).toContain("end-of-details");
  } finally {
    await act(async () => setup.renderer.destroy());
  }
});

test("the hints wrap between bindings in a narrow terminal and keep q quit", async () => {
  const setup = await renderLong(24, 16);
  try {
    const frame = setup.captureCharFrame();
    expect(frame).toContain("q quit");
    expect(frame).toContain("/ filter");
    expect(frame).not.toMatch(/q qu\s*$/m);
  } finally {
    await act(async () => setup.renderer.destroy());
  }
});

test("on a short terminal the details shrink and the list keeps a row", async () => {
  const setup = await renderLong(100, 8);
  try {
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
