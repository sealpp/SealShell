import type { CommandSuggestionProvider } from './model'

// These are examples, not a claim that a command is installed on the host.
const commands = [
  'ls -la', 'ls -lh', 'ls -lah', 'pwd', 'cd ..', 'cd ~',
  'git status', 'git diff', 'git log --oneline', 'git branch', 'git pull', 'git fetch',
  'docker ps', 'docker ps -a', 'docker images', 'docker compose ps', 'docker compose logs',
  'kubectl get pods', 'kubectl get services', 'kubectl get namespaces',
  'systemctl status', 'systemctl list-units', 'journalctl -f', 'journalctl -xe',
  'df -h', 'du -sh', 'free -h', 'ps aux', 'top', 'htop', 'uptime', 'uname -a',
  'ip addr', 'ip route', 'ss -tuln', 'history', 'whoami', 'printenv',
  'npm run', 'npm install', 'npm test', 'python --version', 'python3 --version',
  'find . -name', 'grep -n', 'tail -f', 'head -n', 'cat ', 'less ', 'man ',
]

export const commonCommandProvider: CommandSuggestionProvider = {
  suggestions: () => commands.map((command, index) => ({
    command, source: 'common', priority: 0, uses: commands.length - index, lastUsed: 0,
  })),
}
