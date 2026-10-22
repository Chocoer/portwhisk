# 更新日志

## [0.1.0] - 2026-10-22

### 新增

- 采用 MIT 协议。
- 提供中英文 README，插件界面支持 English / 简体中文。
- 搜索、新增、编辑和删除 SSH 连接，支持名称、主机、用户名和端口管理。
- 使用 macOS 钥匙串保存密码；编辑时可保留或替换密码，删除连接时同步清理凭据。
- 支持选择 Terminal 或 iTerm2，并使用保存的密码启动独立 SSH 会话。
- 保留主机身份校验和首次指纹确认，自动提供一次密码，其他认证挑战由用户在终端处理。
- 保存失败时保留可恢复状态，认证取消或进程异常时清理本次启动资源。
- 提供支持 Apple Silicon 与 Intel 的 macOS ZIP，以及自动构建、打包和发布流程。

### English

- MIT license.
- English and Simplified Chinese documentation and interface, selectable in extension preferences.
- Search, add, edit, and delete SSH connections, with passwords stored in macOS Keychain.
- Keep or replace passwords when editing; remove the corresponding credential when deleting.
- Launch independent SSH sessions in Terminal or iTerm2 with a saved password supplied once.
- Preserve host-key verification and recoverable state after interrupted saves or authentication.
- Provide one macOS ZIP for Apple Silicon and Intel, with automated builds and releases.

[0.1.0]: https://github.com/Chocoer/portwhisk/releases/tag/v0.1.0
