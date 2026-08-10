# hardened-ssh-mcp

A single-purpose [MCP](https://modelcontextprotocol.io) server that gives an AI assistant (Claude, or any other
MCP-compatible client) the ability to run commands over SSH on **one pre-configured host, and only that host** -
with an explicit per-call confirmation gate before anything actually executes.

This started as a fork of a general-purpose "let the AI run arbitrary PowerShell" MCP tool. That felt like too much
uncontrolled surface area for what was actually needed (running specific, known commands on one dev server), so
this exists instead: deliberately minimal, deliberately hard to misuse.

## Feedback welcome

This was built to solve a real problem, not as a polished product - if you try it, hit an issue, or have a
better way to do something here, please open an issue. That's genuinely more useful than a star.

## What this is NOT

It is not a general-purpose remote-execution tool. It exposes exactly **one** tool, `run-ssh-command`, which can
only ever do one thing: send a command over SSH to a fixed `user@host` set by whoever deploys the server via
environment variables. The AI model cannot choose or change the target - it isn't a parameter the model can pass
in, it's fixed configuration. It cannot run local commands, and cannot touch the local filesystem directly.

## Hardening built in

- **Fixed target, not a parameter.** Host, user, and identity file come from environment variables set in your MCP
  client's config, not from anything the model can pass at call time.
- **Explicit confirmation gate.** The tool requires `confirmed: true` to actually execute. Calling it without that
  (the default) just echoes back the command it *would* run, without running it. The intent is that your AI
  assistant is instructed to always show you the exact command and wait for your go-ahead before ever setting
  `confirmed: true` - this parameter is a technical backstop for that behaviour, not a replacement for it. (With
  Claude specifically: put this instruction directly in the tool's own description, as this project does, and
  additionally leave the tool's permission setting on "ask every time" rather than "always allow" in your client.)
- **No shell re-interpretation.** Arguments are passed as an array via `spawn(..., { shell: false })`, not built as
  a concatenated string run through a shell.
- **Fails fast, never hangs silently.** `BatchMode=yes` means if key auth doesn't work, the command errors out
  immediately instead of sitting there waiting for a password prompt nobody can answer. A timeout (default 30s,
  configurable) kills anything that hangs regardless.
- **Local audit log.** Every command that actually executes is appended to `logs/ssh-command-log.txt` with a
  timestamp and exit code, independent of your AI client's own chat history.

## What this does NOT protect against

Being direct about the actual limits, not overselling this:

- `confirmed: true` is a contract the model is instructed to respect, not something this tool can verify was
  genuinely approved by a human. The real backstops are your AI client's own instructed behaviour and its per-tool
  permission prompt.
- Once a command reaches the remote host, it runs as whatever user you configured - this tool doesn't add any
  privilege restriction on the remote side. If you want defence in depth, give the SSH user its own restricted,
  least-privilege account with scoped `sudo`, not your main account.
- This is a small, unaudited piece of code - treat it with the same scepticism as any other tool that can execute
  commands on your behalf, not as a certified-secure product.

## Setup

**Prerequisites:** Node.js 18+, and a working `ssh` client on your system.

1. Clone or download this repo.
2. `npm install`
3. Generate (or reuse) an SSH keypair authorised on the target host, e.g.:
   ```
   ssh-keygen -t ed25519 -f ~/.ssh/hardened-ssh-mcp-key
   ssh-copy-id -i ~/.ssh/hardened-ssh-mcp-key.pub youruser@yourhost
   ```
4. Copy `claude_desktop_config.example.json` and fill in your own values (host, user, key path), or add the
   equivalent `env` block to your existing MCP client config. See that file for the exact shape.
5. Restart your MCP client.
6. In your client's settings, leave this tool's permission on "ask every time," not "always allow."

### Configuration reference

| Variable | Required | Default | Notes |
|---|---|---|---|
| `SSH_USER` | yes | - | Remote username |
| `SSH_HOST` | yes | - | Remote host (IP or hostname) |
| `SSH_IDENTITY_FILE` | yes | - | Absolute path to your private key |
| `SSH_KNOWN_HOSTS_FILE` | no | your normal `~/.ssh/known_hosts` | See the Windows note below if this path contains spaces |
| `SSH_EXECUTABLE` | no | `ssh` (resolved via PATH) | See the Windows note below |
| `SSH_HOME` | no | - | Only needed in the Windows edge case below |
| `SSH_CONNECT_TIMEOUT_SECONDS` | no | `10` | |
| `SSH_COMMAND_TIMEOUT_MS` | no | `30000` | |

## Windows note: a real gotcha this project ran into

If you're running this on Windows with an MSIX-packaged AI client (this includes Claude Desktop's Microsoft
Store-style installer path), you may hit a genuinely strange failure: Windows' native OpenSSH client
(`System32\OpenSSH\ssh.exe`) exits with code 255 and **completely empty output** - no stdout, no stderr, not even
for `ssh -V` with no network or keys involved. It works fine run manually, and even works fine from an identical
standalone Node.js script - but fails silently the moment it's spawned as a child of the packaged client
specifically.

Extensive diagnosis (Process Monitor tracing, elimination of every antivirus/firewall/sandboxing/process-isolation
cause) pointed to `ssh.exe`'s own startup code failing during a call into `kernel.appcore.dll` (a Windows DLL used
to query an application's packaging/App Model identity) - plausibly because it inherits an incomplete package
identity from an MSIX-packaged ancestor process, and doesn't handle that combination cleanly.

**The practical fix:** use Git for Windows' bundled SSH client instead of the native one. It's a completely
different build (MSYS2/Cygwin-based, not Microsoft's MSVC-built port) and does not exhibit this failure under the
identical condition. To use it:

1. Install Git for Windows with the **"Use bundled OpenSSH"** option (not "Use external OpenSSH").
2. Set `SSH_EXECUTABLE` to the bundled client's path, typically `C:\Program Files\Git\usr\bin\ssh.exe`.
3. Set `SSH_HOME` to your user profile directory (e.g. `C:\Users\yourname`) - Git's MSYS2-based client needs `HOME`
   set explicitly to resolve correctly; Windows' native client does not need this.

If you'd rather keep using Windows' native OpenSSH and are hitting this, an alternative (more involved) workaround
is to run this server as a standalone process reached via a stdio-to-HTTP bridge (e.g.
[`mcp-remote`](https://www.npmjs.com/package/mcp-remote)) rather than letting your AI client spawn it directly -
this avoids the failure entirely by ensuring `ssh.exe` is never a descendant of the packaged client process, at the
cost of needing to start that process yourself before each session. Happy to point you at more detail on this if
you land here from a search and it's relevant to your situation - open an issue.

## Extending

A per-command allowlist/denylist, or a second, separately configured instance for an additional host, would both
be straightforward additions to this pattern.

## License

MIT - see [LICENSE](./LICENSE).
