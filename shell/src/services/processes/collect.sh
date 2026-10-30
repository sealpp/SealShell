# SEAL_PROCESS_COLLECT_V2
LC_ALL=C
export LC_ALL
if [ "$(uname -s)" != Linux ] || [ ! -r /proc/uptime ]; then
  printf '仅支持具有 /proc 的 Linux 系统\n' >&2
  exit 64
fi
hz=$(getconf CLK_TCK) || exit 64
page_size=$(getconf PAGESIZE) || exit 64
# GNU ps supplies account names. /proc supplies command lines and
# stable process identity and cumulative CPU ticks, not ps lifetime averages.
ps -eo pid=,uid=,user= > /dev/null || exit 64
ps -eo pid=,uid=,user= | awk -v hz="$hz" -v page_size="$page_size" '
function escape(s) {
  gsub(/%/, "%25", s); gsub(/\t/, "%09", s)
  gsub(/\r/, "%0D", s); gsub(/\n/, "%0A", s)
  gsub(/\000/, "%00", s)
  return s
}
BEGIN {
  getline boot < "/proc/sys/kernel/random/boot_id"
  close("/proc/sys/kernel/random/boot_id")
  getline up < "/proc/uptime"; close("/proc/uptime")
  split(up, times, " ")
  while ((getline line < "/proc/stat") > 0) {
    if (line ~ /^btime /) { split(line, fields, " "); born = fields[2] }
  }
  close("/proc/stat")
  if (!boot || hz <= 0 || page_size <= 0 || !born) exit 65
  printf "SEAL_PROCESS_V2\t%s\t%s\t%s\t%s\n", boot, hz, times[1], born
}
{
  pid = $1; uid = $2; user = $3
  if (pid !~ /^[0-9]+$/) next
  file = "/proc/" pid "/stat"; stat = ""
  while ((getline line < file) > 0) stat = stat (stat ? "\n" : "") line
  close(file)
  if (!stat) next
  rest = stat; sub(/^.*\) /, "", rest)
  count = split(rest, fields, " ")
  if (count < 22 || fields[20] !~ /^[0-9]+$/) next
  name = stat; sub(/^[0-9]+ \(/, "", name); sub(/\) [^)]*$/, "", name)
  command = ""; first = 1; file = "/proc/" pid "/cmdline"
  while ((read = (getline line < file)) > 0) { command = command (first ? "" : "\n") line; first = 0 }
  close(file)
  if (read < 0) command = "(无法读取命令行)"
  # Keep NUL boundaries; the frontend derives display text separately from argv.
  if (!command) command = "[" name "]"
  # Read identity again: do not associate a replacement process command
  # with the process identity read before cmdline.
  file = "/proc/" pid "/stat"; after = ""
  while ((getline line < file) > 0) after = after (after ? "\n" : "") line
  close(file)
  sub(/^.*\) /, "", after); split(after, check, " ")
  if (check[20] != fields[20]) next
  printf "%d\t%d\t%d\t%s\t%s\t%.0f\t%s\t%.0f\t%d\t%s\t%s\n", pid, fields[2], uid, user, fields[1], fields[22] * page_size, fields[20], fields[12] + fields[13], fields[18], escape(name), escape(command)
  rows++
  if (rows > 20000) { failed = 1; exit 66 }
}
END {
  if (!failed && boot && born) printf "SEAL_PROCESS_END\t%d\n", rows
}'
