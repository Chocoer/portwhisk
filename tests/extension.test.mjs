import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { EventEmitter } from "node:events";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync } from "node:fs";
import { createRequire } from "node:module";
import test, { after } from "node:test";
import { fileURLToPath } from "node:url";
import { runInNewContext } from "node:vm";
import { Window } from "happy-dom";
import React, { act, createContext, useContext, useState } from "react";

const window = new Window();
Object.assign(globalThis, {
  window,
  document: window.document,
  HTMLElement: window.HTMLElement,
  IS_REACT_ACT_ENVIRONMENT: true,
});
const { createRoot } = await import("react-dom/client");
const require = createRequire(import.meta.url);
const root = new URL("../", import.meta.url);
const manifest = JSON.parse(readFileSync(new URL("package.json", root), "utf8"));
const storageFile = "/controlled-extension/support/connections/records.json";
const terminalFile = "/controlled-extension/support/terminal.json";
const sessionId = "22222222-2222-4222-8222-222222222222";
const h = React.createElement;
const Navigation = createContext(null);
const valid = {
  name: "开发环境",
  host: "dev.example.com",
  username: "developer",
  port: "22",
  password: "  测试 ' \" \\ 密码  ",
};

// 只翻译宿主展示和导航，React 状态、表单提交、校验与存储流程运行真实实现。
function Container({ children, actions }) {
  return h("section", null, children, actions);
}
function Item({ title, subtitle, description, children, actions, error, text }) {
  return h("article", null, title, subtitle, description, text, error, children, actions);
}
function Field({ id, title, defaultValue, onChange, error, secret = false }) {
  return h(
    "label",
    null,
    title,
    h("input", {
      name: id,
      type: secret ? "password" : "text",
      defaultValue,
      onInput: (event) => onChange?.(event.currentTarget.value),
    }),
    error ? h("span", { role: "alert" }, error) : null,
  );
}
function Dropdown({ id, title, value, onChange, error, children }) {
  return h(
    "label",
    null,
    title,
    h("select", { name: id, value, onChange: (event) => onChange(event.target.value) }, children),
    error ? h("span", { role: "alert" }, error) : null,
  );
}
function Push({ title, target }) {
  const navigation = useContext(Navigation);
  return h("button", { onClick: () => navigation.push(target) }, title);
}
function Submit({ title, onSubmit }) {
  return h(
    "button",
    {
      type: "button",
      onClick: (event) => {
        const form = event.currentTarget.closest("form");
        if (form.querySelector('[role="alert"]')) return;
        const values = Object.fromEntries(
          Array.from(form.querySelectorAll("input, select"), (input) => [input.name, input.value]),
        );
        return onSubmit(values);
      },
    },
    title,
  );
}

function createHarness(options = {}) {
  const { assetsPath = "/controlled-extension/assets" } = options;
  const language = Object.hasOwn(options, "language") ? options.language : "zh-CN";
  const state = {
    storage: new Map(),
    credentials: new Map(),
    calls: [],
    toasts: [],
    writes: 0,
    failWriteAt: 0,
    failAdd: false,
    failDelete: false,
    holdAdd: false,
    confirm: true,
    terminalIds: ["com.apple.Terminal", "com.googlecode.iterm2"],
    failLaunch: false,
    holdLaunch: false,
    failDiscard: false,
    failEdit: false,
    pendingEdit: false,
    failConnectionDelete: false,
    failDeleteCommit: false,
    holdConfirm: false,
    holdEdit: false,
    confirmations: [],
  };
  let renderer;
  let container;
  let pop;

  // 只替换子进程边界；保留真实 stdin 序列化和异步完成时机，绝不访问真实钥匙串。
  function spawn(file, args, options) {
    const child = new EventEmitter();
    child.stdout = new EventEmitter();
    child.stderr = new EventEmitter();
    child.stdin = new EventEmitter();
    child.kill = () => true;
    if (file === "/usr/bin/osascript") {
      state.calls.push({ file, args, options });
      const finish = () => {
        if (state.failLaunch) child.stderr.emit("data", Buffer.from("private launch error"));
        child.emit("close", state.failLaunch ? 1 : 0);
      };
      if (state.holdLaunch) state.finishLaunch = finish;
      else queueMicrotask(finish);
      return child;
    }
    child.stdin.end = (input) => {
      state.calls.push({ file, args, options, input });
      const finish = () => {
        const [operation, id] = args;
        let status = 0;
        if (operation === "save") {
          assert.equal(id, "/controlled-extension/support/connections");
          const request = JSON.parse(input);
          const current = JSON.parse(state.storage.get(storageFile) ?? "[]");
          state.writes += 1;
          if (JSON.stringify(current) !== JSON.stringify(request.expected)) status = -70001;
          else if (state.writes === state.failWriteAt) status = -36;
          else state.storage.set(storageFile, JSON.stringify(request.connections));
        } else if (["edit-connection", "delete-connection"].includes(operation)) {
          assert.equal(id, "/controlled-extension/support/connections");
          const request = JSON.parse(input);
          const records = JSON.parse(state.storage.get(storageFile) ?? "[]");
          const index = records.findIndex((record) => record.id === request.expected.id);
          if (index < 0 || JSON.stringify(records[index]) !== JSON.stringify(request.expected)) {
            status = -70001;
          } else if (operation === "edit-connection") {
            if (state.pendingEdit) {
              records[index] = { ...records[index], status: "pending-edit" };
              status = -70002;
            } else if (state.failEdit) status = -128;
            else {
              records[index] = request.connection;
              if (Object.hasOwn(request, "password")) {
                state.credentials.set(request.expected.credentialRef, request.password);
              }
            }
            state.storage.set(storageFile, JSON.stringify(records));
          } else {
            records[index] = { ...records[index], status: "pending-delete" };
            if (state.failConnectionDelete || state.failDelete) status = -70003;
            else {
              state.credentials.delete(request.expected.credentialRef);
              if (state.failDeleteCommit) status = -70003;
              else records.splice(index, 1);
            }
            state.storage.set(storageFile, JSON.stringify(records));
          }
        } else if (operation === "add") {
          if (state.failAdd) status = -128;
          else state.credentials.set(id, JSON.parse(input).password);
        } else if (operation === "delete") {
          if (state.failDelete) status = -25308;
          else state.credentials.delete(id);
        } else if (operation === "terminal") {
          assert.equal(id, "/controlled-extension/support");
          state.storage.set(terminalFile, input);
        } else if (operation === "ssh-discard") {
          assert.equal(id, `/controlled-extension/support/sessions/${sessionId}`);
          if (state.failDiscard) status = -50;
        } else if (operation === "ssh-prepare") {
          assert.equal(id, "/controlled-extension/support");
          assert.ok(JSON.parse(input).connectionId);
        } else assert.equal(operation, "terminals");
        const result = { status };
        if (operation === "terminals") result.terminalIds = state.terminalIds;
        if (operation === "ssh-prepare") result.sessionId = sessionId;
        child.stdout.emit("data", Buffer.from(JSON.stringify(result)));
        child.emit("close", status === 0 ? 0 : 1);
      };
      if (args[0] === "edit-connection" && state.holdEdit) state.finishEdit = finish;
      else if (args[0] === "add" && state.holdAdd) state.finishAdd = finish;
      else queueMicrotask(finish);
    };
    return child;
  }

  function loadCommand(name) {
    const api = {
      Action: Object.assign(({ title, onAction }) => h("button", { onClick: onAction }, title), {
        Style: { Destructive: "destructive" },
        Push,
        SubmitForm: (props) => {
          state.submit = props.onSubmit;
          return h(Submit, props);
        },
      }),
      ActionPanel: Container,
      Alert: { ActionStyle: { Destructive: "destructive", Cancel: "cancel" } },
      List: Object.assign(Container, { Item, Section: Container, EmptyView: Item }),
      Form: Object.assign(
        ({ children, actions, enableDrafts }) => {
          assert.equal(enableDrafts, false, "密码表单不能开启草稿");
          return h("form", { onSubmit: (event) => event.preventDefault() }, children, actions);
        },
        {
          TextField: Field,
          PasswordField: (props) => h(Field, { ...props, secret: true }),
          Dropdown: Object.assign(Dropdown, {
            Item: ({ value, title }) => h("option", { value }, title),
          }),
          Description: Item,
        },
      ),
      Detail: Object.assign(Container, { Metadata: Object.assign(Container, { Label: Item }) }),
      Icon: { Terminal: "terminal", List: "list", Plus: "plus", Clock: "clock" },
      Keyboard: { Shortcut: { Common: { New: { modifiers: ["cmd"], key: "n" } } } },
      Toast: { Style: { Failure: "failure", Success: "success" } },
      getPreferenceValues: () => (language === undefined ? {} : { language }),
      environment: {
        assetsPath,
        supportPath: "/controlled-extension/support",
      },
      useNavigation: () => useContext(Navigation),
      showToast: async (options) => state.toasts.push(options),
      confirmAlert: (options) => {
        state.confirmations.push(options);
        return state.holdConfirm
          ? new Promise((resolve) => {
              state.finishConfirm = resolve;
            })
          : Promise.resolve(state.confirm);
      },
    };
    const module = { exports: {} };
    runInNewContext(readFileSync(new URL(`dist/${name}.js`, root), "utf8"), {
      module,
      exports: module.exports,
      Error,
      Buffer,
      require(specifier) {
        if (specifier === "@raycast/api") return api;
        if (["child_process", "node:child_process"].includes(specifier)) return { spawn };
        if (["fs/promises", "node:fs/promises"].includes(specifier)) {
          return {
            readFile: async (file) => {
              assert.ok([storageFile, terminalFile].includes(file));
              const stored = state.storage.get(file);
              if (stored === undefined) {
                const error = new Error("File not found");
                error.code = "ENOENT";
                throw error;
              }
              return stored;
            },
          };
        }
        if (
          [
            "react",
            "react/jsx-runtime",
            "buffer",
            "crypto",
            "path",
            "node:buffer",
            "node:crypto",
            "node:path",
          ].includes(specifier)
        ) {
          return require(specifier);
        }
        assert.fail(`生产包包含未预期依赖：${specifier}`);
      },
    });
    assert.equal(typeof module.exports.default, "function");
    return module.exports.default;
  }

  function Shell({ command }) {
    const [stack, setStack] = useState([h(command)]);
    pop = () => setStack((current) => current.slice(0, -1));
    return h(
      Navigation.Provider,
      { value: { push: (target) => setStack((current) => [...current, target]), pop } },
      stack.length > 1
        ? h("button", { onClick: pop }, language === "zh-CN" ? "返回" : "Back")
        : null,
      stack.at(-1),
    );
  }

  async function mount(name = "manage-connections") {
    if (renderer) await act(async () => renderer.unmount());
    container?.remove();
    container = window.document.createElement("div");
    window.document.body.append(container);
    renderer = createRoot(container);
    const command = loadCommand(name);
    await act(async () => renderer.render(h(Shell, { command })));
  }
  async function click(title) {
    const button = Array.from(container.querySelectorAll("button")).find(
      (item) => item.textContent === title,
    );
    assert.ok(button, `应存在操作：${title}`);
    await act(async () => {
      button.click();
      await new Promise(setImmediate);
    });
  }
  async function fill(values) {
    await act(async () => {
      for (const [name, value] of Object.entries(values)) {
        const input = container.querySelector(`[name="${name}"]`);
        assert.ok(input, `应存在表单字段：${name}`);
        input.value = value;
        input.dispatchEvent(
          new window.Event(input.tagName === "SELECT" ? "change" : "input", { bubbles: true }),
        );
      }
    });
  }
  return {
    state,
    mount,
    click,
    fill,
    text: () => container.textContent,
    hasAction: (title) =>
      Array.from(container.querySelectorAll("button")).some((item) => item.textContent === title),
    terminalOptions: () =>
      Array.from(container.querySelectorAll("select option"), (item) => item.value),
    field: (name) => container.querySelector(`[name="${name}"]`)?.value,
    records: () => JSON.parse(state.storage.get(storageFile) ?? "[]"),
    dispose: async () => {
      if (renderer) await act(async () => renderer.unmount());
      container?.remove();
    },
  };
}

after(() => window.happyDOM.close());

async function withHarness(fn, options = {}) {
  const harness = createHarness(options);
  try {
    await harness.mount();
    await fn(harness);
  } finally {
    await harness.dispose();
  }
}

async function openFilledForm(harness, overrides = {}) {
  await harness.click("添加连接");
  await harness.fill({ ...valid, ...overrides });
}

async function showSavedConnection(harness, status = "ready") {
  const id = "11111111-1111-4111-8111-111111111111";
  harness.state.storage.set(
    storageFile,
    JSON.stringify([
      {
        id,
        name: valid.name,
        host: valid.host,
        username: valid.username,
        port: 22,
        credentialRef: id,
        status,
      },
    ]),
  );
  harness.state.credentials.set(id, valid.password);
  await harness.mount("connect");
  return id;
}

test("导入包包含全部声明命令、图标及与源码一致的系统脚本", () => {
  const built = JSON.parse(readFileSync(new URL("dist/package.json", root), "utf8"));
  assert.deepEqual(built.commands, manifest.commands);
  assert.deepEqual(built.preferences, manifest.preferences);
  const language = built.preferences.find((preference) => preference.name === "language");
  assert.equal(language.type, "dropdown");
  assert.equal(language.default, "en");
  assert.ok(language.data.some((option) => option.value === "zh-CN"));
  for (const command of built.commands) {
    assert.ok(readFileSync(new URL(`dist/${command.name}.js`, root)).length);
  }
  const icon = readFileSync(new URL(`dist/assets/${built.icon}`, root));
  assert.equal(icon.readUInt32BE(16), 512);
  const helper = fileURLToPath(new URL("dist/assets/keychain-helper", root));
  assert.ok(readFileSync(helper, "utf8").startsWith("#!/bin/sh\n"));
  assert.ok(statSync(helper).mode & 0o111);
  for (const name of ["keychain-helper", "system.js", "system-core.js"]) {
    assert.deepEqual(
      readFileSync(new URL(`dist/assets/${name}`, root)),
      readFileSync(new URL(`assets/${name}`, root)),
    );
  }
});

test("系统脚本写入真实元数据，拒绝额外密码字段且保留快照保护", () => {
  mkdirSync(new URL("build/", root), { recursive: true });
  const directory = mkdtempSync(new URL("build/metadata-test-", root));
  const helper = fileURLToPath(new URL("dist/assets/keychain-helper", root));
  const record = {
    id: "11111111-1111-4111-8111-111111111111",
    name: "script test",
    host: "example.com",
    username: "test",
    port: 22,
    credentialRef: "11111111-1111-4111-8111-111111111111",
    status: "pending",
  };
  try {
    const path = `${directory}/records.json`;
    const unknown = spawnSync(helper, ["save", directory], {
      input: JSON.stringify({
        expected: [],
        connections: [{ ...record, password: "fixture-must-not-persist" }],
      }),
      encoding: "utf8",
    });
    assert.notEqual(unknown.status, 0);
    assert.equal(existsSync(path), false, "拒绝未知字段时不得创建连接记录");
    const saved = spawnSync(helper, ["save", directory], {
      input: JSON.stringify({ expected: [], connections: [record] }),
      encoding: "utf8",
    });
    assert.equal(saved.status, 0);
    const original = readFileSync(path, "utf8");
    assert.equal(JSON.parse(original)[0].password, undefined);
    const stale = spawnSync(helper, ["save", directory], {
      input: JSON.stringify({ expected: [], connections: [] }),
      encoding: "utf8",
    });
    assert.notEqual(stale.status, 0);
    assert.equal(JSON.parse(stale.stdout).status, -70001);
    assert.equal(readFileSync(path, "utf8"), original);
    const invalid = spawnSync(helper, ["save", directory], {
      input: "not-json",
      encoding: "utf8",
    });
    assert.notEqual(invalid.status, 0);
    assert.equal(readFileSync(path, "utf8"), original);
    const failed = spawnSync(helper, ["save", "/dev/null/invalid-directory"], {
      input: JSON.stringify({ expected: [], connections: [] }),
      encoding: "utf8",
    });
    assert.notEqual(failed.status, 0);
  } finally {
    rmSync(directory, { recursive: true });
  }
});

test("两个命令首次打开均有直接可见的添加入口，表单取消无副作用", async () => {
  await withHarness(async (harness) => {
    for (const name of ["manage-connections", "connect"]) {
      await harness.mount(name);
      await harness.click("添加连接");
      await harness.fill(valid);
      await harness.click("返回");
      assert.equal(harness.state.calls.length, 0);
      assert.equal(harness.state.writes, 0);
    }
  });
});

test("新增保留密码原值，只经 stdin 发送，重新打开两个命令均能看到连接", async () => {
  await withHarness(async (harness) => {
    await openFilledForm(harness, { name: " 开发环境 ", port: "" });
    await harness.click("保存连接");
    assert.match(harness.text(), /开发环境/);
    const [record] = harness.records();
    assert.equal(record.status, "ready");
    assert.equal(record.port, 22);
    assert.equal(record.credentialRef, record.id);
    assert.equal(harness.state.credentials.get(record.id), valid.password);
    assert.deepEqual(Object.keys(record).sort(), [
      "credentialRef",
      "host",
      "id",
      "name",
      "port",
      "status",
      "username",
    ]);
    const call = harness.state.calls.find((item) => item.args[0] === "add");
    assert.equal(call.file, "/controlled-extension/assets/keychain-helper");
    assert.deepEqual(Array.from(call.args), ["add", record.id]);
    assert.equal(JSON.parse(call.input).password, valid.password);
    assert.ok(!JSON.stringify([call.file, call.args, call.options]).includes(valid.password));
    assert.ok(!JSON.stringify([...harness.state.storage.values()]).includes(valid.password));
    assert.ok(!JSON.stringify(harness.state.toasts).includes(valid.password));
    for (const command of ["connect", "manage-connections"]) {
      await harness.mount(command);
      assert.match(harness.text(), /开发环境/);
      assert.match(harness.text(), /developer@dev.example.com:22/);
    }
  });
});

for (const invalid of [
  { name: "", expected: /请输入连接名称/ },
  { host: "-oProxyCommand=touch /tmp/x", expected: /请输入主机名/ },
  { host: "user@example.com:22", expected: /请输入主机名/ },
  { host: "999.1.1.1", expected: /请输入主机名/ },
  { username: " ", expected: /请输入用户名/ },
  { port: "65536", expected: /端口必须/ },
  { port: "1.5", expected: /端口必须/ },
  { password: "", expected: /请输入密码/ },
]) {
  test(`非法字段保存前被拒绝：${Object.keys(invalid)[0]}`, async () => {
    await withHarness(async (harness) => {
      const { expected, ...fields } = invalid;
      await openFilledForm(harness, fields);
      await harness.click("保存连接");
      assert.match(harness.text(), expected);
      assert.equal(harness.state.calls.length, 0);
      assert.equal(harness.state.writes, 0);
      await harness.fill(valid);
      await harness.click("保存连接");
      assert.equal(harness.records().length, 1, "修正后应可再次提交");
    });
  });
}

test("宿主提交包含换行的密码时明确拒绝，不依赖单行输入框的自动处理", async () => {
  await withHarness(async (harness) => {
    await openFilledForm(harness);
    await act(async () => harness.state.submit({ ...valid, password: "test\nsecret" }));
    assert.match(harness.text(), /不能包含 NUL 或换行/);
    assert.equal(harness.state.calls.length, 0);
    assert.equal(harness.state.writes, 0);
  });
});

test("支持 IPv6 和端口上界，不执行远端探测", async () => {
  await withHarness(async (harness) => {
    await openFilledForm(harness, { host: "2001:db8::1", port: "65535" });
    await harness.click("保存连接");
    assert.equal(harness.records()[0].host, "2001:db8::1");
    assert.equal(harness.records()[0].port, 65535);
    assert.equal(harness.state.calls.filter((item) => item.args[0] === "add").length, 1);
  });
});

test("钥匙串拒绝时撤回新增，不把失败显示为保存成功", async () => {
  await withHarness(async (harness) => {
    harness.state.failAdd = true;
    await openFilledForm(harness);
    await harness.click("保存连接");
    assert.deepEqual(harness.records(), []);
    assert.equal(harness.state.credentials.size, 0);
    assert.ok(harness.state.toasts.some((item) => item.title === "连接未保存"));
    assert.ok(!harness.state.toasts.some((item) => item.title === "连接已保存"));
  });
});

test("首次配置写入失败时不尝试保存密码", async () => {
  await withHarness(async (harness) => {
    harness.state.failWriteAt = 1;
    await openFilledForm(harness);
    await harness.click("保存连接");
    assert.ok(!harness.state.calls.some((item) => item.args[0] === "add"));
    assert.deepEqual(harness.records(), []);
  });
});

test("最终配置写入失败时清理已保存密码与待完成记录", async () => {
  await withHarness(async (harness) => {
    harness.state.failWriteAt = 2;
    await openFilledForm(harness);
    await harness.click("保存连接");
    assert.equal(harness.state.credentials.size, 0);
    assert.deepEqual(harness.records(), []);
  });
});

test("补偿失败保留可追踪记录，取消清理不改变数据，确认后可重试", async () => {
  await withHarness(async (harness) => {
    harness.state.failWriteAt = 2;
    harness.state.failDelete = true;
    await openFilledForm(harness);
    await harness.click("保存连接");
    assert.equal(harness.records()[0].status, "pending");
    await harness.click("返回");
    harness.state.confirm = false;
    const before = harness.state.calls.length;
    await harness.click("清理未完成记录");
    assert.equal(harness.state.calls.length, before);
    assert.equal(harness.records().length, 1);
    harness.state.confirm = true;
    harness.state.failDelete = false;
    await harness.click("清理未完成记录");
    assert.deepEqual(harness.records(), []);
    assert.equal(harness.state.credentials.size, 0);
  });
});

test("连续提交在首次保存完成前只写入一次", async () => {
  await withHarness(async (harness) => {
    harness.state.holdAdd = true;
    await openFilledForm(harness);
    await harness.click("保存连接");
    await harness.click("保存连接");
    assert.equal(harness.state.calls.filter((item) => item.args[0] === "add").length, 1);
    await act(async () => {
      harness.state.finishAdd();
      await new Promise(setImmediate);
    });
    assert.equal(harness.records().length, 1);
    assert.equal(harness.records()[0].status, "ready");
  });
});

test("损坏存储明确报错并保持原值，不被后续新增覆盖", async () => {
  await withHarness(async (harness) => {
    harness.state.storage.set(storageFile, "not-json");
    await harness.mount();
    assert.match(harness.text(), /无法读取连接/);
    assert.match(harness.text(), /存储已损坏/);
    assert.equal(harness.state.storage.get(storageFile), "not-json");
    assert.equal(harness.state.calls.length, 0);
  });
});

test("终端设置只列已安装候选，保存后重新打开仍使用所选终端", async () => {
  await withHarness(async (harness) => {
    harness.state.terminalIds = ["com.apple.Terminal", "com.googlecode.iterm2", "arbitrary.app"];
    await harness.mount("terminal-settings");
    assert.deepEqual(harness.terminalOptions(), [
      "",
      "com.apple.Terminal",
      "com.googlecode.iterm2",
    ]);
    await harness.fill({ terminalId: "com.googlecode.iterm2" });
    await harness.click("保存终端设置");
    assert.deepEqual(JSON.parse(harness.state.storage.get(terminalFile)), {
      terminalId: "com.googlecode.iterm2",
    });
    assert.ok(harness.state.toasts.some((item) => item.title === "终端设置已保存"));
    await harness.mount("terminal-settings");
    await harness.click("保存终端设置");
    assert.equal(
      JSON.parse(harness.state.storage.get(terminalFile)).terminalId,
      "com.googlecode.iterm2",
    );
    await showSavedConnection(harness);
    await harness.click("连接服务器");
    const launch = harness.state.calls.find((call) => call.file === "/usr/bin/osascript");
    assert.match(launch.args[1], /com\.googlecode\.iterm2/);
    assert.match(launch.args[1], /create window with default profile command/);
  });
});

test("iTerm2 先跳过默认启动行为，再创建一个独立连接窗口并激活", async () => {
  await withHarness(async (harness) => {
    harness.state.storage.set(
      terminalFile,
      JSON.stringify({ terminalId: "com.googlecode.iterm2" }),
    );
    await showSavedConnection(harness);
    await harness.click("连接服务器");
    const launches = harness.state.calls.filter((call) => call.file === "/usr/bin/osascript");
    assert.equal(launches.length, 1);
    // 检查实际交接脚本的系统命令契约；不把模拟边界当作真实窗口数量证据。
    const commands = launches[0].args[1]
      .split("\n")
      .map((line) => line.trim())
      .filter((line) => line && !line.startsWith("--"));
    assert.deepEqual(commands, [
      "on run argv",
      'tell application id "com.googlecode.iterm2"',
      "launch",
      "create window with default profile command (item 1 of argv)",
      "activate",
      "end tell",
      "end run",
    ]);
    assert.equal(
      launches[0].args[2],
      `'/controlled-extension/assets/keychain-helper' 'ssh-start' '/controlled-extension/support/sessions/${sessionId}'`,
    );
  });
});

test("设置中缺失的候选不会出现，终端全部不可用时不给出保存操作", async () => {
  await withHarness(async (harness) => {
    harness.state.terminalIds = ["com.apple.Terminal"];
    await harness.click("终端设置");
    assert.deepEqual(harness.terminalOptions(), ["", "com.apple.Terminal"]);
    await harness.click("返回");
    harness.state.terminalIds = ["arbitrary.app"];
    await harness.click("终端设置");
    assert.deepEqual(harness.terminalOptions(), [""]);
    assert.match(harness.text(), /没有可用终端/);
    assert.equal(harness.hasAction("保存终端设置"), false);
  });
});

test("已保存终端被卸载时明确拒绝连接，不静默换用 Terminal", async () => {
  await withHarness(async (harness) => {
    harness.state.storage.set(
      terminalFile,
      JSON.stringify({ terminalId: "com.googlecode.iterm2" }),
    );
    harness.state.terminalIds = ["com.apple.Terminal"];
    await showSavedConnection(harness);
    await harness.click("连接服务器");
    assert.ok(
      harness.state.toasts.some(
        (item) => item.title === "SSH 启动未完成" && /所选终端未安装/.test(item.message),
      ),
    );
    assert.equal(
      harness.state.calls.some(
        (call) => call.args[0] === "ssh-prepare" || call.file === "/usr/bin/osascript",
      ),
      false,
    );
    assert.equal(
      JSON.parse(harness.state.storage.get(terminalFile)).terminalId,
      "com.googlecode.iterm2",
    );
    await harness.click("终端设置");
    assert.match(harness.text(), /所选终端未安装/);
    await harness.fill({ terminalId: "com.apple.Terminal" });
    await harness.click("保存终端设置");
    assert.equal(
      JSON.parse(harness.state.storage.get(terminalFile)).terminalId,
      "com.apple.Terminal",
    );
  });
});

test("已有终端设置损坏时保留原值并拒绝连接，允许用户主动修正", async () => {
  await withHarness(async (harness) => {
    harness.state.storage.set(terminalFile, "not-json");
    await showSavedConnection(harness);
    await harness.click("连接服务器");
    assert.ok(harness.state.toasts.some((item) => /保存的终端设置无效/.test(item.message)));
    assert.equal(harness.state.storage.get(terminalFile), "not-json");
    assert.equal(
      harness.state.calls.some((call) => call.file === "/usr/bin/osascript"),
      false,
    );
    await harness.click("终端设置");
    await harness.fill({ terminalId: "com.apple.Terminal" });
    await harness.click("保存终端设置");
    assert.equal(
      JSON.parse(harness.state.storage.get(terminalFile)).terminalId,
      "com.apple.Terminal",
    );
  });
});

test("ready 连接只交接选定记录和会话入口，不读取或暴露保存密码，不报告已登录", async () => {
  await withHarness(async (harness) => {
    const id = await showSavedConnection(harness);
    await harness.click("连接服务器");
    const prepare = harness.state.calls.find((call) => call.args[0] === "ssh-prepare");
    assert.deepEqual(JSON.parse(prepare.input), { connectionId: id });
    const launch = harness.state.calls.find((call) => call.file === "/usr/bin/osascript");
    assert.match(launch.args[1], /com\.apple\.Terminal/);
    assert.match(launch.args[1], /do script \(item 1 of argv\)/);
    assert.equal(
      launch.args[2],
      `'/controlled-extension/assets/keychain-helper' 'ssh-start' '/controlled-extension/support/sessions/${sessionId}'`,
    );
    assert.ok(harness.state.toasts.some((item) => item.title === "已交给终端启动"));
    assert.equal(
      harness.state.toasts.some((item) => /已登录/.test(item.title)),
      false,
    );
    assert.equal(
      harness.state.calls.some((call) =>
        ["add", "delete", "get", "ssh-discard"].includes(call.args[0]),
      ),
      false,
    );
    assert.ok(
      !JSON.stringify([harness.state.calls, harness.state.toasts]).includes(valid.password),
    );
    assert.ok(!JSON.stringify(launch).includes(valid.host));
    assert.equal(harness.state.credentials.get(id), valid.password);
  });
});

test("pending 记录没有连接操作，不能创建 SSH 会话", async () => {
  await withHarness(async (harness) => {
    await showSavedConnection(harness, "pending");
    assert.equal(harness.hasAction("连接服务器"), false);
    assert.equal(harness.hasAction("清理未完成记录"), true);
    assert.equal(harness.state.calls.length, 0);
  });
});

test("终端启动失败时清理本次会话，保留连接与凭据并可重试", async () => {
  await withHarness(async (harness) => {
    const id = await showSavedConnection(harness);
    const original = harness.state.storage.get(storageFile);
    harness.state.failLaunch = true;
    await harness.click("连接服务器");
    assert.equal(harness.state.calls.filter((call) => call.args[0] === "ssh-discard").length, 1);
    assert.ok(
      harness.state.toasts.some(
        (item) => item.title === "SSH 启动未完成" && /自动化授权/.test(item.message),
      ),
    );
    assert.ok(!JSON.stringify(harness.state.toasts).includes("private launch error"));
    assert.equal(harness.state.storage.get(storageFile), original);
    assert.equal(harness.state.credentials.get(id), valid.password);
    harness.state.failLaunch = false;
    await harness.click("连接服务器");
    assert.ok(harness.state.toasts.some((item) => item.title === "已交给终端启动"));
  });
});

test("终端启动后的资源清理失败有明确提示", async () => {
  await withHarness(async (harness) => {
    await showSavedConnection(harness);
    harness.state.failLaunch = true;
    harness.state.failDiscard = true;
    await harness.click("连接服务器");
    assert.ok(harness.state.toasts.some((item) => /本次启动资源清理失败/.test(item.message)));
  });
});

test("同一连接启动中重复执行只交接一次，完成后可再次连接", async () => {
  await withHarness(async (harness) => {
    await showSavedConnection(harness);
    harness.state.holdLaunch = true;
    await harness.click("连接服务器");
    await harness.click("连接服务器");
    assert.equal(harness.state.calls.filter((call) => call.args[0] === "ssh-prepare").length, 1);
    assert.equal(
      harness.state.calls.filter((call) => call.file === "/usr/bin/osascript").length,
      1,
    );
    await act(async () => {
      harness.state.finishLaunch();
      await new Promise(setImmediate);
    });
    harness.state.holdLaunch = false;
    await harness.click("连接服务器");
    assert.equal(
      harness.state.calls.filter((call) => call.file === "/usr/bin/osascript").length,
      2,
    );
  });
});

test("扩展路径中的单引号通过 shell 字面量传递，不改变静态 AppleScript", async () => {
  const harness = createHarness({ assetsPath: "/controlled-extension/user's assets" });
  try {
    await showSavedConnection(harness);
    await harness.click("连接服务器");
    const launch = harness.state.calls.find((call) => call.file === "/usr/bin/osascript");
    assert.equal(
      launch.args[2],
      `'/controlled-extension/user'\\''s assets/keychain-helper' 'ssh-start' '/controlled-extension/support/sessions/${sessionId}'`,
    );
    assert.ok(!launch.args[1].includes("user's assets"));
  } finally {
    await harness.dispose();
  }
});

test("1023 字节 UTF-8 密码可无损保存，超出边界拒绝", async () => {
  await withHarness(async (harness) => {
    const password = "密".repeat(341);
    await openFilledForm(harness, { password: `${password}a` });
    await harness.click("保存连接");
    assert.match(harness.text(), /最多支持 1023 字节/);
    assert.equal(harness.state.calls.length, 0);
    await harness.fill({ password });
    await harness.click("保存连接");
    assert.equal(harness.state.credentials.get(harness.records()[0].id), password);
  });
});

test("编辑预填普通字段且默认保留密码，改名改目标后引用和凭据稳定", async () => {
  await withHarness(async (harness) => {
    const id = await showSavedConnection(harness);
    const otherId = "33333333-3333-4333-8333-333333333333";
    const other = { ...harness.records()[0], id: otherId, credentialRef: otherId };
    harness.state.storage.set(storageFile, JSON.stringify([...harness.records(), other]));
    harness.state.credentials.set(otherId, "other secret");
    await harness.mount();
    await harness.click("编辑连接");
    for (const field of ["name", "host", "username", "port"]) {
      assert.equal(harness.field(field), valid[field]);
    }
    assert.equal(harness.field("passwordMode"), "keep");
    assert.equal(harness.field("password"), undefined, "不得回填保存的密码");
    await harness.fill({ name: "生产环境", host: "new.example.com", port: "2222" });
    await harness.click("保存连接");
    const [record] = harness.records();
    assert.equal(record.name, "生产环境");
    assert.equal(record.host, "new.example.com");
    assert.equal(record.port, 2222);
    assert.equal(record.id, id);
    assert.equal(record.credentialRef, id);
    assert.equal(harness.state.credentials.get(id), valid.password);
    assert.deepEqual(harness.records()[1], other);
    assert.equal(harness.state.credentials.get(otherId), "other secret");
    const edit = harness.state.calls.find((call) => call.args[0] === "edit-connection");
    assert.equal(Object.hasOwn(JSON.parse(edit.input), "password"), false);
    assert.equal(harness.state.calls.length, 1, "编辑不读取密码、不启动终端或探测服务器");
    for (const name of ["connect", "manage-connections"]) {
      await harness.mount(name);
      assert.match(harness.text(), /生产环境/);
      assert.match(harness.text(), /developer@new.example.com:2222/);
    }
  });
});

test("编辑保存完成前重复提交只执行一次系统事务", async () => {
  await withHarness(async (harness) => {
    await showSavedConnection(harness);
    harness.state.holdEdit = true;
    await harness.click("编辑连接");
    await harness.fill({ name: "重复提交检查" });
    await harness.click("保存连接");
    await harness.click("保存连接");
    assert.equal(
      harness.state.calls.filter((call) => call.args[0] === "edit-connection").length,
      1,
    );
    await act(async () => {
      harness.state.finishEdit();
      await new Promise(setImmediate);
    });
    assert.equal(harness.records()[0].name, "重复提交检查");
    assert.ok(harness.state.toasts.some((item) => item.title === "连接已保存"));
  });
});

test("显式替换密码保留特殊字符原值，只经 stdin 到达受控系统边界", async () => {
  await withHarness(async (harness) => {
    const id = await showSavedConnection(harness);
    await harness.click("编辑连接");
    await harness.fill({ passwordMode: "replace" });
    assert.equal(harness.field("password"), "");
    const password = "  新 ' \" \\ 🔑 密码  ";
    await harness.fill({ password });
    await harness.click("保存连接");
    const [record] = harness.records();
    assert.equal(record.id, id);
    assert.equal(record.credentialRef, id);
    assert.equal(record.status, "ready");
    assert.equal(harness.state.credentials.get(id), password);
    const edit = harness.state.calls.find((call) => call.args[0] === "edit-connection");
    assert.equal(JSON.parse(edit.input).password, password);
    assert.ok(!JSON.stringify([edit.file, edit.args, edit.options]).includes(password));
    assert.ok(!JSON.stringify([...harness.state.storage.values()]).includes(password));
    assert.ok(!JSON.stringify(harness.state.toasts).includes(password));
  });
});

test("选择替换却留空时不隐式清空密码，修正后可保存", async () => {
  await withHarness(async (harness) => {
    const id = await showSavedConnection(harness);
    await harness.click("编辑连接");
    await harness.fill({ passwordMode: "replace" });
    await harness.click("保存连接");
    assert.match(harness.text(), /请输入密码/);
    assert.equal(harness.state.calls.length, 0);
    assert.equal(harness.state.credentials.get(id), valid.password);
    await harness.fill({ password: "replacement" });
    await harness.click("保存连接");
    assert.equal(harness.state.credentials.get(id), "replacement");
  });
});

test("输入替换密码后改回保留不会提交已输入秘密，取消编辑无副作用", async () => {
  await withHarness(async (harness) => {
    const id = await showSavedConnection(harness);
    const original = harness.state.storage.get(storageFile);
    await harness.click("编辑连接");
    await harness.fill({ passwordMode: "replace" });
    await harness.fill({ password: "discarded secret", name: "未提交修改" });
    await harness.click("返回");
    assert.equal(harness.state.calls.length, 0);
    assert.equal(harness.state.storage.get(storageFile), original);
    assert.equal(harness.state.credentials.get(id), valid.password);
    await harness.click("编辑连接");
    await harness.fill({ passwordMode: "replace" });
    await harness.fill({ password: "discarded secret" });
    await harness.fill({ passwordMode: "keep" });
    assert.equal(harness.field("password"), undefined);
    await harness.click("保存连接");
    const edit = harness.state.calls.find((call) => call.args[0] === "edit-connection");
    assert.equal(Object.hasOwn(JSON.parse(edit.input), "password"), false);
    assert.equal(harness.state.credentials.get(id), valid.password);
    assert.equal(harness.state.storage.get(storageFile), original);
  });
});

test("钥匙串拒绝编辑时保留旧字段和密码，失败表单要求重新打开", async () => {
  await withHarness(async (harness) => {
    const id = await showSavedConnection(harness);
    const original = harness.state.storage.get(storageFile);
    harness.state.failEdit = true;
    await harness.click("编辑连接");
    await harness.fill({ name: "不能提交的名称", passwordMode: "replace" });
    await harness.fill({ password: "replacement" });
    await harness.click("保存连接");
    assert.equal(harness.state.storage.get(storageFile), original);
    assert.equal(harness.state.credentials.get(id), valid.password);
    assert.ok(harness.state.toasts.some((item) => item.title === "连接未保存"));
    assert.ok(!harness.state.toasts.some((item) => item.title === "连接已保存"));
    assert.equal(harness.hasAction("保存连接"), false);
    await harness.click("返回连接列表");
    assert.match(harness.text(), /开发环境/);
    assert.equal(harness.hasAction("编辑连接"), true);
  });
});

test("编辑补偿未完成时停用连接，修复必须替换密码，成功后恢复可连接状态", async () => {
  await withHarness(async (harness) => {
    const id = await showSavedConnection(harness);
    harness.state.pendingEdit = true;
    await harness.click("编辑连接");
    await harness.fill({ host: "uncommitted.example.com", passwordMode: "replace" });
    await harness.fill({ password: "replacement" });
    await harness.click("保存连接");
    assert.equal(harness.records()[0].status, "pending-edit");
    assert.equal(harness.records()[0].host, valid.host);
    await harness.click("返回连接列表");
    assert.equal(harness.hasAction("连接服务器"), false);
    assert.equal(harness.hasAction("编辑连接"), false);
    await harness.click("修复连接");
    assert.deepEqual(harness.terminalOptions(), ["replace"]);
    assert.equal(harness.field("password"), "");
    await harness.click("保存连接");
    assert.match(harness.text(), /请输入密码/);
    harness.state.pendingEdit = false;
    await harness.fill({ password: "repaired password" });
    await harness.click("保存连接");
    assert.equal(harness.records()[0].status, "ready");
    assert.equal(harness.state.credentials.get(id), "repaired password");
    assert.equal(harness.hasAction("连接服务器"), true);
  });
});

test("正常删除确认展示名称和具体目标，同步删除对应凭据并保留其他连接", async () => {
  await withHarness(async (harness) => {
    const id = await showSavedConnection(harness);
    const secondId = "33333333-3333-4333-8333-333333333333";
    const second = {
      ...harness.records()[0],
      id: secondId,
      credentialRef: secondId,
      name: "另一连接",
    };
    harness.state.storage.set(storageFile, JSON.stringify([...harness.records(), second]));
    harness.state.credentials.set(secondId, "other credential");
    await harness.mount();
    await harness.click("删除连接");
    assert.equal(harness.state.confirmations.length, 1);
    assert.match(harness.state.confirmations[0].title, /开发环境/);
    assert.match(harness.state.confirmations[0].message, /developer@dev.example.com:22/);
    assert.equal(harness.state.confirmations[0].primaryAction.style, "destructive");
    assert.deepEqual(harness.records(), [second]);
    assert.equal(harness.state.credentials.has(id), false);
    assert.equal(harness.state.credentials.get(secondId), "other credential");
    assert.ok(harness.state.toasts.some((item) => item.title === "连接及密码已删除"));
    assert.equal(
      harness.state.calls.filter((call) => call.args[0] === "delete-connection").length,
      1,
    );
    assert.equal(harness.state.calls.length, 1);
  });
});

test("取消删除不调用系统辅助程序，不改变记录与凭据", async () => {
  await withHarness(async (harness) => {
    const id = await showSavedConnection(harness);
    const original = harness.state.storage.get(storageFile);
    harness.state.confirm = false;
    await harness.click("删除连接");
    assert.equal(harness.state.calls.length, 0);
    assert.equal(harness.state.storage.get(storageFile), original);
    assert.equal(harness.state.credentials.get(id), valid.password);
    assert.equal(harness.state.toasts.length, 0);
  });
});

for (const failedStage of ["failConnectionDelete", "failDeleteCommit"]) {
  test(`删除失败保留可定位的停用记录，可重试完成：${failedStage}`, async () => {
    await withHarness(async (harness) => {
      const id = await showSavedConnection(harness);
      harness.state[failedStage] = true;
      await harness.click("删除连接");
      assert.equal(harness.records()[0].id, id);
      assert.equal(harness.records()[0].credentialRef, id);
      assert.equal(harness.records()[0].status, "pending-delete");
      assert.equal(harness.state.credentials.has(id), failedStage === "failConnectionDelete");
      assert.equal(harness.hasAction("连接服务器"), false);
      assert.equal(harness.hasAction("编辑连接"), false);
      assert.equal(harness.hasAction("重试删除"), true);
      assert.ok(harness.state.toasts.some((item) => item.title === "连接未删除"));
      assert.ok(!harness.state.toasts.some((item) => item.title === "连接及密码已删除"));
      harness.state[failedStage] = false;
      await harness.click("重试删除");
      assert.deepEqual(harness.records(), []);
      assert.equal(harness.state.credentials.has(id), false);
      assert.ok(harness.state.toasts.some((item) => item.title === "连接及密码已删除"));
    });
  });
}

test("删除确认未完成时重复执行只弹一次确认且只提交一次操作", async () => {
  await withHarness(async (harness) => {
    await showSavedConnection(harness);
    harness.state.holdConfirm = true;
    await harness.click("删除连接");
    await harness.click("删除连接");
    assert.equal(harness.state.confirmations.length, 1);
    assert.equal(harness.state.calls.length, 0);
    await act(async () => {
      harness.state.finishConfirm(true);
      await new Promise(setImmediate);
    });
    assert.equal(
      harness.state.calls.filter((call) => call.args[0] === "delete-connection").length,
      1,
    );
    assert.deepEqual(harness.records(), []);
  });
});

test("过时编辑快照明确拒绝，不覆盖其他操作更新的目标和密码", async () => {
  await withHarness(async (harness) => {
    const id = await showSavedConnection(harness);
    await harness.click("编辑连接");
    await harness.fill({ name: "过时编辑" });
    const changed = { ...harness.records()[0], host: "concurrent.example.com" };
    harness.state.storage.set(storageFile, JSON.stringify([changed]));
    await harness.click("保存连接");
    assert.deepEqual(harness.records(), [changed]);
    assert.equal(harness.state.credentials.get(id), valid.password);
    assert.ok(harness.state.toasts.some((item) => /其他操作修改/.test(item.message)));
    assert.ok(!harness.state.toasts.some((item) => item.title === "连接已保存"));
    await harness.click("返回连接列表");
    assert.match(harness.text(), /concurrent.example.com/);
  });
});

test("删除确认期间目标已变化时拒绝旧快照，不删除新目标的凭据", async () => {
  await withHarness(async (harness) => {
    const id = await showSavedConnection(harness);
    harness.state.holdConfirm = true;
    await harness.click("删除连接");
    const changed = { ...harness.records()[0], username: "changed-user" };
    harness.state.storage.set(storageFile, JSON.stringify([changed]));
    await act(async () => {
      harness.state.finishConfirm(true);
      await new Promise(setImmediate);
    });
    assert.deepEqual(harness.records(), [changed]);
    assert.equal(harness.state.credentials.get(id), valid.password);
    assert.ok(harness.state.toasts.some((item) => /其他操作修改/.test(item.message)));
    assert.match(harness.text(), /changed-user@dev.example.com/);
  });
});

test("英文界面支持新增、保留或替换密码、选择终端、连接和同步删除凭据", async () => {
  await withHarness(
    async (harness) => {
      await harness.click("Add Connection");
      assert.match(harness.text(), /Connection Name/);
      assert.match(harness.text(), /Host Address/);
      assert.match(harness.text(), /Username/);
      assert.match(harness.text(), /Password/);
      await harness.fill({ ...valid, name: "Development server" });
      await harness.click("Save Connection");
      const id = harness.records()[0].id;
      assert.equal(harness.state.credentials.get(id), valid.password);
      assert.ok(harness.state.toasts.some((item) => item.title === "Connection Saved"));

      await harness.click("Edit Connection");
      assert.match(harness.text(), /Keep Saved Password/);
      assert.equal(harness.field("passwordMode"), "keep");
      assert.equal(harness.field("password"), undefined);
      await harness.fill({ name: "Production server" });
      await harness.click("Save Connection");
      assert.equal(harness.records()[0].name, "Production server");
      assert.equal(harness.state.credentials.get(id), valid.password);
      const keep = harness.state.calls.find((item) => item.args[0] === "edit-connection");
      assert.equal(Object.hasOwn(JSON.parse(keep.input), "password"), false);

      await harness.click("Edit Connection");
      await harness.fill({ passwordMode: "replace" });
      assert.match(harness.text(), /New Password/);
      await harness.fill({ password: "English journey replacement" });
      await harness.click("Save Connection");
      assert.equal(harness.state.credentials.get(id), "English journey replacement");

      await harness.click("Terminal Settings");
      assert.match(harness.text(), /Default Terminal/);
      await harness.fill({ terminalId: "com.googlecode.iterm2" });
      await harness.click("Save Terminal Settings");
      assert.equal(
        JSON.parse(harness.state.storage.get(terminalFile)).terminalId,
        "com.googlecode.iterm2",
      );
      assert.ok(harness.state.toasts.some((item) => item.title === "Terminal Settings Saved"));
      await harness.click("Connect to Server");
      const launch = harness.state.calls.find((item) => item.file === "/usr/bin/osascript");
      assert.match(launch.args[1], /com\.googlecode\.iterm2/);
      const handoff = harness.state.toasts.at(-1);
      assert.equal(handoff.style, "success");
      assert.match(handoff.title, /terminal/i);
      assert.doesNotMatch(handoff.title, /logged in|[\u4e00-\u9fff]/i);
      assert.equal(harness.state.credentials.get(id), "English journey replacement");

      await harness.click("Delete Connection");
      const confirmation = harness.state.confirmations.at(-1);
      assert.match(confirmation.title, /Delete connection.*Production server/i);
      assert.match(confirmation.message, /developer@dev.example.com:22/);
      assert.match(confirmation.message, /Keychain/);
      assert.doesNotMatch(confirmation.message, /[\u4e00-\u9fff]/);
      assert.equal(confirmation.dismissAction.title, "Cancel");
      assert.equal(confirmation.primaryAction.style, "destructive");
      assert.deepEqual(harness.records(), []);
      assert.equal(harness.state.credentials.has(id), false);
      assert.ok(
        harness.state.toasts.some((item) => item.title === "Connection and Password Deleted"),
      );
    },
    { language: "en" },
  );
});

for (const language of [undefined, "unsupported-language"]) {
  test(`缺失或不支持的语言偏好默认使用英文：${String(language)}`, async () => {
    await withHarness(
      async (harness) => {
        assert.equal(harness.hasAction("Add Connection"), true);
        assert.equal(harness.hasAction("添加连接"), false);
        await harness.click("Add Connection");
        await harness.fill({ ...valid, name: "" });
        await harness.click("Save Connection");
        assert.match(harness.text(), /connection name/i);
        assert.doesNotMatch(harness.text(), /请输入连接名称/);
        assert.equal(harness.state.calls.length, 0);
      },
      { language },
    );
  });
}

test("英文校验和钥匙串失败提示保持英文且不暴露密码", async () => {
  await withHarness(
    async (harness) => {
      await harness.click("Add Connection");
      await harness.fill({ name: "", host: "-invalid", username: "", port: "65536", password: "" });
      await harness.click("Save Connection");
      const errors = harness.text();
      assert.match(errors, /connection name/i);
      assert.match(errors, /hostname/i);
      assert.match(errors, /username/i);
      assert.match(errors, /port/i);
      assert.match(errors, /password/i);
      assert.doesNotMatch(errors, /[\u4e00-\u9fff]/);
      assert.equal(harness.state.calls.length, 0);
      await harness.fill({ ...valid, name: "Keychain refusal" });
      harness.state.failAdd = true;
      await harness.click("Save Connection");
      const failure = harness.state.toasts.at(-1);
      assert.equal(failure.title, "Connection Not Saved");
      assert.match(failure.message, /connection and credential were removed.*Keychain/i);
      assert.doesNotMatch(failure.message, /[\u4e00-\u9fff]/);
      assert.ok(!JSON.stringify(harness.state.toasts).includes(valid.password));
      assert.deepEqual(harness.records(), []);
      assert.equal(harness.state.credentials.size, 0);
    },
    { language: "en" },
  );
});
