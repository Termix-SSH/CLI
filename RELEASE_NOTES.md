<!-- SUMMARY -->

First release of the Termix CLI. Manage hosts, run commands, open terminals and transfer files from your shell.

<!-- /SUMMARY -->

<!-- UPDATE_LOG -->

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

<!-- /UPDATE_LOG -->

<!-- BUG_FIXES -->

- Nothing yet, this is the first release

<!-- /BUG_FIXES -->
