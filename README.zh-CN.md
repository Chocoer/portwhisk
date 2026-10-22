# Portwhisk

[English](README.md) | 简体中文

**[下载安装包 v0.1.0（macOS）](https://github.com/Chocoer/portwhisk/releases/download/v0.1.0/portwhisk-0.1.0-macos.zip)** · [发布页面](https://github.com/Chocoer/portwhisk/releases/tag/v0.1.0) · [更新日志](CHANGELOG.md)

面向 Tinycast 的 SSH 快捷连接扩展：管理本地连接、通过 macOS 钥匙串保存密码，并在用户选择的终端中启动系统 OpenSSH 会话。

支持连接新增、编辑与删除，终端设置、独立 SSH 会话启动及保存密码自动登录。支持 Terminal 和 iTerm2，仅显示本机已安装项。

## 下载与版本

需要 macOS 26 或更高版本和 [Tinycast](https://tinycast.dev/docs/install/)，支持 Apple Silicon 与 Intel，无需安装 Node.js 或 Swift。

1. 下载上方安装 ZIP 并解压。
2. 在 Tinycast 的 **Settings → Extensions → Install → Add from folder** 中选择解压后的 `portwhisk` 文件夹。
3. 更新时下载新版本，解压后重新导入同名扩展，无需先卸载，已有连接和终端偏好会保留。

安装包位于 [Releases](https://github.com/Chocoer/portwhisk/releases) 的 **Assets** 中；仓库侧栏的 **Packages** 用于 npm、容器等包注册表。本仓库为私有，下载需要仓库访问权限。

首次使用按系统提示允许 Tinycast 控制所选终端。钥匙串访问由系统 `osascript` 发起，建议选择「允许」仅授予本次访问；「始终允许」会信任共享的系统脚本运行程序。升级后已有条目也可能重新请求授权。

## 构建与导入

构建需要 macOS、Node.js 22.22.2 或更高版本、npm 10 或更高版本。构建和使用均无需 Swift、Xcode 或额外的常驻运行时。

```sh
npm ci --ignore-scripts
npm run check
```

| 命令                      | 用途                                               |
| ------------------------- | -------------------------------------------------- |
| `npm run build`           | 构建 `dist/` 并复制许可证。                        |
| `npm run check`           | 执行类型、代码、格式、生产构建与自动检查。         |
| `npm test`                | 构建后运行测试。                                   |
| `npm run test:unit`       | 针对已有 `dist/` 运行测试，不重新构建。            |
| `npm run package`         | 构建后生成发布 ZIP 与内部校验和。                  |
| `npm run package:release` | 打包已有 `dist/`，不重新构建。                     |
| `npm run release:check`   | 校验发布条件并运行 `check`，不创建标签。           |
| `npm run release`         | 校验、运行 `check`，再创建并推送带注解的版本标签。 |

产物位于 `release/`。已有产物不会被覆盖，可使用 `npm run package -- --output release/<新目录>` 指定新目录；`package:release` 同样支持 `--output` 参数。

在 Tinycast 的 **Settings → Extensions → Install → Add from folder** 中选择本项目的 `dist/`。该目录包含 `package.json`、三个已构建命令、`assets/` 与 `LICENSE`，无需复制源码或 `node_modules`。修改源码后重新构建并重新导入同名扩展；该更新路径保留独立存储，无需先卸载。

## 界面语言

在 Tinycast 的 **Settings → Extensions → Portwhisk → Configure** 中，将 **Language / 语言** 设为 **English** 或 **简体中文**；默认使用英文。也可选中命令，按 **⌘K** 后选择 **Configure Extension**。修改后关闭并重新打开命令生效。

命令内的界面、提示和错误会切换语言。宿主搜索中的命令标题固定为 **Connect**、**Manage Connections** 和 **Terminal Settings**，也可通过「连接服务器」「管理连接」「终端设置」等中文关键词查找。

## 添加连接

打开 **Manage Connections（管理连接）** 或 **Connect（连接服务器）**，选择列表中的「添加连接」，填写名称、主机地址、用户名、端口与密码后保存。端口留空时使用 22；主机地址填写域名或 IP，不包含 `ssh`、用户名或端口。

密码不会去除首尾空白，普通连接存储和命令参数中不包含密码。首次保存时可能出现系统钥匙串授权；取消或失败时会显示结果，不将部分保存报告为成功。保存失败且自动清理未完成的记录会标记「保存未完成」，可从该记录的操作菜单确认清理后重试。

普通连接记录位于扩展专属 `supportPath/connections/records.json`，通过原子文件替换保存；所有写入共用文件锁及快照检查，保护其他命令的修改。现有连接无需迁移。

保存成功后列表会刷新，重新打开两个命令也能读取连接。自动认证按 OpenSSH askpass 的限制最多接受 1023 字节 UTF-8 密码；不能无损传递的输入会明确拒绝。已有更长密码不会被修改，但本次自动认证会停止。

## 编辑与删除

在 **Manage Connections（管理连接）** 或 **Connect（连接服务器）** 中选中记录，从操作菜单进入「编辑连接」。名称、主机、用户名和端口会预填，原密码不读取、不回填；「密码处理」默认是「保留已保存密码」。只有主动选择「替换密码」并填写有效新密码，才会更新对应钥匙串条目。留空不会清除原密码，取消表单也不改变数据。

选择「删除连接」后，确认框会显示名称和具体目标。确认后先保留可追踪状态，再清理专属钥匙串凭据，最后移除连接记录；不会按同名或主机批量删除，也不会终止已建立的远端会话。

编辑或删除失败时不会报告成功。若普通写入失败且补偿成功，原数据仍保留；无法确认完整恢复时，请返回列表核对。「编辑未完成」提供「修复连接」，需要重新输入要使用的密码，或确认删除；「删除未完成」只提供「重试删除」，凭据已经不存在也可以重试完成。未完成记录禁止连接。过期表单或被其他操作改过的记录会拒绝提交，需返回列表重新打开。

## 选择终端与连接

打开 **Terminal Settings（终端设置）** 命令，或在连接列表的操作菜单选择「终端设置」，选择本机已安装的 Terminal 或 iTerm2 并保存。首次未设置时使用 Terminal；已有设置损坏或所选应用被卸载时明确报错，需主动重新选择。

在 **Connect（连接服务器）** 中选中已保存连接，执行「连接服务器」。扩展向所选终端交接新的窗口会话，不向已有会话输入命令。首次使用可能需要 macOS 自动化授权或钥匙串授权；首次连接主机时，终端显示 OpenSSH 指纹确认，核对后手工回应。主机密钥变化仍由 OpenSSH 拒绝。

密码仅在独立的系统 JavaScript 脚本中从钥匙串读取，并在 SSH 请求本次目标的密码时自动提供一次，不返回扩展界面，不经过 shell 参数、环境变量、明文文件或模拟键盘输入。密码错误不会自动反复填写；验证码等 keyboard-interactive 挑战留在终端人工输入，输入不回显。拒绝钥匙串授权、上下文失效或认证辅助失败时停止本次 SSH。

扩展只提示「已交给终端启动」，连接、认证及远端 shell 的实际结果以终端为准。会话准备有效期为 5 分钟，终端内监督进程负责结束清理；未启动的过期非秘密会话在下次连接时回收。当前按填写的主机直连，使用 `-F /dev/null` 不读取用户及系统 SSH 配置；已有 known_hosts 校验仍保留，不支持依赖 SSH 配置的跳板或代理连接。

## 目录

```text
src/                       扩展源码
  connect.tsx              连接服务器命令
  manage-connections.tsx   管理连接命令
  terminal-settings.tsx    终端设置命令
  i18n.ts                  中英文文案与语言偏好
  components/              命令共用的列表、连接表单与终端设置
  connections/             连接模型、校验、普通数据存储与流程
  credentials/             钥匙串访问与凭据边界
  terminals/               终端识别、启动与 SSH 会话交接
assets/
  icon.png                 扩展图标
  keychain-helper          系统脚本入口与会话监督
  system.js                JXA 系统接口、钥匙串、原子写和 SSH 认证
  system-core.js           连接事务、校验及认证边界的纯 JavaScript 核心
scripts/                   打包与版本发布脚本
.github/workflows/         双架构 CI、发布包 Intel 检查与 tag 发布
release/                   本地 ZIP 与校验和（不入库）
tests/                     命令行为、脚本系统边界、取消保护及文件检查
dist/                      构建产物，供 Tinycast 文件夹导入（不入库）
docs/
  README.md                文档导航、开发与验证约定
  spec.md                  V1 产品规格与验收标准
  modules/                 每个模块一份长期维护文档
    engineering.md         工程基础的计划、进度、结论与教训
README.md                  英文项目说明
README.zh-CN.md            中文项目说明
AGENTS.md                  Agent 工作规则
CHANGELOG.md               按版本维护的更新日志
LICENSE                    MIT 协议
package.json               扩展清单、依赖与开发脚本
package-lock.json          npm 依赖锁文件
tsconfig.json              TypeScript 严格检查
eslint.config.mjs          官方 Raycast ESLint 配置
```

## 开发入口

- 阅读 [文档与开发入口](docs/README.md)。
- Agent 修改前读取 [AGENTS.md](AGENTS.md)。
- 脚本与依赖以 `package.json` 为准；使用 npm 和对应锁文件维护项目内依赖。

## 发布版本

1. 运行 `npm version patch --no-git-tag-version` 同步扩展清单与锁文件版本；按需将 `patch` 改为 `minor` 或 `major`。
2. 在 `CHANGELOG.md` 中补充对应版本的有效日期和变更条目，并更新两份 README 的下载链接。
3. 在 `main` 提交改动，推送到 `origin/main`，等待 CI 通过。
4. 可选运行 `npm run release:check`，核对发布条件并执行完整检查，不创建标签。
5. 运行 `npm run release`。脚本核对同样条件、执行完整检查后，创建并推送带注解的 `vX.Y.Z` 标签，由 GitHub Actions 构建并发布安装包；核对流水线和 Release 结果后才算发布完成。

发布命令会拒绝脏工作区、非 `main` 分支、HEAD 与真实远端 `origin/main` 不一致、本地或远端版本标签已存在、清单与锁文件版本不一致，以及日志缺失或无效的情况。脚本不会自动改版本、提交或强推。检查或标签推送失败会立即停止，仅推送标签不代表已发布成功。

## 许可证

本项目采用 [MIT 协议](LICENSE)。
