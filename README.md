# Portwhisk

English | [简体中文](README.zh-CN.md)

**[Download v0.1.0 for macOS](https://github.com/Chocoer/portwhisk/releases/download/v0.1.0/portwhisk-0.1.0-macos.zip)** · [Release](https://github.com/Chocoer/portwhisk/releases/tag/v0.1.0) · [Changelog](CHANGELOG.md)

An SSH launcher for Tinycast: manage local connections, save passwords in macOS Keychain, and open system OpenSSH sessions in your preferred terminal.

Add, edit, and delete connections, choose a terminal, and use saved passwords for automatic login in a new SSH session. Supports Terminal and iTerm2, showing only apps installed on your Mac.

## Download and install

Requires macOS 26 or later and [Tinycast](https://tinycast.dev/docs/install/). Supports Apple Silicon and Intel without installing Node.js or Swift.

1. Download and extract the installation ZIP linked above.
2. In Tinycast, open **Settings → Extensions → Install → Add from folder** and select the extracted `portwhisk` folder.
3. To update, download and extract the new version, then import the extension with the same name again. There is no need to uninstall first; saved connections and terminal preferences are preserved.

Installation packages are under **Assets** on [Releases](https://github.com/Chocoer/portwhisk/releases). The repository's **Packages** sidebar is for registries such as npm and containers. This repository is private, so downloading requires repository access.

On first use, allow Tinycast to control your chosen terminal when macOS asks. Keychain access is requested by the system `osascript` process. Prefer **Allow** for that request; **Always Allow** trusts the shared system script runner. Existing items may request authorization again after an upgrade.

## Build and import

Building requires macOS, Node.js 22.22.2 or later, and npm 10 or later. Building and running the extension require no Swift, Xcode, or additional persistent runtime.

```sh
npm ci --ignore-scripts
npm run check
```

| Command                   | Purpose                                                                |
| ------------------------- | ---------------------------------------------------------------------- |
| `npm run build`           | Build `dist/` and copy the license.                                    |
| `npm run check`           | Run type, lint, formatting, production build, and automated checks.    |
| `npm test`                | Build, then run the tests.                                             |
| `npm run test:unit`       | Run tests against the existing `dist/` without rebuilding.             |
| `npm run package`         | Build, then create the release ZIP and internal checksum.              |
| `npm run package:release` | Package the existing `dist/` without rebuilding.                       |
| `npm run release:check`   | Validate release prerequisites and run `check` without creating a tag. |
| `npm run release`         | Validate, run `check`, then create and push an annotated version tag.  |

Packages are written to `release/`. Existing output is never overwritten; use `npm run package -- --output release/<new-directory>` for a new output directory. The same `--output` option works with `package:release`.

In Tinycast, open **Settings → Extensions → Install → Add from folder** and select this project's `dist/` folder. It contains `package.json`, three built commands, `assets/`, and `LICENSE`; source files and `node_modules` are unnecessary. After changing the source, rebuild and import the extension with the same name again. This update path preserves its separate storage without uninstalling.

## Interface language

In Tinycast's **Settings → Extensions → Portwhisk → Configure**, set **Language / 语言** to **English** or **简体中文**. English is the default. You can also select a command, press **⌘K**, and choose **Configure Extension**. Close and reopen the command after changing this setting.

The setting changes in-command interfaces, messages, and errors. Command titles in the host search remain **Connect**, **Manage Connections**, and **Terminal Settings**. Chinese keywords such as “连接服务器”, “管理连接”, and “终端设置” also find these commands.

## Add a connection

Open **Manage Connections** or **Connect**, choose **Add Connection**, and enter a name, host, username, port, and password. An empty port defaults to 22. Enter a domain name or IP address as the host, without `ssh`, a username, or a port.

Leading and trailing whitespace in passwords is preserved. Passwords are excluded from ordinary connection storage and command arguments. macOS may request Keychain authorization when saving for the first time. Cancellation or failure is reported without presenting a partial save as success. If a save fails and automatic cleanup cannot finish, the record is marked **Save Incomplete**; confirm cleanup from its action menu before retrying.

Ordinary connection records are stored in the extension's `supportPath/connections/records.json` using atomic file replacement. All writes share a file lock and snapshot checks to protect changes made by other commands. Existing connections need no migration.

The list refreshes after saving, and both commands can read the connection when reopened. OpenSSH askpass limits automatic authentication to passwords of at most 1,023 UTF-8 bytes. Inputs that cannot be passed losslessly are explicitly rejected. Existing longer passwords remain unchanged, but automatic authentication stops for that attempt.

## Edit and delete

Select a record in **Manage Connections** or **Connect** and choose **Edit Connection** from its action menu. The name, host, username, and port are prefilled; the saved password is neither read nor filled into the form. **Password** defaults to **Keep Saved Password**. The Keychain item changes only when you explicitly select **Replace Password** and enter a valid new password. Leaving the field empty does not clear the saved password, and canceling the form changes nothing.

Choose **Delete Connection** to display a confirmation with the connection name and target. After confirmation, the extension first preserves a traceable transaction state, removes that connection's Keychain credentials, and then removes the record. It does not delete other connections with matching names or hosts, or terminate established remote sessions.

Failed edits and deletions are never reported as successful. If an ordinary write fails and rollback succeeds, the original data remains. When full recovery cannot be confirmed, return to the list and review the record. **Edit Incomplete** offers **Repair Connection**, which requires re-entering the password to use, or confirming deletion. **Deletion Incomplete** only offers **Retry Deletion**, which also works if the credential has already been removed. Incomplete records cannot connect. Stale forms and records changed by another operation reject submission; return to the list and reopen the form.

## Choose a terminal and connect

Open **Terminal Settings**, or choose it from the connection list's action menu, select an installed Terminal or iTerm2 app, and save. Terminal is used until a preference is saved. If an existing preference is invalid or its app has been uninstalled, the extension reports an error and requires you to choose again.

Select a saved connection in **Connect** and run **Connect to Server**. The extension hands a new window session to your chosen terminal without typing commands into an existing session. First use may require macOS Automation or Keychain authorization. For a host's first connection, OpenSSH displays its fingerprint in the terminal for you to verify and answer manually. OpenSSH still rejects changed host keys.

The password is read from Keychain only inside a separate system JavaScript process and supplied once when SSH requests the password for this attempt's target. It never returns to the extension interface or passes through shell arguments, environment variables, plaintext files, or simulated keystrokes. Incorrect passwords are not repeatedly filled. Keyboard-interactive challenges, such as verification codes, remain in the terminal for manual entry without echo. Denied Keychain authorization, an invalid context, or an authentication-helper failure stops that SSH attempt.

The extension reports only that the session was handed to the terminal. Check the terminal for the actual connection, authentication, and remote-shell results. Session preparation expires after five minutes; a supervisor inside the terminal cleans up when the session ends. Expired, unstarted session metadata contains no secrets and is reclaimed on the next connection. Connections go directly to the entered host with `-F /dev/null`, without loading user or system SSH configuration. Existing known_hosts checks remain enabled; jump hosts and proxies that depend on SSH configuration are unsupported.

## Project layout

```text
src/                       Extension source
  connect.tsx              Connect command
  manage-connections.tsx   Manage Connections command
  terminal-settings.tsx    Terminal Settings command
  i18n.ts                  English/Chinese messages and language preference
  components/              Shared lists, connection forms, and terminal settings
  connections/             Connection model, validation, storage, and workflows
  credentials/             Keychain access and credential boundaries
  terminals/               Terminal discovery, launch, and SSH session handoff
assets/
  icon.png                 Extension icon
  keychain-helper          System-script entry point and session supervision
  system.js                JXA system interfaces, Keychain, atomic writes, and SSH authentication
  system-core.js           Pure JavaScript transaction, validation, and authentication core
scripts/                   Packaging and release scripts
.github/workflows/         Dual-architecture CI, Intel package checks, and tag publishing
release/                   Local ZIP and checksums (ignored by Git)
tests/                     Command behavior, system boundaries, cancellation, and file checks
dist/                      Build output for Tinycast folder import (ignored by Git)
docs/
  README.md                Documentation index and development conventions
  spec.md                  V1 product specification and acceptance criteria
  modules/                 One maintained document per feature module
    engineering.md         Engineering plans, progress, findings, and lessons
README.md                  English project overview
README.zh-CN.md            Chinese project overview
AGENTS.md                  Agent working rules
CHANGELOG.md               Versioned changelog
LICENSE                    MIT license
package.json               Extension manifest, dependencies, and development scripts
package-lock.json          npm dependency lockfile
tsconfig.json              Strict TypeScript configuration
eslint.config.mjs          Official Raycast ESLint configuration
```

## Development

- Read the [documentation and development guide](docs/README.md).
- Agents must read [AGENTS.md](AGENTS.md) before editing.
- `package.json` defines scripts and dependencies; use npm and its lockfile to maintain project dependencies.

## Publish a release

1. Run `npm version patch --no-git-tag-version` to update the manifest and lockfile versions. Use `minor` or `major` instead of `patch` when appropriate.
2. Add that version to `CHANGELOG.md` with a valid date and change entries, and update the download links in both README files.
3. Commit the changes on `main`, push to `origin/main`, and wait for CI to pass.
4. Optionally run `npm run release:check` to check prerequisites and the complete project without creating a tag.
5. Run `npm run release`. It checks the same prerequisites, runs the complete checks, and creates and pushes the annotated `vX.Y.Z` tag. GitHub Actions then builds and publishes the installation package; inspect its result and the Release before considering the version published.

The release commands reject a dirty working tree, a branch other than `main`, a HEAD that differs from the real remote `origin/main`, an existing local or remote version tag, mismatched manifest/lockfile versions, or a missing or invalid changelog entry. They do not change the version, commit, or force-push. A failed check or tag push stops the command; pushing a tag alone does not mean the release has been published.

## License

This project is licensed under the [MIT License](LICENSE).
