import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { resolve, join } from "node:path";
import { parseArgs } from "node:util";
import { fileURLToPath } from "node:url";

const projectRoot = fileURLToPath(new URL("../", import.meta.url));

function git(root, args) {
  return execFileSync("git", args, { cwd: root, encoding: "utf8", stdio: "pipe" }).trim();
}

/** 固定从干净且已推送的 main 发布；真实远端查询失败时停止，不信任过期的跟踪引用。 */
function checkGit(root, tag) {
  assert.equal(git(root, ["branch", "--show-current"]), "main", "请在 main 分支发布");
  assert.equal(
    git(root, ["status", "--porcelain", "--untracked-files=all"]),
    "",
    "工作区必须干净，请先提交改动",
  );
  assert.equal(git(root, ["tag", "--list", tag]), "", `本地标签 ${tag} 已存在，拒绝覆盖`);
  const commit = git(root, ["rev-parse", "HEAD"]);
  const refs = new Map(
    git(root, ["ls-remote", "origin", "refs/heads/main", `refs/tags/${tag}`])
      .split("\n")
      .filter(Boolean)
      .map((line) => line.split(/\s+/).reverse()),
  );
  assert.equal(
    refs.get("refs/heads/main"),
    commit,
    "main 与真实 origin/main 不一致，请先同步并推送提交",
  );
  assert(!refs.has(`refs/tags/${tag}`), `远端标签 ${tag} 已存在，拒绝覆盖`);
  return commit;
}

/** 版本、锁文件和日期化日志必须对应；检查后再复核 Git，绝不自动改版本、提交或强推。 */
export function release({ root = projectRoot, checkOnly = false } = {}) {
  root = resolve(root);
  const manifest = JSON.parse(readFileSync(join(root, "package.json"), "utf8"));
  const lock = JSON.parse(readFileSync(join(root, "package-lock.json"), "utf8"));
  const version = manifest.version;
  assert.equal(typeof version, "string", "缺少 package.json 版本");
  assert.match(
    version,
    /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/,
    "版本必须为 X.Y.Z，不允许前缀或预发布后缀",
  );
  assert.equal(lock.version, version, "锁文件版本与 package.json 不一致");
  assert.equal(lock.packages?.[""]?.version, version, "锁文件根包版本与 package.json 不一致");
  const changelog = readFileSync(join(root, "CHANGELOG.md"), "utf8");
  const section = changelog.split(/^## /m).find((part) => part.startsWith(`[${version}] - `));
  assert(section, `CHANGELOG 缺少 ${version} 版本记录`);
  const date = section.slice(`[${version}] - `.length).split("\n")[0].trim();
  assert(
    /^\d{4}-\d{2}-\d{2}$/.test(date) &&
      Number.isFinite(Date.parse(date)) &&
      new Date(date).toISOString().slice(0, 10) === date,
    "CHANGELOG 版本日期无效",
  );
  assert(/^- \S/m.test(section), "CHANGELOG 当前版本必须包含以 - 开头的变更条目");

  const tag = `v${version}`;
  const commit = checkGit(root, tag);
  execFileSync("npm", ["run", "check"], { cwd: root, stdio: "inherit" });
  // 检查脚本和并发操作都可能改动内容或提交，标签只能指向刚刚验证的同一个版本。
  assert.equal(checkGit(root, tag), commit, "检查期间 HEAD 已变化，请重新发布");
  if (checkOnly) {
    console.log(`发布检查通过：${tag} → ${commit}；未创建或推送标签。`);
    return { tag, commit };
  }
  git(root, ["-c", "tag.gpgSign=false", "tag", "-a", tag, commit, "-m", `Portwhisk ${tag}`]);
  // 推送失败保留本地注解标签供核对，不自动删除或重写已有引用。
  git(root, ["-c", "push.followTags=false", "push", "origin", `refs/tags/${tag}:refs/tags/${tag}`]);
  console.log(`已推送注解标签 ${tag} → ${commit}。请查看 GitHub Actions 的构建和发布结果。`);
  return { tag, commit };
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    const { values } = parseArgs({ options: { check: { type: "boolean", default: false } } });
    release({ checkOnly: values.check });
  } catch (error) {
    console.error(`发布失败：${error.message.split("\n")[0]}`);
    process.exitCode = 1;
  }
}
