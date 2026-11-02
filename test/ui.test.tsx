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

test("lists the most urgent key first with its detail beside it", async () => {
  const setup = await render();
  try {
    const frame = setup.captureCharFrame();
    expect(frame).toContain("2 action");
    expect(frame.indexOf("payments-api")).toBeLessThan(frame.indexOf("mail-token"));
    expect(frame).toContain("in 8 days");
    expect(frame).toContain("PAYMENTS_API_KEY");
  } finally {
    setup.renderer.destroy();
  }
});

test("tab shows findings, including secrets no key declares, and keeps the same height", async () => {
  const setup = await render();
  try {
    const rows = setup.captureCharFrame().split("\n").length;
    await press(setup, ["\t", "j"]);
    const frame = setup.captureCharFrame();
    expect(frame).toContain("findings");
    expect(frame).toContain("NEW_TOKEN is used but not declared");
    expect(frame.split("\n").length).toBe(rows);
  } finally {
    setup.renderer.destroy();
  }
});

test("a filter narrows the list", async () => {
  const setup = await render();
  try {
    await press(setup, ["/", "m", "a", "i", "l", "\r"]);
    const frame = setup.captureCharFrame();
    expect(frame).toContain("mail-token");
    expect(frame).not.toContain("payments-api");
  } finally {
    setup.renderer.destroy();
  }
});
