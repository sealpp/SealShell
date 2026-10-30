"""Run browser UI tests and native Windows protocol/desktop tests separately."""
import argparse
from _tools import SHELL, cargo, environment, npm, python_fixture, run

def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("suite", nargs="?", default="all", choices=("all", "unit", "ui", "native", "desktop", "build"))
    options = parser.parse_args()
    suites = ("unit", "native", "ui", "desktop", "build") if options.suite == "all" else (options.suite,)
    for suite in suites:
        if suite in ("unit", "ui", "build"):
            script = {"unit": "test:unit", "ui": "test:e2e", "build": "build"}[suite]
            run(npm("run", script), SHELL)
        elif suite == "native":
            env = environment()
            env["SEAL_PYTHON"] = str(python_fixture())
            run([cargo(), "test", "-p", "seal-runtime", "--locked"], env=env)
        elif suite == "desktop":
            env = environment()
            env["SEAL_PYTHON"] = str(python_fixture())
            run(["node", "tests/desktop-e2e.mjs"], SHELL, env)

if __name__ == "__main__":
    main()
