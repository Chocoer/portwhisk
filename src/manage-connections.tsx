import { t } from "./i18n";
import ConnectionList from "./components/connection-list";

/** 管理命令复用新增、读取及未完成保存的恢复入口。 */
export default function ManageConnectionsCommand() {
  return <ConnectionList title={t("管理连接", "Manage Connections")} />;
}
