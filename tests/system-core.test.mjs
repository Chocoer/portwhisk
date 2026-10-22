import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { test } from "node:test";
import { runInNewContext } from "node:vm";

const core = runInNewContext(
  readFileSync(new URL("../assets/system-core.js", import.meta.url), "utf8"),
);
const id = "3053aec9-e593-42bc-b280-d2932161baf1";
const otherID = "80d66402-4b8f-4d44-b9df-6f2598ebd1b1";
const connection = (changes = {}) => ({
  id,
  name: "Example",
  host: "Example.test",
  username: "user",
  port: 22,
  credentialRef: id,
  status: "ready",
  ...changes,
});
const before = connection();
const after = connection({ name: "After", host: "new.example.test" });
const session = (changes = {}) => ({
  id: otherID,
  connection: before,
  createdAt: 1000,
  ...changes,
});
const context = (changes = {}) => ({
  prompt: core.expectedPasswordPrompt(session()),
  parentPID: 123,
  sshPID: 123,
  parentPath: "/usr/bin/ssh",
  alreadyUsed: false,
  now: 1000,
  ...changes,
});
const fail = (status) => Object.assign(new Error("simulated system error"), { status });
const throwsStatus = (action, status) => assert.throws(action, (error) => error.status === status);
const copy = (value) => JSON.parse(JSON.stringify(value));

// 每次读写复制快照，像真实文件边界一样隔离调用方内存；旧凭据保留为 opaque 对象。
function fixture(options = {}) {
  const oldPassword = Object.freeze({ bytes: "opaque fixture" });
  const state = {
    records: [before, connection({ id: otherID, credentialRef: otherID, name: "Other" })],
    passwords: new Map([[id, oldPassword]]),
    calls: [],
    writes: 0,
    updates: 0,
    locked: false,
  };
  const io = {
    withLock(callback) {
      if (state.locked) throw fail(-70001);
      state.locked = true;
      try {
        return callback();
      } finally {
        state.locked = false;
      }
    },
    readRecords: () => copy(state.records),
    writeRecords(records) {
      state.writes++;
      state.calls.push("write");
      if (options.writeFailures?.includes(state.writes)) throw fail(-70004);
      state.records = copy(records);
      if (options.writeFailuresAfterEffect?.includes(state.writes)) throw fail(-70004);
    },
    credentials: {
      read(account) {
        state.calls.push("read");
        if (options.readFailure) throw fail(-128);
        return state.passwords.get(account) ?? null;
      },
      update(account, password) {
        state.calls.push("update");
        state.updates++;
        if (options.updateFailures?.includes(state.updates)) throw fail(-128);
        state.passwords.set(account, password);
        if (options.updateFailuresAfterEffect?.includes(state.updates)) throw fail(-128);
      },
      add(account, password) {
        state.calls.push("add");
        if (options.addFailure) throw fail(-128);
        if (state.passwords.has(account)) throw fail(-25299);
        state.passwords.set(account, password);
        if (options.addFailureAfterEffect) throw fail(-128);
      },
      delete(account) {
        state.calls.push("delete");
        if (options.deleteFailure) throw fail(-128);
        state.passwords.delete(account);
      },
    },
  };
  return { state, io, oldPassword, options };
}

function replace(fixture, changes = {}) {
  core.editConnection(
    { expected: before, connection: after, password: "new fixture", ...changes },
    fixture.io,
  );
}

test("system core accepts canonical IDs and hostname/IPv4/IPv6 boundaries", () => {
  assert.equal(core.validUUID(id), true);
  for (const value of [id.toUpperCase(), "", "not-a-uuid", null, 123]) {
    assert.equal(core.validUUID(value), false);
  }
  const longest = ["a".repeat(63), "b".repeat(63), "c".repeat(63), "d".repeat(61)].join(".");
  for (const host of [
    "localhost",
    "127.0.0.1",
    "0.0.0.0",
    "255.255.255.255",
    "::",
    "::1",
    "2001:db8::1234",
    "1:2:3:4:5:6:7:8",
    "::ffff:192.0.2.1",
    "1:2:3:4:5:6:192.0.2.1",
    "a-b.example",
    "EXAMPLE.TEST",
    longest,
  ]) {
    assert.equal(core.validHost(host), true, host);
  }
  for (const host of [
    "",
    "-bad.test",
    "bad-.test",
    ".example",
    "example.",
    "a..b",
    "user@example.test",
    "example.test:22",
    "[::1]",
    "999.1.2.3",
    "1.2.3",
    "01.2.3.4",
    "1.2.3.4.5",
    "host name",
    "x\n.test",
    "$(command).test",
    "例子.test",
    "a".repeat(64) + ".test",
    longest + "b",
    ":",
    ":::1",
    "1::2::3",
    "1:2:3:4:5:6:7",
    "1:2:3:4:5:6:7:8:9",
    "1:2:3:4:5:6:7::8",
    "fe80::1%en0",
    "::ffff:999.1.2.3",
    "1:2:3:4:5:6:7:192.0.2.1",
    null,
  ]) {
    assert.equal(core.validHost(host), false, String(host));
  }
});

test("connection schema rejects unknown fields, invalid targets, and duplicate identities", () => {
  for (const status of ["ready", "pending", "pending-edit", "pending-delete"]) {
    assert.equal(core.validConnection(connection({ status })), true);
  }
  for (const username of ["root", "user+name", "a@b", "用户", "u".repeat(256)]) {
    assert.equal(core.validConnection(connection({ username })), true);
  }
  for (const username of [
    "",
    "-root",
    "a b",
    "a\tb",
    "a\nb",
    "a\0b",
    "a\x7fb",
    ...[0xa0, 0x1680, 0x2000, 0x200a, 0x2028, 0x2029, 0x202f, 0x205f, 0x3000, 0xfeff].map(
      (code) => "a" + String.fromCharCode(code) + "b",
    ),
  ]) {
    assert.equal(core.validConnection(connection({ username })), false, username);
  }
  for (const changes of [
    { id: "bad" },
    { credentialRef: otherID },
    { status: "other" },
    { name: "" },
    { name: "a\0b" },
    { name: "a\x7fb" },
    { port: 0 },
    { port: 65536 },
    { port: 1.5 },
    { port: "22" },
    { port: NaN },
    { host: "-bad" },
    { unknown: "do not silently discard" },
  ]) {
    assert.equal(core.validConnection(connection(changes)), false);
  }
  for (const port of [1, 65535]) assert.equal(core.validConnection(connection({ port })), true);
  const missing = connection();
  delete missing.name;
  assert.equal(core.validConnection(missing), false);
  throwsStatus(() => core.validateConnections([before, before]), -50);
  throwsStatus(() => core.validateConnections([missing]), -50);
  throwsStatus(() => core.validateConnections(null), -50);
  core.validateConnections([]);
});

test("password UTF-8 limits and exact Unicode identity survive without TextEncoder", () => {
  for (const value of [
    " password with spaces ",
    "quotes'\"\\$()",
    "中文🔒",
    "a".repeat(1023),
    "中".repeat(341),
  ]) {
    assert.equal(core.validPassword(value), true);
  }
  for (const value of [
    "",
    "a".repeat(1024),
    "中".repeat(342),
    "a\0b",
    "a\rb",
    "a\nb",
    "\ud800",
    "\udc00",
    null,
  ]) {
    assert.equal(core.validPassword(value), false);
  }
  const nfd = connection({ username: "cafe\u0301" });
  const nfc = connection({ username: "caf\u00e9" });
  assert.equal(core.sameConnection(nfd, nfc), false);
  assert.equal(core.sameConnection(nfd, { ...nfd }), true);
  assert.equal(core.currentConnectionAllowsPassword(nfd, [nfc]), false);
  assert.equal(core.currentConnectionAllowsPassword(nfd, [nfd]), true);
});

test("password delivery binds exact parent, selected target, fresh session, and one request", () => {
  assert.equal(core.expectedPasswordPrompt(session()), "user@example.test's password: ");
  for (const now of [995, 1000, 1300]) {
    assert.equal(core.passwordRequestAllowed(session(), context({ now })), true);
  }
  for (const changes of [
    { now: 994.99 },
    { now: 1300.01 },
    { now: NaN },
    { now: Infinity },
    { parentPID: 124 },
    { parentPID: 0, sshPID: 0 },
    { parentPID: 1.5, sshPID: 1.5 },
    { sshPID: 124 },
    { parentPath: null },
    { parentPath: "/tmp/ssh" },
    { alreadyUsed: true },
    { hint: "confirm" },
    { hint: "" },
    { prompt: "Password: " },
    { prompt: "user@other.test's password: " },
    { prompt: "user@example.test's password:" },
    { prompt: "(user@example.test) Password: " },
  ]) {
    assert.equal(core.passwordRequestAllowed(session(), context(changes)), false);
  }
  for (const changes of [
    { id: "bad" },
    { createdAt: NaN },
    { createdAt: "1000" },
    { connection: connection({ status: "pending" }) },
  ]) {
    assert.equal(core.passwordRequestAllowed(session(changes), context()), false);
  }
  const nfd = session({ connection: connection({ username: "cafe\u0301" }) });
  const nfc = session({ connection: connection({ username: "caf\u00e9" }) });
  assert.equal(
    core.passwordRequestAllowed(nfd, context({ prompt: core.expectedPasswordPrompt(nfd) })),
    true,
  );
  assert.equal(
    core.passwordRequestAllowed(nfd, context({ prompt: core.expectedPasswordPrompt(nfc) })),
    false,
  );
});

test("challenge and host prompts never qualify as stored-password requests", () => {
  for (const prompt of ["(user@example.test) OTP: ", "(user@example.test) Password: "]) {
    assert.equal(core.isInteractiveChallenge(prompt, session()), true);
    assert.equal(core.passwordRequestAllowed(session(), context({ prompt })), false);
  }
  for (const prompt of [
    "(other@example.test) OTP: ",
    "(user@other.test) OTP: ",
    "(user@example.test)OTP: ",
  ]) {
    assert.equal(core.isInteractiveChallenge(prompt, session()), false);
  }
  const unusual = session({ connection: connection({ username: "a@b" }) });
  assert.equal(core.isInteractiveChallenge("(a@b@example.test) OTP: ", unusual), true);
  assert.equal(core.isInteractiveChallenge("(b@example.test) OTP: ", unusual), false);
  const nfd = session({ connection: connection({ username: "cafe\u0301" }) });
  assert.equal(core.isInteractiveChallenge("(cafe\u0301@example.test) OTP: ", nfd), true);
  assert.equal(core.isInteractiveChallenge("(caf\u00e9@example.test) OTP: ", nfd), false);
  const prompt =
    "The authenticity of host 'example.test (192.0.2.1)' can't be established.\nED25519 key fingerprint is SHA256:fixture.\nAre you sure you want to continue connecting (yes/no/[fingerprint])? ";
  assert.equal(core.isHostConfirmation(prompt), true);
  assert.equal(core.passwordRequestAllowed(session(), context({ prompt })), false);
  for (const invalid of [
    "Are you sure you want to continue connecting? ",
    prompt + "extra",
    prompt.replaceAll("fingerprint", "identity"),
  ]) {
    assert.equal(core.isHostConfirmation(invalid), false);
  }
});

test("system SSH accepts safe arguments without making a network connection", () => {
  const args = Array.from(core.sshArguments(before));
  assert.deepEqual(args.slice(0, 3), ["-F", "/dev/null", "-tt"]);
  assert.deepEqual(args.slice(-6), ["-l", "user", "-p", "22", "--", "example.test"]);
  const result = spawnSync("/usr/bin/ssh", ["-G", ...args], { encoding: "utf8" });
  assert.equal(result.status, 0, result.stderr);
  const lines = result.stdout.split("\n");
  for (const line of [
    "stricthostkeychecking ask",
    "passwordauthentication yes",
    "kbdinteractiveauthentication yes",
    "numberofpasswordprompts 1",
    "connectionattempts 1",
    "connecttimeout 15",
    "permitlocalcommand no",
    "preferredauthentications password,keyboard-interactive",
    "user user",
    "hostname example.test",
  ]) {
    assert.ok(lines.includes(line), line);
  }
  for (const option of ["updatehostkeys", "pubkeyauthentication"]) {
    assert.ok(lines.includes(option + " no") || lines.includes(option + " false"));
  }
  assert.ok(
    lines.some((line) => line.startsWith("userknownhostsfile ") && !line.includes("/dev/null")),
  );
});

test("save compares locked snapshots and never accepts canonically equivalent different usernames", () => {
  const f = fixture();
  core.saveConnections({ expected: f.state.records, connections: [after] }, f.io);
  assert.deepEqual(f.state.records, [after]);
  throwsStatus(() => core.saveConnections({ expected: [], connections: [] }, f.io), -70001);
  f.io.withLock(() =>
    throwsStatus(() => core.saveConnections({ expected: [after], connections: [] }, f.io), -70001),
  );
  f.state.records = [connection({ username: "cafe\u0301" })];
  throwsStatus(
    () =>
      core.saveConnections(
        { expected: [connection({ username: "caf\u00e9" })], connections: [] },
        f.io,
      ),
    -70001,
  );
  assert.equal(f.state.locked, false);
});

test("pending add and cleanup share the lock and block late orphan credentials", () => {
  const f = fixture();
  f.state.passwords.delete(id);
  throwsStatus(() => core.addPendingCredential(id, "fixture", f.io), -70001);
  assert.deepEqual(f.state.calls, []);
  const pending = connection({ status: "pending" });
  f.state.records = [pending];
  f.io.withLock(() => throwsStatus(() => core.addPendingCredential(id, "fixture", f.io), -70001));
  core.addPendingCredential(id, "fixture", f.io);
  assert.equal(f.state.passwords.get(id), "fixture");
  assert.deepEqual(f.state.records, [pending]);
  core.deleteConnection({ expected: pending }, f.io);
  throwsStatus(() => core.addPendingCredential(id, "late fixture", f.io), -70001);
  assert.equal(f.state.passwords.has(id), false);
});

test("plain edit preserves password without reading it and protects other records", () => {
  const f = fixture();
  core.editConnection({ expected: before, connection: after }, f.io);
  assert.deepEqual(f.state.records[0], after);
  assert.equal(f.state.records[1].id, otherID);
  assert.deepEqual(f.state.calls, ["write"]);
  assert.equal(f.state.passwords.get(id), f.oldPassword);
  throwsStatus(() => replace(f), -70001);
});

test("replacement stores expressive password unchanged, only after durable disabling", () => {
  const f = fixture();
  const password = " '新\\密碼 fixture ";
  replace(f, { password });
  assert.equal(f.state.passwords.get(id), password);
  assert.deepEqual(f.state.records[0], after);
  assert.deepEqual(f.state.calls, ["read", "write", "update", "write"]);
  assert.ok(!JSON.stringify(f.state.records).includes("password"));
  assert.ok(!JSON.stringify(f.state.records).includes(password));
});

test("invalid and stale edits do not touch credentials", () => {
  for (const request of [
    { expected: before, connection: after, password: "" },
    { expected: before, connection: after, password: "\ud800" },
    { expected: before, connection: connection({ id: otherID, credentialRef: otherID }) },
    { expected: before, connection: connection({ status: "pending" }) },
    { expected: connection({ status: "pending-edit" }), connection: after },
    { expected: connection({ status: "pending-delete" }), connection: after, password: "fixture" },
  ]) {
    const f = fixture();
    throwsStatus(() => core.editConnection(request, f.io), -50);
    assert.deepEqual(f.state.calls, []);
  }
  const f = fixture();
  f.state.records = [connection({ username: "cafe\u0301" })];
  throwsStatus(() => replace(f, { expected: connection({ username: "caf\u00e9" }) }), -70001);
  assert.deepEqual(f.state.calls, []);
});

test("read or initial marker failure changes neither password nor usable target", () => {
  for (const options of [{ readFailure: true }, { writeFailures: [1] }]) {
    const f = fixture(options);
    throwsStatus(() => replace(f), options.readFailure ? -128 : -70004);
    assert.deepEqual(f.state.records[0], before);
    assert.equal(f.state.passwords.get(id), f.oldPassword);
    assert.ok(!f.state.calls.includes("update"));
  }
});

test("failed credential write restores opaque old bytes before enabling original target", () => {
  for (const options of [{ updateFailures: [1] }, { updateFailuresAfterEffect: [1] }]) {
    const f = fixture(options);
    throwsStatus(() => replace(f), -128);
    assert.deepEqual(f.state.records[0], before);
    assert.equal(f.state.passwords.get(id), f.oldPassword);
    assert.deepEqual(f.state.calls, ["read", "write", "update", "update", "write"]);
  }
});

test("uncertain credential write with failed compensation remains blocked and repairable", () => {
  const f = fixture({ updateFailuresAfterEffect: [1], updateFailures: [2] });
  throwsStatus(() => replace(f), -70002);
  const pending = connection({ status: "pending-edit" });
  assert.deepEqual(f.state.records[0], pending);
  assert.equal(core.currentConnectionAllowsPassword(before, f.state.records), false);
  throwsStatus(() => replace(f, { expected: pending, password: null }), -50);
  replace(f, { expected: pending, password: "recovered fixture" });
  assert.deepEqual(f.state.records[0], after);
  assert.equal(f.state.passwords.get(id), "recovered fixture");
});

test("metadata commit failure restores original target and password safely", () => {
  for (const options of [{ writeFailures: [2] }, { writeFailuresAfterEffect: [2] }]) {
    const f = fixture(options);
    throwsStatus(() => replace(f), -70004);
    assert.deepEqual(f.state.records[0], before);
    assert.equal(f.state.passwords.get(id), f.oldPassword);
    assert.deepEqual(f.state.calls, [
      "read",
      "write",
      "update",
      "write",
      "write",
      "update",
      "write",
    ]);
  }
});

test("uncertain metadata commit must be disabled before restoring old password", () => {
  const f = fixture({ writeFailuresAfterEffect: [2], writeFailures: [3] });
  throwsStatus(() => replace(f), -70002);
  assert.deepEqual(f.state.records[0], after);
  assert.equal(f.state.passwords.get(id), "new fixture");
  assert.equal(f.state.updates, 1);
});

test("failed final metadata restore retains disabled target after credential rollback", () => {
  const f = fixture({ writeFailuresAfterEffect: [2], writeFailures: [4] });
  throwsStatus(() => replace(f), -70002);
  assert.deepEqual(f.state.records[0], connection({ status: "pending-edit" }));
  assert.equal(f.state.passwords.get(id), f.oldPassword);
});

test("failed password rollback retains disabled target", () => {
  const f = fixture({ writeFailures: [2], updateFailures: [2] });
  throwsStatus(() => replace(f), -70002);
  assert.deepEqual(f.state.records[0], connection({ status: "pending-edit" }));
  assert.equal(core.currentConnectionAllowsPassword(before, f.state.records), false);
});

test("missing prior credential uses add and compensation restores its absence", () => {
  const successful = fixture();
  successful.state.passwords.delete(id);
  replace(successful);
  assert.deepEqual(successful.state.calls, ["read", "write", "add", "write"]);
  for (const options of [{ writeFailures: [2] }, { addFailureAfterEffect: true }]) {
    const f = fixture(options);
    f.state.passwords.delete(id);
    throwsStatus(() => replace(f), options.addFailureAfterEffect ? -128 : -70004);
    assert.equal(f.state.passwords.has(id), false);
    assert.deepEqual(f.state.records[0], before);
  }
});

test("delete removes only selected credential and metadata", () => {
  const f = fixture();
  core.deleteConnection({ expected: before }, f.io);
  assert.equal(f.state.passwords.has(id), false);
  assert.deepEqual(
    f.state.records.map((record) => record.id),
    [otherID],
  );
  assert.deepEqual(f.state.calls, ["write", "delete", "write"]);
  throwsStatus(() => core.deleteConnection({ expected: before }, f.io), -70001);
});

test("failed delete retains retry identity and supports already missing credentials", () => {
  for (const options of [{ deleteFailure: true }, { writeFailures: [2] }]) {
    const f = fixture(options);
    throwsStatus(() => core.deleteConnection({ expected: before }, f.io), -70003);
    const pending = connection({ status: "pending-delete" });
    assert.deepEqual(f.state.records[0], pending);
    assert.equal(f.state.passwords.has(id), !!options.deleteFailure);
    f.options.deleteFailure = false;
    core.deleteConnection({ expected: pending }, f.io);
    assert.deepEqual(
      f.state.records.map((record) => record.id),
      [otherID],
    );
    assert.equal(f.state.passwords.has(id), false);
  }
});

test("initial delete marker failure never clears a credential", () => {
  const f = fixture({ writeFailures: [1] });
  throwsStatus(() => core.deleteConnection({ expected: before }, f.io), -70004);
  assert.deepEqual(f.state.calls, ["write"]);
  assert.equal(f.state.passwords.get(id), f.oldPassword);
  assert.deepEqual(f.state.records[0], before);
});

test("old SSH snapshot is blocked after edit, delete, or pending transitions", () => {
  assert.equal(core.currentConnectionAllowsPassword(before, [before]), true);
  for (const records of [
    [],
    [after],
    [connection({ status: "pending-edit" })],
    [connection({ status: "pending-delete" })],
  ]) {
    assert.equal(core.currentConnectionAllowsPassword(before, records), false);
  }
  assert.equal(
    core.currentConnectionAllowsPassword(connection({ status: "pending" }), [
      connection({ status: "pending" }),
    ]),
    false,
  );
});
