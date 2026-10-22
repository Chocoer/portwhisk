import { t } from "../i18n";
import { Action, ActionPanel, Form, Toast, showToast } from "@raycast/api";
import { useCallback, useEffect, useRef, useState } from "react";
import {
  getInstalledTerminals,
  readTerminalId,
  saveTerminal,
  type Terminal,
} from "../terminals/settings";

/** 失效设置只显示错误；用户主动选择并保存后才替换原偏好。 */
export default function TerminalSettingsForm({ onSaved }: { onSaved?: () => void }) {
  const [terminals, setTerminals] = useState<Terminal[]>([]);
  const [terminalId, setTerminalId] = useState("");
  const [error, setError] = useState<string>();
  const [isLoading, setIsLoading] = useState(true);
  const saving = useRef(false);

  const load = useCallback(async () => {
    setIsLoading(true);
    setError(undefined);
    try {
      const installed = await getInstalledTerminals();
      setTerminals(installed);
      const selectedId = await readTerminalId();
      if (!installed.some((terminal) => terminal.id === selectedId)) {
        setTerminalId("");
        setError(
          t(
            "所选终端未安装，请选择已安装的终端并保存。",
            "The selected terminal is not installed. Choose an installed terminal and save.",
          ),
        );
      } else {
        setTerminalId(selectedId);
      }
    } catch (cause) {
      setTerminalId("");
      setError(
        cause instanceof Error
          ? cause.message
          : t("无法加载终端设置，请重试。", "Could not load terminal settings. Try again."),
      );
    } finally {
      setIsLoading(false);
    }
  }, []);
  useEffect(() => {
    void load();
  }, [load]);

  async function submit(values: Form.Values) {
    if (saving.current || isLoading) return false;
    const selectedId = typeof values.terminalId === "string" ? values.terminalId : "";
    if (!selectedId) {
      setError(t("请选择已安装的终端。", "Choose an installed terminal."));
      return false;
    }
    saving.current = true;
    setIsLoading(true);
    try {
      await saveTerminal(selectedId);
      setError(undefined);
      await showToast({
        style: Toast.Style.Success,
        title: t("终端设置已保存", "Terminal Settings Saved"),
      });
      onSaved?.();
      return true;
    } catch (cause) {
      const message =
        cause instanceof Error
          ? cause.message
          : t("请检查系统权限后重试。", "Check system permissions and try again.");
      setError(message);
      await showToast({
        style: Toast.Style.Failure,
        title: t("终端设置未保存", "Terminal Settings Not Saved"),
        message,
      });
      return false;
    } finally {
      saving.current = false;
      setIsLoading(false);
    }
  }

  return (
    <Form
      navigationTitle={t("终端设置", "Terminal Settings")}
      enableDrafts={false}
      isLoading={isLoading}
      actions={
        <ActionPanel>
          {terminals.length > 0 && (
            <Action.SubmitForm
              title={t("保存终端设置", "Save Terminal Settings")}
              onSubmit={submit}
            />
          )}
          <Action title={t("重新加载终端", "Reload Terminals")} onAction={load} />
        </ActionPanel>
      }
    >
      <Form.Dropdown
        id="terminalId"
        title={t("默认终端", "Default Terminal")}
        value={terminalId}
        error={error}
        onChange={(value) => {
          setTerminalId(value);
          setError(undefined);
        }}
      >
        <Form.Dropdown.Item value="" title={t("请选择终端", "Choose a terminal")} />
        {terminals.map((terminal) => (
          <Form.Dropdown.Item key={terminal.id} value={terminal.id} title={terminal.name} />
        ))}
      </Form.Dropdown>
      <Form.Description
        title={t("启动说明", "About Launching")}
        text={t(
          "仅列出已安装的 Terminal 和 iTerm2。连接时创建新窗口，首次使用可能需要 macOS 自动化授权。",
          "Only installed Terminal and iTerm2 apps are listed. Connections open in a new window. macOS may request Automation permission on first use.",
        )}
      />
      {!isLoading && terminals.length === 0 && (
        <Form.Description
          title={t("没有可用终端", "No Available Terminals")}
          text={t(
            "请安装 Terminal 或 iTerm2 后重新加载。",
            "Install Terminal or iTerm2, then reload.",
          )}
        />
      )}
    </Form>
  );
}
