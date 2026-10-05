import { test } from "node:test";
import assert from "node:assert/strict";
import { setImmediate } from "node:timers/promises";
import type { PluginClientContext } from "@getpaseo/plugin/client";
import { watchFailures } from "../client/failures";

test("sidebar exists only for warnings, disappears immediately after dismissal, and stops on cleanup", async t => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const visible = new Map<string, { title: string; icon: string }>();
  let count = 2, disconnected = false, calls = 0;
  const client = {
    rpc: async () => { calls++; if (disconnected) throw new Error("offline"); return { failures: Array.from({ length: count }, () => ({})) }; },
    addSidebarItem: (item: { id: string; title: string; icon: string }) => { visible.set(item.id, item); return () => { visible.delete(item.id); }; },
  } as unknown as PluginClientContext;
  const indicator = watchFailures(client);
  assert.equal(visible.size, 0, "no placeholder sidebar item before warnings load");
  await setImmediate();
  assert.equal(visible.get("status")?.title, "Work not pushed (2)");
  disconnected = true;
  t.mock.timers.tick(15000); await setImmediate();
  assert.equal(visible.get("status")?.title, "Work not pushed (2)", "disconnect preserves existing warnings");
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
  const visible = new Map<string, string>();
  const replies: ((status: { failures: object[] }) => void)[] = [];
  const client = {
    rpc: () => new Promise(resolve => replies.push(resolve)),
    addSidebarItem: (item: { id: string; title: string }) => { visible.set(item.id, item.title); return () => { visible.delete(item.id); }; },
  } as unknown as PluginClientContext;
  const indicator = watchFailures(client);
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
