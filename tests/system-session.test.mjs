import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import {
  chmodSync,
  mkdtempSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { join, resolve } from "node:path";
import test from "node:test";

// CI 对下载的同一脚本包执行无凭据文件检查，路径可指向已解压的发布产物。
mkdirSync(resolve("build"), { recursive: true });
const helper = resolve(process.env.PORTWHISK_TEST_HELPER ?? "assets/keychain-helper");
const id = "12345678-1234-4234-8234-123456789abc";
const connection = {
  id,
  name: "fixture",
  host: "example.invalid",
  username: "fixture-user",
  port: 2222,
  credentialRef: id,
  status: "ready",
};

function invoke(operation, target, input = "", environment = {}) {
  return spawnSync(helper, [operation, target], {
    input,
    encoding: "utf8",
    env: { ...process.env, ...environment },
    timeout: 10000,
  });
}

// 仅操作 build 内的虚构元数据；会话启动仅验证提前拒绝，不进入真实 SSH 或钥匙串。
test("script session freezes the selected target, enforces private directories and discards its resources", () => {
  const support = mkdtempSync(resolve("build/session-test-"));
  try {
    mkdirSync(join(support, "connections"));
    const records = join(support, "connections/records.json");
    writeFileSync(records, JSON.stringify([connection]));
    const prepared = invoke("ssh-prepare", support, JSON.stringify({ connectionId: id }));
    assert.equal(prepared.status, 0, prepared.stderr);
    const { sessionId } = JSON.parse(prepared.stdout);
    assert.match(sessionId, /^[0-9a-f-]{36}$/);
    const directory = join(support, "sessions", sessionId);
    assert.equal(statSync(directory).mode & 0o777, 0o700);
    assert.equal(statSync(join(support, "sessions")).mode & 0o777, 0o700);
    const session = JSON.parse(readFileSync(join(directory, "session.json"), "utf8"));
    assert.deepEqual(session.connection, connection);
    assert.equal(session.id, sessionId);
    writeFileSync(records, JSON.stringify([{ ...connection, host: "changed.invalid" }]));
    assert.equal(
      JSON.parse(readFileSync(join(directory, "session.json"))).connection.host,
      connection.host,
    );
    assert.deepEqual(readdirSync(directory), ["session.json"]);

    // 普通 Node 父进程不能冒充本次 SSH，拒绝时不会读凭据或创建已使用标记。
    const denied = spawnSync(helper, ["fixture-user@example.invalid's password: "], {
      encoding: "utf8",
      env: {
        ...process.env,
        PORTWHISK_SSH_SESSION: directory,
        PORTWHISK_SSH_PID: String(process.pid),
      },
      timeout: 10000,
    });
    assert.notEqual(denied.status, 0);
    assert.equal(denied.stdout, "");
    assert.deepEqual(readdirSync(directory), ["session.json"]);
    assert.equal(invoke("ssh-discard", directory).status, 0);
    assert.deepEqual(readdirSync(join(support, "sessions")), []);
  } finally {
    rmSync(support, { recursive: true, force: true });
  }
});

test("script session rejects pending/invalid targets and prunes expired unstarted sessions", () => {
  const support = mkdtempSync(resolve("build/session-test-"));
  try {
    mkdirSync(join(support, "connections"));
    const records = join(support, "connections/records.json");
    for (const record of [
      { ...connection, status: "pending" },
      { ...connection, host: "-oProxyCommand=x" },
    ]) {
      writeFileSync(records, JSON.stringify([record]));
      assert.notEqual(
        invoke("ssh-prepare", support, JSON.stringify({ connectionId: id })).status,
        0,
      );
    }
    writeFileSync(records, JSON.stringify([connection]));
    const first = JSON.parse(
      invoke("ssh-prepare", support, JSON.stringify({ connectionId: id })).stdout,
    );
    const directory = join(support, "sessions", first.sessionId);
    const file = join(directory, "session.json");
    const session = JSON.parse(readFileSync(file));
    writeFileSync(file, JSON.stringify({ ...session, createdAt: Date.now() / 1000 - 301 }));
    const second = invoke("ssh-prepare", support, JSON.stringify({ connectionId: id }));
    assert.equal(second.status, 0);
    assert.deepEqual(readdirSync(join(support, "sessions")), [JSON.parse(second.stdout).sessionId]);
  } finally {
    rmSync(support, { recursive: true, force: true });
  }
});

test("script session rejects a public session root without changing its permissions", () => {
  const support = mkdtempSync(resolve("build/session-test-"));
  try {
    mkdirSync(join(support, "connections"));
    writeFileSync(join(support, "connections/records.json"), JSON.stringify([connection]));
    const sessions = join(support, "sessions");
    mkdirSync(sessions);
    chmodSync(sessions, 0o755);
    const rejected = invoke("ssh-prepare", support, JSON.stringify({ connectionId: id }));
    assert.notEqual(rejected.status, 0);
    assert.equal(statSync(sessions).mode & 0o777, 0o755);
    assert.deepEqual(readdirSync(sessions), []);
  } finally {
    rmSync(support, { recursive: true, force: true });
  }
});

test("script session rejects non-TTY start and direct exec without creating runner state", () => {
  const support = mkdtempSync(resolve("build/session-test-"));
  try {
    mkdirSync(join(support, "connections"));
    writeFileSync(join(support, "connections/records.json"), JSON.stringify([connection]));
    const prepared = invoke("ssh-prepare", support, JSON.stringify({ connectionId: id }));
    assert.equal(prepared.status, 0, prepared.stderr);
    const directory = join(support, "sessions", JSON.parse(prepared.stdout).sessionId);
    for (const operation of ["ssh-start", "ssh-exec"]) {
      const rejected = invoke(operation, directory);
      assert.notEqual(rejected.status, 0, operation);
      assert.equal(rejected.stdout, "");
      if (operation === "ssh-exec") {
        assert.match(rejected.stderr, /Portwhisk: Session invalid/);
        assert.match(rejected.stderr, /会话无效/);
      }
      assert.deepEqual(readdirSync(directory), ["session.json"]);
    }
    assert.equal(invoke("ssh-discard", directory).status, 0);
  } finally {
    rmSync(support, { recursive: true, force: true });
  }
});

test("script terminal preference persists atomically and rejects unsupported identifiers", () => {
  const support = mkdtempSync(resolve("build/terminal-test-"));
  try {
    const preference = { terminalId: "com.apple.Terminal" };
    assert.equal(invoke("terminal", support, JSON.stringify(preference)).status, 0);
    assert.deepEqual(JSON.parse(readFileSync(join(support, "terminal.json"))), preference);
    assert.notEqual(
      invoke("terminal", support, JSON.stringify({ terminalId: "unsupported" })).status,
      0,
    );
    assert.deepEqual(JSON.parse(readFileSync(join(support, "terminal.json"))), preference);
    const inventory = invoke("terminals", support);
    assert.equal(inventory.status, 0);
    assert.ok(
      JSON.parse(inventory.stdout).terminalIds.every((value) =>
        ["com.apple.Terminal", "com.googlecode.iterm2"].includes(value),
      ),
    );
  } finally {
    rmSync(support, { recursive: true, force: true });
  }
});
