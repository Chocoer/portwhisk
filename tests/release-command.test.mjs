import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { release } from "../scripts/release.mjs";

const version = "1.2.3";
const tag = `v${version}`;

// 所有 Git 写入仅发生在本测试创建的临时仓库，origin 始终是同目录下的本地 bare 仓库。
function fixture(t, check = "") {
  const directory = mkdtempSync(join(tmpdir(), "portwhisk-release-command-"));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const remote = join(directory, "origin.git");
  const root = join(directory, "working");
  const git = (...args) =>
    execFileSync("git", args, { cwd: root, encoding: "utf8", stdio: "pipe" }).trim();
  execFileSync(
    "git",
    ["-c", "init.templateDir=", "init", "--bare", "--initial-branch=main", remote],
    {
      stdio: "pipe",
    },
  );
  execFileSync("git", ["-c", "init.templateDir=", "clone", remote, root], { stdio: "pipe" });
  git("symbolic-ref", "HEAD", "refs/heads/main");
  git("config", "user.name", "Portwhisk Release Test");
  git("config", "user.email", "release-test@example.invalid");
  git("config", "commit.gpgsign", "false");
  git("config", "tag.gpgsign", "false");
  git("config", "core.hooksPath", join(directory, "no-hooks"));
  writeFileSync(
    join(root, "package.json"),
    JSON.stringify({
      name: "portwhisk",
      version,
      private: true,
      scripts: { check: "node check.cjs" },
    }),
  );
  writeFileSync(
    join(root, "package-lock.json"),
    JSON.stringify({
      name: "portwhisk",
      version,
      lockfileVersion: 3,
      packages: { "": { version } },
    }),
  );
  writeFileSync(
    join(root, "CHANGELOG.md"),
    `# Changelog\n\n## [${version}] - 2026-10-22\n\n- Release fixture.\n`,
  );
  writeFileSync(join(root, ".gitignore"), "check-ran\n");
  writeFileSync(
    join(root, "check.cjs"),
    `require("node:fs").writeFileSync("check-ran", "checked");\n${check}\n`,
  );
  const commit = () => {
    git("add", "--force", ".");
    git("commit", "-m", "fixture");
  };
  const push = () => git("push", "origin", "main");
  commit();
  push();
  return { root, remote, git, commit, push };
}

function assertNoTag({ git }) {
  assert.equal(git("tag", "--list"), "");
  assert.equal(git("ls-remote", "--tags", "origin"), "");
}

test("release 运行检查并只推送指向已同步 HEAD 的注解 tag", async (t) => {
  const repository = fixture(t);
  const { root, git } = repository;
  const head = git("rev-parse", "HEAD");
  await release({ root });
  assert(existsSync(join(root, "check-ran")));
  assert.equal(git("cat-file", "-t", `refs/tags/${tag}`), "tag");
  assert.equal(git("rev-parse", `${tag}^{commit}`), head);
  assert.equal(git("ls-remote", "origin", `refs/tags/${tag}^{}`).split(/\s/)[0], head);
  assert.equal(git("ls-remote", "origin", "refs/heads/main").split(/\s/)[0], head);
  assert.equal(git("symbolic-ref", "--short", "HEAD"), "main");
  assert.equal(git("status", "--porcelain"), "");
});

test("release checkOnly 执行完整检查但不创建或推送 tag", async (t) => {
  const repository = fixture(t);
  await release({ root: repository.root, checkOnly: true });
  assert(existsSync(join(repository.root, "check-ran")));
  assertNoTag(repository);
});

test("release 拒绝脏工作区、非 main、未推送或真实远端已变化的 HEAD", async (t) => {
  for (const state of ["dirty", "untracked", "branch", "unpushed", "stale-remote"]) {
    await t.test(state, async (t) => {
      const repository = fixture(t);
      const { root, git, commit } = repository;
      if (state === "dirty")
        writeFileSync(
          join(root, "CHANGELOG.md"),
          `${readFileSync(join(root, "CHANGELOG.md"), "utf8")}\n- Uncommitted change.\n`,
        );
      if (state === "untracked") writeFileSync(join(root, "untracked.txt"), "new file\n");
      if (state === "branch") git("switch", "-c", "other");
      if (state === "unpushed" || state === "stale-remote") {
        const original = git("rev-parse", "HEAD");
        writeFileSync(join(root, "extra.txt"), "new commit\n");
        commit();
        if (state === "stale-remote") {
          const advanced = git("rev-parse", "HEAD");
          // 只移动本地 bare origin；保留工作仓库的 origin/main 为旧值，检验真实远端读取。
          git("push", "origin", `${advanced}:refs/heads/main`);
          git("update-ref", "refs/remotes/origin/main", original);
          git("reset", "--hard", original);
        }
      }
      await assert.rejects(async () => release({ root }));
      assertNoTag(repository);
    });
  }
});

test("release 拒绝本地或远端已有的同名 lightweight tag", async (t) => {
  for (const location of ["local", "remote"]) {
    await t.test(location, async (t) => {
      const { root, remote, git } = fixture(t);
      const head = git("rev-parse", "HEAD");
      if (location === "local") git("tag", tag);
      else execFileSync("git", ["--git-dir", remote, "update-ref", `refs/tags/${tag}`, head]);
      await assert.rejects(async () => release({ root }));
      assert.equal(git("tag", "--list"), location === "local" ? tag : "");
      assert.equal(
        git("ls-remote", "origin", `refs/tags/${tag}`),
        location === "remote" ? `${head}\trefs/tags/${tag}` : "",
      );
    });
  }
});

test("release 拒绝锁文件顶层或根包版本不一致，以及缺少当前日志条目", async (t) => {
  for (const invalid of [
    "lock-version",
    "lock-root-version",
    "heading",
    "empty-section",
    "asterisk",
  ]) {
    await t.test(invalid, async (t) => {
      const repository = fixture(t);
      const { root, commit, push } = repository;
      if (invalid.startsWith("lock-")) {
        const path = join(root, "package-lock.json");
        const lock = JSON.parse(readFileSync(path, "utf8"));
        if (invalid === "lock-version") lock.version = "1.2.4";
        else lock.packages[""].version = "1.2.4";
        writeFileSync(path, JSON.stringify(lock));
      } else if (invalid === "asterisk") {
        writeFileSync(
          join(root, "CHANGELOG.md"),
          `# Changelog\n\n## [${version}] - 2026-10-22\n\n* Unsupported bullet.\n`,
        );
      } else {
        writeFileSync(
          join(root, "CHANGELOG.md"),
          invalid === "heading"
            ? "# Changelog\n\n## [1.2.2] - 2026-10-22\n\n- Previous version.\n"
            : `# Changelog\n\n## [${version}] - 2026-10-22\n\nNo change bullets.\n\n## [1.2.2] - 2026-10-21\n\n- Previous version.\n`,
        );
      }
      commit();
      push();
      await assert.rejects(async () => release({ root }));
      assertNoTag(repository);
    });
  }
});

test("release 检查失败或检查修改跟踪文件时不产生 tag", async (t) => {
  for (const check of [
    "process.exit(1);",
    'require("node:fs").appendFileSync("CHANGELOG.md", "modified during check\\n");',
  ]) {
    await t.test(check, async (t) => {
      const repository = fixture(t, check);
      await assert.rejects(async () => release({ root: repository.root }));
      assert(existsSync(join(repository.root, "check-ran")));
      assertNoTag(repository);
    });
  }
});

test("release 检查期间 HEAD 或真实远端变化时停止打 tag", async (t) => {
  for (const changed of ["head", "remote"]) {
    await t.test(changed, async (t) => {
      const check =
        changed === "head"
          ? 'require("node:child_process").execFileSync("git", ["commit", "--allow-empty", "-m", "check changed HEAD"]);'
          : 'require("node:child_process").execFileSync("git", ["push", "origin", ":refs/heads/main"]);';
      const repository = fixture(t, check);
      if (changed === "remote")
        execFileSync("git", [
          "--git-dir",
          repository.remote,
          "config",
          "receive.denyDeleteCurrent",
          "ignore",
        ]);
      await assert.rejects(async () => release({ root: repository.root }));
      assert(existsSync(join(repository.root, "check-ran")));
      assertNoTag(repository);
    });
  }
});

test("release tag 推送失败时保留本地注解 tag 供排障", async (t) => {
  const repository = fixture(t);
  const { root, remote, git } = repository;
  execFileSync("git", ["--git-dir", remote, "config", "receive.denyNonFastForwards", "true"]);
  // 命名空间碰撞让真实 Git 拒绝推送，同步检查仍能正常读取 main 与同名 tag。
  execFileSync("git", [
    "--git-dir",
    remote,
    "update-ref",
    `refs/tags/${tag}/blocked`,
    git("rev-parse", "HEAD"),
  ]);
  await assert.rejects(async () => release({ root }));
  assert.equal(git("cat-file", "-t", `refs/tags/${tag}`), "tag");
  assert.equal(git("ls-remote", "origin", `refs/tags/${tag}`), "");
});
