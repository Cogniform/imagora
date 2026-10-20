#!/usr/bin/env python3
"""配置写入的访问防护层（本机绑定 / Origin 白名单 / 内存令牌）。

为什么需要：写配置 = 改磁盘上的密钥与接口地址，能力等同于改服务器凭据。
本项目只监听 127.0.0.1（见 main.py 的 uvicorn.run(host="127.0.0.1")），
但"只监听本机"挡不住浏览器里别的网页对本机发请求（CSRF），因此再加两层。

三层按"早失败、成本递增"排列：本机绑定最便宜先查，令牌最贵放最后。

作用域限制：这套防护是为「单人本地工具」设计的。若要支持远程访问，
必须重新设计（TLS + 真实认证 + 速率限制），不能直接沿用。
"""

import secrets
from pathlib import Path

from fastapi import Request
from fastapi.responses import JSONResponse

# 进程内随机令牌：每次启动都变，不落盘、不进配置文件、不写环境变量。
# 不落盘是关键——落盘等于把钥匙挂在门上；进程内则即使被本机其他程序读到旧值，
# 下次启动即失效。
CONFIG_TOKEN = secrets.token_urlsafe(32)

# 需要防护的路径前缀。只有写操作才校验令牌。
GUARDED_PREFIX = "/api/config"

# 允许的来源。缺省 Origin（同源导航、非浏览器客户端）也放行——
# 浏览器发的 fetch 一定带 Origin，同源页面带的是自己的 origin。
_ALLOWED_ORIGIN_HOSTS = {"127.0.0.1", "localhost", "[::1]", "::1"}

TOKEN_HEADER = "X-Config-Token"


def is_loopback(client_host: str | None) -> bool:
    """请求来源是否为本机。拿不到 client（测试直调路由时）按放行处理。"""
    if not client_host:
        return True
    return client_host in {"127.0.0.1", "::1", "localhost"}


def origin_allowed(request: Request) -> bool:
    """Origin 是否可信：缺省放行，其余必须指向本机。"""
    origin = request.headers.get("origin")
    if not origin:
        return True
    # 形如 http://127.0.0.1:7860
    host = origin.split("://", 1)[-1]
    hostname = host.rsplit(":", 1)[0] if ":" in host else host
    return hostname in _ALLOWED_ORIGIN_HOSTS


def token_valid(request: Request) -> bool:
    return request.headers.get(TOKEN_HEADER.lower()) == CONFIG_TOKEN


def guard_config_write(request: Request) -> JSONResponse | None:
    """校验一次写配置请求；通过则返回 None，否则返回 403 响应。

    顺序：本机绑定 → Origin → 令牌。GET 不校验（页面首屏要能加载），
    令牌只保护"写"这个不可逆动作。
    """
    if not is_loopback(request.client.host if request.client else None):
        return JSONResponse({"ok": False, "error": "forbidden_host"}, status_code=403)
    if request.method != "POST":
        return None
    if not origin_allowed(request):
        return JSONResponse({"ok": False, "error": "forbidden_origin"}, status_code=403)
    if not token_valid(request):
        return JSONResponse({"ok": False, "error": "forbidden_token"}, status_code=403)
    return None


def token_response_header() -> dict[str, str]:
    """同源页面据此取令牌。跨站页面读不到响应头内容（同源策略），因此安全。"""
    return {TOKEN_HEADER: CONFIG_TOKEN}


def profile_env_names(profile: str) -> dict[str, str]:
    """本机覆盖的环境变量名，沿用既有 API_KEY_<PROFILE> 的命名约定。"""
    suffix = profile.strip().upper()
    return {
        "baseUrl": f"BASE_URL_{suffix}",
        "apiPath": f"API_PATH_{suffix}",
        "model": f"MODEL_{suffix}",
        "apiKey": f"API_KEY_{suffix}",
    }


def safe_profile_path(root: Path, profile: str) -> Path:
    """校验 profile 名可安全用作环境变量后缀，且指向 root 内的文件。

    挡的是路径穿越：profile 来自请求体，`.` 与斜杠会让解析出的文件跑出 root。
    """
    name = profile.strip()
    if not name or not name.replace("-", "").replace("_", "").isalnum():
        raise ValueError("profile 名非法")
    resolved = (root / ".env").resolve()
    if resolved.parent != root.resolve():
        raise ValueError("目标文件不在应用根目录内")
    return resolved
