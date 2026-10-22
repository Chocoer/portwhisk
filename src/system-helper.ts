import { t } from "./i18n";
import { environment } from "@raycast/api";
import { spawn } from "child_process";
import { isAbsolute, join } from "path";

interface HelperResult {
  status: number;
  sessionId?: string;
  terminalIds?: string[];
}

const connectionErrors: Record<number, string> = {
  [-70001]: t(
    "连接正在处理或已被其他操作修改，请返回列表刷新后重试。",
    "This connection is busy or has changed. Return to the list, refresh, and try again.",
  ),
  [-70002]: t(
    "编辑或恢复未确认完成，请返回列表核对；未完成记录须重新输入密码修复或删除，请勿继续使用旧表单。",
    "The edit or recovery could not be confirmed. Return to the list. Repair incomplete records with a password replacement or delete them; do not reuse the old form.",
  ),
  [-70003]: t(
    "删除未确认完成，请刷新列表，若仍有记录请重试删除；对应凭据可能已经清理。",
    "Deletion could not be confirmed. Refresh the list and retry if the record remains; its credential may already have been removed.",
  ),
  [-70004]: t(
    "连接数据读取或写入失败，已停止操作以保护现有数据；请检查磁盘和目录权限。",
    "Could not read or write connection data. The operation stopped to protect existing data. Check the disk and directory permissions.",
  ),
};

/** 只允许受控操作；秘密和记录仅经 stdin 传递，系统错误文本不向外回显。 */
export function runHelper(
  operation:
    | "add"
    | "delete"
    | "save"
    | "edit-connection"
    | "delete-connection"
    | "terminal"
    | "terminals"
    | "ssh-prepare"
    | "ssh-discard",
  target: string,
  input: string,
): Promise<HelperResult> {
  const validTarget =
    operation === "add" || operation === "delete"
      ? /^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/.test(target)
      : isAbsolute(target);
  if (!validTarget)
    return Promise.reject(
      new Error(
        t("存储目标无效，已停止操作。", "The storage target is invalid. The operation stopped."),
      ),
    );

  return new Promise((resolve, reject) => {
    // Tinycast 的 execFile 句柄没有 stdin；spawn 提供已核实的输入管道。
    const child = spawn(join(environment.assetsPath, "keychain-helper"), [operation, target], {
      timeout: 60_000,
      stdio: ["pipe", "pipe", "pipe"],
    });
    let stdout = "";
    child.stdout.on("data", (chunk: Buffer) => {
      stdout += chunk.toString("utf8");
      if (stdout.length > 1024) {
        child.kill();
        reject(
          new Error(
            t(
              "存储辅助程序返回内容异常，已停止操作。",
              "The storage helper returned an invalid response. The operation stopped.",
            ),
          ),
        );
      }
    });
    child.stderr.on("data", () => undefined);
    child.on("error", () => {
      reject(
        new Error(
          t(
            "无法运行存储辅助程序，请重新构建并导入扩展后重试。",
            "Could not run the storage helper. Rebuild and reimport the extension, then try again.",
          ),
        ),
      );
    });
    child.on("close", (code) => {
      let status: unknown;
      let result: HelperResult;
      try {
        result = JSON.parse(stdout);
        status = result.status;
      } catch {
        reject(
          new Error(
            t(
              "存储辅助程序未正常完成，请重新构建并导入扩展后重试。",
              "The storage helper did not complete. Rebuild and reimport the extension, then try again.",
            ),
          ),
        );
        return;
      }
      if (code === 0 && status === 0) {
        resolve(result);
        return;
      }
      if (typeof status === "number" && connectionErrors[status]) {
        reject(new Error(connectionErrors[status]));
        return;
      }
      const message =
        operation === "save"
          ? t(
              "连接信息写入失败，请检查磁盘空间和扩展目录权限。",
              "Could not write connection data. Check disk space and extension directory permissions.",
            )
          : operation === "terminal"
            ? t(
                "终端设置写入失败，请检查磁盘空间和扩展目录权限。",
                "Could not write terminal settings. Check disk space and extension directory permissions.",
              )
            : operation.startsWith("ssh-") || operation === "terminals"
              ? t(
                  "SSH 会话或终端信息处理失败，请刷新连接并重新导入扩展后重试。",
                  "Could not prepare the SSH session or terminal information. Refresh connections and reimport the extension, then try again.",
                )
              : status === -128
                ? t("钥匙串授权已取消。", "Keychain access was canceled.")
                : status === -25308
                  ? t(
                      "钥匙串当前不允许访问，请解锁后重试。",
                      "Keychain access is unavailable. Unlock the keychain and try again.",
                    )
                  : t(
                      "钥匙串操作失败，请检查系统授权后重试。",
                      "The Keychain operation failed. Check system permissions and try again.",
                    );
      reject(new Error(message));
    });
    child.stdin.on("error", () => {
      child.kill();
      reject(new Error(t("存储通道已关闭，请重试。", "The storage channel closed. Try again.")));
    });
    child.stdin.end(input);
  });
}
