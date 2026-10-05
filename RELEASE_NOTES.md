<!-- SUMMARY -->

The CLI now lives at `@termix-ssh/cli` on npm and works with Termix 2.9. If you installed `@termix-cli/cli`, uninstall it and install `@termix-ssh/cli` instead.

<!-- /SUMMARY -->

<!-- UPDATE_LOG -->

- Moved the npm package from `@termix-cli/cli` to `@termix-ssh/cli`
- `termix ssh` waits for the server to be ready before connecting to the host

<!-- /UPDATE_LOG -->

<!-- BUG_FIXES -->

- `termix ssh` failed on Termix 2.9 because the terminal moved to the ssh-terminal plugin. It now connects at the new path and falls back to the old one on older servers
- `termix ssh` could time out on fast connections when `connectToHost` arrived before the server was ready
- An expired session on Termix 2.9 now shows the `termix login` hint instead of a bare close message

<!-- /BUG_FIXES -->
