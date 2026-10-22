import { t } from "../i18n";
import { environment } from "@raycast/api";
import { Buffer } from "buffer";
import { randomUUID } from "crypto";
import { readFile } from "fs/promises";
import { join } from "path";
import { addCredential, deleteCredential } from "../credentials/keychain";
import { runHelper } from "../system-helper";

export interface ConnectionInput {
  name: string;
  host: string;
  username: string;
  port: string;
  password: string;
}

export interface Connection {
  id: string;
  name: string;
  host: string;
  username: string;
  port: number;
  credentialRef: string;
  status: "ready" | "pending" | "pending-edit" | "pending-delete";
}

const storageDirectory = join(environment.supportPath, "connections");
const storageFile = join(storageDirectory, "records.json");
const uuidPattern = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const connectionKeys = ["id", "name", "host", "username", "port", "credentialRef", "status"];
let writeQueue: Promise<unknown> = Promise.resolve();

function isIPv4(host: string): boolean {
  const parts = host.split(".");
  return (
    parts.length === 4 &&
    parts.every((part) => /^(0|[1-9][0-9]{0,2})$/.test(part) && Number(part) <= 255)
  );
}

// 不依赖宿主缺失的 node:net；IPv4 尾段在 IPv6 中占两个十六位组。
function isIPv6(host: string): boolean {
  if (!/^[0-9a-f:.]+$/i.test(host) || !host.includes(":")) return false;
  let address = host;
  if (address.includes(".")) {
    const lastColon = address.lastIndexOf(":");
    if (!isIPv4(address.slice(lastColon + 1))) return false;
    address = `${address.slice(0, lastColon + 1)}0:0`;
  }
  const halves = address.split("::");
  if (halves.length > 2) return false;
  const groups = halves.flatMap((part) => (part === "" ? [] : part.split(":")));
  if (!groups.every((part) => /^[0-9a-f]{1,4}$/i.test(part))) return false;
  return halves.length === 2 ? groups.length < 8 : groups.length === 8;
}

function isHost(host: string): boolean {
  if (host.includes(":")) return isIPv6(host);
  if (/^[0-9.]+$/.test(host)) return isIPv4(host);
  return (
    host.length <= 253 &&
    host.split(".").every((part) => /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/i.test(part))
  );
}

function hasControlCharacter(value: string): boolean {
  return Array.from(value).some((character) => {
    const code = character.charCodeAt(0);
    return code < 32 || code === 127;
  });
}

/** 校验可保存的 SSH 目标；密码原值只传给钥匙串，不做空白归一化。 */
export function validateInput(
  input: ConnectionInput,
  requirePassword = true,
): {
  errors: Partial<Record<keyof ConnectionInput, string>>;
  value?: Omit<ConnectionInput, "port"> & { port: number };
} {
  const errors: Partial<Record<keyof ConnectionInput, string>> = {};
  const name = input.name.trim();
  const host = input.host.trim();
  const username = input.username.trim();
  const portText = input.port.trim() || "22";
  const port = Number(portText);

  if (!name || hasControlCharacter(name)) {
    errors.name = t(
      "请输入连接名称，且不要包含控制字符",
      "Enter a connection name without control characters",
    );
  }
  if (!isHost(host)) {
    errors.host = t(
      "请输入主机名、IPv4 或 IPv6 地址，不包含命令、用户名或端口",
      "Enter a hostname, IPv4, or IPv6 address without a command, username, or port",
    );
  }
  if (!username || /^-/.test(username) || /\s/u.test(username) || hasControlCharacter(username)) {
    errors.username = t(
      "请输入用户名，不包含空白、控制字符或以 - 开头",
      "Enter a username without whitespace or control characters; it must not start with -",
    );
  }
  if (!/^[0-9]+$/.test(portText) || !Number.isInteger(port) || port < 1 || port > 65535) {
    errors.port = t(
      "端口必须是 1 到 65535 的整数，留空使用 22",
      "Port must be an integer from 1 to 65535; leave it empty to use 22",
    );
  }
  if (
    requirePassword &&
    (!input.password || ["\0", "\r", "\n"].some((character) => input.password.includes(character)))
  ) {
    errors.password = t(
      "请输入密码，密码不能包含 NUL 或换行",
      "Enter a password without NUL or line breaks",
    );
  } else if (
    requirePassword &&
    Array.from(input.password).some((character) => {
      const code = character.codePointAt(0)!;
      return code >= 0xd800 && code <= 0xdfff;
    })
  ) {
    errors.password = t(
      "密码包含无法完整编码的 Unicode 字符，请重新输入",
      "The password contains invalid Unicode characters. Enter it again",
    );
  } else if (requirePassword && Buffer.byteLength(input.password, "utf8") > 1023) {
    errors.password = t(
      "OpenSSH 自动密码认证最多支持 1023 字节的 UTF-8 密码",
      "OpenSSH automatic authentication supports UTF-8 passwords up to 1023 bytes",
    );
  }
  if (Object.keys(errors).length) return { errors };
  return { errors, value: { name, host, username, port, password: input.password } };
}

/** 拒绝损坏或未知格式，避免后续保存把仍需恢复的数据覆盖为空列表。 */
export async function listConnections(): Promise<Connection[]> {
  let stored: unknown;
  try {
    stored = await readFile(storageFile, "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
    throw new Error(
      t("无法读取连接信息，请稍后重试", "Could not read connections. Try again later"),
    );
  }
  let parsed: unknown;
  try {
    if (typeof stored !== "string") throw new Error();
    parsed = JSON.parse(stored);
  } catch {
    throw new Error(
      t(
        "连接存储已损坏或格式不兼容，已停止保存以保护现有数据",
        "Connection storage is damaged or incompatible. Saving has stopped to protect existing data",
      ),
    );
  }
  if (!Array.isArray(parsed)) {
    throw new Error(
      t(
        "连接存储已损坏或格式不兼容，已停止保存以保护现有数据",
        "Connection storage is damaged or incompatible. Saving has stopped to protect existing data",
      ),
    );
  }
  const ids = new Set<string>();
  return parsed.map((record: unknown) => {
    if (typeof record !== "object" || record === null) throw invalidStorage();
    const item = record as Record<string, unknown>;
    if (
      Object.keys(item).length !== connectionKeys.length ||
      !Object.keys(item).every((key) => connectionKeys.includes(key)) ||
      typeof item.id !== "string" ||
      !uuidPattern.test(item.id) ||
      ids.has(item.id) ||
      item.credentialRef !== item.id ||
      typeof item.name !== "string" ||
      typeof item.host !== "string" ||
      typeof item.username !== "string" ||
      typeof item.port !== "number" ||
      typeof item.status !== "string" ||
      !["ready", "pending", "pending-edit", "pending-delete"].includes(item.status)
    ) {
      throw invalidStorage();
    }
    const { value } = validateInput({
      name: item.name,
      host: item.host,
      username: item.username,
      port: String(item.port),
      password: "validation-only",
    });
    if (
      !value ||
      value.name !== item.name ||
      value.host !== item.host ||
      value.username !== item.username
    ) {
      throw invalidStorage();
    }
    ids.add(item.id);
    return {
      id: item.id,
      name: item.name,
      host: item.host,
      username: item.username,
      port: item.port,
      credentialRef: item.id,
      status: item.status as Connection["status"],
    };
  });
}

function invalidStorage(): Error {
  return new Error(
    t(
      "连接存储含有无效或不兼容的记录，已停止保存以保护现有数据",
      "Connection storage contains invalid or incompatible records. Saving has stopped to protect existing data",
    ),
  );
}

async function saveConnections(connections: Connection[], expected: Connection[]): Promise<void> {
  // Tinycast 的 LocalStorage 会吞落盘错误，fs.rename 会先删目标；交给系统脚本原子写。
  await runHelper("save", storageDirectory, JSON.stringify({ expected, connections }));
}

// 同一运行进程的读改写串行执行；失败不会阻塞下一次用户主动操作。
function serializeWrite<T>(operation: () => Promise<T>): Promise<T> {
  const result = writeQueue.then(operation);
  writeQueue = result.catch(() => undefined);
  return result;
}

/** 先写可追踪的待完成记录，再保存凭据；只有两边完成才标记可用。 */
export async function addConnection(input: ConnectionInput): Promise<Connection> {
  const { errors, value } = validateInput(input);
  if (!value) throw new Error(Object.values(errors).join(t("；", "; ")));
  return serializeWrite(async () => {
    const connections = await listConnections();
    const id = randomUUID();
    const pending: Connection = {
      id,
      name: value.name,
      host: value.host,
      username: value.username,
      port: value.port,
      credentialRef: id,
      status: "pending",
    };
    const withPending = [...connections, pending];
    try {
      await saveConnections(withPending, connections);
    } catch {
      throw new Error(
        t(
          "连接信息保存失败，尚未写入密码；请重新打开检查是否存在待清理记录",
          "Could not save the connection; the password has not been stored. Reopen the list and check for an incomplete record",
        ),
      );
    }

    try {
      await addCredential(id, value.password);
      const ready: Connection = { ...pending, status: "ready" };
      await saveConnections([...connections, ready], withPending);
      return ready;
    } catch {
      // 回执可能丢失；先核实已落盘的完整状态，再决定是否需要补偿，不能删除已提交的凭据。
      try {
        const current = await listConnections();
        const item = current.find((record) => record.id === id);
        if (item?.status === "ready") {
          if (JSON.stringify(item) === JSON.stringify({ ...pending, status: "ready" })) return item;
          throw new Error(t("连接状态已变化", "The connection has changed"));
        }
        if (item && JSON.stringify(item) !== JSON.stringify(pending)) {
          throw new Error(t("连接状态已变化", "The connection has changed"));
        }
        await deleteCredential(id);
        if (item)
          await saveConnections(
            current.filter((record) => record.id !== id),
            current,
          );
      } catch {
        throw new Error(
          t(
            `保存未完成，自动清理失败；连接编号 ${id}，请刷新并重试清理，勿覆盖现有数据`,
            `Saving and cleanup did not complete. Connection ID: ${id}. Refresh the list and retry cleanup without overwriting existing data`,
          ),
        );
      }
      throw new Error(
        t(
          "保存未完成，已撤回新增连接及对应凭据；请检查钥匙串授权和存储后重试",
          "Saving did not complete. The new connection and credential were removed. Check Keychain access and storage, then try again",
        ),
      );
    }
  });
}

/** 编辑快照在系统文件锁内再检查；保留密码时连秘密字段也不发送给辅助程序。 */
export async function updateConnection(
  expected: Connection,
  input: ConnectionInput,
  replacePassword: boolean,
): Promise<void> {
  const { errors, value } = validateInput(input, replacePassword);
  if (!value) throw new Error(Object.values(errors).join(t("；", "; ")));
  if (expected.status !== "ready" && expected.status !== "pending-edit") {
    throw new Error(
      t(
        "当前连接不能编辑，请刷新列表后重试",
        "This connection cannot be edited. Refresh the list and try again",
      ),
    );
  }
  if (expected.status === "pending-edit" && !replacePassword) {
    throw new Error(
      t(
        "编辑尚未完成，请明确替换密码以修复连接，或删除连接",
        "The edit is incomplete. Replace the password to repair the connection, or delete it",
      ),
    );
  }
  const connection: Connection = {
    id: expected.id,
    name: value.name,
    host: value.host,
    username: value.username,
    port: value.port,
    credentialRef: expected.credentialRef,
    status: "ready",
  };
  await serializeWrite(() =>
    runHelper(
      "edit-connection",
      storageDirectory,
      JSON.stringify({
        expected,
        connection,
        ...(replacePassword ? { password: value.password } : {}),
      }),
    ),
  );
}

/** 删除由系统脚本同一事务处理；失败保留专属引用，重试时凭据已不存在也能完成。 */
export async function deleteConnection(expected: Connection): Promise<void> {
  await serializeWrite(() =>
    runHelper("delete-connection", storageDirectory, JSON.stringify({ expected })),
  );
}

/** 旧新增失败记录也复用有快照保护的删除事务，避免误删并发修改。 */
export async function cleanupIncompleteConnection(id: string): Promise<void> {
  return serializeWrite(async () => {
    const connections = await listConnections();
    const connection = connections.find((item) => item.id === id);
    if (!connection || connection.status !== "pending") {
      throw new Error(
        t(
          "只能清理待完成的连接记录，请刷新列表后重试",
          "Only incomplete new connections can be cleaned up. Refresh the list and try again",
        ),
      );
    }
    await runHelper(
      "delete-connection",
      storageDirectory,
      JSON.stringify({ expected: connection }),
    );
  });
}
