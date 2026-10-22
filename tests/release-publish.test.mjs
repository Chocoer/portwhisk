import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("../", import.meta.url));
const version = "1.2.3";
const archive = `portwhisk-${version}-macos.zip`;
const workflow = readFileSync(join(root, ".github/workflows/pipeline.yml"), "utf8");
const step = workflow.split("      - name: Upload, download-verify and publish\n")[1];
assert(step, "工作流必须保留待执行的发布步骤");
const script = step.split("        run: |\n")[1].replace(/^ {10}/gm, "");
assert.match(script, /^set -euo pipefail\n/);

// 只替换 GitHub 边界，执行真实发布 shell，确保条件分支和失败退出行为也被覆盖。
const fakeGh = String.raw`
const fs = require("node:fs");
const path = require("node:path");
const args = process.argv.slice(2);
fs.appendFileSync(process.env.FAKE_GH_CALLS, JSON.stringify(args) + "\n");
const state = JSON.parse(fs.readFileSync(process.env.FAKE_GH_STATE, "utf8"));
const option = (name) => args[args.indexOf(name) + 1];
const save = () => fs.writeFileSync(process.env.FAKE_GH_STATE, JSON.stringify(state));
if (args[0] !== "release") process.exit(2);
switch (args[1]) {
  case "view":
    if (state.draft === null) process.exit(1);
    if (option("--json") === "isDraft") {
      console.log(state.draft);
    } else {
      if (state.failList) process.exit(1);
      console.log(JSON.stringify(state.assets.map((asset) => asset.name)));
    }
    break;
  case "create":
    state.draft = true;
    save();
    break;
  case "upload":
    state.assets.push({ name: path.basename(args[3]), data: fs.readFileSync(args[3]).toString("base64") });
    save();
    break;
  case "download": {
    const asset = state.assets.find((item) => item.name === option("--pattern"));
    if (!asset) process.exit(1);
    fs.mkdirSync(option("--dir"), { recursive: true });
    fs.writeFileSync(path.join(option("--dir"), asset.name), Buffer.from(asset.data, "base64"));
    break;
  }
  case "edit":
    state.draft = false;
    save();
    break;
  default:
    process.exit(2);
}
`;

function publish({
  draft = true,
  extraAssets = [],
  existing = true,
  different = false,
  failList = false,
  packageLicense = "MIT",
  staleLicense = false,
} = {}) {
  const directory = mkdtempSync(join(tmpdir(), "portwhisk-publish-"));
  try {
    for (const subdirectory of ["bin", "release", "stage/portwhisk", "runner"]) {
      mkdirSync(join(directory, subdirectory), { recursive: true });
    }
    writeFileSync(
      join(directory, "stage/portwhisk/package.json"),
      JSON.stringify({ version, license: packageLicense }),
    );
    const license = readFileSync(join(root, "LICENSE"));
    writeFileSync(join(directory, "LICENSE"), license);
    writeFileSync(
      join(directory, "stage/portwhisk/LICENSE"),
      staleLicense ? "outdated license" : license,
    );
    execFileSync(
      "/usr/bin/zip",
      ["-q", join(directory, "release", archive), "portwhisk/package.json", "portwhisk/LICENSE"],
      {
        cwd: join(directory, "stage"),
      },
    );
    const bytes = readFileSync(join(directory, "release", archive));
    writeFileSync(
      join(directory, "release/SHA256SUMS"),
      `${createHash("sha256").update(bytes).digest("hex")}  ${archive}\n`,
    );
    writeFileSync(
      join(directory, "CHANGELOG.md"),
      `## [${version}] - 2026-10-22\n\n- 发布修复。\n`,
    );
    const gh = join(directory, "bin/gh");
    writeFileSync(gh, `#!${process.execPath}\n${fakeGh}`);
    chmodSync(gh, 0o700);
    // 发布 job 用 Ubuntu 命令名，本机检查复用系统 shasum，实际计算摘要且不依赖 GNU 工具。
    const checksum = join(directory, "bin/sha256sum");
    writeFileSync(checksum, '#!/bin/sh\nexec /usr/bin/shasum -a 256 "$@"\n');
    chmodSync(checksum, 0o700);
    const statePath = join(directory, "state.json");
    const callsPath = join(directory, "calls.jsonl");
    writeFileSync(callsPath, "");
    writeFileSync(
      statePath,
      JSON.stringify({
        draft,
        failList,
        assets: [
          ...(existing
            ? [
                {
                  name: archive,
                  data: (different ? Buffer.from("旧包") : bytes).toString("base64"),
                },
              ]
            : []),
          ...extraAssets.map((name) => ({
            name,
            data: Buffer.from("多余附件").toString("base64"),
          })),
        ],
      }),
    );
    const result = spawnSync("/bin/bash", ["--noprofile", "--norc", "-c", script], {
      cwd: join(directory, "release"),
      encoding: "utf8",
      timeout: 15_000,
      env: {
        ...process.env,
        PATH: `${join(directory, "bin")}:${process.env.PATH}`,
        GH_TOKEN: "",
        GH_REPO: "fixture/portwhisk",
        GITHUB_REF_NAME: `v${version}`,
        RUNNER_TEMP: join(directory, "runner"),
        FAKE_GH_STATE: statePath,
        FAKE_GH_CALLS: callsPath,
      },
    });
    assert.ifError(result.error);
    const calls = readFileSync(callsPath, "utf8")
      .trim()
      .split("\n")
      .filter(Boolean)
      .map(JSON.parse);
    return { ...result, calls, state: JSON.parse(readFileSync(statePath, "utf8")), bytes };
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
}

function operations(result) {
  return result.calls.map((args) => args[1]);
}

test("包内许可证声明或正文不一致时在创建发布前停止", () => {
  for (const scenario of [{ packageLicense: "UNLICENSED" }, { staleLicense: true }]) {
    const result = publish(scenario);
    assert.notEqual(
      result.status,
      0,
      JSON.stringify({ scenario, stdout: result.stdout, stderr: result.stderr }),
    );
    assert.deepEqual(operations(result), []);
    assert.equal(result.state.draft, true);
  }
});

test("草稿的其他附件必须阻止发布，不自动清理或覆盖", () => {
  for (const name of [`portwhisk-${version}-macos-universal.zip`, "SHA256SUMS", "unexpected.txt"]) {
    const result = publish({ extraAssets: [name] });
    assert.notEqual(result.status, 0);
    assert.match(result.stdout, /草稿包含预期以外的附件/);
    assert.deepEqual(operations(result), ["view", "view"]);
    assert.equal(result.state.draft, true);
    assert.deepEqual(
      result.state.assets.map((asset) => asset.name),
      [archive, name],
    );
  }
});

test("相同 ZIP 的草稿可重跑，下载核对后公开且不重复上传", () => {
  const result = publish();
  assert.equal(result.status, 0, result.stderr);
  assert.deepEqual(operations(result), ["view", "view", "download", "download", "edit"]);
  assert.equal(result.state.draft, false);
  assert.deepEqual(Buffer.from(result.state.assets[0].data, "base64"), result.bytes);
});

test("空草稿可以补传 ZIP，经下载核对后公开", () => {
  const result = publish({ existing: false });
  assert.equal(result.status, 0, result.stderr);
  assert.deepEqual(operations(result), ["view", "view", "upload", "download", "edit"]);
  assert.equal(result.state.draft, false);
  assert.deepEqual(
    result.state.assets.map((asset) => asset.name),
    [archive],
  );
});

test("附件列表查询失败必须停止，不能作为缺少 ZIP 继续上传和发布", () => {
  const result = publish({ existing: false, failList: true });
  assert.notEqual(result.status, 0);
  assert.deepEqual(operations(result), ["view", "view"]);
  assert.equal(result.state.draft, true);
  assert.deepEqual(result.state.assets, []);
});

test("同名 ZIP 字节不同则拒绝覆盖和发布", () => {
  const result = publish({ different: true });
  assert.notEqual(result.status, 0);
  assert.deepEqual(operations(result), ["view", "view", "download"]);
  assert.equal(result.state.draft, true);
});

test("已经公开的版本保持拒绝覆盖", () => {
  const result = publish({ draft: false });
  assert.notEqual(result.status, 0);
  assert.deepEqual(operations(result), ["view"]);
});

test("新版本从草稿创建、上传、下载校验到公开完整执行", () => {
  const result = publish({ draft: null, existing: false });
  assert.equal(result.status, 0, result.stderr);
  assert.deepEqual(operations(result), ["view", "create", "view", "upload", "download", "edit"]);
  assert.equal(result.state.draft, false);
});
