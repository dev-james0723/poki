<p align="center">
  <img src="docs/images/poki-icon.png" width="72" height="72" alt="Poki icon">
</p>

<h1 align="center">Poki uses your iPhone like you do</h1>

<p align="center">
  <img src="docs/images/poki-home.gif" width="720" alt="Poki website home page animation">
</p>

<p align="center">
  English | <a href="README.zh-CN.md">简体中文</a> | <a href="README.zh-TW.md">繁體中文</a> | <a href="README.ja.md">日本語</a> | <a href="README.ko.md">한국어</a> | <a href="README.es.md">Español</a><br>
  <a href="https://poki.bot">poki.bot</a>
</p>

<!-- badges:start -->
<p align="center">
  <a href="LICENSE"><img src="https://img.shields.io/badge/license-AGPL--3.0--only-blue" alt="License: AGPL-3.0-only"></a>
  <a href="https://github.com/JosssphZhou/poki/stargazers"><img src="https://img.shields.io/github/stars/JosssphZhou/poki" alt="GitHub stars"></a>
  <a href="https://github.com/JosssphZhou/poki/forks"><img src="https://img.shields.io/github/forks/JosssphZhou/poki" alt="GitHub forks"></a>
  <a href="https://github.com/JosssphZhou/poki/issues"><img src="https://img.shields.io/github/issues/JosssphZhou/poki" alt="GitHub issues"></a>
  <a href="https://github.com/JosssphZhou/poki/releases"><img src="https://img.shields.io/github/v/release/JosssphZhou/poki" alt="Latest release"></a>
  <img src="https://img.shields.io/badge/platform-macOS%20%7C%20iOS-lightgrey" alt="Platform: macOS and iOS">
</p>
<!-- badges:end -->

## Quick start

### Poki on your iPhone

Tell your agent:

```text
Install Poki on my iPhone from https://github.com/JosssphZhou/poki
```

The agent follows the [install-poki skill](skills/install-poki/SKILL.md) and runs `bin/install-iphone.mjs`, which does every step it can by itself. You only do what iOS asks of you: type your Apple Account into a Poki Setup window on the Mac, tap Trust and turn on Developer Mode on the iPhone, trust the developer, and open Poki. When Poki first opens it asks for Automation Mode: tap Continue and enter the iPhone passcode. If you cancel, turn Poki on again to be asked again. The agent tells you each one in a sentence when it comes up. A free Apple Account works.

Requires macOS 14+, Node.js 24+, iOS 18+, a USB data cable, an Apple Account, and a compatible VPN/proxy app on the iPhone that routes 10.7.0.1 back to it, such as Karing or Shadowrocket configured through Poki's Setup instructions. On iOS 27 and later Poki controls the iPhone through its native services by default. On iOS 18 to 26 it uses the XCTest session instead, as Alpha 0.2.9 did; this release was not tested on a physical iPhone below iOS 27. Xcode is not required. Free Apple Account signing lasts 7 days and needs renewal. Enable UI Automation in the iPhone's Developer settings and configure model access in Poki. With an older Poki Setup and no Xcode, the agent asks you to finish model-key and connection setup manually and reports those checks as unverified until you confirm them.

No Node.js 24, or on Windows? The same prompt works once Poki Setup is installed: the agent then uses the command line tool inside Poki Setup. Poki Setup's own menu also copies a prompt for your agent (Poki > Copy Prompt for Your Agent on a Mac, Settings > Use an agent on Windows).

Prefer clicking through it yourself? Download Poki Setup for macOS or Windows (contributed by [@ZhehanZhang](https://github.com/ZhehanZhang)) from the [Alpha release](https://github.com/JosssphZhou/poki/releases/tag/app-alpha-latest) and follow its window.

### Poki MCP for your agent

**Let your agent install it.** Copy this to your agent:

```text
Install https://github.com/JosssphZhou/poki following its root AGENTS.md, including the MCP skill, and stop whenever you need me to act.
```

**Poki MCP.** Already using Claude Code, Codex, or another MCP client? Connect Poki MCP and use your own subscription. No extra model account needed.

Start the server and keep it running:

```sh
git clone https://github.com/JosssphZhou/poki.git
cd poki
./bin/setup
npm start
```

Requires macOS 15 or later, full Xcode, Rust, Node.js 24+, and ffmpeg. `./bin/setup` checks for missing dependencies. The initial build takes a few minutes.

Poki targets macOS. For Linux, see the community port [poki-for-linux](https://github.com/carrotciallo/poki-for-linux) ([#16](https://github.com/JosssphZhou/poki/issues/16)), maintained outside this repo.

Poki MCP on Windows: community port at [scy7796/poki-for-windows](https://github.com/scy7796/poki-for-windows) (maintained by its author, not tested by us).

### Prebuilt macOS arm64 package

Download `poki-v0.1.1-macos-arm64.tar.gz` from the release and run:

```sh
tar -xzf poki-v0.1.1-macos-arm64.tar.gz
cd poki-v0.1.1
npm ci --no-audit --no-fund
npm start
```

The package includes the native bridge and idevice tools. You do not need Rust or `./bin/setup`. You still need macOS on Apple Silicon, full Xcode, Node.js 24+, Python 3, and ffmpeg. Register your MCP client and install the optional Agent as described below.

In another terminal, from the same directory, register the MCP server:

```sh
claude mcp add --scope user poki-mcp -- node "$PWD/src/stdio.mjs"   # Claude Code
codex mcp add poki-mcp -- node "$PWD/src/stdio.mjs"                 # Codex
```

**Poki Agent.** For Poki's standalone terminal agent or messaging channels, keep `npm start` running and open another terminal in the same directory. Install the agent, add its command to this terminal's path, and sign in:

```sh
npm ci --prefix agent
export PATH="$PWD/bin:$PATH"
poki login
poki status
```

Poki Agent uses GPT-6.1 Terra (`gpt-6.1-terra`) with low reasoning by default. We recommend keeping it: it is the fastest setup we have tested for phone tasks. Override it with `POKI_AGENT_MODEL`; see [Run Poki Agent](agent/README.md).

For a physical iPhone, pair it with your Mac over USB first. See [Physical iPhone setup](docs/physical-iphone.md).

Update with `./bin/poki update`. Set `POKI_NO_UPDATE_CHECK=1` to disable the daily anonymous GitHub release check. See [Update](AGENTS.md#update) for the request URL, restart steps, and prebuilt packages.

## Phone capability tools

The native query/wait, correlated Shortcuts, task App Intents, owned navigation, and isolated Safari DOM interfaces are documented in [Phone capabilities](docs/phone-capabilities.md). That guide distinguishes configured capabilities, verified receipts, and physical acceptance, and includes the callback and rollout requirements.

## Try a task

With Poki Agent, one connected iPhone is selected automatically. With multiple devices, add `--device '<device UUID>'`.

```sh
node bin/call.mjs list_devices   # Find your device UUID
poki "Search esp32 in Chrome and summarize the top result"
```

> **Note:** Poki controls your real iPhone. If you ask it to send messages or make payments, it will. Screen contents are sent to your configured model service.

Gets faster with use: Poki Agent remembers past tasks and runs them faster on repeat.

**Channels:** After configuring an authorized channel, start it with `poki imessage` or [`poki telegram`](agent/README.md#telegram). See [Poki Agent](agent/README.md) for setup.

**MCP clients:** Claude Code, Codex, and any client supporting `mcpServers` JSON.

Physical iPhone support has been verified only on iPhones using the Chinese interface. Physical devices support portrait orientation only. App container export and direct links to Settings subpages are unavailable. See [verification and known limits](docs/verification.md).

## Docs

| Topic | Read |
| --- | --- |
| Installation, other MCP clients, and troubleshooting | [Install guide](docs/install.md) |
| Poki Agent, models, iMessage, and Telegram | [Run Poki Agent](agent/README.md) |
| MCP tool reference | [Tool behavior](docs/tools.md) |
| Environment variables and sessions | [Configuration](docs/configuration.md) |
| USB pairing, Developer Mode, and Wi-Fi | [Physical iPhone setup](docs/physical-iphone.md) |
| Test results, known limits, and disclaimers | [Verification](docs/verification.md) |
| Bridge architecture | [Native bridge](native/NATIVE.md) and [simulator adapter](native/simulator.md) |
| Roadmap | [poki.bot](https://poki.bot) |

## Roadmap

<p align="center">
  <img src="docs/images/roadmap.png" width="860" alt="Poki roadmap. Shipped: Poki MCP, Poki Agent, iMessage, Telegram, and Terminal integrations, self-learning routes, remote connections. In Progress: persistent connection performance improvements, native text input (clipboard-free), simplified tool interface. Planned: Poki App, which runs locally on iPhone and is available while your Mac is powered off. Future: iPhone Duo support, physical device support (no Xcode required), additional model providers.">
</p>

## Star History

<a href="https://www.star-history.com/?repos=JosssphZhou%2Fpoki&type=date&legend=top-left">
  <picture>
    <source media="(prefers-color-scheme: dark)" srcset="https://api.star-history.com/chart?repos=JosssphZhou/poki&type=date&theme=dark&legend=top-left">
    <source media="(prefers-color-scheme: light)" srcset="https://api.star-history.com/chart?repos=JosssphZhou/poki&type=date&legend=top-left">
    <img alt="Star History chart" src="https://api.star-history.com/chart?repos=JosssphZhou/poki&type=date&legend=top-left">
  </picture>
</a>

## Poki keyboard

On the native path Poki types through its own keyboard panel at a person's pace, without
reading the screen while it types. The panel has no keys and is not a keyboard for people:
it shows while Poki types and has a Take Over button. Nothing is pasted unless you choose
Paste in Advanced. See [docs/poki-keyboard.md](docs/poki-keyboard.md).

## Core contributors

<!-- CORE-CONTRIBUTORS:START -->
<table>
  <tbody>
    <tr>
      <td align="center" valign="top" width="33%"><a href="https://github.com/makirqi-alt"><img src="https://avatars.githubusercontent.com/u/295395617?v=4&size=240" width="120" height="120" alt="makirqi-alt"/><br /><sub><b>makirqi-alt</b></sub></a><br />Filed Poki's first issue, <a href="https://github.com/JosssphZhou/poki/issues/1">#1</a>, on iOS 18.6.2: screenshots worked, accessibility and touch did not, and the clear split made it easy to follow.</td>
      <td align="center" valign="top" width="33%"><a href="https://github.com/ZhehanZhang"><img src="https://avatars.githubusercontent.com/u/67270559?v=4&size=240" width="120" height="120" alt="ZhehanZhang"/><br /><sub><b>ZhehanZhang</b></sub></a><br />The great co-creator of Poki.</td>
      <td align="center" valign="top" width="33%"><a href="https://github.com/edge369"><img src="https://avatars.githubusercontent.com/u/63720633?v=4&size=240" width="120" height="120" alt="edge369"/><br /><sub><b>edge369</b></sub></a><br />Made Poki run on a router in <a href="https://github.com/JosssphZhou/poki/pull/14">#14</a>, so Telegram can drive the iPhone with the Mac powered off; <a href="https://github.com/JosssphZhou/poki/pull/15">#15</a>, <a href="https://github.com/JosssphZhou/poki/pull/17">#17</a> and <a href="https://github.com/JosssphZhou/poki/issues/19">#19</a> followed.</td>
    </tr>
    <tr>
      <td align="center" valign="top" width="33%"><a href="https://github.com/mawenhao1028"><img src="https://avatars.githubusercontent.com/u/70818670?v=4&size=240" width="120" height="120" alt="mawenhao1028"/><br /><sub><b>mawenhao1028</b></sub></a><br />Reported in <a href="https://github.com/JosssphZhou/poki/issues/6">#6</a> that usbmuxd listed no iPhone on macOS 27.2; Poki now says so plainly and why a helper stops early (<a href="https://github.com/JosssphZhou/poki/issues/59">#59</a>).</td>
      <td align="center" valign="top" width="33%"><a href="https://github.com/igc110"><img src="https://avatars.githubusercontent.com/u/241411380?v=4&size=240" width="120" height="120" alt="igc110"/><br /><sub><b>igc110</b></sub></a><br />Found why taps on a physical iPhone were slow in <a href="https://github.com/JosssphZhou/poki/issues/10">#10</a>; the fix that followed made them about a third faster.</td>
      <td align="center" valign="top" width="33%"><a href="https://github.com/carrotciallo"><img src="https://avatars.githubusercontent.com/u/69567867?v=4&size=240" width="120" height="120" alt="carrotciallo"/><br /><sub><b>carrotciallo</b></sub></a><br />Ported Poki to Linux and tested it on a physical iPhone over USB, LAN and Tailscale in <a href="https://github.com/JosssphZhou/poki/issues/16">#16</a>; the README now points to it.</td>
    </tr>
    <tr>
      <td align="center" valign="top" width="33%"><a href="https://github.com/guangtouge82"><img src="https://avatars.githubusercontent.com/u/269691899?v=4&size=240" width="120" height="120" alt="guangtouge82"/><br /><sub><b>guangtouge82</b></sub></a><br />Traced failing touches on a physical iPhone to a missing display service in <a href="https://github.com/JosssphZhou/poki/issues/18">#18</a>; Poki now says nothing was sent and points to prepare-device.</td>
      <td align="center" valign="top" width="33%"><a href="https://github.com/Dreaminmaster"><img src="https://avatars.githubusercontent.com/u/189544503?v=4&size=240" width="120" height="120" alt="Dreaminmaster"/><br /><sub><b>Dreaminmaster</b></sub></a><br />Fixed a corrupt cached route that aborted unrelated Agent tasks (<a href="https://github.com/JosssphZhou/poki/issues/21">#21</a>, <a href="https://github.com/JosssphZhou/poki/pull/22">#22</a>), then let the Agent reuse its post-action screen read in <a href="https://github.com/JosssphZhou/poki/pull/37">#37</a>.</td>
      <td align="center" valign="top" width="33%"><a href="https://github.com/PeterKingXu1s"><img src="https://avatars.githubusercontent.com/u/89392314?v=4&size=240" width="120" height="120" alt="PeterKingXu1s"/><br /><sub><b>PeterKingXu1s</b></sub></a><br />Reported in <a href="https://github.com/JosssphZhou/poki/issues/25">#25</a> that a natural-language stop request did not interrupt an iMessage task; Poki now replies to mid-task messages and points to /stop.</td>
    </tr>
    <tr>
      <td align="center" valign="top" width="33%"><a href="https://github.com/ScottH1122"><img src="https://avatars.githubusercontent.com/u/142722955?v=4&size=240" width="120" height="120" alt="ScottH1122"/><br /><sub><b>ScottH1122</b></sub></a><br />Reproduced two Agent bugs in <a href="https://github.com/JosssphZhou/poki/issues/27">#27</a> and <a href="https://github.com/JosssphZhou/poki/issues/28">#28</a>, then merged seven fixes and test repairs, from cancelled input locks (<a href="https://github.com/JosssphZhou/poki/pull/102">#102</a>) to invalid touch coordinates (<a href="https://github.com/JosssphZhou/poki/pull/136">#136</a>).</td>
      <td align="center" valign="top" width="33%"><a href="https://github.com/jiahuipaung"><img src="https://avatars.githubusercontent.com/u/70688286?v=4&size=240" width="120" height="120" alt="jiahuipaung"/><br /><sub><b>jiahuipaung</b></sub></a><br />Fixed in <a href="https://github.com/JosssphZhou/poki/pull/34">#34</a> a RemotePairing connection that died when the iPhone's LAN address changed (<a href="https://github.com/JosssphZhou/poki/issues/30">#30</a>); a real iPhone reconnected in 768 ms.</td>
      <td align="center" valign="top" width="33%"><a href="https://github.com/Zeno6898"><img src="https://avatars.githubusercontent.com/u/229920081?v=4&size=240" width="120" height="120" alt="Zeno6898"/><br /><sub><b>Zeno6898</b></sub></a><br />Field-tested the iPhone app over cellular and from Windows in <a href="https://github.com/JosssphZhou/poki/issues/35">#35</a> and <a href="https://github.com/JosssphZhou/poki/issues/40">#40</a>, which led to the Wi-Fi setup note (<a href="https://github.com/JosssphZhou/poki/issues/138">#138</a>); reported <a href="https://github.com/JosssphZhou/poki/issues/162">#162</a>.</td>
    </tr>
    <tr>
      <td align="center" valign="top" width="33%"><a href="https://github.com/scy7796"><img src="https://avatars.githubusercontent.com/u/282529358?v=4&size=240" width="120" height="120" alt="scy7796"/><br /><sub><b>scy7796</b></sub></a><br />Fixed taps that failed every time over RemotePairing from a Windows host in <a href="https://github.com/JosssphZhou/poki/pull/39">#39</a>; 5 of 5 taps then worked.</td>
      <td align="center" valign="top" width="33%"><a href="https://github.com/foshanfm"><img src="https://avatars.githubusercontent.com/u/24779370?v=4&size=240" width="120" height="120" alt="foshanfm"/><br /><sub><b>foshanfm</b></sub></a><br />Ran an insurance-terms check on a real iPhone over Tailscale in <a href="https://github.com/JosssphZhou/poki/issues/42">#42</a>; the report shaped clearer USB errors and a per-session transport switch.</td>
      <td align="center" valign="top" width="33%"><a href="https://github.com/xiaweiyi713"><img src="https://avatars.githubusercontent.com/u/208608622?v=4&size=240" width="120" height="120" alt="xiaweiyi713"/><br /><sub><b>xiaweiyi713</b></sub></a><br />Recorded demo videos of Poki driving a real iPhone, so new visitors can see what it does before installing anything.</td>
    </tr>
    <tr>
      <td align="center" valign="top" width="33%"><a href="https://github.com/fucknima"><img src="https://avatars.githubusercontent.com/u/18666223?v=4&size=240" width="120" height="120" alt="f&#42;&#42;&#42;&#42;&#42;&#42;&#42;"/><br /><sub><b>f&#42;&#42;&#42;&#42;&#42;&#42;&#42;</b></sub></a><br />Added OpenCode Go as a model account in the iPhone app in <a href="https://github.com/JosssphZhou/poki/pull/68">#68</a>, with its own Keychain credential and independent model choice.</td>
      <td align="center" valign="top" width="33%"><a href="https://github.com/owensn951954688"><img src="https://avatars.githubusercontent.com/u/312761798?v=4&size=240" width="120" height="120" alt="owensn951954688"/><br /><sub><b>owensn951954688</b></sub></a><br />Posted a full timeline of Runner pairing failing after 25 idle minutes in <a href="https://github.com/JosssphZhou/poki/issues/69">#69</a>; Setup now points to Loopback and Pairing (<a href="https://github.com/JosssphZhou/poki/issues/70">#70</a>).</td>
      <td align="center" valign="top" width="33%"><a href="https://github.com/kira-ariaki"><img src="https://avatars.githubusercontent.com/u/257352493?v=4&size=240" width="120" height="120" alt="kira-ariaki"/><br /><sub><b>kira-ariaki</b></sub></a><br />Made batch calls report an ambiguous device instead of crashing (<a href="https://github.com/JosssphZhou/poki/pull/74">#74</a>), added POKI_MCP_DEVICE (<a href="https://github.com/JosssphZhou/poki/pull/75">#75</a>) and an optional per-task approval gate (<a href="https://github.com/JosssphZhou/poki/pull/77">#77</a>).</td>
    </tr>
    <tr>
      <td align="center" valign="top" width="33%"><a href="https://github.com/Purelite"><img src="https://avatars.githubusercontent.com/u/9334469?v=4&size=240" width="120" height="120" alt="Purelite"/><br /><sub><b>Purelite</b></sub></a><br />Fixed pairing setup sending people to the wrong Settings page, so the Developer Mode and UI Automation steps now open the right one (<a href="https://github.com/JosssphZhou/poki/pull/137">#137</a>).</td>
      <td align="center" valign="top" width="33%"><a href="https://github.com/heyallencao"><img src="https://avatars.githubusercontent.com/u/258265534?v=4&size=240" width="120" height="120" alt="heyallencao"/><br /><sub><b>heyallencao</b></sub></a><br />Fixed screen reads that ran past their call deadline in <a href="https://github.com/JosssphZhou/poki/pull/139">#139</a>, with a regression test for consistently slow runner responses.</td>
    </tr>
  </tbody>
</table>
<!-- CORE-CONTRIBUTORS:END -->

## Thanks

Thanks to everyone who opened an issue or pull request. Your feedback and fixes make Poki better.

<!-- THANKS-WALL:START -->
<table>
  <tbody>
    <tr>
      <td align="center" valign="top" width="20%"><a href="https://github.com/ZhehanZhang"><img src="https://avatars.githubusercontent.com/u/67270559?v=4&size=160" width="80" height="80" alt="ZhehanZhang"/><br /><sub><b>ZhehanZhang</b></sub></a></td>
      <td align="center" valign="top" width="20%"><a href="https://github.com/carrotciallo"><img src="https://avatars.githubusercontent.com/u/69567867?v=4&size=160" width="80" height="80" alt="carrotciallo"/><br /><sub><b>carrotciallo</b></sub></a></td>
      <td align="center" valign="top" width="20%"><a href="https://github.com/Dreaminmaster"><img src="https://avatars.githubusercontent.com/u/189544503?v=4&size=160" width="80" height="80" alt="Dreaminmaster"/><br /><sub><b>Dreaminmaster</b></sub></a></td>
      <td align="center" valign="top" width="20%"><a href="https://github.com/edge369"><img src="https://avatars.githubusercontent.com/u/63720633?v=4&size=160" width="80" height="80" alt="edge369"/><br /><sub><b>edge369</b></sub></a></td>
      <td align="center" valign="top" width="20%"><a href="https://github.com/foshanfm"><img src="https://avatars.githubusercontent.com/u/24779370?v=4&size=160" width="80" height="80" alt="foshanfm"/><br /><sub><b>foshanfm</b></sub></a></td>
    </tr>
    <tr>
      <td align="center" valign="top" width="20%"><a href="https://github.com/fucknima"><img src="https://avatars.githubusercontent.com/u/18666223?v=4&size=160" width="80" height="80" alt="f&#42;&#42;&#42;&#42;&#42;&#42;&#42;"/><br /><sub><b>f&#42;&#42;&#42;&#42;&#42;&#42;&#42;</b></sub></a></td>
      <td align="center" valign="top" width="20%"><a href="https://github.com/guangtouge82"><img src="https://avatars.githubusercontent.com/u/269691899?v=4&size=160" width="80" height="80" alt="guangtouge82"/><br /><sub><b>guangtouge82</b></sub></a></td>
      <td align="center" valign="top" width="20%"><a href="https://github.com/heyallencao"><img src="https://avatars.githubusercontent.com/u/258265534?v=4&size=160" width="80" height="80" alt="heyallencao"/><br /><sub><b>heyallencao</b></sub></a></td>
      <td align="center" valign="top" width="20%"><a href="https://github.com/htx996"><img src="https://avatars.githubusercontent.com/u/95217139?v=4&size=160" width="80" height="80" alt="htx996"/><br /><sub><b>htx996</b></sub></a></td>
      <td align="center" valign="top" width="20%"><a href="https://github.com/igc110"><img src="https://avatars.githubusercontent.com/u/241411380?v=4&size=160" width="80" height="80" alt="igc110"/><br /><sub><b>igc110</b></sub></a></td>
    </tr>
    <tr>
      <td align="center" valign="top" width="20%"><a href="https://github.com/iTry"><img src="https://avatars.githubusercontent.com/u/1381960?v=4&size=160" width="80" height="80" alt="iTry"/><br /><sub><b>iTry</b></sub></a></td>
      <td align="center" valign="top" width="20%"><a href="https://github.com/jiahuipaung"><img src="https://avatars.githubusercontent.com/u/70688286?v=4&size=160" width="80" height="80" alt="jiahuipaung"/><br /><sub><b>jiahuipaung</b></sub></a></td>
      <td align="center" valign="top" width="20%"><a href="https://github.com/kilingzhang"><img src="https://avatars.githubusercontent.com/u/17439300?v=4&size=160" width="80" height="80" alt="kilingzhang"/><br /><sub><b>kilingzhang</b></sub></a></td>
      <td align="center" valign="top" width="20%"><a href="https://github.com/kira-ariaki"><img src="https://avatars.githubusercontent.com/u/257352493?v=4&size=160" width="80" height="80" alt="kira-ariaki"/><br /><sub><b>kira-ariaki</b></sub></a></td>
      <td align="center" valign="top" width="20%"><a href="https://github.com/lunar-me"><img src="https://avatars.githubusercontent.com/u/275556969?v=4&size=160" width="80" height="80" alt="lunar-me"/><br /><sub><b>lunar-me</b></sub></a></td>
    </tr>
    <tr>
      <td align="center" valign="top" width="20%"><a href="https://github.com/makirqi-alt"><img src="https://avatars.githubusercontent.com/u/295395617?v=4&size=160" width="80" height="80" alt="makirqi-alt"/><br /><sub><b>makirqi-alt</b></sub></a></td>
      <td align="center" valign="top" width="20%"><a href="https://github.com/mawenhao1028"><img src="https://avatars.githubusercontent.com/u/70818670?v=4&size=160" width="80" height="80" alt="mawenhao1028"/><br /><sub><b>mawenhao1028</b></sub></a></td>
      <td align="center" valign="top" width="20%"><a href="https://github.com/oasis979559-alt"><img src="https://avatars.githubusercontent.com/u/295108220?v=4&size=160" width="80" height="80" alt="oasis979559-alt"/><br /><sub><b>oasis979559-alt</b></sub></a></td>
      <td align="center" valign="top" width="20%"><a href="https://github.com/owensn951954688"><img src="https://avatars.githubusercontent.com/u/312761798?v=4&size=160" width="80" height="80" alt="owensn951954688"/><br /><sub><b>owensn951954688</b></sub></a></td>
      <td align="center" valign="top" width="20%"><a href="https://github.com/PeterKingXu1s"><img src="https://avatars.githubusercontent.com/u/89392314?v=4&size=160" width="80" height="80" alt="PeterKingXu1s"/><br /><sub><b>PeterKingXu1s</b></sub></a></td>
    </tr>
    <tr>
      <td align="center" valign="top" width="20%"><a href="https://github.com/Purelite"><img src="https://avatars.githubusercontent.com/u/9334469?v=4&size=160" width="80" height="80" alt="Purelite"/><br /><sub><b>Purelite</b></sub></a></td>
      <td align="center" valign="top" width="20%"><a href="https://github.com/ScottH1122"><img src="https://avatars.githubusercontent.com/u/142722955?v=4&size=160" width="80" height="80" alt="ScottH1122"/><br /><sub><b>ScottH1122</b></sub></a></td>
      <td align="center" valign="top" width="20%"><a href="https://github.com/scy7796"><img src="https://avatars.githubusercontent.com/u/282529358?v=4&size=160" width="80" height="80" alt="scy7796"/><br /><sub><b>scy7796</b></sub></a></td>
      <td align="center" valign="top" width="20%"><a href="https://github.com/wanghao-SunSky"><img src="https://avatars.githubusercontent.com/u/73684879?v=4&size=160" width="80" height="80" alt="wanghao-SunSky"/><br /><sub><b>wanghao-SunSky</b></sub></a></td>
      <td align="center" valign="top" width="20%"><a href="https://github.com/windywendyday"><img src="https://avatars.githubusercontent.com/u/65647922?v=4&size=160" width="80" height="80" alt="windywendyday"/><br /><sub><b>windywendyday</b></sub></a></td>
    </tr>
    <tr>
      <td align="center" valign="top" width="20%"><a href="https://github.com/xiaweiyi713"><img src="https://avatars.githubusercontent.com/u/208608622?v=4&size=160" width="80" height="80" alt="xiaweiyi713"/><br /><sub><b>xiaweiyi713</b></sub></a></td>
      <td align="center" valign="top" width="20%"><a href="https://github.com/zcyoung2000"><img src="https://avatars.githubusercontent.com/u/62181891?v=4&size=160" width="80" height="80" alt="zcyoung2000"/><br /><sub><b>zcyoung2000</b></sub></a></td>
      <td align="center" valign="top" width="20%"><a href="https://github.com/Zeno6898"><img src="https://avatars.githubusercontent.com/u/229920081?v=4&size=160" width="80" height="80" alt="Zeno6898"/><br /><sub><b>Zeno6898</b></sub></a></td>
      <td align="center" valign="top" width="20%"><a href="https://github.com/zqy5608"><img src="https://avatars.githubusercontent.com/u/14949471?v=4&size=160" width="80" height="80" alt="zqy5608"/><br /><sub><b>zqy5608</b></sub></a></td>
    </tr>
  </tbody>
</table>
<!-- THANKS-WALL:END -->

## Disclaimer

Poki is an independent open source project. It is not affiliated with, or endorsed by, Apple, OpenAI, or the makers of any app or website it operates. iPhone is a trademark of Apple Inc.

Automating third-party apps and websites may violate their terms of service. Decide for yourself whether to use Poki with a given service. You are responsible for what it does on your device and accounts, including messages it sends, changes it makes, and any account restrictions that result.

Poki is provided "as is", without warranty, as set out in the AGPL-3.0 license.

## License

Poki is open source under the [AGPL-3.0-only license](LICENSE).

Copyright (c) 2026 Joseph Zhou and contributors. Open-source dependencies retain their respective licenses; see [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md). To contribute, see [CONTRIBUTING.md](CONTRIBUTING.md).

## Acknowledgments

<p align="center">
  <img src="docs/images/acknowledgments.png" width="860" alt="Built on open source: pi, idevice, idb, BlueBubbles, Hermes Agent, MCP SDK, sharp, and FFmpeg"><br>
  <sub>Open source acknowledgments: <a href="https://github.com/earendil-works/pi">pi</a> | <a href="https://github.com/jkcoxson/idevice">idevice</a> | <a href="https://github.com/facebook/idb">idb</a> | <a href="https://github.com/BlueBubblesApp/bluebubbles-server">BlueBubbles</a> | <a href="https://github.com/NousResearch/hermes-agent">Hermes Agent</a> | <a href="https://github.com/modelcontextprotocol/typescript-sdk">MCP SDK</a> | <a href="https://github.com/lovell/sharp">sharp</a> | <a href="https://github.com/FFmpeg/FFmpeg">FFmpeg</a></sub>
</p>
