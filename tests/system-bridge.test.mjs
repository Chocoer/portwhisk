import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { copyFileSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import test from "node:test";

const id = "12345678-1234-4234-8234-123456789abc";
const connection = {
  id,
  name: "Bridge fixture",
  host: "example.invalid",
  username: "fixture-user",
  port: 2222,
  credentialRef: id,
  status: "ready",
};
const source = readFileSync(new URL("../assets/system.js", import.meta.url), "utf8");

// 仅替换测试副本的四个 C 函数调用；真实 JXA 仍负责创建 CF 对象和读写非秘密元数据。
function fixture(t) {
  mkdirSync(resolve("build"), { recursive: true });
  const root = mkdtempSync(resolve("build/bridge-test-"));
  const directory = join(root, "connections");
  mkdirSync(directory, { mode: 0o700 });
  copyFileSync(new URL("../assets/system-core.js", import.meta.url), join(root, "system-core.js"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const records = join(directory, "records.json");
  const calls = join(root, "calls.json");
  const script = join(root, "system.js");
  let isolated = source;
  for (const name of ["CopyMatching", "Add", "Update", "Delete"]) {
    const original = `$.SecItem${name}(`;
    assert.equal(isolated.split(original).length, 2, `expected one ${name} boundary`);
    isolated = isolated.replace(original, `bridge${name}(`);
  }
  assert.doesNotMatch(isolated, /\$\.SecItem(?:CopyMatching|Add|Update|Delete)\s*\(/);

  function invoke(operation, input, expectedCalls, password = "") {
    // 副本只嵌入预期字节数；新增和替换的密码只经标准输入交给生产解析路径。
    const fake = `
const bridgeExpected = ${JSON.stringify(expectedCalls)};
const bridgePasswordLength = ${Buffer.byteLength(password, "utf8")};
const bridgeCalls = [];
const bridgeRetained = [];
writeJSON(assets + "/calls.json", bridgeCalls);
ObjC.bindFunction("CFDictionaryGetValueIfPresent", ["bool", ["pointer", "pointer", "pointer"]]);
ObjC.bindFunction("SecAccessCopyACLList", ["int", ["pointer", "pointer"]]);
ObjC.bindFunction("SecACLCopyContents", ["int", ["pointer", "pointer", "pointer", "pointer"]]);
function bridgeCheck(condition, reason) {
  if (!condition) {
    writeJSON(assets + "/calls.json", { calls: bridgeCalls, error: reason });
    fail(-75001);
  }
}
function bridgeQuery(pointer, kind) {
  const query = ObjC.castRefToObject(pointer);
  bridgeCheck(query.isKindOfClass($.NSMutableDictionary), "query dictionary class");
  const values = ObjC.deepUnwrap(query);
  bridgeCheck(values.class === "genp", "generic password class");
  bridgeCheck(values.svce === "dev.portwhisk.ssh", "service namespace");
  bridgeCheck(values.acct === ${JSON.stringify(id)}, "credential account");
  const keys = ["class", "svce", "acct"];
  if (kind === "read") {
    keys.push("r_Data", "m_Limit");
    bridgeCheck(values.r_Data === true && values.m_Limit === "m_LimitOne", "read options");
  }
  if (kind === "add") {
    keys.push("labl", "v_Data", ObjC.unwrap(securityConstant($.kSecAttrAccess)));
    bridgeCheck(values.labl === "Portwhisk SSH", "credential label");
    bridgePassword(query);
    bridgeAccess(query);
  }
  bridgeCheck(Object.keys(values).sort().join() === keys.sort().join(), "query key whitelist");
  bridgeCheck(bridgeExpected[bridgeCalls.length] === kind, "unexpected credential call");
  bridgeCalls.push(kind);
  writeJSON(assets + "/calls.json", bridgeCalls);
  return query;
}
function bridgeAccess(query) {
  const access = query.objectForKey(securityConstant($.kSecAttrAccess));
  bridgeCheck(!access.isNil(), "explicit credential access");
  const list = Ref("id*");
  bridgeCheck($.SecAccessCopyACLList(ObjC.castObjectToRef(access), list) === 0, "access ACL list");
  const entries = ObjC.castRefToObject(list[0]);
  let restricted = 0;
  for (let index = 0; index < Number(entries.count); index++) {
    const applications = Ref("id*");
    bridgeCheck($.SecACLCopyContents(
      ObjC.castObjectToRef(entries.objectAtIndex(index)), applications,
      Ref("id*"), Ref("unsigned short"),
    ) === 0, "ACL application list");
    const pointer = applications[0];
    // 加密等公开操作可有 nil 列表；受限制操作必须显式留空，不能信任通用脚本宿主。
    if (pointer === null || pointer === undefined) continue;
    const trusted = ObjC.castRefToObject(pointer);
    if (trusted.isNil()) continue;
    bridgeCheck(Number(trusted.count) === 0, "no default trusted application");
    restricted++;
  }
  bridgeCheck(restricted > 0, "restricted credential ACL exists");
}
function bridgePassword(dictionary) {
  const value = dictionary.objectForKey(securityConstant($.kSecValueData));
  bridgeCheck(value.isKindOfClass($.NSData), "password NSData class");
  bridgeCheck(Number(value.length) === bridgePasswordLength, "password UTF-8 byte length");
  bridgeCheck(dataFor(stringFor(value)).isEqualToData(value), "password UTF-8 round trip");
}
function bridgeCopyMatching(pointer, output) {
  bridgeQuery(pointer, "read");
  const holder = $.NSMutableDictionary.dictionary;
  holder.setObjectForKey(dataFor("opaque previous fixture"), $("result"));
  bridgeRetained.push(holder);
  bridgeCheck($.CFDictionaryGetValueIfPresent(
    ObjC.castObjectToRef(holder), ObjC.castObjectToRef($("result")), output,
  ), "CF output pointer");
  return 0;
}
function bridgeAdd(pointer, output) {
  bridgeCheck(output === null, "add output pointer");
  bridgeQuery(pointer, "add");
  return 0;
}
function bridgeUpdate(pointer, attributesPointer) {
  bridgeQuery(pointer, "update");
  const update = ObjC.castRefToObject(attributesPointer);
  bridgeCheck(update.isKindOfClass($.NSMutableDictionary), "update dictionary class");
  bridgeCheck(Number(update.count) === 1, "update attribute whitelist");
  bridgePassword(update);
  return 0;
}
function bridgeDelete(pointer) {
  bridgeQuery(pointer, "delete");
  return 0;
}
`;
    writeFileSync(script, isolated + fake);
    const outcome = spawnSync(
      "/usr/bin/osascript",
      ["-l", "JavaScript", script, operation, operation === "add" ? id : directory],
      { input: JSON.stringify(input), encoding: "utf8", timeout: 10000 },
    );
    const actualCalls = JSON.parse(readFileSync(calls, "utf8"));
    assert.equal(outcome.status, 0, `${outcome.stderr}\n${JSON.stringify(actualCalls)}`);
    assert.deepEqual(JSON.parse(outcome.stdout), { status: 0 });
    assert.deepEqual(actualCalls, expectedCalls);
  }
  return {
    directory,
    invoke,
    write: (value) => writeFileSync(records, JSON.stringify(value), { mode: 0o600 }),
    read: () => JSON.parse(readFileSync(records, "utf8")),
  };
}

test("JXA adds a pending credential using a real Security dictionary and stdin NSData", (t) => {
  const state = fixture(t);
  const pending = { ...connection, status: "pending" };
  state.invoke("save", { expected: [], connections: [pending] }, []);
  const password = "fixture-密碼-é-'\\-🔑";
  state.invoke("add", { directory: state.directory, password }, ["add"], password);
  assert.deepEqual(state.read(), [pending]);
  state.invoke("save", { expected: [pending], connections: [connection] }, []);
  assert.deepEqual(state.read(), [connection]);
});

test("JXA edits preserve credentials or read and replace through typed CF output pointers", (t) => {
  const state = fixture(t);
  state.write([connection]);
  const renamed = { ...connection, name: "Renamed fixture" };
  state.invoke("edit-connection", { expected: connection, connection: renamed }, []);
  assert.deepEqual(state.read(), [renamed]);
  const updated = { ...renamed, host: "updated.invalid" };
  const password = "replacement-🔒-é-'\\";
  state.invoke(
    "edit-connection",
    { expected: renamed, connection: updated, password },
    ["read", "update"],
    password,
  );
  assert.deepEqual(state.read(), [updated]);
});

test("JXA deletes the exact credential account and then removes its connection", (t) => {
  const state = fixture(t);
  state.write([connection]);
  state.invoke("delete-connection", { expected: connection }, ["delete"]);
  assert.deepEqual(state.read(), []);
});
