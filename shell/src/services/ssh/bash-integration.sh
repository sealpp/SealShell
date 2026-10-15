__seal_report_cwd() {
  builtin local __seal_status=$?
  builtin printf '\033]1337;CurrentDir=%s\007' "$PWD"
  return "$__seal_status"
}

# Keep scalar/array prompt hooks and the preceding command's exit status intact.
PROMPT_COMMAND[0]="__seal_report_cwd${PROMPT_COMMAND[0]:+; ${PROMPT_COMMAND[0]}}"
