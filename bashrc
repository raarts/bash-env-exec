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

    OPENCLAW_WORKSPACE=$(jq -r --arg agent "$AGENT" '
      (.agents.list? // []
        | .[]
        | select(.id? == $agent)
        | .workspace?
      )
      // .agents.defaults?.workspace
      // "not found"
    ' "$CONFIG")

    if [[ -z "$OPENCLAW_WORKSPACE" ]]; then
        echo "❌ Unknown agent: '$AGENT'"
        return 1
    fi

    if [[ ! -d "$OPENCLAW_WORKSPACE" ]]; then
        echo "❌ Directory not found: $OPENCLAW_WORKSPACE"
        return 1
    fi

    if [[ -f "$OPENCLAW_WORKSPACE/.bash_env" ]]; then
        pushd $OPENCLAW_WORKSPACE &> /dev/null
        source $OPENCLAW_WORKSPACE/.bash_env
        popd       &> /dev/null
    else
        echo "⚠️  No .bash_env found in $OPENCLAW_WORKSPACE"
    fi

    export OPENCLAW_AGENT="$AGENT"
    export OPENCLAW_SHELL="shell"
    export OPENCLAW_WORKSPACE
}

unbecome() {
    if [[ -n "${OPENCLAW_AGENT:-}" ]]; then
        unset OPENCLAW_AGENT
        unset OPENCLAW_SHELL
        unset OPENCLAW_WORKSPACE
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

