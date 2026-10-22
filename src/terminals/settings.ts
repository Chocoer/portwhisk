import { t } from "../i18n";
import { environment } from "@raycast/api";
import { readFile } from "fs/promises";
import { join } from "path";
import { runHelper } from "../system-helper";

export interface Terminal {
  id: string;
  name: string;
}

const candidates: Terminal[] = [
  { id: "com.apple.Terminal", name: "Terminal" },
  { id: "com.googlecode.iterm2", name: "iTerm2" },
];

/** 系统接口按应用标识查询，避免宿主搜索范围漏掉系统 Terminal。 */
export async function getInstalledTerminals(): Promise<Terminal[]> {
  try {
    const { terminalIds } = await runHelper("terminals", environment.supportPath, "");
    if (!Array.isArray(terminalIds) || !terminalIds.every((id) => typeof id === "string")) {
      throw new Error(t("终端识别结果无效。", "The terminal inventory is invalid."));
    }
    return candidates.filter((terminal) => terminalIds.includes(terminal.id));
  } catch {
    throw new Error(
      t(
        "无法读取已安装的终端，请检查系统权限后重试。",
        "Could not read installed terminals. Check system permissions and try again.",
      ),
    );
  }
}

/** 仅首次使用默认 Terminal；损坏、失效的已有设置必须由用户明确修正。 */
export async function readTerminalId(): Promise<string> {
  let text: string;
  try {
    text = await readFile(join(environment.supportPath, "terminal.json"), "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return "com.apple.Terminal";
    throw new Error(
      t(
        "无法读取终端设置，请检查扩展目录权限后重试。",
        "Could not read terminal settings. Check extension directory permissions and try again.",
      ),
    );
  }
  try {
    const value: unknown = JSON.parse(text);
    if (
      typeof value === "object" &&
      value !== null &&
      Object.keys(value).length === 1 &&
      "terminalId" in value &&
      typeof value.terminalId === "string" &&
      candidates.some((terminal) => terminal.id === value.terminalId)
    ) {
      return value.terminalId;
    }
  } catch {
    // 已有设置不可被默认值掩盖，用户仍可从设置表单主动替换。
  }
  throw new Error(
    t(
      "保存的终端设置无效或不受支持，请重新选择终端并保存。",
      "The saved terminal setting is invalid or unsupported. Select a terminal and save it again.",
    ),
  );
}

export async function getSelectedTerminal(): Promise<Terminal> {
  const terminalId = await readTerminalId();
  const terminal = (await getInstalledTerminals()).find((item) => item.id === terminalId);
  if (!terminal)
    throw new Error(
      t(
        "所选终端未安装，请打开终端设置重新选择并保存。",
        "The selected terminal is not installed. Open Terminal Settings, choose another terminal, and save.",
      ),
    );
  return terminal;
}

/** 保存时再次核对实际安装情况，再由系统脚本完成原子写入。 */
export async function saveTerminal(terminalId: string): Promise<void> {
  if (!(await getInstalledTerminals()).some((terminal) => terminal.id === terminalId)) {
    throw new Error(
      t(
        "请选择已安装且受支持的终端，然后重试保存。",
        "Select an installed, supported terminal and save again.",
      ),
    );
  }
  await runHelper("terminal", environment.supportPath, JSON.stringify({ terminalId }));
}
