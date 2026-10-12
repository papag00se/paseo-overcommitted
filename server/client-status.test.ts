import { test } from "node:test";
import assert from "node:assert/strict";
import { setImmediate } from "node:timers/promises";
import type { PluginClientContext, PluginSidebarItemProps } from "@getpaseo/plugin/client";
import type { ReactElement } from "react";

// Inspect the registered component's rendered row, not Settings > Sidebar's stable title.
type Item = { id: string; title: string; Component: (props: PluginSidebarItemProps) => ReactElement<{ label: string }> };
const Row = () => null;
const label = (item: Item | undefined) => item?.Component({} as PluginSidebarItemProps).props.label;
import { watchFailures } from "../client/failures";

test("sidebar exists only for warnings, disappears immediately after dismissal, and stops on cleanup", async t => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const visible = new Map<string, Item>();
  let count = 2, disconnected = false, calls = 0;
  const client = {
    rpc: async () => { calls++; if (disconnected) throw new Error("offline"); return { failures: Array.from({ length: count }, () => ({})) }; },
    addSidebarHeaderItem: (item: Item) => { visible.set(item.id, item); return () => { visible.delete(item.id); }; },
  } as unknown as PluginClientContext;
  const indicator = watchFailures(client, Row);
  assert.equal(visible.size, 0, "no placeholder sidebar item before warnings load");
  await setImmediate();
  assert.equal(label(visible.get("status")), "Work not pushed (2)");
  assert.equal(visible.get("status")?.title, "Work not pushed");
  count = 3; await indicator.refresh();
  assert.equal(label(visible.get("status")), "Work not pushed (3)", "the rendered count updates");
  disconnected = true;
  t.mock.timers.tick(15000); await setImmediate();
  assert.equal(label(visible.get("status")), "Work not pushed (3)", "disconnect preserves existing warnings");
  disconnected = false; count = 0;
  await indicator.refresh();
  assert.equal(visible.size, 0, "dismissal refresh removes the item without waiting for a timer");
  disconnected = true;
  await indicator.refresh();
  assert.equal(visible.size, 0, "offline state must not invent an undismissable warning");
  indicator.dispose(); const before = calls;
  t.mock.timers.tick(60000); await setImmediate();
  assert.equal(calls, before); assert.equal(visible.size, 0);
});

test("late poll responses cannot resurrect dismissed warnings or rows after disposal", async t => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const visible = new Map<string, Item>();
  const replies: ((status: { failures: object[] }) => void)[] = [];
  const client = {
    rpc: () => new Promise(resolve => replies.push(resolve)),
    addSidebarHeaderItem: (item: Item) => { visible.set(item.id, item); return () => { visible.delete(item.id); }; },
  } as unknown as PluginClientContext;
  const indicator = watchFailures(client, Row);
  const refreshed = indicator.refresh();
  replies[1]({ failures: [] }); await refreshed;
  replies[0]({ failures: [{}] }); await setImmediate();
  assert.equal(visible.size, 0);
  const pending = indicator.refresh();
  indicator.dispose(); replies[2]({ failures: [{}] }); await pending;
  assert.equal(visible.size, 0);
  t.mock.timers.tick(60000); await setImmediate();
  assert.equal(replies.length, 3);
});
