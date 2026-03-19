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
Copy or symlink this directory there:

```sh
cp -r /path/to/bash-env-exec ~/.openclaw/extensions/bash-env-exec
# or
ln -s /path/to/bash-env-exec ~/.openclaw/extensions/bash-env-exec
```

No changes to `plugins.list` are needed when using the extensions directory.

If you prefer to keep the plugin somewhere else, add it explicitly instead:

```json
{
  "plugins": {
    "enabled": true,
    "list": ["/path/to/bash-env-exec"]
  }
}
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

*(The `tools.exec.pathPrepend` setting only applies to the built-in exec.
Pass `pathPrepend` in the plugin config block instead.)*

**Why `alsoAllow` and not `allow`?**
openclaw applies tool policies in a pipeline: the profile policy runs first and
filters to its own known set of core tools.  A plugin tool like `shell` is
unknown to the profile, so it gets dropped before the global `tools.allow` list
is ever consulted.  `alsoAllow` is merged into the profile's allow list *before*
that filter runs, which is why it is the correct key here.

Because the plugin registers the tool with `optional: true`, it only appears
when it is listed in `tools.alsoAllow` (or resolved via the plugin ID
`bash-env-exec` in an alsoAllow list).

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

`OPENCLAW_AGENT` is useful in scripts or `.bash_env` when you need to
behave differently depending on which agent is running the command.

---

## How BASH_ENV works

When bash runs a non-interactive, non-login shell (i.e. `bash -c "command"`),
it checks the `BASH_ENV` variable and sources the file it points to before
executing the command.  A relative path like `.bash_env` is resolved
against the current working directory of the shell process, which is the
command's `workdir`.

If your `.bash_env` exports environment variables or sets up `PATH`,
those changes take effect for every command the LLM runs.
