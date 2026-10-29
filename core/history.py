"""本地生成历史读取：容忍损坏 JSONL，支持轻量筛选。"""

import hashlib
import json
import os
import re
import shutil
import time
from pathlib import Path

from core import registry
from core.config import WORK_ROOT
from core.logging import LOGS_DIR

HISTORY_FILE = LOGS_DIR / "generation.jsonl"

# 搜索空白折叠：账本 prompt 存 Windows CRLF（表单提交 %0D%0A），用户粘进单行搜索框时
# 浏览器把换行归一/移除，与账本换行错位导致整串子串匹配失败——两侧统一折叠为单空格。
_SPACES = re.compile(r"\s+")


def _collect_all(query: str = "", status: str = "", raw_limit: int = 500) -> list[dict]:
    """读取账本并聚合后的完整列表（最新在前，坏行忽略）。

    raw_limit 限制**原始行数**（聚合前），防大账本全盘扫描；聚合由
    dedupe_generation_history 完成，因此返回条数 ≤ 原始行数。
    读取/筛选/聚合三步骤在此收敛，供分页与整页共用，语义一致。
    """
    # 两侧都做空白折叠（CRLF/LF/连续空格 → 单空格），换行差异不再导致整串匹配失败
    needle = _SPACES.sub(" ", query.strip()).casefold()
    status_filter = status.strip().casefold()
    try:
        lines = Path(HISTORY_FILE).read_text(encoding="utf-8").splitlines()
    except OSError:
        return []
    items: list[dict] = []
    for line in reversed(lines):
        try:
            record = json.loads(line)
        except (TypeError, ValueError):
            continue
        if not isinstance(record, dict):
            continue
        if status_filter and str(record.get("status", "")).casefold() != status_filter:
            continue
        if needle:
            haystack = " ".join(
                _SPACES.sub(" ", str(record.get(key, "")))
                for key in ("time", "prompt", "mode", "quality", "output")
            ).casefold()
            if needle not in haystack:
                continue
        items.append(record)
        if len(items) >= max(1, int(raw_limit)):
            break
    return dedupe_generation_history(items)


def read_generation_history(
    limit: int = 200,
    query: str = "",
    status: str = "",
) -> list[dict]:
    """返回最新的生成记录（聚合后）；坏行被忽略，最多 500 条。"""
    safe_limit = min(500, max(1, int(limit)))
    return _collect_all(query=query, status=status)[:safe_limit]


def read_generation_history_paged(
    offset: int = 0,
    limit: int = 200,
    query: str = "",
    status: str = "",
) -> dict:
    """分页读取（聚合后切片）：{items, total}——total 为聚合后总数。

    与 read_generation_history 同一收集/筛选/聚合语义，offset 是**聚合后**记录的
    偏移（前端按已加载条数推进即可，不受聚合压缩影响）；分页与搜索/状态筛选
    天然一致——筛选发生在聚合之前。
    """
    all_items = _collect_all(query=query, status=status)
    safe_offset = max(0, int(offset or 0))
    safe_limit = min(500, max(1, int(limit)))
    page = all_items[safe_offset : safe_offset + safe_limit]
    return {"items": page, "total": len(all_items)}


def read_raw_history(limit: int | None = None) -> list[dict]:
    """读取账本**原始行**（最新在前，坏行忽略；不做参数聚合、不做 500 行截断）。

    与 read_generation_history 的区别是口径不同：那边面向「列表展示」，会聚合同参数
    记录并限制原始行数；这边面向**统计与计费**——每个成功行都真实花过钱，聚合会少算
    费用，故保留全部原始行。limit 为 None 表示不限。
    """
    try:
        lines = Path(HISTORY_FILE).read_text(encoding="utf-8").splitlines()
    except OSError:
        return []
    items: list[dict] = []
    for line in reversed(lines):
        try:
            record = json.loads(line)
        except (TypeError, ValueError):
            continue
        if not isinstance(record, dict):
            continue
        items.append(record)
        if limit is not None and len(items) >= max(1, int(limit)):
            break
    return items


def _params_key(record: dict) -> tuple:
    """同一生成参数的判别键（含缺失字段容错）。

    「时间不算参数」：time / output / cost / seconds / submissionId / outputAssetIds 仅是
    运行结果与环境，不参与判定；参考图用内容 id（inputAssetIds）参与——同图重新上传按内容
    sha1 去重为同一 id，两批不同的参考图不会误合并。旧行无 inputAssetIds 以空元组兜底。
    """
    raw_ids = record.get("inputAssetIds")
    ids_part = tuple(str(a) for a in raw_ids) if isinstance(raw_ids, list) else ()
    return (
        str(record.get("mode", "")),
        str(record.get("prompt", "")),
        str(record.get("size", "")),
        str(record.get("quality", "")),
        int(record.get("refs") or 0),
        ids_part,
    )


def dedupe_generation_history(items: list[dict]) -> list[dict]:
    """呈现前聚合：同一生成参数的**失败**记录只保留最新一条，**成功记录一条都不合并**。

    聚合只为一个目的——「同一提示词卡片失败多次历史刷屏」：多次失败 → 一条（最新那次）。
    但**成功记录是真实产出**：同卡片同提示词同参考图连点两次会真的出两张图（画布上也是两个
    结果），账本里也因此是两行、两个 output。早先的实现把所有同参数行（含成功）一并折叠，
    于是「两张图都在、历史里只有一张」——历史与产出对不上（且被折叠掉的那张连「导入画布」
    的白名单都进不去）。规范：

      - `status == "ok"` 的行**永远保留**（每次成功都是一次独立产出）；
      - 同组的失败行最多留**最新一条**，且仅当它比该组最新成功更晚（否则已被成功取代）；
      - 任一参数（mode/prompt/size/quality/refs/inputAssetIds）不一致则不合并。

    输入须为最新在前（read_generation_history 的既有顺序），输出保持同样序。
    """
    seen_ok: set[tuple] = set()
    kept_error: set[tuple] = set()
    out: list[dict] = []
    for record in items:
        key = _params_key(record)
        if str(record.get("status", "")) == "ok":
            # 成功：全留。记下「这组已成功过」，后面的失败行据此被取代。
            seen_ok.add(key)
            out.append(record)
            continue
        # 失败：本组已出现过成功（更新的那条在前）→ 视为已被取代，丢弃；
        # 本组已经保留过一条失败 → 再丢（失败刷屏只留最新一条）。
        if key in seen_ok or key in kept_error:
            continue
        kept_error.add(key)
        out.append(record)
    return out


# ================= 历史账本迁移（core.history 自带，供 scripts/migrate.py 调用） =================


def resolve_output_path(output: str) -> str:
    """把账本里的 output 路径解析为绝对路径（相对路径按 WORK_ROOT 拼接）。

    与 server 旧实现逻辑一致；server 已委托本函数，避免两处分叉。
    """
    raw = str(output or "").strip()
    if not raw:
        return ""
    return os.path.normpath(raw if os.path.isabs(raw) else str(WORK_ROOT / raw))


def _mig_ts() -> str:
    import time

    return time.strftime("%Y%m%d-%H%M%S")


def backfill_output_asset_ids(apply: bool = False) -> dict:
    """历史旧行（缺 outputAssetIds）按 output 文件内容反查注册表补齐 id。

    安全语义（与迁移家族一致）：
      - 默认只报告：扫描并说明多少行可补/无法反查/已具备，不写文件；
      - apply 才落盘：先整文件备份 .bak-<ts>，原子写（tmp+os.replace），读回校验行数不变；
      - 只补能可靠反查的行（output 文件在 + 内容 sha1 命中注册表）；其余跳过并计数，绝不猜；
      - 幂等：已有 outputAssetIds 的行不动，重复执行结果不变。
    返回 {"action", "backfill", "unable", "already", "backup", "lines"}。
    """
    if not HISTORY_FILE.exists():
        return {"action": "nothing", "rows": 0}
    lines = HISTORY_FILE.read_text(encoding="utf-8").splitlines()
    entries = registry.load_registry()
    out = list(lines)
    backfill = 0
    unable = 0
    already = 0
    for i, line in enumerate(lines):
        try:
            rec = json.loads(line)
        except (TypeError, ValueError):
            continue  # 坏行原样保留
        if not isinstance(rec, dict):
            continue
        if rec.get("outputAssetIds"):
            already += 1
            continue
        abs_path = resolve_output_path(rec.get("output", ""))
        filled = False
        if abs_path and os.path.isfile(abs_path):
            try:
                with open(abs_path, "rb") as f:
                    content = f.read()
                img_id = hashlib.sha1(content).hexdigest()[:12]
                if img_id in entries:
                    rec = {**rec, "outputAssetIds": [img_id]}
                    out[i] = json.dumps(rec, ensure_ascii=False)
                    filled = True
                    backfill += 1
            except OSError:
                pass
        if not filled:
            unable += 1
    if not apply:
        return {
            "action": "report",
            "backfill": backfill,
            "unable": unable,
            "already": already,
        }
    backup = None
    if os.path.isfile(HISTORY_FILE):
        backup = f"{HISTORY_FILE}.bak-{_mig_ts()}"
        shutil.copy2(HISTORY_FILE, backup)
    tmp = f"{HISTORY_FILE}.{os.getpid()}.{time.time_ns()}.tmp"
    try:
        with open(tmp, "w", encoding="utf-8") as f:
            f.write("\n".join(out))
            if out:
                f.write("\n")
        os.replace(tmp, HISTORY_FILE)
    finally:
        try:
            os.unlink(tmp)
        except OSError:
            pass
    after = HISTORY_FILE.read_text(encoding="utf-8").splitlines()
    ok = (
        len(after) == len(lines)
        and sum(1 for l in after if '"outputAssetIds"' in l) >= backfill
    )
    return {
        "action": "backfilled" if ok else "FAILED-VERIFY",
        "backfill": backfill,
        "unable": unable,
        "already": already,
        "backup": backup,
        "lines": len(after),
    }
