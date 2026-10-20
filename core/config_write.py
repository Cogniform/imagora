"""Step 1: core/config_write.py — surgical (line-level) .env updates.

Pure functions do the text surgery so they are unit-testable without touching disk;
the write wrapper adds .bak + atomic replace.

Design constraints (2026-10-03, config editor UI):
  - The .env file is hand-edited by the user, so its comments / blank lines /
    key order / quoting style are user content and must survive a UI save.
  - Never rewrite the whole file from a parsed dict — that is exactly what wipes
    comments. Only the targeted lines change.
  - Removing a key comments it out instead of deleting the line, so a mistap is
    recoverable by hand (there is deliberately no "reset" button in the UI).
"""

from __future__ import annotations

import os
import shutil
import tempfile
from pathlib import Path

# Quote characters we keep when rewriting an existing line.
_QUOTES = ("'", '"')


def split_key_value(line: str) -> tuple[str, str] | None:
    """Split one .env line into (key, raw_value); None when it isn't an assignment.

    Mirrors core/config.py's `_load_env_file` parser exactly: strip, skip blanks
    and `#` comments, then partition on the FIRST `=`. Keeping the two parsers
    identical matters — if this one disagreed, we'd rewrite keys the loader would
    then ignore (or worse, miss keys it does read).
    """
    stripped = line.strip()
    if not stripped or stripped.startswith("#") or "=" not in stripped:
        return None
    key, _, value = stripped.partition("=")
    key = key.strip()
    if not key:
        return None
    return key, value.strip()


def _unquote(value: str) -> tuple[str, str | None]:
    """Strip matching surrounding quotes; return (value, original_quote_char).

    The quote char is returned so the rewrite can put the same one back.
    """
    for quote in _QUOTES:
        if len(value) >= 2 and value.startswith(quote) and value.endswith(quote):
            return value[1:-1], quote
    return value, None


def _quote_like(value: str, quote: str | None) -> str:
    """Wrap `value` in `quote` when the original line was quoted, else return bare.

    `quote` is the *original* quote character (already stripped off by
    `_unquote`), not a re-inspection of the new value — re-inspecting would
    always answer `"` and silently turn every single-quoted line into a
    double-quoted one.
    """
    if quote is None:
        return value
    return f"{quote}{value}{quote}"


def _detect_newline(text: str) -> str:
    """Use CRLF when the file already uses it; otherwise LF (and never mixed)."""
    return "\r\n" if "\r\n" in text else "\n"


def update_env_text(text: str, updates: dict[str, str]) -> str:
    """Return `text` with `updates` applied line by line. Pure.

    Rules:
      - comments / blank lines / non-assignment lines: copied verbatim
      - an existing KEY: value replaced in place, keeping that line's quoting style
      - a new KEY: appended as a block with a marker comment above it
      - a key in `updates` whose value is empty: **no change** (the UI's
        "leave blank = don't change" rule); use `comment_out_keys` to clear one

    Trailing newline is preserved as found (or added for an appended block).
    """
    if not updates:
        return text

    newline = _detect_newline(text)
    lines = text.split(newline) if text else []
    had_trailing_newline = bool(text) and text.endswith(newline)
    seen: set[str] = set()
    out: list[str] = []

    for line in lines:
        parsed = split_key_value(line)
        if parsed is None:
            out.append(line)
            continue
        key, raw_value = parsed
        if key not in updates:
            out.append(line)
            continue
        new_value = updates[key]
        if new_value == "":
            # "留空 = 不修改"：原样保留，绝不因为输入框空了就抹掉磁盘上的值
            out.append(line)
            seen.add(key)
            continue
        _, quote = _unquote(raw_value)
        # 保留原有缩进，只换值
        indent = line[: len(line) - len(line.lstrip())]
        out.append(f"{indent}{key}={_quote_like(new_value, quote)}")
        seen.add(key)

    pending = [k for k, v in updates.items() if v != "" and k not in seen]
    if pending:
        if out and out[-1].strip() != "":
            out.append("")
        out.append("# 由配置界面写入（本机覆盖，删掉这几行即恢复 config.json 出厂值）")
        out.extend(f"{key}={updates[key]}" for key in pending)
        had_trailing_newline = True

    result = newline.join(out)
    if had_trailing_newline and result and not result.endswith(newline):
        result += newline
    return result


def comment_out_keys(text: str, keys: list[str]) -> str:
    """Comment out the given keys (prefix `# `), leaving everything else intact.

    Used by the "clear secret" action: the line stays on disk as a reminder of
    what was there, and recovering is a one-character edit in any text editor.
    """
    if not keys:
        return text
    wanted = set(keys)
    newline = _detect_newline(text)
    out: list[str] = []
    for line in text.split(newline):
        parsed = split_key_value(line)
        if parsed is not None and parsed[0] in wanted:
            indent = line[: len(line) - len(line.lstrip())]
            out.append(f"{indent}# {line.lstrip()}")
        else:
            out.append(line)
    return newline.join(out)


def write_text_atomic(path: Path, text: str, *, backup: bool = True) -> None:
    """Write `text` to `path` via temp file + os.replace, keeping a .bak first.

    Atomic replace matters: this file holds the API key, and a crash mid-write
    would otherwise leave a truncated (possibly half-written key) .env, which
    means the service comes back up unable to generate at all.
    """
    path.parent.mkdir(parents=True, exist_ok=True)
    if backup and path.exists():
        shutil.copy2(path, path.with_name(path.name + ".bak"))

    handle, tmp_name = tempfile.mkstemp(
        dir=str(path.parent), prefix=path.name + ".", suffix=".tmp"
    )
    tmp = Path(tmp_name)
    try:
        with os.fdopen(handle, "w", encoding="utf-8", newline="") as fh:
            fh.write(text)
            fh.flush()
            os.fsync(fh.fileno())
        # 保留原文件权限（新文件默认继承 umask，.env 收紧权限是有意义的）
        if path.exists():
            shutil.copymode(path, tmp)
        os.replace(tmp, path)
    except BaseException:
        tmp.unlink(missing_ok=True)
        raise


def update_env_file(
    path: Path, updates: dict[str, str], *, backup: bool = True
) -> None:
    """Apply `updates` to the .env at `path`, atomically."""
    text = path.read_text(encoding="utf-8") if path.exists() else ""
    write_text_atomic(path, update_env_text(text, updates), backup=backup)


def comment_out_env_file(path: Path, keys: list[str], *, backup: bool = True) -> None:
    """Comment out `keys` in the .env at `path`, atomically."""
    text = path.read_text(encoding="utf-8") if path.exists() else ""
    write_text_atomic(path, comment_out_keys(text, keys), backup=backup)


def read_env_values(path: Path) -> dict[str, str]:
    """Read the .env file into {KEY: value}; comments and blanks dropped.

    Lives next to the writer on purpose: it must use the **same** parser as
    `update_env_text`, otherwise "what the UI believes is in the file" and "what
    the UI writes" would disagree on quoting/whitespace handling.
    Missing or unreadable file → empty dict (never raises; a config reader must
    not take the server down).
    """
    if not path.exists():
        return {}
    try:
        text = path.read_text(encoding="utf-8")
    except OSError:
        return {}
    out: dict[str, str] = {}
    for line in text.splitlines():
        parsed = split_key_value(line)
        if parsed is None:
            continue
        key, raw_value = parsed
        out[key] = _unquote(raw_value)[0]
    return out
