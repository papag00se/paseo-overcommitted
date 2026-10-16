import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { StatusStore } from "./status";
import { Scheduler } from "./scheduler";
import { preferences, type Report } from "../shared/contracts";

const report = (outcome: Report["outcome"], directory = "/repo"): Report => ({ at: new Date().toISOString(), directory, outcome, message: outcome === "error" ? "Push rejected; work remains pending" : outcome });

test("each real check replaces saved warnings with only its current errors", async t => {
  const base = await mkdtemp(join(tmpdir(), "overcommitted-status-test-"));
  t.after(() => rm(base, { recursive: true, force: true }));
  const file = join(base, "status.json");
  const stale = { ...report("error", "/koralabs"), message: "Submodule changes require a separate commit/push; refusing a partial checkpoint" };
  for (const current of [[report("skipped", stale.directory)], [report("clean", stale.directory)], [report("pushed", "/different-repo")], [], [report("error", "/current-repo"), report("scanned", "/parent")]]) {
    const first = new StatusStore(file);
    await first.record([stale, report("error", "daemon")], false);
    const restored = new StatusStore(file); await restored.load();
    assert.deepEqual(restored.visibleFailures, first.visibleFailures, "warnings survive reload until the next real check");
    await restored.record(current, false);
    const expected = current.filter(r => r.outcome === "error");
    assert.deepEqual(restored.visibleFailures, expected, "skipped, absent and resolved failures must not linger");
    const reloaded = new StatusStore(file); await reloaded.load();
    assert.deepEqual(reloaded.failures, expected, "replacement must survive another reload");
    assert.deepEqual(reloaded.reports, current);
  }
});

test("loading older saved status drops warnings missing from its latest real-check reports", async t => {
  const base = await mkdtemp(join(tmpdir(), "overcommitted-legacy-status-"));
  t.after(() => rm(base, { recursive: true, force: true }));
  const file = join(base, "status.json"), current = report("error", "/current-repo");
  await writeFile(file, JSON.stringify({ reports: [report("skipped"), current], failures: [report("error"), current], dismissed: [] }));
  const store = new StatusStore(file); await store.load();
  assert.deepEqual(store.visibleFailures, [current], "reload must not restore historical errors excluded from the latest check");
});

test("previews leave saved real-check warnings and dismissals unchanged", async t => {
  const base = await mkdtemp(join(tmpdir(), "overcommitted-preview-status-"));
  t.after(() => rm(base, { recursive: true, force: true }));
  const file = join(base, "status.json"), failure = report("error");
  const store = new StatusStore(file);
  await store.record([failure], false);
  await store.dismiss([failure]);
  for (const preview of [[], [report("clean")], [report("eligible")], [report("error", "daemon")]]) {
    await store.record(preview, true);
    assert.deepEqual(store.reports, preview);
    assert.deepEqual(store.failures, [failure]);
    assert.deepEqual(store.visibleFailures, []);
    const restored = new StatusStore(file); await restored.load();
    assert.deepEqual(restored.reports, [failure]);
    assert.deepEqual(restored.failures, [failure]);
    assert.deepEqual(restored.visibleFailures, []);
  }
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
  assert.deepEqual(restored.failures, [failure]);
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
  const current = report("error", "/current-repo");
  await assert.rejects(store.record([current], false));
  assert.deepEqual(store.reports, [failure]);
  assert.deepEqual(store.visibleFailures, [failure], "a failed replacement must retain the last saved warnings");
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
  const store = new StatusStore(file);
  await store.record([report("error")], false);
  let disconnected = true;
  const scheduler = new Scheduler(async () => {
    if (disconnected) throw new Error("connection lost");
    return [];
  }, store);
  t.after(() => scheduler.stop());
  await scheduler.restore(); scheduler.configure(preferences.schema.parse({}));
  await assert.rejects(scheduler.run(false), /connection lost/);
  assert.ok(scheduler.nextCheck);
  const restored = new StatusStore(file); await restored.load();
  assert.equal(restored.failures.length, 1, "a daemon failure replaces old repository warnings too");
  assert.equal(restored.failures[0].directory, "daemon");
  assert.match(restored.failures[0].message, /connection lost/);
  disconnected = false;
  await scheduler.run(false);
  assert.deepEqual(scheduler.failures, [], "an empty completed check clears the old daemon warning");
  await restored.load();
  assert.deepEqual(restored.failures, []);
});
