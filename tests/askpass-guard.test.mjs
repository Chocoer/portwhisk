import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import {
  chmodSync,
  copyFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { join, resolve } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import test from "node:test";

const id = "12345678-1234-4234-8234-123456789abc";
const source = readFileSync(new URL("../assets/system.js", import.meta.url), "utf8");

async function waitFor(predicate, description, timeout = 10000) {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) {
    const value = predicate();
    if (value) return value;
    await delay(25);
  }
  assert.fail(`Timed out waiting for ${description}`);
}

function parentPID(pid) {
  const inspected = spawnSync("/bin/ps", ["-p", String(pid), "-o", "ppid="], {
    encoding: "utf8",
    timeout: 2000,
  });
  return inspected.status === 0 ? Number(inspected.stdout.trim()) : null;
}

function identity(pid) {
  const inspected = spawnSync("/bin/ps", ["-p", String(pid), "-o", "lstart=,comm=,command="], {
    encoding: "utf8",
    timeout: 2000,
  });
  return inspected.status === 0 ? inspected.stdout.trim() : null;
}

function stopOwned(pid, expected) {
  if (!expected || identity(pid) !== expected) return;
  try {
    process.kill(pid, "SIGKILL");
  } catch (error) {
    if (error.code !== "ESRCH") throw error;
  }
}

// 假 SSH 是独立 Node 子进程；根测试进程绝不作为被终止目标，也不启动真实 SSH。
async function fixture(t, { success = false, guardExit, signalBehavior } = {}) {
  mkdirSync(resolve("build"), { recursive: true });
  const root = mkdtempSync(resolve("build/askpass-guard-"));
  const helper = join(root, "keychain-helper");
  let fake;
  let waiting;
  let outcome;
  let guardian;
  const owned = new Map();
  t.after(async () => {
    // 同时核对启动时间、路径和含本夹具独占目录的命令，清理重挂子进程也不会误杀复用 PID。
    const remaining = spawnSync("/bin/ps", ["-ax", "-o", "pid=,command="], {
      encoding: "utf8",
      timeout: 2000,
    });
    for (const line of remaining.stdout.split("\n")) {
      const match = /^\s*(\d+)\s+/.exec(line);
      if (!match || !line.includes(root)) continue;
      const pid = Number(match[1]);
      const expected = identity(pid);
      if (!owned.has(pid) && expected?.includes(root)) owned.set(pid, expected);
    }
    for (const [pid, expected] of owned) stopOwned(pid, expected);
    if (fake && !outcome) fake.kill("SIGKILL");
    if (fake) await waitFor(() => outcome, "fixture child cleanup");
    rmSync(root, { recursive: true, force: true });
  });
  copyFileSync(new URL("../assets/keychain-helper", import.meta.url), helper);
  chmodSync(helper, 0o700);
  copyFileSync(new URL("../assets/system-core.js", import.meta.url), join(root, "system-core.js"));

  // 测试副本只改变进程路径识别和密码回答入口；取消后的生产终止逻辑保持完整。
  const pathBoundary = "function executablePath(pid) {";
  assert.equal(source.split(pathBoundary).length, 2);
  let isolated = source.replace(
    pathBoundary,
    `${pathBoundary}
  if (pid === Number(environment.PORTWHISK_SSH_PID)) return "/usr/bin/ssh";
  ${signalBehavior ? 'const waitingPath = environment.PORTWHISK_SSH_SESSION + "/waiting.json"; if (fm.fileExistsAtPath(waitingPath) && readJSON(waitingPath).child === pid) return "/usr/bin/osascript";' : ""}`,
  );
  const answerBoundary = /function answerAskpass\(prompt\) \{[\s\S]*?\n\}\n\nfunction run\(args\)/g;
  assert.equal([...isolated.matchAll(answerBoundary)].length, 1);
  isolated = isolated.replace(
    answerBoundary,
    `function answerAskpass(prompt) {
  const path = environment.PORTWHISK_SSH_SESSION;
  writeJSON(path + "/waiting.json", { child: $.getpid(), wrapper: $.getppid() });
  ${success ? `${success === true ? "$.usleep(300000); " : ""}stdout("fixture-response"); return;` : ""}
  ObjC.bindFunction("pause", ["int", []]);
  $.pause();
  fail(-75002);
}

function run(args)`,
  );
  const guardBoundary = "function watchAskpass(childPID) {";
  assert.equal(isolated.split(guardBoundary).length, 2);
  isolated = isolated.replace(
    guardBoundary,
    `${guardBoundary}
  writeJSON(environment.PORTWHISK_SSH_SESSION + "/guardian.json", { pid: $.getpid() });
  ${guardExit === undefined ? "" : `$.usleep(500000); $.exit(${guardExit});`}`,
  );
  writeFileSync(join(root, "system.js"), isolated);
  mkdirSync(join(root, "connections"), { mode: 0o700 });
  writeFileSync(
    join(root, "connections/records.json"),
    JSON.stringify([
      {
        id,
        name: "Cancellation fixture",
        host: "example.invalid",
        username: "fixture-user",
        port: 2222,
        credentialRef: id,
        status: "ready",
      },
    ]),
    { mode: 0o600 },
  );
  const prepared = spawnSync(helper, ["ssh-prepare", root], {
    input: JSON.stringify({ connectionId: id }),
    encoding: "utf8",
    timeout: 10000,
  });
  assert.equal(prepared.status, 0, prepared.stderr);
  const session = join(root, "sessions", JSON.parse(prepared.stdout).sessionId);
  if (signalBehavior) {
    // 替代认证入口的独立进程只验证信号与退出清理，不创建 TTY 或调用真实凭据。
    const signalChild = join(root, "signal-child.mjs");
    writeFileSync(
      signalChild,
      `import { writeFileSync } from "node:fs";
const session = process.env.PORTWHISK_SSH_SESSION;
process.on("SIGTERM", () => {
  writeFileSync(session + "/term.json", "true");
  ${signalBehavior === "cleanup" ? "setTimeout(() => process.exit(0), 100);" : ""}
});
process.on("exit", () => writeFileSync(session + "/cleanup.json", "true"));
writeFileSync(session + "/waiting.json", JSON.stringify({ child: process.pid, wrapper: process.ppid }));
setInterval(() => {}, 1000);
`,
    );
    const launch = '/usr/bin/osascript -l JavaScript "$script_dir/system.js" "$@" &';
    const helperSource = readFileSync(helper, "utf8");
    assert.equal(helperSource.split(launch).length, 2);
    const quote = (value) => `'${value.replaceAll("'", "'\\''")}'`;
    writeFileSync(
      helper,
      helperSource.replace(launch, `${quote(process.execPath)} ${quote(signalChild)} &`),
    );
  }
  const fixtureCode = `
import { spawn } from "node:child_process";
const child = spawn(process.argv[1], ["fixture-user@example.invalid's password: "], {
  env: { ...process.env, PORTWHISK_SSH_PID: String(process.pid), PORTWHISK_SSH_SESSION: process.argv[2] },
  stdio: ["ignore", "pipe", "pipe"],
});
child.stdout.pipe(process.stdout);
child.stderr.pipe(process.stderr);
// 即使 askpass 仅退出或返回 EOF，假 SSH 也继续存活，确保测试必须观察到主动终止。
setInterval(() => {}, 1000);
`;
  fake = spawn(process.execPath, ["--input-type=module", "-e", fixtureCode, helper, session], {
    stdio: ["ignore", "pipe", "pipe"],
  });
  owned.set(fake.pid, identity(fake.pid));
  let output = "";
  for (const stream of [fake.stdout, fake.stderr]) {
    stream.on("data", (chunk) => {
      output = (output + chunk.toString()).slice(-8192);
    });
  }
  fake.on("exit", (code, signal) => {
    outcome = { code, signal };
  });
  waiting = await waitFor(() => {
    assert.equal(outcome, undefined, output);
    const path = join(session, "waiting.json");
    return existsSync(path) && JSON.parse(readFileSync(path, "utf8"));
  }, "isolated askpass child");
  async function registerOwned(pid) {
    const expected = identity(pid);
    if (success && !expected?.includes(root)) {
      // 瞬时成功的 zombie 可已失去命令路径；确认退出后跳过，绝不登记为可终止目标。
      await waitFor(() => parentPID(pid) === null, "completed fixture process to disappear");
      return;
    }
    assert.ok(expected?.includes(root));
    owned.set(pid, expected);
  }
  for (const pid of [waiting.child, waiting.wrapper]) await registerOwned(pid);
  guardian = await waitFor(() => {
    const path = join(session, "guardian.json");
    return existsSync(path) && JSON.parse(readFileSync(path, "utf8")).pid;
  }, "askpass guardian");
  await registerOwned(guardian);
  assert.notEqual(fake.pid, process.pid);
  const wrapperParent = parentPID(waiting.wrapper);
  const childParent = parentPID(waiting.child);
  if (!success || wrapperParent) assert.equal(wrapperParent, fake.pid);
  if (!success || childParent) assert.equal(childParent, waiting.wrapper);
  return {
    cancel: (target, signal = "SIGTERM") =>
      process.kill(
        target === "ssh" ? fake.pid : target === "guardian" ? guardian : waiting[target],
        signal,
      ),
    async expectStopped(signal = "SIGKILL") {
      await waitFor(() => outcome, `bound fake SSH to stop (${output})`);
      assert.deepEqual(outcome, { code: null, signal }, output);
      await waitFor(
        () => [waiting.child, waiting.wrapper, guardian].every((pid) => parentPID(pid) === null),
        "askpass wrapper, child and guardian to exit",
      );
    },
    async expectSuccess() {
      await waitFor(
        () => [waiting.child, waiting.wrapper, guardian].every((pid) => parentPID(pid) === null),
        "successful askpass processes to exit",
      );
      assert.equal(outcome, undefined, output);
      // 子进程退出不代表转发管道的数据事件已到达，仍须等到完整原值才能判定成功。
      await waitFor(() => output === "fixture-response", "successful askpass response");
    },
    expectTerminationCleanup(completed) {
      assert.equal(existsSync(join(session, "term.json")), true, "child received SIGTERM");
      assert.equal(existsSync(join(session, "cleanup.json")), completed, "child exit cleanup");
    },
  };
}

test("askpass child cancellation actively kills its bound SSH instead of returning EOF", async (t) => {
  const state = await fixture(t);
  state.cancel("child");
  await state.expectStopped();
});

test("askpass wrapper cancellation actively kills its bound SSH", async (t) => {
  const state = await fixture(t);
  state.cancel("wrapper");
  await state.expectStopped();
});

test("askpass wrapper SIGKILL is detected by its guardian", async (t) => {
  const state = await fixture(t);
  state.cancel("wrapper", "SIGKILL");
  await state.expectStopped();
});

for (const signal of ["SIGTERM", "SIGKILL"]) {
  test(`parent SSH ${signal} also stops its blocked askpass processes`, async (t) => {
    const state = await fixture(t);
    state.cancel("ssh", signal);
    await state.expectStopped(signal);
  });
}

test("successful askpass completion keeps its bound SSH running", async (t) => {
  const state = await fixture(t, { success: true });
  await state.expectSuccess();
});

test("an immediately completed askpass does not leave its guardian waiting", async (t) => {
  const state = await fixture(t, { success: "immediate" });
  await state.expectSuccess();
});

test("guardian cancellation stops SSH and its blocked authentication child", async (t) => {
  const state = await fixture(t);
  state.cancel("guardian");
  await state.expectStopped();
});

for (const guardExit of [0, 1]) {
  test(`guardian unexpected exit ${guardExit} fails closed`, async (t) => {
    const state = await fixture(t, { guardExit });
    await state.expectStopped();
  });
}

test("askpass termination allows child signal cleanup before exiting", async (t) => {
  const state = await fixture(t, { signalBehavior: "cleanup" });
  state.cancel("ssh");
  await state.expectStopped("SIGTERM");
  state.expectTerminationCleanup(true);
});

test("askpass termination forcibly stops a child that ignores SIGTERM after a bounded wait", async (t) => {
  const state = await fixture(t, { signalBehavior: "ignore" });
  const started = Date.now();
  state.cancel("ssh");
  await state.expectStopped("SIGTERM");
  assert.ok(Date.now() - started >= 450, "SIGTERM grace interval was preserved");
  state.expectTerminationCleanup(false);
});
