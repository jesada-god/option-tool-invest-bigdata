"""Fast production-source lint checks that do not require a formatter runtime."""

from __future__ import annotations

import ast
from pathlib import Path
import sys


ROOT = Path(__file__).resolve().parents[1]
SOURCES = [ROOT / "main.py", *(ROOT / "app").rglob("*.py")]
FORBIDDEN_CALLS = {"eval", "exec", "compile"}


def call_name(node: ast.Call) -> str | None:
    return node.func.id if isinstance(node.func, ast.Name) else None


def main() -> int:
    problems: list[str] = []
    for source in SOURCES:
        try:
            tree = ast.parse(source.read_text(encoding="utf-8"), filename=str(source))
        except SyntaxError as exc:
            problems.append(f"{source.relative_to(ROOT)}:{exc.lineno}: {exc.msg}")
            continue
        for node in ast.walk(tree):
            if isinstance(node, ast.Call) and call_name(node) in FORBIDDEN_CALLS:
                problems.append(f"{source.relative_to(ROOT)}:{node.lineno}: forbidden dynamic execution call")
            if isinstance(node, ast.Call) and call_name(node) == "print":
                problems.append(f"{source.relative_to(ROOT)}:{node.lineno}: use structured logging instead of print")
    if problems:
        print("\n".join(problems), file=sys.stderr)
        return 1
    print(f"Backend static lint passed for {len(SOURCES)} production Python files.")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
