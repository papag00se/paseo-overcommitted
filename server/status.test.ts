import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { StatusStore } from "./status";
import { Scheduler } from "./scheduler";
import { preferences, type Report } from "../shared/contracts";

const report = (outcome: Report["outcome"], directory = "/repo"): Report => ({ at: new Date().toISOString(), directory, outcome, message: outcome === "error" ? "Push rejected; work remains pending" : outcome });

test("failure status survives restart, skip, preview and missing repositories; only actual success clears it", async t => {
  const base = await mkdtemp(join(tmpdir(), "overcommitted-status-test-"));
  t.after(() => rm(base, { recursive: true, force: true }));
  const file = join(base, "status.json");
  const first = new StatusStore(file); await first.load();
  await first.record([report("error")], false);
  const second = new StatusStore(file); await second.load();
  assert.equal(second.failures.length, 1);
  await second.record([report("skipped")], false);
  await second.record([report("eligible")], true);
  await second.record([report("clean")], true);
  await second.record([report("pushed", "/different-repo")], false);
  assert.equal(second.failures.length, 1);
  const third = new StatusStore(file); await third.load();
  assert.equal(third.failures.length, 1);
  await third.record([report("pushed")], false);
  const fourth = new StatusStore(file); await fourth.load();
  assert.deepEqual(fourth.failures, []);
});

test("dismissal survives restart without resolving failed work or suppressing retries", async t => {
  const base = await mkdtemp(join(tmpdir(), "overcommitted-dismiss-"));
  t.after(() => rm(base, { recursive: true, force: true }));
  const file = join(base, "status.json"), failure = report("error");
  const store = new StatusStore(file);
  await store.record([failure], false);
  assert.equal(await store.dismiss([failure]), 1);
  assert.equal(store.failures.length, 1, "the failure is still unresolved");
  assert.deepEqual(store.visibleFailures, []);
  const restored = new StatusStore(file); await restored.load();
  assert.equal(restored.failures.length, 1);
  assert.deepEqual(restored.visibleFailures, []);
  await restored.record([report("clean")], true);
  await restored.record([report("skipped")], false);
  await restored.record([report("clean", "/other")], false);
  assert.equal(restored.failures.length, 1);
  assert.deepEqual(restored.visibleFailures, []);
  let attempts = 0;
  const scheduler = new Scheduler(async () => { attempts++; return [report("pushed")]; }, restored);
  t.after(() => scheduler.stop());
  scheduler.configure(preferences.schema.parse({}));
  assert.deepEqual(scheduler.failures, []);
  await scheduler.run(false);
  assert.equal(attempts, 1, "acknowledging the UI must not stop the next push attempt");
  assert.deepEqual(restored.failures, []);
});

test("new failures resurface; stale and concurrent dismissals cannot hide newer attempts", async t => {
  const base = await mkdtemp(join(tmpdir(), "overcommitted-dismiss-race-"));
  t.after(() => rm(base, { recursive: true, force: true }));
  const file = join(base, "status.json");
  const store = new StatusStore(file);
  const first = { ...report("error"), at: "2026-10-02T01:00:00.000Z" };
  const second = { ...first, at: "2026-10-02T02:00:00.000Z" };
  await store.record([first], false);
  await Promise.all([store.dismiss([first]), store.record([second], false)]);
  assert.deepEqual(store.visibleFailures, [second]);
  const third = { ...first, at: "2026-10-02T03:00:00.000Z" };
  const [, dismissed] = await Promise.all([store.record([third], false), store.dismiss([second])]);
  assert.equal(dismissed, 0);
  const restored = new StatusStore(file); await restored.load();
  assert.deepEqual(restored.visibleFailures, [third]);
  assert.equal(await restored.dismiss([third, third]), 1, "duplicate selections acknowledge only one warning");
  assert.deepEqual(restored.visibleFailures, []);
});

test("failed persistence leaves warnings visible and does not poison subsequent writes", async t => {
  const base = await mkdtemp(join(tmpdir(), "overcommitted-dismiss-write-"));
  t.after(() => rm(base, { recursive: true, force: true }));
  const directory = join(base, "store"), file = join(directory, "status.json");
  const store = new StatusStore(file), failure = report("error");
  await store.record([failure], false);
  await rm(directory, { recursive: true }); await writeFile(directory, "not a directory");
  await assert.rejects(store.dismiss([failure]));
  assert.deepEqual(store.visibleFailures, [failure]);
  await rm(directory); await mkdir(directory);
  assert.equal(await store.dismiss([failure]), 1);
  const restored = new StatusStore(file); await restored.load();
  assert.deepEqual(restored.visibleFailures, []);
  assert.deepEqual(restored.failures, [failure]);
});

test("scheduler persists daemon errors and schedules a later retry instead of calling failure completion", async t => {
  const base = await mkdtemp(join(tmpdir(), "overcommitted-scheduler-test-"));
  t.after(() => rm(base, { recursive: true, force: true }));
  const file = join(base, "status.json");
  const scheduler = new Scheduler(async () => { throw new Error("connection lost"); }, new StatusStore(file));
  t.after(() => scheduler.stop());
  await scheduler.restore(); scheduler.configure(preferences.schema.parse({}));
  await assert.rejects(scheduler.run(false), /connection lost/);
  assert.ok(scheduler.nextCheck);
  const restored = new StatusStore(file); await restored.load();
  assert.equal(restored.failures[0].directory, "daemon");
  assert.match(restored.failures[0].message, /connection lost/);
});
