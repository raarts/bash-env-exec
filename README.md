# bash-env-exec

An openclaw plugin that replaces the built-in `exec` tool with one that sets
`BASH_ENV` before every shell command, causing bash to source the named file
in non-interactive/non-login invocations.

This allows you to set agent-specific environment variables, like tokens, config paths or whatever.
It also supplies OPENCLAW_AGENT which holds the agent name. 

## What it does differently

The built-in exec strips `BASH_ENV` from the environment for security reasons.
This plugin bypasses that sanitisation so your `.bash_env` (or any file
you choose) is sourced before each command.

Everything else – command, workdir, env, timeout, yieldMs, background, pty –
works the same way as the built-in exec.

**Not supported** (compared to the built-in):

| Feature | Status |
|---------|--------|
| `host=sandbox` / `host=node` | Gateway / local only |
| `elevated` | Not implemented |
| Background session tracking | Yields "still running" but the `process` tool (poll/log/kill) cannot see it |
| Approval gating (`ask=`) | Not implemented |

---

## The naming conflict

openclaw's policy system filters tools **by name only**.  If this plugin
registers a tool also called `exec`, there are two tools with the same name
and the Anthropic API rejects the request.

**You must use a tool name that is not `exec`**.  The default is `shell`,
which avoids the conflict.  Only change `toolName` if `shell` clashes with
something else in your setup.

---

## Setup

### 1. Install the plugin

openclaw auto-discovers plugins placed under `~/.openclaw/extensions/`.
Clone this repo and:

```sh
openclaw plugins install ./bash-env-exec
```

### 2. Configure the plugin

The tool name defaults to `shell` and `.bash_env` is sourced by default,
so no configuration is needed for a basic setup.

Plugin-specific config can be set via `plugins.entries` in `openclaw.json`:

```json
{
  "plugins": {
    "enabled": true,
    "entries": {
      "bash-env-exec": {
        "config": {
          "toolName": "shell",
          "bashEnvFile": ".bash_env",
          "pathPrepend": [ "/usr/local/bin" ]
        }
      }
    }
  }
}
```

### 3. Update your tools policy

Block the built-in `exec` and allow this plugin's tool name instead.

Update or create a tools section like this:

```json
"tools": {
  "deny": ["exec"],
  "alsoAllow": ["shell"]
}
```

**Why `alsoAllow` and not `allow`?**
openclaw applies tool policies in a pipeline: the profile policy runs first and
filters to its own known set of core tools.  A plugin tool like `shell` is
unknown to the profile, so it gets dropped before the global `tools.allow` list
is ever consulted.  `alsoAllow` is merged into the profile's allow list *before*
that filter runs, which is why it is the correct key here.

Because the plugin registers the tool with `optional: true`, it only appears
when it is listed in `tools.alsoAllow` (or resolved via the plugin ID
`bash-env-exec` in an alsoAllow list).

### 4. Optional: open an agent shell from the command line

The `become` script starts an interactive bash shell with the exact environment
that an agent sees when executing commands via this plugin: gateway process env,
`.bash_env` applied, agent vars set, and cwd pointing to the agent's workspace.

Place it somewhere on your `PATH`:

```sh
cp become ~/bin/become   # or any directory on your PATH
chmod +x ~/bin/become
```

Then use it as:

```sh
become <agent-id>   # e.g. become kai
```

Inside the shell you get:
- Prompt prefixed with the agent name: `(kai) artsr@host:~$`
- `acd` alias to jump back to the agent's workspace
- All `.bash_env` exports active
- `OPENCLAW_AGENT`, `OPENCLAW_WORKSPACE`, `OPENCLAW_HOME` set

Exit with `exit` or Ctrl-D to return to your normal shell.

---

## Config reference

| Key | Type | Default | Description |
|-----|------|---------|-------------|
| `toolName` | string | `"shell"` | Name the tool is registered under. **Must not be `exec`** – see above. |
| `bashEnvFile` | string | `".bash_env"` | Value assigned to `BASH_ENV`. Relative paths are resolved by bash against the command's working directory. |
| `pathPrepend` | string[] | `[]` | Directories prepended to `PATH` for every command. |
| `defaultTimeoutSec` | number | `1800` | Default command timeout in seconds. |
| `defaultYieldMs` | number | `10000` | Milliseconds to wait before yielding a still-running command. |

---

## Environment variables injected by this plugin

This plugin injects the following environment variables:

| Variable | Value |
|----------|-------|
| `BASH_ENV` | The configured `bashEnvFile` value (default `.bash_env`) |
| `OPENCLAW_SHELL` | The configured `toolName` (default `"shell"`) |
| `OPENCLAW_AGENT` | The openclaw agent ID (e.g. `main`), when available |
| `OPENCLAW_WORKSPACE` | The agent's workspace directory, when available |

`OPENCLAW_AGENT` and `OPENCLAW_WORKSPACE` are useful in scripts or `.bash_env` when you need to
behave differently depending on which agent is running the command, or need to reference
the agent's workspace path.

---

## How BASH_ENV works

When bash runs a non-interactive, non-login shell (i.e. `bash -c "command"`),
it checks the `BASH_ENV` variable and sources the file it points to before
executing the command.  A relative path like `.bash_env` is resolved
against the current working directory of the shell process, which is the
command's `workdir`.

If your `.bash_env` exports environment variables or sets up `PATH`,
those changes take effect for every command the LLM runs.
