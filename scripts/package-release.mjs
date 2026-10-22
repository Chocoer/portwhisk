import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
  chmodSync,
  constants,
  copyFileSync,
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";

const projectRoot = fileURLToPath(new URL("../", import.meta.url));

function regularFile(path) {
  const stat = lstatSync(path);
  assert(stat.isFile() && !stat.isSymbolicLink(), `发布输入必须是普通文件：${path}`);
  return stat;
}

function readManifest(path) {
  regularFile(path);
  return JSON.parse(readFileSync(path, "utf8"));
}

// 只复制明确交付的文件；绝不遍历开发目录、用户连接或凭据。
export function packageRelease({ root = projectRoot, output = join(root, "release"), tag } = {}) {
  root = resolve(root);
  output = resolve(output);
  const source = readManifest(join(root, "package.json"));
  const manifest = readManifest(join(root, "dist/package.json"));
  const plugin = readManifest(join(root, "dist/plugin.json"));
  assert.equal(source.name, "portwhisk", "项目名称必须是 portwhisk");
  assert.equal(source.license, "MIT", "项目许可证必须是 MIT");
  assert.match(source.version, /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/, "版本必须为 X.Y.Z");
  if (tag !== undefined)
    assert.equal(tag, `v${source.version}`, "tag 必须严格匹配 package.json 版本");
  for (const item of [manifest, plugin]) {
    assert.equal(item.name, source.name, "dist 名称与源码不一致，请重新构建");
    assert.equal(item.version, source.version, "dist 版本与源码不一致，请重新构建");
    assert.equal(item.license, source.license, "dist 许可证声明与源码不一致，请重新构建");
  }
  assert.deepEqual(manifest.commands, source.commands, "dist 命令与源码不一致，请重新构建");
  assert.deepEqual(
    manifest.preferences,
    source.preferences,
    "dist 语言偏好与源码不一致，请重新构建",
  );
  assert.equal(manifest.title, source.title, "dist 显示名与源码不一致，请重新构建");
  assert.equal(source.commands.length, 3, "发布包必须包含三个扩展命令");
  const commands = source.commands.map(({ name }) => {
    assert.match(name, /^[a-z][a-z0-9-]*$/, "命令名称不能包含路径");
    return `${name}.js`;
  });
  assert.equal(new Set(commands).size, commands.length, "命令名称必须唯一");
  const files = [
    "LICENSE",
    "package.json",
    "plugin.json",
    ...commands,
    "assets/icon.png",
    "assets/keychain-helper",
    "assets/system.js",
    "assets/system-core.js",
  ];
  for (const file of files) regularFile(join(root, "dist", file));
  regularFile(join(root, "LICENSE"));
  assert.deepEqual(
    readFileSync(join(root, "dist/LICENSE")),
    readFileSync(join(root, "LICENSE")),
    "dist 许可证文件与源码不一致，请重新构建",
  );
  // 发布时只接受当前源码脚本，防止 dist 残留旧二进制或旧系统逻辑。
  for (const file of ["assets/keychain-helper", "assets/system.js", "assets/system-core.js"]) {
    const sourcePath = join(root, file);
    regularFile(sourcePath);
    const content = readFileSync(join(root, "dist", file));
    assert(
      !content.includes(0) && Buffer.from(content.toString("utf8")).equals(content),
      `运行资产必须是 UTF-8 文本，不能包含旧二进制：${file}`,
    );
    assert.deepEqual(content, readFileSync(sourcePath), `dist 系统脚本与源码不一致：${file}`);
  }
  const helper = join(root, "dist/assets/keychain-helper");
  assert.match(
    readFileSync(helper, "utf8"),
    /^#!\/bin\/sh\r?\n/,
    "辅助入口必须是 POSIX shell 脚本",
  );
  assert(regularFile(helper).mode & 0o100, "辅助入口必须保留执行权限");
  execFileSync("/bin/sh", ["-n", helper], { stdio: "pipe" });

  const name = `portwhisk-${source.version}-macos.zip`;
  const archive = join(output, name);
  const sums = join(output, "SHA256SUMS");
  assert(
    !existsSync(archive) && !existsSync(sums),
    "发布产物已存在；请指定新的 --output 目录，不会覆盖旧包",
  );
  mkdirSync(join(root, "build"), { recursive: true });
  const temporary = mkdtempSync(join(root, "build/release-"));
  let copiedArchive = false;
  try {
    const staging = join(temporary, "portwhisk");
    mkdirSync(join(staging, "assets"), { recursive: true });
    for (const file of files) {
      copyFileSync(join(root, "dist", file), join(staging, file));
      chmodSync(join(staging, file), regularFile(join(root, "dist", file)).mode & 0o777);
    }
    writeFileSync(
      join(staging, "INSTALL.md"),
      "# Portwhisk Installation / 安装\n\n## English\n\nRequires macOS 26 or later and Tinycast. Supports Apple Silicon and Intel. No Node.js or compiler is required.\n\nExtract this ZIP, then open Tinycast Settings → Extensions → Install → Add from folder and select the portwhisk folder. To update, reimport the same extension without uninstalling it; saved connections and terminal preferences are kept.\n\nOpen Settings → Extensions → Portwhisk → Configure and choose English or 简体中文 under Language / 语言. English is the default. Close and reopen the command after changing it. Launcher command names remain Connect, Manage Connections, and Terminal Settings; Chinese keywords also work.\n\nAllow Tinycast to control the selected terminal when macOS asks. Keychain requests come from the system osascript runner. Choose Allow for this access; Always Allow trusts the shared system script runner. Existing items may ask again after an update.\n\n## 简体中文\n\n需要 macOS 26 或更高版本和 Tinycast，支持 Apple Silicon 与 Intel。无需安装 Node.js 或编译工具。\n\n解压 ZIP 后，在 Tinycast 的 Settings → Extensions → Install → Add from folder 中选择 portwhisk 文件夹。更新时直接重新导入同名扩展，无需卸载，以保留本地连接和终端偏好。\n\n在 Settings → Extensions → Portwhisk → Configure 的 Language / 语言 中选择 English 或简体中文，默认英文。修改后关闭并重新打开命令。启动器命令名称为 Connect、Manage Connections 和 Terminal Settings，亦可用中文关键词搜索。\n\n首次使用按系统提示允许 Tinycast 控制所选终端。钥匙串访问由系统 osascript 发起，建议选择「允许」仅授予本次访问；「始终允许」会信任共享的系统脚本运行程序。升级后已有条目也可能重新请求授权。\n",
    );
    const temporaryArchive = join(temporary, name);
    execFileSync("/usr/bin/ditto", [
      "-c",
      "-k",
      "--norsrc",
      "--noextattr",
      "--noqtn",
      "--noacl",
      "--keepParent",
      staging,
      temporaryArchive,
    ]);
    const sha256 = createHash("sha256").update(readFileSync(temporaryArchive)).digest("hex");
    mkdirSync(output, { recursive: true });
    // 排他写入避免检查后其他进程创建同名产物时被覆盖；失败只清理自己创建的文件。
    copyFileSync(temporaryArchive, archive, constants.COPYFILE_EXCL);
    copiedArchive = true;
    writeFileSync(sums, `${sha256}  ${name}\n`, { flag: "wx" });
    return { archive, sums, sha256 };
  } catch (error) {
    if (copiedArchive) rmSync(archive);
    throw error;
  } finally {
    rmSync(temporary, { recursive: true, force: true });
  }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    const { values } = parseArgs({
      options: { tag: { type: "string" }, output: { type: "string" } },
    });
    const result = packageRelease({ tag: values.tag, output: values.output });
    console.log(`已生成 ${result.archive}\nSHA-256 ${result.sha256}\n校验文件 ${result.sums}`);
  } catch (error) {
    console.error(`打包失败：${error.message}`);
    process.exitCode = 1;
  }
}
