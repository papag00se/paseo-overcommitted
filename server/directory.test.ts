import assert from "node:assert/strict";
import { test } from "node:test";
import { localDaemonConnection } from "./directory";

const local = { pid: 100, listen: "127.0.0.1:6767" };
const owner = { pid: 101, parentPid: 100 };

test("desktop plugin binds to its IPC owner when optional status details time out", () => {
  assert.deepEqual(localDaemonConnection({ ...local, note: "Status details unavailable" }, owner), {
    url: "ws://127.0.0.1:6767/ws", daemonPid: 101,
  });
});

test("foreground daemon can own the plugin without a separate supervisor", () => {
  assert.equal(localDaemonConnection({ ...local, pid: 101 }, owner).daemonPid, 101);
});

test("full live status must identify the same worker as the plugin owner", () => {
  assert.equal(localDaemonConnection({ ...local, workerPid: 101 }, owner).daemonPid, 101);
  assert.throws(() => localDaemonConnection({ ...local, workerPid: 202 }, owner), /different daemon/);
});

test("partial status from a different home cannot authorize another daemon", () => {
  assert.throws(() => localDaemonConnection({ ...local, pid: 200 }, owner), /different daemon/);
});

test("non-IPC callers still require authoritative live worker identity", () => {
  assert.throws(() => localDaemonConnection(local, null), /worker identity/);
  assert.equal(localDaemonConnection({ ...local, workerPid: 101 }, null).daemonPid, 101);
});

test("missing instances, non-loopback listeners and malformed worker identities fail closed", () => {
  for (const state of [
    { ...local, pid: null }, { ...local, pid: 0 }, { ...local, listen: null },
    { ...local, listen: "0.0.0.0:6767" }, { ...local, listen: "example.com:6767" },
    { ...local, workerPid: 0 }, { ...local, workerPid: "101" },
  ]) assert.throws(() => localDaemonConnection(state, owner));
  assert.equal(localDaemonConnection({ ...local, listen: "[::1]:6767" }, owner).url, "ws://[::1]:6767/ws");
});
