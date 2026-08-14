<div align="center">

<img src="https://raw.githubusercontent.com/Termix-SSH/Termix/main/public/icon.svg" width="120" height="120" alt="Termix Logo" />

<h1>Termix CLI</h1>

<p>Manage your Termix servers from the command line</p>

<p>
  <img src="https://img.shields.io/github/stars/Termix-SSH/CLI?style=flat&label=Stars&color=F39044&labelColor=1a1a1a" />
  <img src="https://img.shields.io/github/forks/Termix-SSH/CLI?style=flat&label=Forks&color=F39044&labelColor=1a1a1a" />
  <img src="https://img.shields.io/github/v/release/Termix-SSH/CLI?style=flat&label=Release&color=F39044&labelColor=1a1a1a" />
  <a href="https://discord.gg/jVQGdvHDrf"><img alt="Discord" src="https://img.shields.io/discord/1347374268253470720?color=F39044&labelColor=1a1a1a" /></a>
  <a href="https://donate.termix.site/"><img alt="Donate" src="https://img.shields.io/badge/Donate-Support%20Termix-F39044?style=flat&labelColor=1a1a1a" /></a>
</p>

<p>
  <a href="https://donate.termix.site/"><img alt="Donations this month" src="https://img.shields.io/badge/dynamic/json?style=for-the-badge&label=Donations%20this%20month&query=%24.fiatTotal&prefix=%24&url=https%3A%2F%2Ftermix.site%2Fdonation-snapshot.json&color=F39044&labelColor=1a1a1a" /></a>
</p>

</div>

## Features

- Interactive SSH terminal with `termix ssh`, over the same connection the web UI uses
- One-off remote commands with `termix exec`, exiting with the remote exit code
- File browsing and transfer over SFTP
- SSH tunnel and Docker container control
- Fleets, including running a command across every host at once
- Host, credential and snippet management, with import and export
- API keys and host enrollment for scripts, CI and AI agents
- Table output on a terminal, JSON when piped, with documented exit codes

## Installation

```bash
npm install -g @termix/cli
```

Requires Node.js 20.11 or newer. Standalone binaries for Windows, Linux and macOS
that need no Node.js install are attached to each
[release](https://github.com/Termix-SSH/CLI/releases).

## Documentation

Full documentation is at [docs.termix.site/cli](https://docs.termix.site/cli/).

## Planned Features

See [Projects](https://github.com/orgs/Termix-SSH/projects/5) for all planned features.
If you are looking to contribute, see
[Contributing](https://github.com/Termix-SSH/CLI/blob/main/CONTRIBUTING.md).

<br />

## Sponsors

Interested in a paid placement to support development? Email [mail@termix.site](mailto:mail@termix.site).

<div align="center">

<a href="https://www.digitalocean.com/">
  <img src="https://opensource.nyc3.cdn.digitaloceanspaces.com/attribution/assets/SVG/DO_Logo_horizontal_blue.svg" height="40" alt="DigitalOcean" />
</a>
&nbsp;&nbsp;&nbsp;
<a href="https://crowdin.com/">
  <img src="https://support.crowdin.com/assets/logos/core-logo/svg/crowdin-core-logo-cDark.svg" height="40" alt="Crowdin" />
</a>
&nbsp;&nbsp;&nbsp;
<a href="https://www.blacksmith.sh/">
  <img src="https://cdn.prod.website-files.com/681bfb0c9a4601bc6e288ec4/683ca9e2c5186757092611b8_e8cb22127df4da0811c4120a523722d2_logo-backsmith-wordmark-light.svg" height="40" alt="Blacksmith" />
</a>
&nbsp;&nbsp;&nbsp;
<a href="https://www.cloudflare.com/">
  <img src="https://sirv.sirv.com/website/screenshots/cloudflare/cloudflare-logo.png?w=300" height="40" alt="Cloudflare" />
</a>
&nbsp;&nbsp;&nbsp;
<a href="https://akamai.com/">
  <img src="https://upload.wikimedia.org/wikipedia/commons/8/8b/Akamai_logo.svg" height="40" alt="Akamai" />
</a>
&nbsp;&nbsp;&nbsp;
<a href="https://aws.amazon.com/">
  <img src="https://upload.wikimedia.org/wikipedia/commons/thumb/9/93/Amazon_Web_Services_Logo.svg/960px-Amazon_Web_Services_Logo.svg.png" height="40" alt="AWS" />
</a>
&nbsp;&nbsp;&nbsp;
<a href="https://rackgenius.com/">
  <img src="https://rackgenius.com/rackgenius-logo.png" height="40" alt="Rack Genius" />
</a>
&nbsp;&nbsp;&nbsp;
<a href="https://ginernet.com/">
  <img src="https://ginernet.com/img/logo-web.png" height="40" alt="Ginernet" />
</a>
</div>

<br />

## Support

If you need help or want to request a feature with Termix CLI, visit the
[Issues](https://github.com/Termix-SSH/Support/issues) page, log in, and press
`New Issue`. Please be as detailed as possible in your issue, preferably written in
English. You can also join the [Discord](https://discord.gg/jVQGdvHDrf) server and
visit the support channel, however, response times may be longer.

<br />

## License

Distributed under the Apache License Version 2.0. See `LICENSE` for more information.
