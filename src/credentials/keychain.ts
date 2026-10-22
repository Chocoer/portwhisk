import { environment } from "@raycast/api";
import { join } from "path";
import { runHelper } from "../system-helper";

/** 新增当前稳定 ID 的密码；不覆盖已有条目，密码仅进入 stdin。 */
export async function addCredential(id: string, password: string): Promise<void> {
  await runHelper(
    "add",
    id,
    JSON.stringify({ password, directory: join(environment.supportPath, "connections") }),
  );
}

/** 仅供新增失败补偿使用；正常编辑/删除由持锁系统事务处理。 */
export async function deleteCredential(id: string): Promise<void> {
  await runHelper("delete", id, "");
}
