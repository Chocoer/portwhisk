import { t } from "./i18n";
import ConnectionList from "./components/connection-list";

/** 连接命令读取同一份已保存数据，提供首次新增入口。 */
export default function ConnectCommand() {
  return <ConnectionList title={t("连接服务器", "Connect to Server")} />;
}
