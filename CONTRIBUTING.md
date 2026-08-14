# Contributing

## Prerequisites

- [Node.js](https://nodejs.org/en/download/) (v20.11 or newer)
- [NPM](https://docs.npmjs.com/downloading-and-installing-node-js-and-npm)
- [Git](https://git-scm.com/downloads)

## Installation

1. Clone the repository:
   ```sh
   git clone https://github.com/Termix-SSH/CLI
   ```
2. Install the dependencies:
   ```sh
   npm install
   ```

## Development

```sh
npm run build        # Bundle to dist/
npm test             # Run the test suite
npm run lint         # ESLint
npm run type-check   # TypeScript, including tests
npm run format       # Prettier
npm run verify       # Everything above, plus the smoke test
```

`npm run verify` is what CI runs, on Linux and Windows. Run it before opening a PR.

## Trying the CLI locally

### Rebuild and run in one step

```sh
npm run cli -- hosts list
npm run cli -- --help
npm run cli -- ssh 3
```

Deletes the previous build, rebuilds, then runs the CLI with whatever follows
`--`. There is never a stale `dist/` to second-guess. Arguments and the exit code
pass straight through, and build output goes to stderr, so piping and exit-code
checks behave exactly as they would for an installed copy.

For a tighter loop on a larger change, run `npm run dev` in one terminal to
rebuild on save and `npm start -- <args>` in another.

The unit tests never execute the packaged artifact, so two further checks exist.

### Smoke test the real package

```sh
npm run smoke
```

Builds, packs and installs the tarball into a temporary prefix, then drives the
installed binary the way a user would: version, help, exit codes, and that
warnings stay off stdout. Nothing is published and your global `node_modules` is
untouched. This is what catches a bad `bin` path, a mangled shebang, or a native
module getting bundled into the tarball.

### Build a standalone binary

```sh
npm run build:binary -- termix_linux_x64
```

Produces a self-contained executable in `release/` using Node's Single Executable
Application support, so it runs without Node installed. SEA embeds the runtime it
was built with and cannot cross-compile, so a binary only works on the platform
and architecture that produced it. The release workflow builds all five targets
on their own runners.

### Run against a live server

```sh
npm run link:local     # build, then npm link
termix login --url https://termix.example.com
termix hosts list
npm run unlink:local   # when you are done
```

`npm link` puts `termix` on your PATH pointing at this checkout, so rebuilding
picks up your changes without reinstalling. Use `npm run dev` in another
terminal to rebuild on save.

Against a bare backend rather than a reverse proxy, only the main API is on the
configured port, so point the other services at theirs:

```sh
export TERMIX_URL=http://localhost:4090
export TERMIX_METRICS_URL=http://localhost:30005   # status
export TERMIX_TERMINAL_URL=http://localhost:30002  # ssh
export TERMIX_FILES_URL=http://localhost:30004     # files
export TERMIX_DOCKER_URL=http://localhost:30007    # docker
export TERMIX_TUNNEL_URL=http://localhost:30003    # tunnel
```

## Keeping up with the server API

`src/api/endpoints.ts` lists every Termix endpoint the CLI calls, and
`test/drift.test.ts` checks each one against a vendored copy of the server's
OpenAPI specification at `spec/openapi.json`. If the server renames or removes a
route, that test fails instead of the CLI failing for a user.

When the server API changes, refresh the vendored spec from a checkout of the
[Termix](https://github.com/Termix-SSH/Termix) repository:

```sh
cd /path/to/Termix
npm run generate:openapi          # writes openapi.json in the repo root
cp openapi.json /path/to/CLI/spec/openapi.json
rm openapi.json                   # it is not committed to the server repo
```

Then update `src/api/endpoints.ts` for any route that moved.

A few routes are registered directly on the Express app rather than in a routes
file, so the generator never sees them. Those carry an `undocumented` note in
`endpoints.ts` and are verified by hand against the server source.

## Contributing

1. **Fork the repository**: Click the "Fork" button at the top right of
   the [repository page](https://github.com/Termix-SSH/CLI).
2. **Create a new branch**:
   ```sh
   git checkout -b feature/my-new-feature
   ```
3. **Make your changes**: Implement your feature, fix, or improvement.
4. **Commit your changes**:
   ```sh
   git commit -m "Feature request my new feature"
   ```
5. **Push to your fork**:
   ```sh
   git push origin feature/my-feature-request
   ```
6. **Open a pull request**: Go to the original repository and create a PR with a clear description.

## Support

If you need help or want to request a feature with Termix, visit the [Issues](https://github.com/Termix-SSH/Support/issues) page, log in, and press `New Issue`.
Please be as detailed as possible in your issue, preferably written in English. You can also join the [Discord](https://discord.gg/jVQGdvHDrf) server and visit the support
channel, however, response times may be longer.
