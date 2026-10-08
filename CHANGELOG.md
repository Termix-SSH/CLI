# Changelog

## 1.1.0

Works with Termix plugins. Needs Termix 2.9 or newer.

### Added

- `termix plugins` shows what your server has
- `termix api` calls any route, including plugin routes
- Exit code 8 when a command needs a plugin that is missing or off
- `files rm --trash`, `alerts delete`, and `alerts --unread` and `--limit`
- Prompts for a host's code, password or key passphrase
- `ssh` asks before trusting a new or changed host key, and `--trust-host-key` for new keys in scripts

### Fixed

- Files, Docker, tunnels, fleets, snippets, alerts, status and ssh on Termix 2.9 and later
- Binary files in `files get`, `cat` and `put`
- `hosts create` and `update` ignoring `--enable-docker` and `--enable-tunnel`

## 1.0.2

The CLI now lives at `@termix-ssh/cli` on npm and works with Termix 2.9. If you installed `@termix-cli/cli`, uninstall it and install `@termix-ssh/cli` instead.

### Changed

- Moved the npm package from `@termix-cli/cli` to `@termix-ssh/cli`
- `termix ssh` waits for the server to be ready before connecting to the host

### Fixed

- `termix ssh` failed on Termix 2.9 because the terminal moved to the ssh-terminal plugin. It now connects at the new path and falls back to the old one on older servers
- `termix ssh` could time out on fast connections when `connectToHost` arrived before the server was ready
- An expired session on Termix 2.9 now shows the `termix login` hint instead of a bare close message

## 1.0.1

First release of the Termix CLI. Manage hosts, run commands, open terminals and transfer files from your shell.

### Added

- Interactive terminal with `termix ssh`, over the same WebSocket the web UI uses
- Run one-off commands with `termix exec`, exiting with the remote exit code
- SFTP browsing and transfer with `termix files ls/cat/get/put/mkdir/rm`
- SSH tunnel control with `termix tunnel list/show/start/stop`
- Docker container control with `termix docker ps/logs/start/stop/restart`
- Fleet management, including running a command across every host with `termix fleets exec`
- Host, credential and snippet management, plus import and export
- API key management and API-key-based host enrollment for automation
- Session and device management with `termix sessions`
- Table output on a terminal, JSON when piped, with documented exit codes
- Session tokens stored in the OS keychain where one is available
