# 工程基础

## 当前结论

- Portwhisk 使用 TypeScript/JavaScript、POSIX shell 与 macOS 自带接口，提供连接、管理连接、终端设置三个命令；不编译或分发项目自带的原生二进制，不需要额外常驻运行时。
- 已发布基线为 [Portwhisk v0.1.0](https://github.com/Chocoer/portwhisk/releases/tag/v0.1.0)。本轮准备 v0.1.1 补丁版本，最终发布状态以对应 tag 的 Actions 和 Release 为准。
- 依赖与开发命令以 package.json 和 package-lock.json 为准。打包只复制明确白名单文件，产物名为 `portwhisk-<版本>-macos.zip`，支持 Apple Silicon 和 Intel。
- 普通记录、凭据事务和 SSH 边界分别见[连接管理](connections.md)、[SSH 与终端](ssh.md)，规格见 [V1 规格](../spec.md)，开发与发布流程见[文档入口](../README.md)。

## 当前工作

- v0.1.1：用户已授权提交推送与打 tag。范围为 iTerm2 启动修复、回归检查、版本/锁文件、双语下载链接和更新日志；不改变依赖或发布工作流。验收为完整检查通过、main 推送成功、注解 tag v0.1.1 指向同一提交且推送成功。计划：同步版本与发行说明 → 完整检查 → 提交并推送 main → 现有 release 脚本复核并推送 tag → 核对远端与 CI 状态。真实终端验证仍未执行，详情见 SSH 模块。

- 命令已规范：package/test 是自包含入口，package:release/test:unit 复用已有构建；release:check 检查但不写 Git 引用，release 检查后创建并推送注解 vX.Y.Z。预检覆盖版本/lock/CHANGELOG、干净 main、真实 origin 同步及已有标签，检查后再次核对；正常入口禁止覆盖。

- 双语实现、发布命令与本地交付检查已完成：README.md 为英文，README.zh-CN.md 为中文；界面、校验和错误通过宿主语言偏好切换，默认英文。连接、凭据和会话协议不变。
- 当前 0.1.0 按用户要求合为一个根提交；双架构检查、同包 Intel 验证及公开发布由 [.github/workflows/pipeline.yml](../../.github/workflows/pipeline.yml) 执行，最终交付以 [v0.1.0 Release](https://github.com/Chocoer/portwhisk/releases/tag/v0.1.0) 和[对应 Actions](https://github.com/Chocoer/portwhisk/actions/workflows/pipeline.yml) 为准，不为发布回执另加源码提交。
- 验收与范围：中英 README、语言偏好、界面与边界错误、双语安装说明、打包拒绝过期偏好、134 项回归、单一提交和授权的同版本重新发布。未增加依赖或改变仓库可见性，不迁移连接/凭据，不操作真实应用、钥匙串、TTY 或远端 SSH。
- 已完成步骤：官方/源码和实例调查 → 双语实现与文档 → 本地回归/打包 → 独立只读审查。GitHub 发布仍由上述 CI 门禁保护；同版替换是本轮明确授权的例外，常规发布继续拒绝覆盖。

## 实现约束

- 日常版本使用 npm version --no-git-tag-version 更新源码与锁文件，维护 CHANGELOG 后提交 main。release 只创建当前版本的注解 tag 并显式推送单 tag，发布结果以 CI 为准；无 force、自动提交或覆盖入口。Git 推送失败时保留本地 tag 供核对。

- 项目采用 MIT，源码、锁文件和构建清单声明一致；LICENSE 必须随 dist 与发布 ZIP 交付，正文与源码逐字节核对。第三方依赖保留各自许可。
- 运行资产为三个文本脚本，打包验证 UTF-8、源码与 dist 字节一致、shell 语法和执行位，拒绝旧二进制。SHA256SUMS 只用于内部核验，不作为 Release 附件。
- CI 在 Apple Silicon/Intel 分别检查，再由 Intel 执行同一 ARM job 的 ZIP；只有全部通过才允许 tag 发布。官方 Actions 固定 commit，检查任务只读，发布任务单独授予写权限。
- 草稿只允许空附件或唯一当前 ZIP；列表失败、其他附件、不同字节和已有公开版本均拒绝。上传后重新下载比对再公开，不自动删除用户附件。
- JXA C 接口按公开 ABI 绑定；Intel 的 stat 使用 inode64 符号。Foundation 原子写、持久文件锁与锁内快照检查保护数据；不能把权限/解析错误当成空记录。
- 新凭据不默认信任共享 osascript，旧凭据 ACL 不自动迁移。读取授权由系统处理，密码不进入扩展返回值、命令参数、环境变量、明文文件或日志。

## 验证

- 入口为 npm run check，覆盖类型、ESLint、非写入格式检查、生产构建和 Node 回归；真实系统外部操作仍遵守授权边界。
- 认证回归只用独立假进程，真实 Security 操作在测试副本替换；内存 ACL 检查不访问钥匙串。发布回归执行真实工作流 shell，GitHub 使用本地 fake gh。

## 变更记录

### 2026-10-26 17:20:20

- 0.1.1 版本与锁文件根版本、双语下载链接和 CHANGELOG 已同步；依赖版本无变化。完整 npm run check 通过：类型、ESLint、非写入格式检查、构建、135/135 回归。差异检查通过，范围共九份文件。
- 本地发布准备完成，下一步按授权提交并推送 main，再由 npm run release 复核同一提交并推送 v0.1.1 注解标签。远端最终回执以 Git 引用和 Actions/Release 为准，不为发布回执另加源码提交；真实 iTerm2 窗口行为仍待实机复测。

### 2026-10-26 17:19:18

- 收到“直接推送打tag”授权。核对当前 main 与真实 origin/main 均为 9bfb0e3，只有 v0.1.0 标签；工作区仅有本次 SSH 修复的三份文件，暂存区为空。
- 按补丁修复采用 0.1.1，保留 v0.1.0。沿用 npm run release 创建并推送注解 tag，由现有流水线完成双架构检查、同包 Intel 验证和正式发布；不绕过发布门禁。

### 2026-10-22 09:21:42

- 最终 npm run check 通过 134/134，含双语界面、打包/发布与新增 24 项真实临时 Git 场景。独立审查发现本地日志允许星号而 CI 只接受横线，已统一为 `- ` 条目，并增加拒绝回归；审查未再发现遗漏。
- npm run package 已实际验证先构建再转发 --tag/--output，生成同版本 ZIP；CI 使用 package:release 复用检查阶段构建，避免重复。README 中英命令表和正常发布步骤、开发文档均已同步。
- 发布入口不更改版本/锁文件、提交或覆盖引用；当前用户授权的历史重建及同版替换由主代理完成后，将使用新 npm run release 实际发布。最终回执由 Actions/Release 保留，单一源码提交不再追加发布过程提交。

### 2026-10-22 09:17:12

- 用户追加规范命令与 tag 流程，已暂停受影响的标签/发布替换。现有 package 依赖已有 dist、test 隐含构建且没有 release 入口；将补齐自包含入口及严格预检，不增加自动改版本、提交或强推逻辑。使用本地临时 bare Git 仓库验证，禁止测试访问真实远端。

### 2026-10-22 09:15:12

- npm run check 通过：类型、ESLint、限定非写入格式检查、生产构建及 110/110 回归；其中真实 dist 入口的 49 项含英文完整增改连删旅程、字段错误/授权取消、缺省与未知语言英文回退，中文场景保留。
- 本地发布 ZIP 已生成，11 文件白名单；两份清单为 0.1.0/MIT，LICENSE、三脚本与源码一致，安装说明为双语，language 偏好进入 package.json。新增过期偏好拒绝打包回归与终端双语错误断言通过；独立审查未发现遗漏。
- Raycast 商店指南当前仅支持英文并建议避免自建本地化；Tinycast 官方文档/源码支持 dropdown、默认值与 getPreferenceValues，Environment 无 locale，清单标题为静态字符串。因此采用默认英文的显式偏好和最小 t(中文,英文)，英文标题配中文关键词；依据统一保留在[开发约定](../README.md#语言与文档)。
- 为满足用户的单一提交要求，本轮汇总保留已确认的工程事实与上述验证，替换旧 Git/发布过程记录；公开发布的最终结果和下载摘要由 Actions/Release 回执记录，避免再追加过程提交。README 许可说明只保留协议名称与链接。
- 没有执行真实 Tinycast、终端、钥匙串、TTY 或 SSH 联调；模拟系统边界不替代真实登录结果。无需额外决定。
