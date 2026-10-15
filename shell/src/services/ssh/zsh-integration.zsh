__seal_report_cwd() {
  builtin printf '\033]1337;CurrentDir=%s\007' "$PWD"
}

# Keep existing prompt and directory hooks, including those installed by themes.
precmd_functions+=(__seal_report_cwd)
chpwd_functions+=(__seal_report_cwd)
__seal_report_cwd
