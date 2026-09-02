<div align="center">

  <a href="https://github.com/NousResearch/hermes-agent">
    <img src="https://github.com/user-attachments/assets/ac2f5702-c842-4b2e-9340-737481fa0ece" width="96" height="96" alt="Nous Research Hermes mark" />
  </a>

  # Hermes Terminal

  **The TUI of the gateway this window is already on.**

  Hermes Terminal opens the real `hermes --tui` of the gateway this Desktop window is connected to.
  Local Hermes, or a remote dashboard you already signed into. Same PTY the web dashboard Chat tab uses.

  <sub>POWERED BY <a href="https://github.com/NousResearch/hermes-agent">HERMES AGENT</a> &nbsp;·&nbsp; COMMUNITY PLUGIN &nbsp;·&nbsp; VERSION 0.0.1</sub>

  <br /><br />

  [Explore the product](#tui-in-a-workspace-tab) &nbsp;·&nbsp; [Install it](#make-it-yours) &nbsp;·&nbsp; [Understand the connection](#how-the-connection-works)

</div>

## Powered by Hermes

Hermes Terminal is a community-built workspace tab for [Hermes Desktop](https://github.com/NousResearch/hermes-agent). It uses the Hermes plugin SDK, the gateway this window is already signed into, and the same profile-aware desktop environment you already use.

The plugin does not invent a terminal. It opens the stock TUI on that gateway.


## TUI in a workspace tab

Desktop's right-pane terminal is a local shell. This is not that.

| | |
| --- | --- |
| **Open**<br />Sidebar item **TUI**, palette **TUI: Open**, or Ctrl/Cmd+Alt+T. All three open the TUI as a tab in the main area, next to the chat. | **Stay**<br />Open it again and the tab comes to the front. Close the tab to end it. |
| **New**<br />Starts a fresh TUI on the connected gateway. | **Resume**<br />The session rail is `session.list` on that same gateway. Click a row to resume it, the way the dashboard Chat rail does. |

It is a tab and not a route page on purpose. On a remote gateway cold start the Desktop's route table can miss plugin pages registered late in boot. The pane tree does not have that problem.

## Same gateway. Same sessions.

Hermes Terminal keeps the TUI on the gateway you are already using, then stays out of the way:

- Hide the session rail from the header when you want the TUI full width.
- Drag the divider to resize. Double-click it to reset.
- Reconnect remints the WebSocket ticket and dials again.

If the window is on a remote gateway, that TUI is the remote one.

## Stock Hermes. One file.

Hermes Terminal is a single desktop plugin with its own **TUI** item in Hermes. It works with stock Hermes Desktop. There is no fork, upstream patch, separate backend, build step, or package manager.

## Make it yours

### Install

The disk door is `$HERMES_HOME/desktop-plugins/hermes-terminal/plugin.js`.

On this box `$HERMES_HOME` is `%LOCALAPPDATA%\hermes`, not `~/.hermes`. Check before copying:

```bash
hermes config show
```

Under a named profile the root moves to `$HERMES_HOME/profiles/<name>/desktop-plugins/`.

The folder name should match the plugin id (`hermes-terminal`).

The same [`plugin.js`](plugin.js) file is both the source and the installable artifact.

### Symlink

Edits here then hot-reload in place.

PowerShell, as Administrator or with Developer Mode on:

```powershell
New-Item -ItemType SymbolicLink -Path "$env:LOCALAPPDATA\hermes\desktop-plugins\hermes-terminal" -Target "C:\Developer\Hermes\hermes-terminal"
```

macOS / Linux:

```bash
ln -s /path/to/hermes-terminal "$HERMES_HOME/desktop-plugins/hermes-terminal"
```

### Copy

```powershell
New-Item -ItemType Directory -Force -Path "$env:LOCALAPPDATA\hermes\desktop-plugins\hermes-terminal"
Copy-Item "C:\Developer\Hermes\hermes-terminal\plugin.js" "$env:LOCALAPPDATA\hermes\desktop-plugins\hermes-terminal\plugin.js" -Force
```

Then **Ctrl+K** → **Reload desktop plugins**. A load error also raises a toast.

## The TUI, not a local shell

When you open TUI, the plugin mints a WebSocket ticket for the current connection, rewrites it from `/api/ws` to `/api/pty`, and paints `hermes --tui` with xterm.js. Nothing runs in this machine's shell. See [Limits](#limits) for what that rules out.

## How the connection works

```text
Your Hermes Desktop  →  gateway ticket (/api/ws rewritten to /api/pty)  →  hermes --tui on that gateway
```

A remote dashboard must already work for Desktop chat. Loopback bind (`127.0.0.1`) rejects other machines. Auth has to be configured for a public bind. See the web dashboard remote-backend notes.

## Compatibility

Hermes Terminal uses the desktop plugin SDK. It needs a current Hermes Desktop with `getGatewayWsUrl`, and `getGatewayWsUrlFor` when the window is on a registry remote.

The connected dashboard has to be able to spawn the TUI. That is the same extra as dashboard Chat: `ptyprocess` on POSIX, `pywinpty` on native Windows. If spawn fails, `/api/pty` sends an ANSI banner and closes.

First load fetches xterm.js from jsdelivr, with esm.sh as backup. The Desktop SDK does not export a terminal emulator, and a disk plugin cannot import one. Airgapped machines will see that error until we vendor xterm.

## Limits

- This is the TUI, not the old CLI. `/api/pty` always spawns `hermes --tui`. There is no stock remote CLI PTY.
- It does not type `hermes --tui` into this machine's shell. That would miss the point of a remote gateway.
- `openSessionInTerminal` (the OS terminal) is local-only and is not used here.
- xterm comes from a CDN on first open. Offline is a known miss. Vendoring a minified xterm into `plugin.js` is the fix for that.

## License

MIT

<br />

<div align="center">
  <strong>Hermes Terminal</strong><br />
  <sub>Stock Hermes. One file. No core patch.</sub>
</div>

<br />

> **Community project**
>
> Hermes Terminal is an independent community plugin. It is not affiliated with, endorsed by, sponsored by, or officially associated with [Nous Research](https://github.com/NousResearch) or the [Hermes Agent project](https://github.com/NousResearch/hermes-agent). Hermes, Hermes Agent, and Nous Research are names and marks belonging to their respective owners.
