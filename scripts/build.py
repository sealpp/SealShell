"""Build the Windows installer, including the offline WebView2 prerequisite."""
from _tools import SHELL, cargo, npm, run

if __name__ == "__main__":
    cargo()
    run(npm("run", "desktop:build", "--", "--bundles", "nsis"), SHELL)
