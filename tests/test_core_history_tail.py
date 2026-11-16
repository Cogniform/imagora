import json


def _write_tail(tmp_path, lines: list[bytes]) -> "object":
    path = tmp_path / "generation.jsonl"
    path.write_bytes(b"\n".join(lines))
    return path


def test_reverse_reader_handles_chunk_boundaries(tmp_path):
    """块边界切开行时必须拼回去：用远小于行长度的块跑一遍，结果要与整份读一致。"""
    from core import history

    records = [
        {
            "time": f"2026-08-09 10:00:{i:02d}",
            "prompt": f"提示词 {i}" * 20,
            "status": "ok",
        }
        for i in range(12)
    ]
    path = tmp_path / "generation.jsonl"
    path.write_text(
        "\n".join(json.dumps(r, ensure_ascii=False) for r in records), encoding="utf-8"
    )

    # 7 字节一块：几乎每个汉字都会被切开（多字节字符跨块），这是最容易写错的地方
    lines_small = list(history.iter_ledger_lines_reversed(path, chunk_size=7))
    lines_whole = list(history.iter_ledger_lines_reversed(path, chunk_size=1 << 20))

    assert lines_small == lines_whole
    # 最新在前，且每行都能独立解析
    parsed = [json.loads(line) for line in lines_small if line.strip()]
    assert [p["prompt"] for p in parsed] == [r["prompt"] for r in reversed(records)]


def test_list_stops_at_raw_limit_without_reading_the_whole_file(tmp_path, monkeypatch):
    """列表只读尾部：文件开头放一行非法 UTF-8，整份解码会炸，按块倒读则完全碰不到它。"""
    from core import history

    good = [
        json.dumps(
            {"time": f"2026-08-09 11:00:{i:02d}", "prompt": f"new {i}", "status": "ok"}
        ).encode()
        for i in range(3)
    ]
    # 0xff 不是合法 UTF-8 起始字节：整份 read_text 会抛 UnicodeDecodeError
    path = _write_tail(tmp_path, [b"\xff\xfe garbage head", *good])
    monkeypatch.setattr(history, "HISTORY_FILE", path)

    result = history.read_generation_history(limit=2)

    assert [item["prompt"] for item in result] == ["new 2", "new 1"]


def test_bad_bytes_only_affect_their_own_line(tmp_path, monkeypatch):
    """逐行解码：坏字节行被跳过，其余行照常返回（旧实现会整份失败、返回空）。"""
    from core import history

    path = _write_tail(
        tmp_path,
        [
            json.dumps(
                {"time": "2026-08-09 10:00:00", "prompt": "ok first", "status": "ok"}
            ).encode(),
            b"\xff\xfe broken bytes",
            json.dumps(
                {"time": "2026-08-09 11:00:00", "prompt": "ok second", "status": "ok"}
            ).encode(),
        ],
    )
    monkeypatch.setattr(history, "HISTORY_FILE", path)

    assert [item["prompt"] for item in history.read_generation_history()] == [
        "ok second",
        "ok first",
    ]
