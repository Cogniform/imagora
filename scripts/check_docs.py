#!/usr/bin/env python3
"""仓库完整性校验：相对链接可解析 + 仪表盘计数与源码一致 + 桌面链产物不脱节
（图标指纹、exe 里烘焙的启动脚本路径）。

只读、无副作用（不写任何文件），本地与 CI 均可跑：
    python scripts/check_docs.py [--quiet]
退出码 0 = 全部通过；1 = 有断链 / 计数漂移（输出明细）。

背景：文档体系要求「改任何文档后复查链接可解析、仪表盘数字不过时」
（根 AGENTS.md 互改联动）。测试计数分散在 AGENTS / tests/README /
ARCHITECTURE / frontend/README 多处，人工同步易漏（曾出现 221→222
漏改、frontend 145 过时数字等漂移）。本脚本把「数字与源码一致」
从纪律变成可执行检查：后端数解 pytest 的 def test_，前端数解 vitest
的 it()，再与各文档声明的数字逐处比对。
"""

import argparse
import ast
import hashlib
import pathlib
import re
import sys

ROOT = pathlib.Path(__file__).resolve().parent.parent

# 递归跳过目录（node_modules 等大目录不进扫描）
_SKIP_DIRS = {".git", "node_modules", "dist", ".venv", "output", "logs"}

LINK_RE = re.compile(r"\[[^\]]*\]\(([^)]+)\)")


def doc_markdown_files() -> list[pathlib.Path]:
    """项目内所有 doc 系 markdown（递归，跳过大目录）。"""
    files = []
    for p in ROOT.rglob("*.md"):
        rel = p.relative_to(ROOT)
        if any(part in _SKIP_DIRS for part in rel.parts):
            continue
        files.append(p)
    return sorted(files)


def check_links() -> list[str]:
    """相对 markdown 链接可解析：逐 md 提取 [text](target)，跳过外链/锚点/占位。"""
    problems: list[str] = []
    checked = 0
    for md in doc_markdown_files():
        try:
            text = md.read_text(encoding="utf-8")
        except OSError as exc:
            problems.append(f"{md.relative_to(ROOT)}: 读取失败 {exc}")
            continue
        for m in LINK_RE.finditer(text):
            target = m.group(1).strip()
            if not target or target.startswith(
                ("http://", "https://", "mailto:", "#", "<")
            ):
                continue
            path_part = target.split("#", 1)[0].strip()
            if not path_part:
                continue
            path_part = path_part.strip("<>")  # <path> 形式角括号包裹
            if not (md.parent / path_part).resolve().exists():
                line = text.count("\n", 0, m.start()) + 1
                problems.append(f"{md.relative_to(ROOT)}:{line} 断链 → {target}")
            checked += 1
    return checked, problems


def _parametrize_multiplier(decorator: ast.expr) -> int:
    """`@pytest.mark.parametrize(...)` 把 1 个函数展开成 N 个用例，返回倍数。

    只认字面量 argvalues（list/tuple）；变量或函数调用无法静态展开，按 1 计。
    同一函数叠多个 parametrize 时倍数相乘（pytest 的笛卡尔积语义）。
    """
    call = decorator
    if not isinstance(call, ast.Call):
        return 1
    # 只处理 pytest.mark.parametrize，其它装饰器（fixture/skipif）不改变倍数
    func = call.func
    if not (isinstance(func, ast.Attribute) and func.attr == "parametrize"):
        return 1
    if len(call.args) < 2:
        return 1
    values = call.args[1]
    if isinstance(values, (ast.List, ast.Tuple)):
        return max(1, len(values.elts))
    return 1


def count_backend_tests() -> tuple[int, dict[str, int]]:
    """tests/test_*.py 的用例数（与 pytest 收集口径一致，参数化按展开后计）。

    曾只数 `def test_`，于是 `@pytest.mark.parametrize` 展开出的用例被漏掉：
    文档写 432、`pytest` 实际收 454，两边都写错反而自洽通过。
    """
    total = 0
    per_file: dict[str, int] = {}
    for py in sorted((ROOT / "tests").glob("test_*.py")):
        tree = ast.parse(py.read_text(encoding="utf-8"), filename=str(py))
        n = 0
        for node in ast.walk(tree):
            if not isinstance(node, (ast.FunctionDef, ast.AsyncFunctionDef)):
                continue
            if not node.name.startswith("test_"):
                continue
            multiplier = 1
            for decorator in node.decorator_list:
                multiplier *= _parametrize_multiplier(decorator)
            n += multiplier
        per_file[py.name] = n
        total += n
    return total, per_file


# it.each 的表头：`it.each([...])` / `it.each<Type>([...])` / `it.each\`...\``。
# 必须允许 `<...>` 类型参数——`it.each<CropHandle>([8 项])(...)` 里带尖括号，
# 只写 `it\.each\(` 会整条漏掉，8 个用例被算成 0（曾把 475 算成 467）。
_IT_EACH_RE = re.compile(r"it\.each(?:<[^>]*>)?\s*[(`]")
_IT_RE = re.compile(r"\bit\(")


def count_frontend_tests() -> int:
    """frontend/src 下 *.test.ts* 的 it() / it.each() 数（vitest 用例口径）。

    `it.each` 的表格行数要展开算——vitest 运行时按表长展开成 N 个用例，
    静态计数必须同口径，否则仪表盘数字与 `vitest run` 输出对不上。
    """
    total = 0
    for ts in sorted((ROOT / "frontend" / "src").rglob("*.test.ts*")):
        text = ts.read_text(encoding="utf-8")
        # 先把 it.each 的调用从文本里摘掉，避免它内部的 `it(` 被重复计数
        without_each = _IT_EACH_RE.sub("__IT_EACH__", text)
        total += len(_IT_RE.findall(without_each))
        total += _count_each_rows(text)
    return total


# `it.each([...])` / `it.each<Type>([...])` 的字面量数组：数顶层逗号分隔的元素。
_EACH_TABLE_RE = re.compile(r"it\.each(?:<[^>]*>)?\s*\(\s*\[([^\]]*)\]", re.DOTALL)


def _count_each_rows(text: str) -> int:
    """统计 it.each 表格字面量里的行数；解析不出的（变量 / 模板）按 1 计。"""
    rows = 0
    for match in _EACH_TABLE_RE.finditer(text):
        body = match.group(1).strip()
        if not body:
            continue
        # 元素可能是字符串、数字或元组；按「不在括号/引号内的逗号」切分
        depth = 0
        quote: str | None = None
        items = 1
        for ch in body:
            if quote:
                if ch == quote:
                    quote = None
            elif ch in "\"'`":
                quote = ch
            elif ch in "([{":
                depth += 1
            elif ch in ")]}":
                depth -= 1
            elif ch == "," and depth == 0:
                items += 1
        rows += items
    # 有 it.each 但表格不是字面量（变量 / 模板字符串）时无法静态展开，按 1 计
    each_calls = len(_IT_EACH_RE.findall(text))
    literal_tables = len(_EACH_TABLE_RE.findall(text))
    rows += max(0, each_calls - literal_tables)
    return rows


# 计数声明点：文本模式 → 期望的计数类型（backend/frontend）。
# 每处模式必须恰好命中且数值与源码一致；模式改写法导致匹配不到会报错（防校验空转）。
COUNT_PATTERNS: list[tuple[pathlib.Path, str, str]] = [
    (ROOT / "tests" / "README.md", r"# 后端全量（(\d+) 用例）", "backend"),
    (ROOT / "tests" / "README.md", r"## 文件索引（后端 pytest，共 (\d+)）", "backend"),
    (ROOT / "tests" / "README.md", r"## 文件索引（前端 vitest，共 (\d+)", "frontend"),
    (ROOT / "AGENTS.md", r"后端 pytest：\*\*(\d+) passed\*\*", "backend"),
    (ROOT / "AGENTS.md", r"前端 vitest：\*\*(\d+) passed\*\*", "frontend"),
    (ROOT / "docs" / "ARCHITECTURE.md", r"后端 pytest：\*\*(\d+) 用例\*\*", "backend"),
    (ROOT / "docs" / "ARCHITECTURE.md", r"前端 vitest：\*\*(\d+) 用例\*\*", "frontend"),
    (ROOT / "docs" / "ARCHITECTURE.md", r"后端 pytest（(\d+) 用例）", "backend"),
    (ROOT / "docs" / "ARCHITECTURE.md", r"前端 vitest（(\d+) 用例）", "frontend"),
    (ROOT / "frontend" / "README.md", r"vitest run（(\d+) 用例）", "frontend"),
]

# tests/README.md 逐文件表格：| [`test_xxx.py`](...) | N | ... |
TABLE_ROW_RE = re.compile(r"\|\s*\[`([^`]+)`\]\([^)]*\)\s*\|\s*(\d+)\s*\|")


def check_counts(
    backend_total: int, per_file: dict[str, int], frontend_total: int
) -> list[str]:
    """逐文件表格 + 各声明点计数与源码一致。"""
    problems: list[str] = []
    expected = {"backend": backend_total, "frontend": frontend_total}

    # tests/README.md 表格逐行比对
    readme = (ROOT / "tests" / "README.md").read_text(encoding="utf-8")
    for m in TABLE_ROW_RE.finditer(readme):
        name, declared = m.group(1), int(m.group(2))
        if name.endswith(".py"):
            actual = per_file.get(name)
            if actual is None:
                problems.append(f"tests/README.md 表格含未知后端文件 {name}")
            elif actual != declared:
                problems.append(
                    f"tests/README.md 声称 {name}={declared}，实际 {actual}"
                )
        elif name.endswith((".test.ts", ".test.tsx")):
            # 前端逐文件数不细拆（it 计数已算总数），只校验文件存在由链接检查兜底
            pass

    # 各处总数声明
    for path, pattern, kind in COUNT_PATTERNS:
        try:
            text = path.read_text(encoding="utf-8")
        except OSError as exc:
            problems.append(f"{path.relative_to(ROOT)}: 读取失败 {exc}")
            continue
        matches = re.findall(pattern, text)
        if not matches:
            problems.append(
                f"{path.relative_to(ROOT)}: 未找到计数声明（模式 {pattern!r}）"
            )
            continue
        for value in matches:
            if int(value) != expected[kind]:
                problems.append(
                    f"{path.relative_to(ROOT)}: {kind} 计数声明 {value}，实际 {expected[kind]}（模式 {pattern!r}）"
                )
    return problems


LOGO_SOURCE = ROOT / "frontend" / "src" / "brand" / "logo.svg"
ICON_SIDECAR = ROOT / "scripts" / "desktop" / "icon-source.sha256"
ICON_FILE = ROOT / "scripts" / "desktop" / "启动生图工作台.ico"


def check_icon_freshness() -> list[str]:
    """桌面图标产物是否与源图同步（内容指纹比对，不看 mtime——git 不保留时间）。

    不在这里重跑渲染：make_icon.py 需要 playwright + chromium，
    而前端 Job 里没有 Python 依赖；改为比对 make_icon.py 写下的源图指纹。
    """
    problems: list[str] = []
    if not LOGO_SOURCE.exists():
        return [f"{LOGO_SOURCE.relative_to(ROOT)}: 品牌源图不见了（形状的唯一来源）"]
    if not ICON_SIDECAR.exists() or not ICON_FILE.exists():
        missing = [
            str(f.relative_to(ROOT))
            for f in (ICON_SIDECAR, ICON_FILE)
            if not f.exists()
        ]
        return [
            f"{'、'.join(missing)}: 桌面图标或其指纹缺失，跑 scripts/desktop/make_icon.py 重建"
        ]
    want = hashlib.sha256(LOGO_SOURCE.read_bytes()).hexdigest()
    got = ICON_SIDECAR.read_text(encoding="utf-8").strip()
    # Windows 上 core.autocrlf=true 会把工作区的 logo.svg 转成 CRLF，字节与仓库里的
    # blob（LF）不同 —— 指纹因此在这台机器上永远"不一致"，属误报。
    # 两边都接受：原样字节 或 归一成 LF 后的字节（CI 的 LF 检出两种都命中）。
    want_lf = hashlib.sha256(
        LOGO_SOURCE.read_bytes().replace(b"\r\n", b"\n")
    ).hexdigest()
    if got not in (want, want_lf):
        problems.append(
            f"{ICON_SIDECAR.relative_to(ROOT)}: 指纹 {got[:12]}… 与 "
            f"{LOGO_SOURCE.relative_to(ROOT)} 当前内容 {want[:12]}… 不一致"
            " —— 源图改了但图标没重生成，exe 仍是旧形状。"
            "依次跑：scripts/desktop/make_icon.py，再 powershell -File scripts/desktop/make_launcher.ps1"
            "（编译前先关掉正在运行的启动器）"
        )
    return problems


LAUNCHER_CS = ROOT / "scripts" / "desktop" / "launcher.cs"


def check_launcher_target() -> list[str]:
    """launcher.cs 里烘焙进 exe 的 .cmd 路径必须真的落在本仓。

    exe 是编译产物：路径写错、或 .cmd 挪了位置而没同步改这里 + 重编，
    表现只是「双击失灵」——CI 不跑双击，ruff 也看不出，只能靠这条静态校验兜。
    """
    if not LAUNCHER_CS.exists():
        return [f"{LAUNCHER_CS.relative_to(ROOT)}: 启动器源码不见了"]
    src = LAUNCHER_CS.read_text(encoding="utf-8")
    m = re.search(r"Path\.Combine\(\s*root\s*,([^)]*)\)", src)
    if m is None:
        return [
            (
                f"{LAUNCHER_CS.relative_to(ROOT)}: 找不到 Path.Combine(root, …) 形式的启动脚本定位，"
                "本校验需要跟着改（别让它空转）"
            )
        ]
    parts = re.findall(r'"([^"]+)"', m.group(1))
    target = ROOT.joinpath(*parts)
    if not target.exists():
        return [
            (
                f"{LAUNCHER_CS.relative_to(ROOT)}: 烘焙进 exe 的启动脚本路径 {'/'.join(parts)} "
                "在仓里不存在 —— 挪了 .cmd 就要同步改这里，再重编 exe"
                "（powershell -NoProfile -File scripts\\desktop\\make_launcher.ps1）"
            )
        ]
    return []


def main() -> int:
    # GBK 控制台（Windows 默认 cp936）无法打印 ✔/❌，统一按 utf-8 输出
    try:
        sys.stdout.reconfigure(encoding="utf-8", errors="replace")
        sys.stderr.reconfigure(encoding="utf-8", errors="replace")
    except (AttributeError, OSError):
        pass
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument(
        "--quiet", action="store_true", help="只输出问题，不输出通过摘要"
    )
    args = parser.parse_args()

    checked, link_problems = check_links()
    backend_total, per_file = count_backend_tests()
    frontend_total = count_frontend_tests()
    count_problems = check_counts(backend_total, per_file, frontend_total)

    problems = (
        link_problems
        + count_problems
        + check_icon_freshness()
        + check_launcher_target()
    )
    for p in problems:
        print(f"❌ {p}")
    if not problems:
        if not args.quiet:
            print(
                f"✔ 全部通过：链接 {checked} 处可解析；"
                f"后端 {backend_total} / 前端 {frontend_total} 计数与文档一致"
            )
        return 0
    print(f"共 {len(problems)} 处问题", file=sys.stderr)
    return 1


if __name__ == "__main__":
    sys.exit(main())
