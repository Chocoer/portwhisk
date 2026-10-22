# 文档与开发约定

| 入口 | 内容与使用时机 |
| --- | --- |
| [项目说明（中文）](../README.zh-CN.md) / [English](../README.md) | 查看安装、使用方法和目录职责 |
| [更新日志](../CHANGELOG.md) | 查看每个版本的功能与调整 |
| [V1 规格](spec.md) | 实现产品功能、讨论范围或检查验收时阅读 |
| [Agent 规则](../AGENTS.md) | Agent 开始修改前阅读 |
| [工程基础](modules/engineering.md) | 查看工程、CI/CD、打包发布的当前结论、计划、进度和历史依据 |
| [连接管理](modules/connections.md) | 查看新增/编辑/删除、校验、存储与凭据一致性约定及验证 |
| [SSH 与终端](modules/ssh.md) | 查看终端设置、SSH 启动、一次供密边界及未验项目 |

产品事实以规格为准，协作规则以 AGENTS.md 为准。开发文档只补充实现所需信息；新增架构决策文档应有真实决策及理由，不把未验证方案写成既定事实。

## 文档组织

规格放 `docs/spec.md`，每个功能模块在 `docs/modules/<module>.md` 中集中维护设计结论、当前计划、进度、验证与教训。相同模块始终更新同一文件，时间仅用于记录内的变更标记，不再创建日期目录或逐任务拆分文件。

新模块有实际工作时再建文档；当前维护工程基础、连接管理与 SSH 终端。跨模块通用约定直接维护在本文或 AGENTS.md，根目录保留项目入口、Agent 规则与必要工程配置。

## 当前状态与下一步

当前已实现两个命令共用的连接增删改、列表读取与刷新、输入校验、普通字段持久化和钥匙串事务边界。终端设置、独立 SSH 会话启动及一次供密流程已实现，设计与验收边界见 [SSH 与终端](modules/ssh.md)。产品范围、技术提案和完整验收条件见 V1 规格。

当前使用方法和支持范围见根 README；开发检查与过程依据保留在模块记录中。

项目.npmrc固定官方npm registry，锁文件tarball来自官方来源；不依赖开发机私有镜像或认证。使用 npm，版本与命令以 `package.json`、`package-lock.json` 为准。安装使用 `npm ci --ignore-scripts`；完整检查使用 `npm run check`。构建使用显式输出的 Raycast 构建，并将根目录 LICENSE 复制到 dist/，运行资产为普通 JavaScript 与 POSIX shell 文本，不调用 Swift、lipo 或 codesign，不需要 Xcode。SDK CLI 启动时仍会创建配置目录并读取已有 CLI 配置，但不发送默认构建刷新，也不使用 `ray develop`。产物从 Tinycast 的 Add from folder 导入，具体步骤见根 README。

`build/`、`dist/` 与 SDK 自动生成的 `raycast-env.d.ts` 不入库；`assets/keychain-helper`、`assets/system.js` 与 `assets/system-core.js` 作为源码跟踪，构建时直接复制到产物。终端设置为独立命令并在列表操作中提供入口，偏好保存到 supportPath/terminal.json；只识别 Terminal/iTerm2。

## 语言与文档

README.md 为英文入口，README.zh-CN.md 为中文入口，两页互链并保持产品说明对应。界面通过扩展级 language dropdown 选择 English / 简体中文，默认 en；设置位于 Tinycast Settings → Extensions → Portwhisk → Configure，也可从命令的 ⌘K → Configure Extension 进入，修改后重开命令。

src/i18n.ts 只使用 getPreferenceValues 和两种文案，不引入额外依赖；缺省/未知语言使用英文。显示层、输入校验和错误边界均使用同一偏好；系统终端的失败提示固定提供中英双语，保持 SSH/会话数据协议不变。清单命令名为固定英文，中文入口保留为 keywords。宿主和 OpenSSH 自己的文案由对应软件决定。

依据：[Raycast 商店本地化说明](https://developers.raycast.com/basics/prepare-an-extension-for-store#localization--language)（当前仅支持英文并建议避免自建 UI 本地化）；本项目按 Tinycast 直接分发的产品要求提供双语，不声称符合该商店条款。[Tinycast 配置](https://tinycast.dev/docs/extensions/customising/)与[Preferences API](https://developers.raycast.com/api-reference/preferences)确认偏好路径；双语 README 结构参考 [Easydict](https://github.com/tisfeng/Raycast-Easydict)。

## 代码组织

扩展命令入口直接放在 `src/`，文件名与 manifest 的命令名对应。共用列表与表单放 `src/components/`，模型、校验及保存一致性放 `src/connections/`，受控子进程通信放 `src/system-helper.ts`。`src/credentials/` 和 `src/terminals/` 分别组织凭据流程与终端设置/启动。

`assets/system-core.js` 是不依赖宿主的 JavaScript 核心，负责数据校验、快照比较与失败恢复；`assets/system.js` 由系统 `/usr/bin/osascript -l JavaScript` 执行，通过 JXA 的系统桥调用 Security、Foundation 和 Darwin 接口；`assets/keychain-helper` 只负责脚本分派与进程监督。独立 SSH 使用 `/usr/bin/ssh`，无需安装 Node 或其他运行时，也不编译辅助二进制。

普通记录仍使用 `environment.supportPath/connections/records.json`，7字段及稳定ID/ref不变。因 Tinycast LocalStorage 会吞写盘错误、fs.rename 会先删除目标，文件写入继续使用 Foundation 原子写、持久文件锁与锁内快照检查。密码替换的旧值只在脚本进程内存中用于补偿；供密前在同一锁内核对当前 ready 目标。主机校验、首次指纹人工确认、一次供密和取消后停止本次SSH保持原约束。

钥匙串 service 固定 `dev.portwhisk.ssh`，account仍为连接UUID，不迁移或重建已有凭据。新条目使用 `SecAccessCreate` 的空受信应用列表，避免默认信任通用 `osascript` 身份；不修改旧条目的 ACL。用户可按系统提示授予访问，若选择永久信任，授权主体是共享系统脚本运行器。依据：[Apple SecAccessCreate](https://developer.apple.com/documentation/security/secaccesscreate(_:_:_:))、[Keychain ACL](https://developer.apple.com/documentation/security/access-control-lists)。

模块按具体调用关系组织。首次确有需求时再创建辅助脚本或额外目录，职责和技术选择依据写入相关模块记录。

## 验证

测试放 `tests/`，优先从命令入口验证可观察结果，系统边界使用无秘密的替代实现。安全边界不能通过入口有效覆盖时补小范围测试；详细场景直接遵循 [规格中的验证要求](spec.md#testing-decisions)。

发布回归直接执行工作流的发布 shell，只替换 GitHub 为本地 fake gh；macOS 使用系统 shasum 做实际摘要核验，不触发远端发布。

当前 `npm test` 先构建，再通过 `test:unit` 用 Node 内置测试工具、React DOM 与 happy-dom 加载 `dist/` 中真实命令包。测试运行真实 React 状态、表单、校验与保存流程，仅在宿主展示/导航、文件读取与子进程边界提供无秘密替代。另以纯 JavaScript 检查连接事务和认证边界，并实际执行 JXA 生产副本、真实 Foundation/CF 桥与文件操作，仅在测试副本替换四个 SecItem 调用。内存中的 ACL 构造与受信列表检查不读写真实钥匙串。取消检查使用独立子进程作为 SSH 边界替身，不启动真实终端或连接网络。使用 ssh -G 只解析有效配置；执行脚本元数据、终端偏好和会话准备/清理分支，在生成的测试目录验证真实文件、权限和失败回执。未知运行时依赖直接失败；不启动浏览器或真实应用，不调用真实钥匙串。SDK 和 JSX runtime 兼容性的依据见 [Tinycast 运行时源码](https://github.com/abue-ammar/tinycast/blob/main/Scripts/raycast-runtime/src/index.js) 和 [安装文档](https://tinycast.dev/docs/extensions/installing/)。

类型、构建、限定文件的非写入检查按实际变更执行。真实 Tinycast、外部终端及 SSH 登录分别记录环境、场景和结果。没有证据的能力保持“未验证”，工具尚未配置的检查保持“未执行”。

开发样例和未来测试夹具只使用虚构连接与无秘密数据；真实服务器资料、钥匙串内容和私人 SSH 文件不进入项目。

## CI/CD 与打包发布

工作流位于 `.github/workflows/pipeline.yml`。PR、main 推送与手工触发在 macos-15（Apple Silicon）和 macos-15-intel 上执行 `npm ci --ignore-scripts`、`npm run check` 与 `npm run package:release`，保留14天构建产物。Actions 固定到官方已核实的 commit，检查任务只有 contents:read，PR 不使用秘密或 pull_request_target。Node使用受支持的22系列。

随后 Intel runner 下载 Apple Silicon job 产生的同一份 macOS ZIP，校验摘要、文本脚本、源码/许可证一致性、shell语法和执行权限，运行打包后辅助程序的无凭据文件与会话检查。该任务不安装npm依赖，也不访问钥匙串或SSH网络。发布必须等待所有检查。

`npm run package` 先构建，再调用 `package:release`；CI 已完成构建时直接使用后者，避免重复构建。两者均转发 `--output` 与 `--tag`，不覆盖已有产物。`npm run package:release -- --tag v0.1.0` 要求 tag 严格匹配 package.json 中 X.Y.Z 版本，源码与 dist 清单一致。打包前要求三个脚本、LICENSE 与源码逐字节一致，源码及两份构建清单声明 MIT，拒绝遗留Mach-O/无效UTF-8/错误shebang或失效执行位；只打包明确交付的清单、三命令JS、图标、三个运行脚本、MIT LICENSE 与安装说明；不打包源码映射、开发依赖、测试或用户数据。已有同名 ZIP/校验和拒绝覆盖；需要重新打包时用新的 --output 目录。ZIP 内保留 portwhisk/ 根目录，须先解压再文件夹导入，不能将 ZIP 直接作为 Tinycast 安装格式。

后续版本流程：

1. 在本地用 `npm version <X.Y.Z> --no-git-tag-version` 同步 package.json 与锁文件版本，更新 CHANGELOG.md 对应版本段、README 顶部版本下载链接及相关使用说明并运行 `npm run check`。
2. 审查后提交到 main，推送并等待 CI 通过。
3. 对已检查的提交创建 `git tag -a v<X.Y.Z> -m "Portwhisk v<X.Y.Z>"`，再 `git push origin v<X.Y.Z>`。不要移动或强推已发布 tag。
4. tag 流水线重新校验版本与构建，发布任务仅用 GITHUB_TOKEN 的 contents:write 创建 draft，从 CHANGELOG.md 提取当前版本的发行说明，仅上传 ZIP，重新下载与已校验的原包逐字节核对后正式发布并标记 Latest。SHA256SUMS 仅供 CI 内部校验，不作为 Release 附件。无需额外 PAT、Apple 证书或常驻服务。
5. 失败时优先在Actions重跑失败的发布job以复用已通过的构建产物。草稿重跑只允许唯一的当前 ZIP，缺失时可补传；附件查询失败、额外附件、不同字节或已有公开版本都会明确失败，不使用 --clobber。若草稿需替换，请先人工核实其来源再处理，不能覆盖已发布资产。

tag 发布要求 CHANGELOG.md 中存在同版本标题（`## [X.Y.Z] - YYYY-MM-DD`）及变更条目，缺失时停止发布。GitHub 默认源码 ZIP 不是可导入扩展，应下载命名为 portwhisk-<版本>-macos.zip 的资产。正式版本由对应 tag 构建，Release 只提供当前版本的安装 ZIP。

接口依据：[GitHub runner](https://docs.github.com/en/actions/reference/runners/github-hosted-runners)、[GITHUB_TOKEN](https://docs.github.com/en/actions/tutorials/authenticate-with-github_token)、[gh release create](https://cli.github.com/manual/gh_release_create)、[Tinycast安装](https://tinycast.dev/docs/extensions/installing/)。完整本轮证据归[工程基础](modules/engineering.md)。

## 维护者发布命令

package.json 将构建、检查、打包和发布明确分开：test=build+test:unit，package=build+package:release；日常使用自包含入口，CI 已完成构建时调用后半段。lint 和 format:check 均非写入式。

正常版本先使用 `npm version patch --no-git-tag-version`（或 minor/major）同步 package.json 与锁文件，更新 CHANGELOG 当前日期条目和两份 README 下载链接，然后提交并推送 main。`npm run release:check` 执行发布预检与完整 check，不写 Git 引用；`npm run release` 检查通过后创建 `vX.Y.Z` 注解 tag，仅推送该标签，由 CI 构建并发布。

发布脚本拒绝非 main、脏工作区、真实 origin/main 不等于当前 HEAD、同名本地/远端标签、非 X.Y.Z 版本、锁版本不一致和缺失/无有效日期及 `- ` 条目的当前日志。检查完成后重新核对 Git 与远端；不会自动改版本、提交、删标签或强推。推送失败时本地 tag 保留供核对，可在确认远端状态后显式推送同一 tag，不通过覆盖重建修复。测试仅在自己创建的临时本地 Git 仓库与 bare origin 执行，不连接用户远端。

依据：[npm version](https://docs.npmjs.com/cli/v11/commands/npm-version/) 与 [Git annotated tag](https://git-scm.com/docs/git-tag)。本轮 0.1.0 的授权覆盖由主代理单独处理；脚本没有覆盖入口。
