# 第 2 步接口设计 · 配置写入

> 配套：[配置弹窗 UI 交互设计](config-editor-ui-design.md)
> 本文件是接口契约（单一事实来源）。**服务端能写的字段比界面用到的多**：
> 界面只落 `profile` 与 `model`（见配套文档第 1 节），其余字段留给脚本 / CLI，契约不变。

## 1. 写配置接口

`POST /api/config`

请求体：

```jsonc
{
  "profile": "wanwu",              // 必填：写入哪个 profile 的覆盖键
  "changes": {                      // 只放要改的键；空字符串 = 不修改该键
    "profile": "wanwu",             // 可选：切配置来源，写 .env 的 ACTIVE_PROFILE（校验已注册）
    "baseUrl": "https://example.com",
    "apiPath": "/v1/images/generations",
    "model": "gpt-image-2.5-flare",
    "apiKey": "sk-new-key"          // 可选；留空/缺省 = 不动现有密钥
  },
  "expectedMtimes": {               // 必填：打开弹窗时读到的 mtime
    "env": 1758000000.123,          // .env 的 mtime（秒，浮点）
    "config": null                  // config.json 的 mtime；UI 不写它，恒为 null
  }
}
```

响应体（成功 200）：

```jsonc
{
  "ok": true,
  "written": ["baseUrl", "apiKey"],  // 实际写下去的键（空值键不会出现在这里）
  "mtimes": { "env": 1758000001.5 }, // 写后的新 mtime，前端直接覆盖 fileState 用
  "pending": ["baseUrl", "apiKey"],  // 写了但进程尚未重载 = 待重启
  "unchanged": []                    // 提交了但与文件里一样的键
}
```

响应体（冲突 409）：

```jsonc
{
  "ok": false,
  "error": "stale_file",
  "reason": "文件已被外部修改",
  "detail": ".env 于 12:04:31 被其他程序修改",
  "currentMtimes": { "env": 1758000009.9 }
}
```

其他失败：

| 状态 | `error` | 场景 |
|---|---|---|
| 403 | `forbidden_host` | 请求来源非本机 |
| 403 | `forbidden_origin` | Origin 不在白名单 |
| 403 | `forbidden_token` | 缺失或错误的 `X-Config-Token` |
| 400 | `invalid_profile` | profile 不在 `config.json` 注册列表里 |
| 400 | `invalid_value` | 值格式非法（URL 解析不出 host / 路径不以 / 开头） |
| 403 | `outside_app_root` | 解析出的目标文件不在 `IMAGORA_APP_ROOT` 内 |

### 1.1 为什么不接受"删除某个键"

`POST /api/config` 只能改值，不能删键。清空密钥走独立接口：

`POST /api/config/secret`，请求体 `{ "profile": "wanwu", "confirm": true }`

理由：改值和删除是两种心智模型，混在一起迟早误操作。该接口内部走 `comment_out_keys`（注释掉而非删除），值留在文件里可手工恢复。

## 2. 三层防护的执行顺序

顺序固定为 **早失败、低成本先查**：

```python
@app.middleware("http")
async def guard(request, call_next):
    # ① 本机绑定：最便宜，先查
    if not is_loopback(request.client):
        return JSONResponse(403, {"error": "forbidden_host"})

    # ② 只对写操作做②③；GET 一律放行（页面要能加载）
    if request.method == "POST" and request.url.path.startswith("/api/config"):
        # ② Origin 白名单：挡 CSRF（跨站页面发来的请求 Origin 是恶意站）
        if not origin_allowed(request):
            return JSONResponse(403, {"error": "forbidden_origin"})

        # ③ 内存令牌：证明调用者是本进程给过令牌的同源页面
        if request.headers.get("X-Config-Token") != CONFIG_TOKEN:
            return JSONResponse(403, {"error": "forbidden_token"})
    return await call_next(request)
```

| 层 | 失败返回 | 为什么排这个位置 |
|---|---|---|
| ① 本机绑定 | 403 `forbidden_host` | 最便宜，且失败信息最不该外泄 |
| ② Origin | 403 `forbidden_origin` | 挡的是"你开着工作台时访问恶意网页" |
| ③ 令牌 | 403 `forbidden_token` | 最强的证明，放最后 |

**为什么令牌在最后**：前两层是粗筛（几乎零成本），令牌是精确校验。顺序反过来会让每个请求都做一次 token 比较。

**为什么 GET 不校验**：页面首屏必须能加载；令牌只保护"写"这个不可逆动作。

## 3. 令牌怎么送到前端

**响应头**，不是 URL、不是配置文件、不落盘。

| 环节 | 动作 |
|---|---|
| 注入 | 中间件在响应**离开前**追加 `X-Config-Token: <token>`。仅对 `GET /api/config` 注入 |
| 前端读 | `api.ts` 的 `getConfig()` 从 `res.headers.get("X-Config-Token")` 取出，存模块级变量 |
| 前端存 | 内存（模块作用域），**不写 localStorage** |
| 前端发 | 后续写请求由 `api.ts` 自动附带 `X-Config-Token` |

**为什么跨站页面拿不到**：同源策略禁止跨源读取响应头内容。恶意页面能对 `127.0.0.1:7860` 发 POST，但**读不到 `GET /api/config` 的响应头**，因此拼不出合法令牌。

**为什么不落盘**：落盘就等于把钥匙挂在门上。进程内随机 → 重启即失效 → 即使被本机其他程序读到某个旧值，下次启动就无用。

**Token 生成**：`secrets.token_urlsafe(32)`，模块加载时执行一次。

## 4. mtime 冲突检测接在哪

**接在写入前的最后一道**，用 `core/config_write.py` 已有的写函数包一层：

```python
def apply_env_changes(path, changes, expected_mtime):
    # ① 读当前 mtime（stat，不读内容）
    actual = path.stat().st_mtime if path.exists() else None
    # ② 比对：打开弹窗时读到的 vs 现在磁盘上的
    if expected_mtime is not None and abs(actual - expected_mtime) > 0.001:
        raise StaleFile(actual)
    # ③ 才真正读内容 + 改 + 原子写
    update_env_file(path, changes)
```

**为什么不放在读的时候**：读的时候比对没有意义 —— 用户打开弹窗到你点保存之间，文件本来就可能变。冲突检测的本质是"**我即将覆盖别人的修改**"，所以必须紧贴写入动作。

**为什么不放在写函数内部**：`update_env_file` 是纯文件工具，不该知道 HTTP 的 `expectedMtime` 概念。冲突检测属于"接口层策略"，由 server 负责。

**两个文件各自独立**（你已确认）：`expectedMtimes.env` 只比 `.env`。UI 第一版不写 `config.json`，所以 `config` 恒为 `null`；字段先留着，将来若开放写 `config.json` 就不用改接口。

### 4.1 精度与误报

用 `st_mtime`（浮点秒，Windows NTFS 精度约 100ns）。比对用 `abs(actual - expected) > 0.001`，容忍文件系统精度差异。

**已知边界**：若文件在弹窗打开期间被改动**又改回原样**，mtime 变了但内容没变 —— 会误报一次冲突。后果是用户多点一次"重新读取"，无数据损失，可接受。

**为什么不用内容哈希**：要读全文，而 mtime 一次 `stat()` 就够。哈希能消除上面的误报，但成本不划算。

## 5. 单测要点

| 目标 | 断言 |
|---|---|
| 非本机来源 | 403 `forbidden_host` |
| 恶意 Origin | 403 `forbidden_origin` |
| 缺令牌 / 错令牌 | 403 `forbidden_token` |
| 正常路径 | 200，且 `.env` 内容确实更新、注释保留 |
| 空值键 | 不写入，且不出现在 `written` 里 |
| mtime 不匹配 | 409 `stale_file`，且**磁盘文件未被改动** |
| mtime 匹配 | 200 正常写入 |
| 密钥 write-only | 写完后 `GET /api/config` 响应里**搜不到该 key 的值** |
| `POST /api/config/secret` | 确认清空后该行被注释掉，且响应不返回原值 |
| 切 profile | 写 `ACTIVE_PROFILE`，注释与未改的键保留；未注册的来源 400 且磁盘不变 |
| 切 profile + 改字段同批 | 字段覆盖键按**选中**的来源拼（`MODEL_VOLC`），**不落到**当前生效的那个（`MODEL_WANWU`）——否则切过去后覆盖失效，表现为「切换成功但模型没变」 |
| 路径逃逸 | profile 名含 `../` 时 400 |

## 6. 已知不做

- 不做速率限制（单人本地工具，令牌已足够）
- 不做审计日志（同上）
- 不做「查看差异」（需引 diff 库，成本远超收益）
- **不做远程部署支持**：三层防护的前提是"只监听 127.0.0.1"。若将来要远程访问，安全层必须重新设计 —— 至少需要 TLS + 真实认证 + 速率限制，现有方案不可直接沿用