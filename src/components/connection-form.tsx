import { t } from "../i18n";
import { Action, ActionPanel, Form, Toast, showToast, useNavigation } from "@raycast/api";
import { useRef, useState } from "react";
import {
  addConnection,
  updateConnection,
  validateInput,
  type Connection,
  type ConnectionInput,
} from "../connections/store";

/** 编辑只预填普通字段；保留密码时不读取凭据，替换必须由用户明确选择。 */
export default function ConnectionForm({
  onSaved,
  connection,
}: {
  onSaved: () => Promise<void>;
  connection?: Connection;
}) {
  const repairing = connection?.status === "pending-edit";
  const [passwordMode, setPasswordMode] = useState(repairing ? "replace" : "keep");
  const [errors, setErrors] = useState<Partial<Record<keyof ConnectionInput, string>>>({});
  const [isSaving, setIsSaving] = useState(false);
  const [needsReopen, setNeedsReopen] = useState(false);
  const saving = useRef(false);
  const invalidated = useRef(false);
  const { pop } = useNavigation();

  async function submit(values: Form.Values) {
    if (saving.current || invalidated.current) return false;
    const text = (key: string) => (typeof values[key] === "string" ? values[key] : "");
    const replacePassword = !connection || repairing || text("passwordMode") === "replace";
    const input: ConnectionInput = {
      name: text("name"),
      host: text("host"),
      username: text("username"),
      port: text("port"),
      password: replacePassword ? text("password") : "",
    };
    const validation = validateInput(input, replacePassword);
    setErrors(validation.errors);
    if (!validation.value) return false;

    saving.current = true;
    setIsSaving(true);
    try {
      if (connection) {
        await updateConnection(connection, input, replacePassword);
      } else {
        await addConnection(input);
      }
    } catch (error) {
      // 写入可能已进入恢复状态，旧表单快照不能继续覆盖当前记录。
      if (connection) {
        invalidated.current = true;
        setNeedsReopen(true);
      }
      await onSaved();
      await showToast({
        style: Toast.Style.Failure,
        title: t("连接未保存", "Connection Not Saved"),
        message:
          error instanceof Error
            ? error.message
            : t(
                "请检查系统授权与存储后重试。",
                "Check system permissions and storage, then try again.",
              ),
      });
      return false;
    } finally {
      saving.current = false;
      setIsSaving(false);
    }
    await onSaved();
    await showToast({ style: Toast.Style.Success, title: t("连接已保存", "Connection Saved") });
    pop();
    return true;
  }

  const clearError = (field: keyof ConnectionInput) => () =>
    setErrors((current) => ({ ...current, [field]: undefined }));

  return (
    <Form
      navigationTitle={
        connection
          ? repairing
            ? t("修复连接", "Repair Connection")
            : t("编辑连接", "Edit Connection")
          : t("添加连接", "Add Connection")
      }
      enableDrafts={false}
      isLoading={isSaving}
      actions={
        <ActionPanel>
          {needsReopen ? (
            <Action title={t("返回连接列表", "Back to Connections")} onAction={pop} />
          ) : (
            <Action.SubmitForm title={t("保存连接", "Save Connection")} onSubmit={submit} />
          )}
        </ActionPanel>
      }
    >
      <Form.TextField
        id="name"
        title={t("连接名称", "Connection Name")}
        placeholder={t("例如：开发服务器", "e.g. Development server")}
        defaultValue={connection?.name}
        error={errors.name}
        onChange={clearError("name")}
      />
      <Form.TextField
        id="host"
        title={t("主机地址", "Host Address")}
        placeholder={t(
          "主机名、IPv4 或 IPv6，不包含端口",
          "Hostname, IPv4, or IPv6, without a port",
        )}
        defaultValue={connection?.host}
        error={errors.host}
        onChange={clearError("host")}
      />
      <Form.TextField
        id="username"
        title={t("用户名", "Username")}
        placeholder={t("SSH 登录用户", "SSH login username")}
        defaultValue={connection?.username}
        error={errors.username}
        onChange={clearError("username")}
      />
      <Form.TextField
        id="port"
        title={t("端口", "Port")}
        defaultValue={String(connection?.port ?? 22)}
        error={errors.port}
        onChange={clearError("port")}
      />
      {connection && (
        <Form.Dropdown
          id="passwordMode"
          title={t("密码处理", "Password")}
          value={passwordMode}
          onChange={(value) => {
            setPasswordMode(value);
            clearError("password")();
          }}
        >
          {!repairing && (
            <Form.Dropdown.Item value="keep" title={t("保留已保存密码", "Keep Saved Password")} />
          )}
          <Form.Dropdown.Item value="replace" title={t("替换密码", "Replace Password")} />
        </Form.Dropdown>
      )}
      {(!connection || passwordMode === "replace") && (
        <Form.PasswordField
          id="password"
          title={connection ? t("新密码", "New Password") : t("密码", "Password")}
          error={errors.password}
          onChange={clearError("password")}
        />
      )}
      <Form.Description
        title={t("保存说明", "About Saving")}
        text={t(
          "密码保存在 macOS 钥匙串中；保存连接不会访问服务器。",
          "Passwords are stored in macOS Keychain. Saving a connection does not contact the server.",
        )}
      />
      {repairing && (
        <Form.Description
          title={t("修复说明", "About Repairing")}
          text={t(
            "上次密码编辑未完成，原连接字段仍保留。请重新输入要使用的密码，成功后恢复连接。",
            "The previous password change was incomplete. Your original connection details are preserved. Enter the password to restore this connection.",
          )}
        />
      )}
      {needsReopen && (
        <Form.Description
          title={t("请重新打开", "Reopen This Connection")}
          text={t(
            "连接状态已刷新。请返回列表后重新编辑或处理未完成记录，避免覆盖其他变化。",
            "The connection status has changed. Return to the list and reopen this connection or resolve the incomplete operation to avoid overwriting other changes.",
          )}
        />
      )}
    </Form>
  );
}
