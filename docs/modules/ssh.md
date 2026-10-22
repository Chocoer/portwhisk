# SSH 与终端

## 当前结论

- 提供 Terminal/iTerm2 选择，仅显示已安装候选。首次无设置使用 Terminal；已有设置损坏、终端被卸载或启动失败时明确报错，不静默换终端。
- 每次连接重新读取选中记录，冻结非秘密会话描述，由所选终端启动独立系统 OpenSSH。扩展只报告“已交给终端启动”，登录结果以终端为准。
- 使用系统 JavaScript 与 shell 监督，不引入常驻服务或项目编译二进制。编辑/删除的一致性约束见[连接管理](connections.md)。

## 调用与认证边界

- 连接操作 → src/terminals/launch.ts 重读记录与终端设置 → system.js 准备会话 → 静态 AppleScript 向终端交接受控脚本路径/会话 ID → keychain-helper → 系统 SSH → askpass。
- 主机和账户独立传参，不参与 shell 解释；SSH 使用 -F /dev/null，保留 StrictHostKeyChecking=ask，不自动接受未知指纹或清除 known_hosts。首次主机确认与额外认证挑战留给用户。
- askpass 绑定实际 SSH 的 PID、启动时间、可执行路径和父关系，核对精确密码提示、五分钟有效期和单次标记。读取凭据前持连接文件锁，确认当前 ready 目标仍与会话快照一致。
- 密码仅由 JXA 从钥匙串直接写入当前 SSH 的管道，不返回扩展界面，不经过参数、环境变量、文件、日志、剪贴板或模拟输入。失败时先停止绑定 SSH，避免 OpenSSH 把 askpass 失败当成空密码发送。
- shell 持有认证管道，短时 JXA 监督器每 100ms 检查本次身份，父 SSH 退出或监督失败时收回认证子树。正常/瞬时成功不误停 SSH，监督器意外返回也按失败处理。
- 认证进程先 TERM，保留 readpassphrase 恢复终端回显的机会；每 20ms 核对同一身份，最多等待 500ms，只有仍存活的原进程才 KILL。不会按裸 PID 清理其他会话。
- 非秘密临时会话使用私有目录，终端内监督负责结束清理，未启动的过期会话在后续准备时回收。

## 验证与边界

- 自动检查使用独立假 SSH 与测试脚本副本，覆盖父进程/认证/包装壳/监督器取消、正常与瞬时成功、TERM 清理和拒绝退出后的有限强杀。身份采样确认完成进程已消失，不把 zombie 的无路径状态登记为可终止目标。
- 文件、权限、会话准备/清理与终端偏好由真实系统接口在生成目录检查；不触碰真实钥匙串或网络。ARM 和本机 Rosetta x86 是不同证据，Rosetta 不能代替 Intel 硬件或远端 CI。
- 真实终端回显、系统授权和远端登录需相应环境证据，不由模拟边界代替。初始化身份采样前被不可捕获 SIGKILL 终止的创建窗口不作全覆盖承诺。

## 当前工作

- 状态：当前认证监督与清理修复纳入 0.1.0 工程基线；本次不改变支持终端或用户数据。
- 验收：只处理明确选定目标；保留主机校验；最多自动供密一次；取消/异常清理本次资源；不误报已登录。

## 接口依据

- [OpenSSH readpass](https://github.com/openssh/openssh-portable/blob/V_10_3_P1/readpass.c)：askpass、提示类型和失败返回处理。
- [OpenSSH 认证挑战](https://github.com/openssh/openssh-portable/blob/V_10_3_P1/sshconnect2.c)：keyboard-interactive 的本地目标前缀。
- [Darwin readpassphrase](https://github.com/apple-oss-distributions/Libc/blob/main/gen/FreeBSD/readpassphrase.c)：终端回显和信号恢复。
- [iTerm2 AppleScript](https://iterm2.com/documentation-one-page.html)：创建独立窗口与命令参数。

## 变更记录

### 2026-10-22 09:15:12

- 终端设置、启动提示和错误按 language 偏好提供中英文；系统终端的失败信息固定双语。未改变 SSH 参数、一次供密、主机校验、会话格式或监督控制流；新增双语错误断言通过。构建与发布依据见[工程基础](engineering.md)。

### 2026-10-22 07:25:39

- 整理当前会话、认证与取消边界，移除旧版本/提交/发布记录，保留当前安全约束。统一验收与发布证据见[工程基础](engineering.md)。
