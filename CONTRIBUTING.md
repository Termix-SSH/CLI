# Contributing

The Termix CLI is the command line client for [Termix](https://github.com/Termix-SSH/Termix), self-hosted, plugin-based server management.

## Prerequisites

- [Node.js](https://nodejs.org/en/download/) (v22.12 or newer)
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
npm run build        # bundle to dist/
npm test             # run the tests
npm run lint         # ESLint
npm run type-check   # TypeScript, including tests
npm run format       # Prettier
npm run verify       # all of the above plus the smoke test
```

CI runs `npm run verify` on Linux and Windows. Run it before opening a PR.

## Trying the CLI locally

```sh
npm run cli -- hosts list
npm run cli -- --help
```

Rebuilds and runs the CLI with whatever follows `--`. Arguments, exit codes and stdout behave like an installed copy (build output goes to stderr). For a faster loop, run `npm run dev` in one terminal to rebuild on save and `npm start -- <args>` in another.

### Smoke test

```sh
npm run smoke
```

Packs the CLI, installs the tarball into a temp prefix and runs it like a user would: version, help, exit codes, and no warnings on stdout. Nothing is published. This catches a bad `bin` path, a broken shebang or a native module in the tarball, which the unit tests can't see.

### Standalone binary

```sh
npm run build:binary -- termix_linux_x64
```

Builds a single executable in `release/` with Node's SEA support, so it runs without Node. SEA can't cross-compile, so a binary only works on the platform that built it. The release workflow builds all five targets on their own runners.

### Against a live server

```sh
npm run link:local     # build, then npm link
termix login --url https://termix.example.com
termix hosts list
npm run unlink:local   # when done
```

Termix 2.9+ serves everything on one port, so `TERMIX_URL` is all you need. For an older backend without a reverse proxy, point each service at its own port:

```sh
export TERMIX_URL=http://localhost:4090
export TERMIX_METRICS_URL=http://localhost:30005   # status
export TERMIX_TERMINAL_URL=http://localhost:30002  # ssh
export TERMIX_FILES_URL=http://localhost:30004     # files
export TERMIX_DOCKER_URL=http://localhost:30007    # docker
export TERMIX_TUNNEL_URL=http://localhost:30003    # tunnel
```

## Server API changes

`src/api/endpoints.ts` lists every endpoint the CLI calls. `test/drift.test.ts` checks them against the OpenAPI specs in `spec/`, so a renamed or removed route fails the tests instead of failing for a user.

To refresh the specs, run `npm run sync` in a [Termix-Docs](https://github.com/Termix-SSH/Docs) checkout next to this one, then:

```sh
npm run sync:spec
```

Then fix `src/api/endpoints.ts` for any route that moved. A few routes are registered straight on the Express app, so the spec doesn't have them. Those are marked `undocumented` in `endpoints.ts` and checked by hand.

## Making a change

1. Fork the [repo](https://github.com/Termix-SSH/CLI).
2. Create a branch:
   ```sh
   git checkout -b feature/my-new-feature
   ```
3. Make your changes.
4. Commit your changes:
   ```sh
   git commit -m "feat: add my new feature"
   ```
5. Push to your fork:
   ```sh
   git push origin feature/my-new-feature
   ```
6. Open a pull request with a clear description.

## Support

Bugs and ideas for the CLI go in [this repo](https://github.com/Termix-SSH/CLI/issues/new/choose). Add as much detail as you can, in English if possible. You can also ask in the [Discord](https://discord.gg/jVQGdvHDrf) server.
