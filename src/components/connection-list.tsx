import { t } from "../i18n";
import {
  Action,
  ActionPanel,
  Alert,
  Detail,
  Icon,
  Keyboard,
  List,
  Toast,
  confirmAlert,
  showToast,
  useNavigation,
} from "@raycast/api";
import { useCallback, useEffect, useRef, useState } from "react";
import {
  cleanupIncompleteConnection,
  deleteConnection,
  listConnections,
  type Connection,
} from "../connections/store";
import ConnectionForm from "./connection-form";
import TerminalSettingsForm from "./terminal-settings-form";
import { connect } from "../terminals/launch";

/** 两个命令共用管理入口；未完成事务只允许对应恢复动作。 */
export default function ConnectionList({ title }: { title: string }) {
  const [connections, setConnections] = useState<Connection[]>([]);
  const [isLoading, setIsLoading] = useState(true);
  const [error, setError] = useState<string>();
  const deleting = useRef(new Set<string>());
  const { pop } = useNavigation();

  const reload = useCallback(async () => {
    setIsLoading(true);
    try {
      setConnections(await listConnections());
      setError(undefined);
    } catch (cause) {
      setError(
        cause instanceof Error
          ? cause.message
          : t("无法读取连接，请稍后重试。", "Could not load connections. Try again later."),
      );
    } finally {
      setIsLoading(false);
    }
  }, []);
  useEffect(() => {
    void reload();
  }, [reload]);

  async function remove(connection: Connection) {
    if (deleting.current.has(connection.id)) return;
    deleting.current.add(connection.id);
    const incomplete = connection.status === "pending";
    try {
      if (
        !(await confirmAlert({
          title: incomplete
            ? t(
                `清理未完成的连接「${connection.name}」？`,
                `Clean up incomplete connection “${connection.name}”?`,
              )
            : t(`删除连接「${connection.name}」？`, `Delete connection “${connection.name}”?`),
          message: t(
            `目标：${connection.username}@${connection.host}:${connection.port}。将同步删除此连接记录和 macOS 钥匙串中的对应密码。`,
            `Target: ${connection.username}@${connection.host}:${connection.port}. This deletes the connection and its password from macOS Keychain.`,
          ),
          primaryAction: {
            title: incomplete ? t("清理", "Clean Up") : t("删除连接", "Delete Connection"),
            style: Alert.ActionStyle.Destructive,
          },
          dismissAction: { title: t("取消", "Cancel"), style: Alert.ActionStyle.Cancel },
        }))
      ) {
        return;
      }
      try {
        if (incomplete) {
          await cleanupIncompleteConnection(connection.id);
        } else {
          await deleteConnection(connection);
        }
        await showToast({
          style: Toast.Style.Success,
          title: incomplete
            ? t("未完成记录已清理", "Incomplete Connection Removed")
            : t("连接及密码已删除", "Connection and Password Deleted"),
        });
      } catch (cause) {
        await showToast({
          style: Toast.Style.Failure,
          title: incomplete
            ? t("清理未完成", "Cleanup Failed")
            : t("连接未删除", "Connection Not Deleted"),
          message:
            cause instanceof Error
              ? cause.message
              : t("请检查钥匙串授权后重试。", "Check Keychain permissions and try again."),
        });
      }
      await reload();
    } finally {
      deleting.current.delete(connection.id);
    }
  }

  const addAction = (
    <Action.Push
      title={t("添加连接", "Add Connection")}
      icon={Icon.Plus}
      shortcut={Keyboard.Shortcut.Common.New}
      target={<ConnectionForm onSaved={reload} />}
    />
  );
  const settingsAction = (
    <Action.Push
      title={t("终端设置", "Terminal Settings")}
      icon={Icon.Terminal}
      target={<TerminalSettingsForm onSaved={pop} />}
    />
  );

  return (
    <List
      navigationTitle={title}
      searchBarPlaceholder={t(
        "搜索连接名称、主机或用户名",
        "Search by connection name, host, or username",
      )}
      isLoading={isLoading}
      actions={
        error ? undefined : (
          <ActionPanel>
            {addAction}
            {settingsAction}
          </ActionPanel>
        )
      }
    >
      {error ? (
        <List.EmptyView
          icon={Icon.Clock}
          title={t("无法读取连接", "Could Not Load Connections")}
          description={error}
          actions={
            <ActionPanel>
              <Action title={t("重新加载", "Reload")} onAction={reload} />
              {settingsAction}
            </ActionPanel>
          }
        />
      ) : (
        <>
          <List.Item
            title={t("添加连接", "Add Connection")}
            subtitle={t("保存新的 SSH 服务器", "Save a new SSH server")}
            icon={Icon.Plus}
            keywords={["新增", "添加", "add", "new"]}
            actions={
              <ActionPanel>
                {addAction}
                {settingsAction}
              </ActionPanel>
            }
          />
          <List.Section title={t("已保存的连接", "Saved Connections")}>
            {connections.map((connection) => (
              <List.Item
                key={connection.id}
                title={connection.name}
                subtitle={`${connection.username}@${connection.host}:${connection.port}`}
                keywords={[connection.host, connection.username]}
                icon={connection.status === "ready" ? Icon.Terminal : Icon.Clock}
                accessories={
                  connection.status === "ready"
                    ? []
                    : [
                        {
                          text:
                            connection.status === "pending-edit"
                              ? t("编辑未完成", "Edit Incomplete")
                              : connection.status === "pending-delete"
                                ? t("删除未完成", "Deletion Incomplete")
                                : t("保存未完成", "Save Incomplete"),
                        },
                      ]
                }
                actions={
                  <ActionPanel>
                    {connection.status === "pending" ? (
                      <Action
                        title={t("清理未完成记录", "Clean Up Incomplete Connection")}
                        style={Action.Style.Destructive}
                        onAction={() => remove(connection)}
                      />
                    ) : connection.status === "ready" ? (
                      <Action
                        title={t("连接服务器", "Connect to Server")}
                        icon={Icon.Terminal}
                        onAction={() => connect(connection.id)}
                      />
                    ) : null}
                    {(connection.status === "ready" || connection.status === "pending-edit") && (
                      <Action.Push
                        title={
                          connection.status === "pending-edit"
                            ? t("修复连接", "Repair Connection")
                            : t("编辑连接", "Edit Connection")
                        }
                        target={<ConnectionForm connection={connection} onSaved={reload} />}
                      />
                    )}
                    {connection.status !== "pending" && (
                      <Action
                        title={
                          connection.status === "pending-delete"
                            ? t("重试删除", "Retry Deletion")
                            : t("删除连接", "Delete Connection")
                        }
                        style={Action.Style.Destructive}
                        onAction={() => remove(connection)}
                      />
                    )}
                    {connection.status === "ready" && (
                      <Action.Push
                        title={t("查看连接信息", "View Connection Details")}
                        target={
                          <Detail
                            navigationTitle={connection.name}
                            markdown={t(
                              "连接信息已保存。连接时会在所选终端的新窗口中启动 SSH；首次连接请在终端核对主机指纹。",
                              "Connection details are saved. Connecting starts SSH in a new window of your selected terminal. Verify the host fingerprint in the terminal on your first connection.",
                            )}
                            metadata={
                              <Detail.Metadata>
                                <Detail.Metadata.Label
                                  title={t("名称", "Name")}
                                  text={connection.name}
                                />
                                <Detail.Metadata.Label
                                  title={t("主机", "Host")}
                                  text={connection.host}
                                />
                                <Detail.Metadata.Label
                                  title={t("用户名", "Username")}
                                  text={connection.username}
                                />
                                <Detail.Metadata.Label
                                  title={t("端口", "Port")}
                                  text={String(connection.port)}
                                />
                              </Detail.Metadata>
                            }
                          />
                        }
                      />
                    )}
                    {addAction}
                    {settingsAction}
                  </ActionPanel>
                }
              />
            ))}
          </List.Section>
          <List.EmptyView
            title={t("没有匹配的连接", "No Matching Connections")}
            description={t(
              "可按名称、主机或用户名搜索，或添加新连接。",
              "Search by name, host, or username, or add a connection.",
            )}
            actions={
              <ActionPanel>
                {addAction}
                {settingsAction}
              </ActionPanel>
            }
          />
        </>
      )}
    </List>
  );
}
