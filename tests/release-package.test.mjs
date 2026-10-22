import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
  chmodSync,
  cpSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { packageRelease } from "../scripts/package-release.mjs";

const root = fileURLToPath(new URL("../", import.meta.url));
const manifest = JSON.parse(readFileSync(join(root, "package.json"), "utf8"));

function fixture() {
  mkdirSync(join(root, "build"), { recursive: true });
  const directory = mkdtempSync(join(root, "build/package-test-"));
  cpSync(join(root, "dist"), join(directory, "dist"), { recursive: true });
  cpSync(join(root, "assets"), join(directory, "assets"), { recursive: true });
  cpSync(join(root, "LICENSE"), join(directory, "LICENSE"));
  writeFileSync(join(directory, "package.json"), JSON.stringify(manifest));
  return directory;
}

test("发布包仅包含白名单文件，解压保留系统脚本、执行权限和正确摘要", () => {
  const directory = fixture();
  try {
    writeFileSync(join(directory, "dist/private-records.json"), "不得进入产物");
    const result = packageRelease({ root: directory, tag: `v${manifest.version}` });
    assert.equal(
      result.archive,
      join(directory, "release", `portwhisk-${manifest.version}-macos.zip`),
    );
    assert.equal(
      result.sha256,
      createHash("sha256").update(readFileSync(result.archive)).digest("hex"),
    );
    assert.equal(
      readFileSync(result.sums, "utf8"),
      `${result.sha256}  portwhisk-${manifest.version}-macos.zip\n`,
    );
    const unpack = join(directory, "unpacked");
    execFileSync("/usr/bin/ditto", ["-x", "-k", result.archive, unpack]);
    assert.deepEqual(readdirSync(unpack), ["portwhisk"]);
    const extension = join(unpack, "portwhisk");
    assert.deepEqual(
      readdirSync(extension).sort(),
      [
        "INSTALL.md",
        "LICENSE",
        "assets",
        "package.json",
        "plugin.json",
        ...manifest.commands.map(({ name }) => `${name}.js`),
      ].sort(),
    );
    assert.deepEqual(readdirSync(join(extension, "assets")).sort(), [
      "icon.png",
      "keychain-helper",
      "system-core.js",
      "system.js",
    ]);
    for (const file of [
      "LICENSE",
      "package.json",
      "plugin.json",
      ...manifest.commands.map(({ name }) => `${name}.js`),
      "assets/icon.png",
      "assets/keychain-helper",
      "assets/system.js",
      "assets/system-core.js",
    ]) {
      assert.deepEqual(readFileSync(join(extension, file)), readFileSync(join(root, "dist", file)));
    }
    assert.equal(manifest.license, "MIT");
    assert.deepEqual(readFileSync(join(extension, "LICENSE")), readFileSync(join(root, "LICENSE")));
    const helper = join(extension, "assets/keychain-helper");
    assert(statSync(helper).mode & 0o100);
    assert.match(readFileSync(helper, "utf8"), /^#!\/bin\/sh\n/);
    execFileSync("/bin/sh", ["-n", helper]);
    const install = readFileSync(join(extension, "INSTALL.md"), "utf8");
    assert.match(install, /Add from folder/);
    assert.match(install, /无需卸载/);
    assert.match(install, /without uninstalling/);
    assert.match(install, /Language \/ 语言/);
    assert.match(install, /English is the default/);
    assert.deepEqual(
      JSON.parse(readFileSync(join(extension, "package.json"), "utf8")).preferences,
      manifest.preferences,
    );
    assert.doesNotMatch(install, /签名|公证|Swift/);
    assert.throws(() => packageRelease({ root: directory }), /发布产物已存在/);
    assert.equal(
      createHash("sha256").update(readFileSync(result.archive)).digest("hex"),
      result.sha256,
    );
    assert.deepEqual(readdirSync(join(directory, "build")), []);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test("许可证缺失、声明过期或正文不一致时拒绝打包", () => {
  for (const target of [
    "LICENSE",
    "dist/LICENSE",
    "package.json",
    "dist/package.json",
    "dist/plugin.json",
  ]) {
    const directory = fixture();
    try {
      if (target === "LICENSE" || target === "dist/LICENSE") {
        rmSync(join(directory, target));
      } else {
        const path = join(directory, target);
        writeFileSync(
          path,
          JSON.stringify({ ...JSON.parse(readFileSync(path, "utf8")), license: "UNLICENSED" }),
        );
      }
      assert.throws(() => packageRelease({ root: directory }), /LICENSE|许可证/);
      assert(!readdirSync(directory).includes("release"));
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  }
  const directory = fixture();
  try {
    writeFileSync(join(directory, "dist/LICENSE"), "outdated license");
    assert.throws(() => packageRelease({ root: directory }), /许可证文件与源码不一致/);
    assert(!readdirSync(directory).includes("release"));
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test("tag 或源码与 dist 版本不匹配时拒绝打包，保留原有发布包", () => {
  const directory = fixture();
  try {
    const result = packageRelease({ root: directory });
    const original = readFileSync(result.archive);
    const sums = readFileSync(result.sums);
    for (const tag of ["v99.0.0", manifest.version, `v${manifest.version}-rc.1`]) {
      assert.throws(() => packageRelease({ root: directory, tag }), /tag 必须严格匹配/);
    }
    writeFileSync(
      join(directory, "package.json"),
      JSON.stringify({ ...manifest, version: "99.0.0" }),
    );
    assert.throws(() => packageRelease({ root: directory }), /dist 版本与源码不一致/);
    assert.deepEqual(readFileSync(result.archive), original);
    assert.deepEqual(readFileSync(result.sums), sums);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test("dist 命令清单过期时拒绝打包且不创建输出", () => {
  const directory = fixture();
  try {
    writeFileSync(
      join(directory, "dist/package.json"),
      JSON.stringify({ ...manifest, commands: [] }),
    );
    assert.throws(() => packageRelease({ root: directory }), /dist 命令与源码不一致/);
    assert(!readdirSync(directory).includes("release"));
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test("dist 语言偏好过期时拒绝打包且不创建输出", () => {
  const directory = fixture();
  try {
    writeFileSync(
      join(directory, "dist/package.json"),
      JSON.stringify({ ...manifest, preferences: [] }),
    );
    assert.throws(() => packageRelease({ root: directory }), /dist 语言偏好与源码不一致/);
    assert(!readdirSync(directory).includes("release"));
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test("脚本辅助入口缺少执行权限时拒绝打包", () => {
  const directory = fixture();
  try {
    chmodSync(join(directory, "dist/assets/keychain-helper"), 0o644);
    assert.throws(() => packageRelease({ root: directory }), /必须保留执行权限/);
    assert(!readdirSync(directory).includes("release"));
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test("dist 显示名过期时拒绝打包且不创建输出", () => {
  const directory = fixture();
  try {
    writeFileSync(
      join(directory, "dist/package.json"),
      JSON.stringify({ ...manifest, title: "Outdated title" }),
    );
    assert.throws(() => packageRelease({ root: directory }), /dist 显示名与源码不一致/);
    assert(!readdirSync(directory).includes("release"));
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test("dist 任一系统脚本过期时拒绝打包且不创建输出", () => {
  for (const file of ["keychain-helper", "system.js", "system-core.js"]) {
    const directory = fixture();
    try {
      const target = join(directory, "dist/assets", file);
      writeFileSync(target, `${readFileSync(target, "utf8")}\n# stale asset`);
      assert.throws(() => packageRelease({ root: directory }), /dist 系统脚本与源码不一致/);
      assert(!readdirSync(directory).includes("release"));
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  }
});

test("旧 Mach-O 二进制不能作为脚本资产发布", () => {
  const directory = fixture();
  try {
    const binary = Buffer.from([0xcf, 0xfa, 0xed, 0xfe, 0, 0, 0, 0]);
    for (const prefix of ["assets", "dist/assets"]) {
      writeFileSync(join(directory, prefix, "keychain-helper"), binary);
    }
    assert.throws(() => packageRelease({ root: directory }), /必须是 UTF-8 文本/);
    assert(!readdirSync(directory).includes("release"));
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test("辅助入口必须使用 POSIX shell 且语法有效", () => {
  const directory = fixture();
  try {
    for (const prefix of ["assets", "dist/assets"]) {
      writeFileSync(join(directory, prefix, "keychain-helper"), "#!/usr/bin/env node\n");
    }
    assert.throws(() => packageRelease({ root: directory }), /必须是 POSIX shell 脚本/);
    for (const prefix of ["assets", "dist/assets"]) {
      writeFileSync(join(directory, prefix, "keychain-helper"), "#!/bin/sh\nif\n");
    }
    assert.throws(() => packageRelease({ root: directory }), /Command failed/);
    assert(!readdirSync(directory).includes("release"));
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});
