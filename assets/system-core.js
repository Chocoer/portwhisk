(function () {
  "use strict";

  var keys = ["id", "name", "host", "username", "port", "credentialRef", "status"];
  var statuses = ["ready", "pending", "pending-edit", "pending-delete"];

  function failure(status) {
    var error = new Error("Portwhisk system operation failed");
    error.status = status;
    return error;
  }

  function validUUID(value) {
    return (
      typeof value === "string" &&
      /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/.test(value)
    );
  }

  function validIPv4(host) {
    var parts = host.split(".");
    return (
      parts.length === 4 &&
      parts.every(function (part) {
        return /^(0|[1-9][0-9]{0,2})$/.test(part) && Number(part) <= 255;
      })
    );
  }

  function validHost(host) {
    if (typeof host !== "string" || !host || host.length > 253) return false;
    if (host.indexOf(":") !== -1) {
      if (!/^[0-9a-f:.]+$/i.test(host)) return false;
      var address = host;
      // IPv4 尾段占两个十六位组，压缩符必须实际省略至少一组。
      if (address.indexOf(".") !== -1) {
        var colon = address.lastIndexOf(":");
        if (!validIPv4(address.slice(colon + 1))) return false;
        address = address.slice(0, colon + 1) + "0:0";
      }
      var halves = address.split("::");
      if (halves.length > 2) return false;
      var groups = [];
      halves.forEach(function (half) {
        if (half !== "") groups = groups.concat(half.split(":"));
      });
      if (
        !groups.every(function (part) {
          return /^[0-9a-f]{1,4}$/i.test(part);
        })
      )
        return false;
      return halves.length === 2 ? groups.length < 8 : groups.length === 8;
    }
    if (/^[0-9.]+$/.test(host)) return validIPv4(host);
    return host.split(".").every(function (part) {
      return /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/i.test(part);
    });
  }

  function validConnection(record) {
    if (!record || typeof record !== "object" || Array.isArray(record)) return false;
    var actual = Object.keys(record);
    return (
      actual.length === keys.length &&
      keys.every(function (key) {
        return actual.indexOf(key) !== -1;
      }) &&
      validUUID(record.id) &&
      record.credentialRef === record.id &&
      typeof record.name === "string" &&
      record.name.length > 0 &&
      !hasControlCharacter(record.name) &&
      validHost(record.host) &&
      typeof record.username === "string" &&
      record.username.length > 0 &&
      record.username.charAt(0) !== "-" &&
      !/\s/.test(record.username) &&
      !hasControlCharacter(record.username) &&
      typeof record.port === "number" &&
      Math.floor(record.port) === record.port &&
      record.port >= 1 &&
      record.port <= 65535 &&
      statuses.indexOf(record.status) !== -1
    );
  }

  function hasControlCharacter(value) {
    for (var i = 0; i < value.length; i++) {
      if (value.charCodeAt(i) < 32 || value.charCodeAt(i) === 127) return true;
    }
    return false;
  }

  function validPassword(value) {
    if (
      typeof value !== "string" ||
      !value ||
      value.indexOf("\0") !== -1 ||
      value.indexOf("\r") !== -1 ||
      value.indexOf("\n") !== -1
    )
      return false;
    try {
      // encodeURIComponent 拒绝孤立代理；编码后的百分号序列按 UTF-8 字节计数。
      return encodeURIComponent(value).replace(/%[0-9a-f]{2}/gi, "x").length <= 1023;
    } catch {
      return false;
    }
  }

  function sameConnection(left, right) {
    return (
      !!left &&
      !!right &&
      keys.every(function (key) {
        return left[key] === right[key];
      })
    );
  }

  function validateConnections(records) {
    if (!Array.isArray(records)) throw failure(-50);
    var ids = [];
    records.forEach(function (record) {
      if (!validConnection(record) || ids.indexOf(record.id) !== -1) throw failure(-50);
      ids.push(record.id);
    });
  }

  function sshArguments(connection) {
    return [
      "-F",
      "/dev/null",
      "-tt",
      "-o",
      "StrictHostKeyChecking=ask",
      "-o",
      "UpdateHostKeys=no",
      "-o",
      "PreferredAuthentications=password,keyboard-interactive",
      "-o",
      "PasswordAuthentication=yes",
      "-o",
      "KbdInteractiveAuthentication=yes",
      "-o",
      "PubkeyAuthentication=no",
      "-o",
      "NumberOfPasswordPrompts=1",
      "-o",
      "ConnectionAttempts=1",
      "-o",
      "ConnectTimeout=15",
      "-o",
      "PermitLocalCommand=no",
      "-l",
      connection.username,
      "-p",
      String(connection.port),
      "--",
      connection.host.toLowerCase(),
    ];
  }

  function expectedPasswordPrompt(session) {
    return (
      session.connection.username + "@" + session.connection.host.toLowerCase() + "'s password: "
    );
  }

  function isInteractiveChallenge(prompt, session) {
    var prefix =
      "(" + session.connection.username + "@" + session.connection.host.toLowerCase() + ") ";
    return typeof prompt === "string" && prompt.indexOf(prefix) === 0;
  }

  function isHostConfirmation(prompt) {
    return (
      typeof prompt === "string" &&
      prompt.indexOf("The authenticity of host '") === 0 &&
      prompt.indexOf("fingerprint") !== -1 &&
      prompt.indexOf("Are you sure you want to continue connecting") !== -1 &&
      prompt.slice(-2) === "? "
    );
  }

  function passwordRequestAllowed(session, context) {
    return (
      !!session &&
      validUUID(session.id) &&
      validConnection(session.connection) &&
      session.connection.status === "ready" &&
      typeof session.createdAt === "number" &&
      isFinite(session.createdAt) &&
      typeof context.now === "number" &&
      isFinite(context.now) &&
      context.now >= session.createdAt - 5 &&
      context.now - session.createdAt <= 300 &&
      typeof context.parentPID === "number" &&
      context.parentPID > 0 &&
      Math.floor(context.parentPID) === context.parentPID &&
      context.parentPID === context.sshPID &&
      context.parentPath === "/usr/bin/ssh" &&
      context.alreadyUsed === false &&
      (context.hint === null || context.hint === undefined) &&
      context.prompt === expectedPasswordPrompt(session)
    );
  }

  function withStatus(record, status) {
    var result = {};
    keys.forEach(function (key) {
      result[key] = key === "status" ? status : record[key];
    });
    return result;
  }

  function sameRecords(left, right) {
    return (
      left.length === right.length &&
      left.every(function (record, index) {
        return sameConnection(record, right[index]);
      })
    );
  }

  function saveConnections(request, io) {
    if (!request) throw failure(-50);
    validateConnections(request.expected);
    validateConnections(request.connections);
    return io.withLock(function () {
      if (!sameRecords(io.readRecords(), request.expected)) throw failure(-70001);
      io.writeRecords(request.connections);
    });
  }

  // 新增与清理共用锁，pending 消失后不再创建无法追踪的迟到凭据。
  function addPendingCredential(id, password, io) {
    if (!validUUID(id) || !validPassword(password)) throw failure(-50);
    return io.withLock(function () {
      var records = io.readRecords();
      if (
        !records.some(function (record) {
          return record.id === id && record.status === "pending";
        })
      )
        throw failure(-70001);
      io.credentials.add(id, password);
    });
  }

  // 密码操作前持久禁用目标；补偿失败保留同一 ID 供显式修复或删除。
  function editConnection(request, io) {
    if (!request) throw failure(-50);
    validateConnections([request.expected]);
    validateConnections([request.connection]);
    var replacing = request.password !== undefined && request.password !== null;
    if (
      request.expected.id !== request.connection.id ||
      request.connection.status !== "ready" ||
      ["ready", "pending-edit"].indexOf(request.expected.status) === -1 ||
      (request.expected.status === "pending-edit" && !replacing) ||
      (replacing && !validPassword(request.password))
    )
      throw failure(-50);
    return io.withLock(function () {
      var records = io.readRecords();
      var index = records.findIndex(function (record) {
        return record.id === request.expected.id;
      });
      if (index === -1 || !sameConnection(records[index], request.expected)) throw failure(-70001);
      var original = records.slice();
      if (!replacing) {
        records[index] = request.connection;
        io.writeRecords(records);
        return;
      }
      var previousPassword = io.credentials.read(request.expected.id);
      function restoreOriginal() {
        if (previousPassword !== null) io.credentials.update(request.expected.id, previousPassword);
        else io.credentials.delete(request.expected.id);
        io.writeRecords(original);
      }
      records[index] = withStatus(request.expected, "pending-edit");
      io.writeRecords(records);
      try {
        if (previousPassword !== null) io.credentials.update(request.expected.id, request.password);
        else io.credentials.add(request.expected.id, request.password);
      } catch (credentialError) {
        // 系统报错不代表没有副作用；旧凭据恢复成功后才重新启用记录。
        try {
          restoreOriginal();
        } catch {
          throw failure(-70002);
        }
        throw credentialError;
      }
      records[index] = request.connection;
      try {
        io.writeRecords(records);
      } catch (commitError) {
        // 写入失败可能已提交新目标；必须确认禁用后，才能恢复旧密码。
        records[index] = withStatus(request.expected, "pending-edit");
        try {
          io.writeRecords(records);
          restoreOriginal();
        } catch {
          throw failure(-70002);
        }
        throw commitError;
      }
    });
  }

  // 先写可重试标记，再清凭据，最后移除元数据，失败不伪报全部删除。
  function deleteConnection(request, io) {
    if (!request) throw failure(-50);
    validateConnections([request.expected]);
    return io.withLock(function () {
      var records = io.readRecords();
      var index = records.findIndex(function (record) {
        return record.id === request.expected.id;
      });
      if (index === -1 || !sameConnection(records[index], request.expected)) throw failure(-70001);
      records[index] = withStatus(request.expected, "pending-delete");
      io.writeRecords(records);
      try {
        io.credentials.delete(request.expected.id);
      } catch {
        throw failure(-70003);
      }
      records.splice(index, 1);
      try {
        io.writeRecords(records);
      } catch {
        throw failure(-70003);
      }
    });
  }

  function currentConnectionAllowsPassword(connection, records) {
    return (
      validConnection(connection) &&
      connection.status === "ready" &&
      records.some(function (record) {
        return sameConnection(connection, record);
      })
    );
  }

  return {
    validUUID: validUUID,
    validHost: validHost,
    validConnection: validConnection,
    validPassword: validPassword,
    sameConnection: sameConnection,
    validateConnections: validateConnections,
    sshArguments: sshArguments,
    expectedPasswordPrompt: expectedPasswordPrompt,
    isInteractiveChallenge: isInteractiveChallenge,
    isHostConfirmation: isHostConfirmation,
    passwordRequestAllowed: passwordRequestAllowed,
    saveConnections: saveConnections,
    addPendingCredential: addPendingCredential,
    editConnection: editConnection,
    deleteConnection: deleteConnection,
    currentConnectionAllowsPassword: currentConnectionAllowsPassword,
  };
})();
