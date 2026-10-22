import { t } from "../i18n";
import { environment, Toast, showToast } from "@raycast/api";
import { spawn } from "child_process";
import { isAbsolute, join } from "path";
import { listConnections } from "../connections/store";
import { runHelper } from "../system-helper";
import { getSelectedTerminal, type Terminal } from "./settings";

const starting = new Set<string>();
const scripts: Record<string, string> = {
  "com.apple.Terminal": `on run argv
  tell application id "com.apple.Terminal"
    do script (item 1 of argv)
    activate
  end tell
end run`,
  "com.googlecode.iterm2": `on run argv
  tell application id "com.googlecode.iterm2"
    create window with default profile command (item 1 of argv)
    activate
  end tell
end run`,
};

function shellQuote(value: string): string {
  return `'${value.replace(/'/g, "'\\''")}'`;
}

/** 静态脚本只接收受控程序和会话目录，不向已有终端会话输入命令或秘密。 */
function launchTerminal(terminal: Terminal, sessionDirectory: string): Promise<void> {
  const helperPath = join(environment.assetsPath, "keychain-helper");
  if (!isAbsolute(helperPath) || !isAbsolute(sessionDirectory) || !scripts[terminal.id]) {
    return Promise.reject(
      new Error(
        t(
          "终端启动路径或设置无效，请重新构建并导入扩展。",
          "The terminal launch path or settings are invalid. Rebuild and reimport the extension.",
        ),
      ),
    );
  }
  const command = [helperPath, "ssh-start", sessionDirectory].map(shellQuote).join(" ");
  return new Promise((resolve, reject) => {
    const child = spawn("/usr/bin/osascript", ["-e", scripts[terminal.id], command], {
      timeout: 30_000,
      stdio: ["ignore", "pipe", "pipe"],
    });
    child.stdout.on("data", () => undefined);
    // osascript 的错误可能含动态命令，不把原始输出带入提示或日志。
    child.stderr.on("data", () => undefined);
    child.on("error", () => {
      reject(
        new Error(
          t(
            `无法启动 ${terminal.name}，请检查安装和 macOS 自动化授权后重试。`,
            `Could not launch ${terminal.name}. Check that it is installed and macOS Automation access is allowed, then try again.`,
          ),
        ),
      );
    });
    child.on("close", (code) => {
      if (code === 0) resolve();
      else {
        reject(
          new Error(
            t(
              `${terminal.name} 启动失败或超时，请检查 macOS 自动化授权后重试。`,
              `${terminal.name} failed to launch or timed out. Check macOS Automation access and try again.`,
            ),
          ),
        );
      }
    });
  });
}

/** 每次重读选定记录，启动期间去重；成功交接后会话由终端中的系统 SSH 和监督脚本负责。 */
export async function connect(connectionId: string): Promise<void> {
  if (starting.has(connectionId)) return;
  starting.add(connectionId);
  let sessionDirectory: string | undefined;
  try {
    const connection = (await listConnections()).find((item) => item.id === connectionId);
    if (!connection || connection.status !== "ready") {
      throw new Error(
        t(
          "连接不存在或保存尚未完成，请刷新列表后重试。",
          "The connection is missing or incomplete. Refresh the list and try again.",
        ),
      );
    }
    const terminal = await getSelectedTerminal();
    const result = await runHelper(
      "ssh-prepare",
      environment.supportPath,
      JSON.stringify({ connectionId }),
    );
    if (
      !result.sessionId ||
      !/^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/.test(result.sessionId)
    ) {
      throw new Error(
        t(
          "SSH 辅助程序返回的会话无效，请重新构建并导入扩展。",
          "The SSH helper returned an invalid session. Rebuild and reimport the extension.",
        ),
      );
    }
    sessionDirectory = join(environment.supportPath, "sessions", result.sessionId);
    await launchTerminal(terminal, sessionDirectory);
    sessionDirectory = undefined;
    await showToast({
      style: Toast.Style.Success,
      title: t("已交给终端启动", "Handed off to terminal"),
    });
  } catch (cause) {
    let message =
      cause instanceof Error
        ? cause.message
        : t(
            "请检查连接设置和系统授权后重试。",
            "Check connection settings and system permissions, then try again.",
          );
    if (sessionDirectory) {
      try {
        await runHelper("ssh-discard", sessionDirectory, "");
      } catch {
        message += t(
          " 本次启动资源清理失败，请保留扩展数据并重试。",
          " Session cleanup failed. Keep the extension data and try again.",
        );
      }
    }
    await showToast({
      style: Toast.Style.Failure,
      title: t("SSH 启动未完成", "SSH launch did not complete"),
      message,
    });
  } finally {
    starting.delete(connectionId);
  }
}
