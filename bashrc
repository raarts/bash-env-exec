# ============== FOR OPENCLAW BASH-ENV-EXEC =================
become() {
    if [[ -z "$1" ]]; then
        echo "Usage: become <agent-naam>"
        return 1
    fi

    local AGENT="$1"
    CONFIG="$HOME/.openclaw/openclaw.json"

    if [[ ! -f "$CONFIG" ]]; then
      echo "Not found: $CONFIG" >&2
      return 1
    fi

    workspace=$(jq -r --arg agent "$AGENT" '
      (.agents.list? // []
        | .[]
        | select(.id? == $agent)
        | .workspace?
      )
      // .agents.defaults?.workspace
      // "not found"
    ' "$CONFIG")

    if [[ -z "$workspace" ]]; then
        echo "❌ Unknown agent: '$agent'"
        return 1
    fi

    if [[ ! -d "$workspace" ]]; then
        echo "❌ Directory not found: $workspace"
        return 1
    fi

    if [[ -f "$workspace/.bash_env" ]]; then
        pushd $workspace &> /dev/null
        source $workspace/.bash_env
        popd       &> /dev/null
    else
        echo "⚠️  No .bash_env found in $workspace"
    fi

    export OPENCLAW_AGENT="$AGENT"
    export OPENCLAW_SHELL="shell"
}

unbecome() {
    if [[ -n "${OPENCLAW_AGENT:-}" ]]; then
        unset OPENCLAW_AGENT
        unset OPENCLAW_SHELL
        update_prompt
    fi
}

if [[ -z "$ORIGINAL_PS1" ]]; then
    ORIGINAL_PS1="$PS1"
fi

update_prompt() {
    local prefix=""
    if [[ -n "${OPENCLAW_AGENT:-}" ]]; then
        prefix="(\e[1;32m${OPENCLAW_AGENT}\e[0m) "
    fi
    PS1="${prefix}${ORIGINAL_PS1}"
}

# Voeg toe aan PROMPT_COMMAND (veilig appenden)
if [[ ":$PROMPT_COMMAND:" != *":update_prompt:"* ]]; then
    if [[ -z "$PROMPT_COMMAND" ]]; then
        PROMPT_COMMAND="update_prompt"
    else
        PROMPT_COMMAND="update_prompt; $PROMPT_COMMAND"
    fi
fi

