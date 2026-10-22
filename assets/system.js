/* exported run */
ObjC.import("Foundation");
ObjC.import("AppKit");
ObjC.import("Security");
ObjC.import("stdlib");

// 只使用系统现有 ABI；不编译或加载项目自带的原生模块。
[
  ["getuid", "int", []],
  ["getpid", "int", []],
  ["getppid", "int", []],
  ["isatty", "int", ["int"]],
  ["open", "int", ["char *", "int"]],
  ["close", "int", ["int"]],
  ["flock", "int", ["int", "int"]],
  ["__error", "int *", []],
  ["proc_pidpath", "int", ["int", "void *", "unsigned int"]],
  ["proc_pidinfo", "int", ["int", "int", "unsigned long long", "void *", "int"]],
  ["kill", "int", ["int", "int"]],
  ["usleep", "int", ["unsigned int"]],
  ["calloc", "void**", ["unsigned long", "unsigned long"]],
  ["strdup", "pointer", ["string"]],
  ["execv", "int", ["string", "pointer"]],
  ["setenv", "int", ["string", "string", "int"]],
  ["unsetenv", "int", ["string"]],
  ["SecItemCopyMatching", "int", ["pointer", "pointer"]],
  ["SecItemAdd", "int", ["pointer", "pointer"]],
  ["SecAccessCreate", "int", ["pointer", "pointer", "pointer"]],
  ["SecItemUpdate", "int", ["pointer", "pointer"]],
  ["SecItemDelete", "int", ["pointer"]],
  ["readpassphrase", "string", ["string", "pointer", "unsigned long", "int"]],
  ["memset", "void *", ["void *", "int", "unsigned long"]],
].forEach(function (binding) {
  ObjC.bindFunction(binding[0], [binding[1], binding[2]]);
});

// Intel 的无后缀 stat 符号保留旧 inode ABI；按当前脚本进程架构绑定公开的 64 位接口。
ObjC.bindFunction("NXGetLocalArchInfo", ["int*", []]);
const cpuType = $.NXGetLocalArchInfo()[2] & 0xffffff;
if (cpuType !== 7 && cpuType !== 12) throw new Error("Unsupported system architecture");
const fstatSymbol = cpuType === 7 ? "fstat$INODE64" : "fstat";
const lstatSymbol = cpuType === 7 ? "lstat$INODE64" : "lstat";
ObjC.bindFunction(fstatSymbol, ["int", ["int", "pointer"]]);
ObjC.bindFunction(lstatSymbol, ["int", ["string", "pointer"]]);

const fm = $.NSFileManager.defaultManager;
const environment = ObjC.deepUnwrap($.NSProcessInfo.processInfo.environment);
const script = ObjC.deepUnwrap($.NSProcessInfo.processInfo.arguments)[3];
const assets = ObjC.unwrap($(script).stringByDeletingLastPathComponent);
const core = eval(
  ObjC.unwrap(
    $.NSString.stringWithContentsOfFileEncodingError(
      assets + "/system-core.js",
      $.NSUTF8StringEncoding,
      null,
    ),
  ),
);
let boundSSH = null;

function fail(status) {
  const error = new Error("Portwhisk system operation failed");
  error.status = status;
  throw error;
}
function requireValue(condition, status) {
  if (!condition) fail(status === undefined ? -50 : status);
}
function dataFor(text) {
  return $(text).dataUsingEncoding($.NSUTF8StringEncoding);
}
function stringFor(data) {
  const value = $.NSString.alloc.initWithDataEncoding(data, $.NSUTF8StringEncoding);
  requireValue(!value.isNil());
  return ObjC.unwrap(value);
}
function stdout(value) {
  $.NSFileHandle.fileHandleWithStandardOutput.writeData(dataFor(value));
}
function result(value) {
  stdout(JSON.stringify(value));
}
function normalized(path) {
  return (
    typeof path === "string" &&
    path.charAt(0) === "/" &&
    ObjC.unwrap($(path).stringByStandardizingPath) === path
  );
}
function attributes(path, allowMissing) {
  const buffer = $.NSMutableData.dataWithLength(256);
  if ($[lstatSymbol](path, buffer.mutableBytes) !== 0) {
    if (allowMissing && $.__error()[0] === 2) return null;
    fail(-70004);
  }
  const data = bytes(buffer);
  const mode = unsigned(data, 4, 2);
  const kind = mode & 61440;
  return {
    NSFileType:
      kind === 16384 ? "NSFileTypeDirectory" : kind === 32768 ? "NSFileTypeRegular" : "other",
    NSFileOwnerAccountID: unsigned(data, 16, 4),
    NSFilePosixPermissions: mode & 511,
  };
}
function privateDirectory(path) {
  const value = attributes(path);
  return (
    value.NSFileType === "NSFileTypeDirectory" &&
    value.NSFileOwnerAccountID === $.getuid() &&
    (value.NSFilePosixPermissions & 63) === 0
  );
}
function makeDirectory(path, allowPublic) {
  requireValue(normalized(path));
  const error = Ref();
  requireValue(
    fm.createDirectoryAtPathWithIntermediateDirectoriesAttributesError(
      path,
      true,
      $({ NSFilePosixPermissions: 448 }),
      error,
    ),
    -70004,
  );
  requireValue(
    allowPublic
      ? attributes(path).NSFileType === "NSFileTypeDirectory" &&
          attributes(path).NSFileOwnerAccountID === $.getuid()
      : privateDirectory(path),
    -70004,
  );
}
function setPrivateFile(path) {
  requireValue(
    fm.setAttributesOfItemAtPathError($({ NSFilePosixPermissions: 384 }), path, Ref()),
    -70004,
  );
}
function readBounded(handle, limit) {
  const data = $.NSMutableData.data;
  while (true) {
    const chunk = handle.readDataOfLength(8192);
    if (Number(chunk.length) === 0) return data;
    data.appendData(chunk);
    requireValue(Number(data.length) <= limit);
  }
}
function readJSON(path) {
  const handle = $.NSFileHandle.fileHandleForReadingAtPath(path);
  requireValue(!handle.isNil(), -70004);
  try {
    return JSON.parse(stringFor(readBounded(handle, 1048576)));
  } finally {
    handle.closeAndReturnError(Ref());
  }
}
function writeJSON(path, value) {
  writeText(path, JSON.stringify(value));
}
function writeText(path, value) {
  requireValue(dataFor(value).writeToFileOptionsError(path, $.NSDataWritingAtomic, Ref()), -70004);
  setPrivateFile(path);
}
function exclusiveFile(path, value) {
  // Foundation 的排他创建避免 ARM 可变参数 open(mode) 的脚本桥 ABI 差异。
  requireValue(
    dataFor(value || "").writeToFileOptionsError(path, $.NSDataWritingWithoutOverwriting, Ref()),
  );
  setPrivateFile(path);
}

// 仅解码 proc/fstat 的非秘密元数据；密码始终保留为 NSData 或原值字符串。
function bytes(data) {
  const encoded = ObjC.unwrap(data.base64EncodedStringWithOptions(0));
  const alphabet = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
  const output = [];
  let bits = 0;
  let count = 0;
  for (let i = 0; i < encoded.length && encoded[i] !== "="; i++) {
    bits = (bits << 6) | alphabet.indexOf(encoded[i]);
    count += 6;
    if (count >= 8) {
      count -= 8;
      output.push((bits >>> count) & 255);
    }
  }
  return output;
}
function unsigned(data, offset, length) {
  let value = 0;
  for (let i = length - 1; i >= 0; i--) value = value * 256 + data[offset + i];
  return value;
}
function executablePath(pid) {
  const buffer = $.NSMutableData.dataWithLength(4096);
  const length = $.proc_pidpath(pid, buffer.mutableBytes, 4096);
  if (length <= 0) return null;
  return stringFor(buffer.subdataWithRange($.NSMakeRange(0, length))).replace(/\0.*$/, "");
}
function processIdentity(pid) {
  if (!Number.isInteger(pid) || pid <= 1) return null;
  const buffer = $.NSMutableData.dataWithLength(136);
  // Darwin proc_bsdinfo 的公开 LP64 布局，ARM/Intel 相同；返回尺寸变化时停止。
  if ($.proc_pidinfo(pid, 3, 0, buffer.mutableBytes, 136) !== 136) return null;
  const data = bytes(buffer);
  return {
    pid,
    status: unsigned(data, 4, 4),
    seconds: unsigned(data, 120, 8),
    micros: unsigned(data, 128, 8),
    parentPID: unsigned(data, 16, 4),
  };
}
function sameProcess(identity, path) {
  if (!identity) return false;
  const current = processIdentity(identity.pid);
  return (
    !!current &&
    current.seconds === identity.seconds &&
    current.micros === identity.micros &&
    (!path || executablePath(identity.pid) === path)
  );
}
function isShell(pid) {
  return ["/bin/sh", "/bin/bash"].indexOf(executablePath(pid)) !== -1;
}
function sameShell(identity) {
  return sameProcess(identity) && isShell(identity.pid);
}
function readRecords(directory) {
  const path = directory + "/records.json";
  if (!attributes(path, true)) return [];
  const records = readJSON(path);
  try {
    core.validateConnections(records);
  } catch {
    fail(-70004);
  }
  return records;
}
function withLock(directory, action) {
  makeDirectory(directory);
  const lock = directory + "/.lock";
  if (!attributes(lock, true)) {
    const error = Ref();
    if (dataFor("").writeToFileOptionsError(lock, $.NSDataWritingWithoutOverwriting, error))
      setPrivateFile(lock);
    else requireValue(!!attributes(lock, true), -70004);
  }
  const descriptor = $.open(lock, 2 | 256);
  requireValue(descriptor >= 0, -70004);
  try {
    const buffer = $.NSMutableData.dataWithLength(256);
    requireValue($[fstatSymbol](descriptor, buffer.mutableBytes) === 0, -70004);
    const metadata = bytes(buffer);
    const mode = unsigned(metadata, 4, 2);
    requireValue(
      (mode & 61440) === 32768 && (mode & 63) === 0 && unsigned(metadata, 16, 4) === $.getuid(),
      -70004,
    );
    requireValue($.flock(descriptor, 6) === 0, -70001);
    try {
      return action();
    } finally {
      $.flock(descriptor, 8);
    }
  } finally {
    $.close(descriptor);
  }
}

function securityConstant(value) {
  return ObjC.castRefToObject(value);
}
function credentialQuery(id) {
  requireValue(core.validUUID(id));
  const query = $.NSMutableDictionary.dictionary;
  query.setObjectForKey(
    securityConstant($.kSecClassGenericPassword),
    securityConstant($.kSecClass),
  );
  query.setObjectForKey($("dev.portwhisk.ssh"), securityConstant($.kSecAttrService));
  query.setObjectForKey($(id), securityConstant($.kSecAttrAccount));
  return query;
}
function passwordData(value) {
  return typeof value === "string" ? dataFor(value) : value;
}
const credentials = {
  read: function (id) {
    const query = credentialQuery(id);
    query.setObjectForKey($(true), securityConstant($.kSecReturnData));
    query.setObjectForKey(
      securityConstant($.kSecMatchLimitOne),
      securityConstant($.kSecMatchLimit),
    );
    const found = Ref("id*");
    const status = $.SecItemCopyMatching(ObjC.castObjectToRef(query), found);
    if (status === -25300) return null;
    if (status !== 0) fail(status);
    return ObjC.castRefToObject(found[0]);
  },
  add: function (id, value) {
    const query = credentialQuery(id);
    query.setObjectForKey($("Portwhisk SSH"), securityConstant($.kSecAttrLabel));
    query.setObjectForKey(passwordData(value), securityConstant($.kSecValueData));
    // 系统脚本运行器是共享身份；新条目不默认信任创建者，也不改动已有条目的 ACL。
    const access = Ref("id*");
    const accessStatus = $.SecAccessCreate(
      ObjC.castObjectToRef($("Portwhisk SSH")),
      ObjC.castObjectToRef($.NSArray.array),
      access,
    );
    if (accessStatus !== 0) fail(accessStatus);
    query.setObjectForKey(ObjC.castRefToObject(access[0]), securityConstant($.kSecAttrAccess));
    const status = $.SecItemAdd(ObjC.castObjectToRef(query), null);
    if (status !== 0) fail(status);
  },
  update: function (id, value) {
    const update = $.NSMutableDictionary.dictionary;
    update.setObjectForKey(passwordData(value), securityConstant($.kSecValueData));
    const status = $.SecItemUpdate(
      ObjC.castObjectToRef(credentialQuery(id)),
      ObjC.castObjectToRef(update),
    );
    if (status !== 0) fail(status);
  },
  delete: function (id) {
    const status = $.SecItemDelete(ObjC.castObjectToRef(credentialQuery(id)));
    if (status !== 0 && status !== -25300) fail(status);
  },
};
function connectionIO(directory) {
  requireValue(normalized(directory));
  return {
    withLock: function (action) {
      return withLock(directory, action);
    },
    readRecords: function () {
      return readRecords(directory);
    },
    writeRecords: function (records) {
      writeJSON(directory + "/records.json", records);
    },
    credentials,
  };
}

function loadSession(path, allowExpired) {
  requireValue(normalized(path));
  const directory = ObjC.unwrap($(path).lastPathComponent);
  const parent = ObjC.unwrap($(path).stringByDeletingLastPathComponent);
  requireValue(
    core.validUUID(directory) &&
      ObjC.unwrap($(parent).lastPathComponent) === "sessions" &&
      privateDirectory(path),
  );
  const session = readJSON(path + "/session.json");
  requireValue(
    session.id === directory &&
      core.validConnection(session.connection) &&
      session.connection.status === "ready" &&
      Number.isFinite(session.createdAt),
  );
  const age = Date.now() / 1000 - session.createdAt;
  requireValue(allowExpired || (age >= -5 && age <= 300 && !attributes(path + "/cancelled", true)));
  return session;
}
function removeSession(path) {
  requireValue(fm.removeItemAtPathError(path, Ref()), -70004);
}
function pruneSessions(root) {
  const paths = fm.contentsOfDirectoryAtPathError(root, Ref());
  requireValue(!paths.isNil(), -70004);
  ObjC.deepUnwrap(paths).forEach(function (name) {
    const path = root + "/" + name;
    try {
      const session = loadSession(path, true);
      if (Date.now() / 1000 - session.createdAt <= 300) return;
      if (attributes(path + "/runner.json", true)) {
        const runner = readJSON(path + "/runner.json");
        if (sameProcess(runner) || $.kill(runner.pid, 0) === 0) return;
      }
      removeSession(path);
    } catch {
      /* 未知、损坏或仍在使用的目录留待明确处理，不扩大清理范围。 */
    }
  });
}
function prepareSession(support, request) {
  requireValue(normalized(support) && core.validUUID(request.connectionId));
  const records = readRecords(support + "/connections");
  const connection = records.find(function (record) {
    return record.id === request.connectionId;
  });
  requireValue(connection && connection.status === "ready");
  const root = support + "/sessions";
  makeDirectory(root);
  pruneSessions(root);
  const id = ObjC.unwrap($.NSUUID.UUID.UUIDString).toLowerCase();
  const path = root + "/" + id;
  makeDirectory(path);
  try {
    writeJSON(path + "/session.json", { id, connection, createdAt: Date.now() / 1000 });
  } catch (error) {
    removeSession(path);
    throw error;
  }
  return id;
}
function startSession(path) {
  loadSession(path);
  const parent = $.getppid();
  requireValue($.isatty(0) === 1 && isShell(parent));
  exclusiveFile(path + "/started");
  const runner = processIdentity(parent);
  requireValue(runner);
  writeJSON(path + "/runner.json", runner);
}
function executeSSH(path) {
  const session = loadSession(path);
  const runner = readJSON(path + "/runner.json");
  const identity = processIdentity($.getpid());
  requireValue(
    $.isatty(0) === 1 && identity && identity.parentPID === runner.pid && sameShell(runner),
  );
  exclusiveFile(path + "/ssh-identity.json", JSON.stringify(identity));
  exclusiveFile(path + "/ssh-pid.json", JSON.stringify(identity.pid));
  const variables = {
    PORTWHISK_SSH_SESSION: path,
    PORTWHISK_SSH_PID: String(identity.pid),
    SSH_ASKPASS: assets + "/keychain-helper",
    SSH_ASKPASS_REQUIRE: "force",
    DISPLAY: "portwhisk",
    LC_ALL: "C",
  };
  Object.keys(variables).forEach(function (key) {
    requireValue($.setenv(key, variables[key], 1) === 0);
  });
  requireValue($.unsetenv("SSH_ASKPASS_PROMPT") === 0);
  // execv 继承同一 PID；所有参数独立编码，不生成 shell 命令或密码文件。
  const values = ["/usr/bin/ssh"].concat(core.sshArguments(session.connection));
  const argv = $.calloc(values.length + 1, 8);
  values.forEach(function (value, index) {
    argv[index] = $.strdup(value);
  });
  loadSession(path);
  $.execv(values[0], argv);
  fail(-50);
}
function signalSSH(path, value) {
  loadSession(path, true);
  const runner = readJSON(path + "/runner.json");
  requireValue(runner.pid === $.getppid() && sameShell(runner) && [1, 2, 15].indexOf(value) !== -1);
  if (!attributes(path + "/cancelled", true)) exclusiveFile(path + "/cancelled");
  if (!attributes(path + "/ssh-identity.json", true)) return;
  const identity = readJSON(path + "/ssh-identity.json");
  if (sameProcess(identity, "/usr/bin/ssh")) $.kill(identity.pid, value);
}
function finishSession(path) {
  loadSession(path, true);
  const runner = readJSON(path + "/runner.json");
  requireValue(runner.pid === $.getppid() && sameShell(runner));
  if (attributes(path + "/ssh-identity.json", true))
    requireValue(!sameProcess(readJSON(path + "/ssh-identity.json")));
  removeSession(path);
}
function discardSession(path) {
  loadSession(path, true);
  if (attributes(path + "/runner.json", true)) {
    const runner = readJSON(path + "/runner.json");
    if (sameProcess(runner)) {
      requireValue(isShell(runner.pid));
      $.kill(runner.pid, 15);
      for (let i = 0; i < 100 && sameShell(runner); i++) $.usleep(20000);
      requireValue(!sameShell(runner));
    } else if ($.kill(runner.pid, 0) === 0 && !processIdentity(runner.pid)) fail(-50);
  }
  if (attributes(path, true)) removeSession(path);
}
function replyOnTTY(prompt, secret) {
  requireValue(dataFor(prompt).length <= 16384);
  const buffer = $.NSMutableData.dataWithLength(1025);
  try {
    const reply = $.readpassphrase(prompt, buffer.mutableBytes, 1025, 2 | (secret ? 0 : 1));
    requireValue(typeof reply === "string");
    const value = reply;
    requireValue(core.validPassword(value));
    return dataFor(value);
  } finally {
    $.memset(buffer.mutableBytes, 0, 1025);
  }
}
function parentSSH() {
  const pid = Number(environment.PORTWHISK_SSH_PID);
  const wrapper = processIdentity($.getppid());
  requireValue(
    wrapper &&
      isShell(wrapper.pid) &&
      wrapper.parentPID === pid &&
      executablePath(pid) === "/usr/bin/ssh",
  );
  const identity = processIdentity(pid);
  requireValue(identity);
  return identity;
}
function isBoundSSH(identity) {
  const wrapper = processIdentity($.getppid());
  return (
    wrapper &&
    isShell(wrapper.pid) &&
    wrapper.parentPID === identity.pid &&
    sameProcess(identity, "/usr/bin/ssh")
  );
}
function stopBoundSSH(childPID) {
  const wrapper = processIdentity($.getppid());
  requireValue(wrapper && sameShell(wrapper));
  const child = processIdentity(childPID);
  const identity = processIdentity(Number(environment.PORTWHISK_SSH_PID));
  if (identity && isBoundSSH(identity)) $.kill(identity.pid, 9);
  // SSH 已退出时也回收本壳的认证进程；发信号前复核启动身份、路径和父关系。
  stopAskpassChild(child, wrapper);
}
function stopAskpassChild(child, wrapper) {
  function stillOwned() {
    const current = child && processIdentity(child.pid);
    return (
      child &&
      current &&
      current.status !== 5 &&
      child.pid !== $.getpid() &&
      sameProcess(child, "/usr/bin/osascript") &&
      ((sameShell(wrapper) && current.parentPID === wrapper.pid) ||
        (!sameProcess(wrapper) && current.parentPID === 1))
    );
  }
  if (!stillOwned()) return;
  // 先让 readpassphrase 的信号处理恢复终端回显；只对原身份的顽固进程有限升级。
  $.kill(child.pid, 15);
  for (let i = 0; i < 25; i++) {
    if (!stillOwned()) return;
    $.usleep(20000);
  }
  if (stillOwned()) $.kill(child.pid, 9);
}
// 单进程监督本次父 SSH 与认证子进程，避免授权/TTY 等待在父进程退出后遗留。
function watchAskpass(childPID) {
  const wrapper = processIdentity($.getppid());
  requireValue(wrapper && sameShell(wrapper));
  const child = processIdentity(childPID);
  // 壳可能已回收瞬时完成的子进程；SZOMB=5 表示退出后尚未 wait。
  if (!child || child.pid === $.getpid() || child.status === 5) return;
  const path = executablePath(child.pid);
  const current = processIdentity(child.pid);
  if (!current || current.status === 5 || !sameProcess(child)) return;
  requireValue(child.parentPID === wrapper.pid && path === "/usr/bin/osascript");
  const ssh = processIdentity(Number(environment.PORTWHISK_SSH_PID));
  const bound = ssh && isBoundSSH(ssh);
  while (true) {
    const current = processIdentity(child.pid);
    if (!current || !sameProcess(child) || current.status === 5) return;
    if (!sameShell(wrapper) || !ssh || !isBoundSSH(ssh)) {
      // 包装壳被强制终止时，仍按此前绑定的启动身份先停止 SSH，再关闭认证输出。
      if (bound && sameProcess(ssh, "/usr/bin/ssh")) $.kill(ssh.pid, 9);
      stopAskpassChild(child, wrapper);
      fail(-75002);
    }
    $.usleep(100000);
  }
}
function answerAskpass(prompt) {
  boundSSH = parentSSH();
  const pid = boundSSH.pid;
  const path = environment.PORTWHISK_SSH_SESSION;
  const session = loadSession(path);
  requireValue(
    readJSON(path + "/ssh-pid.json") === pid &&
      sameProcess(readJSON(path + "/ssh-identity.json"), "/usr/bin/ssh"),
  );
  if (
    environment.SSH_ASKPASS_PROMPT === undefined &&
    (core.isHostConfirmation(prompt) || core.isInteractiveChallenge(prompt, session))
  ) {
    const reply = replyOnTTY(prompt, !core.isHostConfirmation(prompt));
    loadSession(path);
    $.NSFileHandle.fileHandleWithStandardOutput.writeData(reply);
    return;
  }
  requireValue(
    core.passwordRequestAllowed(session, {
      prompt,
      hint: environment.SSH_ASKPASS_PROMPT,
      parentPID: processIdentity($.getppid()).parentPID,
      sshPID: pid,
      parentPath: executablePath(pid),
      alreadyUsed: !!attributes(path + "/password-used", true),
      now: Date.now() / 1000,
    }),
  );
  exclusiveFile(path + "/password-used");
  const support = ObjC.unwrap(
    $(ObjC.unwrap($(path).stringByDeletingLastPathComponent)).stringByDeletingLastPathComponent,
  );
  withLock(support + "/connections", function () {
    requireValue(
      core.currentConnectionAllowsPassword(
        session.connection,
        readRecords(support + "/connections"),
      ),
    );
    const password = credentials.read(session.connection.credentialRef);
    requireValue(password && core.validPassword(stringFor(password)));
    loadSession(path);
    $.NSFileHandle.fileHandleWithStandardOutput.writeData(password);
  });
}

function run(args) {
  const askpass = args.length === 1 && environment.PORTWHISK_SSH_SESSION !== undefined;
  const operation = args[0];
  try {
    if (askpass) {
      answerAskpass(operation);
      return;
    }
    if (operation === "ssh-stop" || operation === "ssh-watch") {
      requireValue(args.length === 3 && args[1] === environment.PORTWHISK_SSH_SESSION);
      if (operation === "ssh-stop") stopBoundSSH(Number(args[2]));
      else {
        watchAskpass(Number(args[2]));
        // 保留状态区分已确认的完成与运行器意外退出 0，避免壳错误地继续等待认证。
        $.exit(73);
      }
      return;
    }
    if (operation === "ssh-signal") {
      requireValue(args.length === 3);
      signalSSH(args[1], Number(args[2]));
      return;
    }
    requireValue(args.length === 2);
    const target = args[1];
    if (["ssh-start-prepare", "ssh-exec", "ssh-finish"].indexOf(operation) !== -1) {
      ({ "ssh-start-prepare": startSession, "ssh-exec": executeSSH, "ssh-finish": finishSession })[
        operation
      ](target);
      return;
    }
    if (operation === "terminals") {
      const ids = ["com.apple.Terminal", "com.googlecode.iterm2"].filter(function (id) {
        const url = $.NSWorkspace.sharedWorkspace.URLForApplicationWithBundleIdentifier(id);
        if (url.isNil()) return false;
        const bundle = $.NSBundle.bundleWithURL(url);
        return (
          ObjC.unwrap(bundle.bundleIdentifier) === id &&
          fm.isExecutableFileAtPath(ObjC.unwrap(bundle.executablePath))
        );
      });
      result({ status: 0, terminalIds: ids });
      return;
    }
    if (operation === "delete") {
      credentials.delete(target);
      result({ status: 0 });
      return;
    }
    if (operation === "ssh-discard") {
      discardSession(target);
      result({ status: 0 });
      return;
    }
    const request = JSON.parse(
      stringFor(readBounded($.NSFileHandle.fileHandleWithStandardInput, 1048576)),
    );
    if (operation === "add") {
      requireValue(core.validUUID(target));
      core.addPendingCredential(target, request.password, connectionIO(request.directory));
    } else if (operation === "save") core.saveConnections(request, connectionIO(target));
    else if (operation === "edit-connection") core.editConnection(request, connectionIO(target));
    else if (operation === "delete-connection")
      core.deleteConnection(request, connectionIO(target));
    else if (operation === "terminal") {
      requireValue(
        request &&
          Object.keys(request).length === 1 &&
          ["com.apple.Terminal", "com.googlecode.iterm2"].indexOf(request.terminalId) !== -1,
      );
      makeDirectory(target, true);
      writeJSON(target + "/terminal.json", request);
    } else if (operation === "ssh-prepare") {
      result({ status: 0, sessionId: prepareSession(target, request) });
      return;
    } else fail(-50);
    result({ status: 0 });
  } catch (error) {
    if (askpass && boundSSH && isBoundSSH(boundSSH)) $.kill(boundSSH.pid, 9);
    if (
      askpass ||
      ["ssh-start-prepare", "ssh-exec", "ssh-finish", "ssh-stop", "ssh-watch"].indexOf(
        operation,
      ) !== -1
    ) {
      $.NSFileHandle.fileHandleWithStandardError.writeData(
        dataFor(
          "Portwhisk: Session invalid, expired, or authentication canceled; operation stopped. / 会话无效、已过期或认证已取消，操作已停止。\n",
        ),
      );
    } else result({ status: Number.isInteger(error.status) ? error.status : -50 });
    $.exit(1);
  }
}
