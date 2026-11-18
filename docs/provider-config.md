# 渠道与模型 — 扩展点说明书

> **定位**：本项目唯一的「适配层」入口。接一家新渠道、加一个能力不同的模型，改配置即可，不改代码。
> **读者**：想接渠道的人；被要求接渠道的 agent（照此文可完成，不必读源码）。
> **真源**：`providers.local.json`（本机、git 忽略、界面只写这里）。`config.json` 是出厂示例。
> **插件同源**：DSH 插件 `dsh-imagora-desk` 读同一份文件、同一套规则，改一次两边生效。

## 一条判据

先问：这个差异是**值**还是**流程**？

- **值**（字段名、取值、发不发）→ 配置能表达，看本文。
- **流程**（先上传再轮询、SSE 分段解析、签名、多端点串联）→ 配置表达不了，得写代码；目前没做，也不必急着做。

再问两句定位置：

| 问题 | 成立则写 | 例 |
| --- | --- | --- |
| 换模型、不换服务器，还成立吗？ | `transport.request` | `response_format`：图以什么形式回来 |
| 换服务器、不换模型，还成立吗？ | `models[].params` | `background: transparent`：模型会不会画透明 |

## 三个块

| 块 | 谁定 | 作用 |
| --- | --- | --- |
| **基线** | 代码 | `model` / `prompt` / `size` / `quality` / `n`：产品语义，配置**不许改** |
| **transport**（profile 级） | 你 | 这家服务器每次都要带的字段；`drop` 从基线里摘字段 |
| **models[].params**（模型级） | 你 | 这个模型额外带的字段；同键覆盖上一层 |

拼装顺序固定：`基线 → 按 drop 摘 → 叠 transport → 叠 params`。
`drop` 只作用于基线，所以「先摘掉基线的 `output_format`，再在 params 给 `jpeg`」是合法写法。

## 抄这四段

**A. 什么都不用写**（OpenAI 官方 / 大多数中转站，走默认）

```json
"myapi": { "label": "我的中转站", "base_url": "https://example.com/v1" }
```

**B. 只有 b64 才回原始 PNG 的网关**（透明底需要这个）

```json
"transport": { "request": { "response_format": "b64_json" }, "drop": ["output_format", "watermark"] }
```

**C. 某家有自己的开关**（如火山方舟）

```json
"transport": { "request": { "watermark": false } }
```

**D. 某模型需要显式开透明**

```json
"models": [{ "id": "needs-explicit-alpha", "params": { "background": "transparent" } }]
```

值只允许字符串 / 数字 / 布尔 / null，或它们的数组；不允许嵌套对象。

## 自检

```powershell
python scripts/check_provider.py                       # 当前 profile / 当前模型
python scripts/check_provider.py --profile X --model Y  # 换着看
python scripts/check_provider.py --json                 # 只出请求体，给脚本/agent 消费
```

（脚本：[scripts/check_provider.py](../scripts/check_provider.py)；规则实现：[core/payload.py](../core/payload.py)。）

输出三块：**写了什么** → **最终请求体** → **标注**（`drop:` 摘掉的 / `channel:` 渠道加的 / `model:` 模型加的 / `passthrough:` 我们不认识的）。
不发请求、不花钱、不需要密钥。退出码 `0` 合法 / `1` 有问题（问题逐条打印，并说明被忽略后的实际行为）。

## 三条边界

1. **只能改请求体**。地址是 `base_url`，密钥是 `.env`；`authorization` / `headers` / `url` / `host` 一律拒绝——否则配置能把 key 指到任意地址。
2. **写错只降级，不半截生效**。块里任何一处非法 → 整块丢弃 + 警告，行为回到默认。半截生效比不生效更难查。
3. **不提供脚本通道**。扩展点是数据，不是可执行代码；要「流程」差异时，那是有意留待下一轮的设计决策，不是漏做。

## 为什么透明底需要 `b64_json`

一次实测（2026-11-18，同一台 `chatgpt2api`、同一模型、同一提示词）：

| 请求体 | 耗时 | 结果 |
| --- | --- | --- |
| 默认（`url` 回图） | 49.0s | JPEG / RGB，透明像素变纯黑 |
| 加 `stream: true` | 45.3s | SSE 里仍是 `url` → 仍是 JPEG |
| 加 `response_format: b64_json` | **44.4s** | **PNG / RGBA，alpha 0–255** |

`url` 通道回的是网关转码后的 JPEG（无 alpha），`b64_json` 才是模型原始字节；它不慢，省掉了「再发一个请求下载」。
一句话：**模型会不会画透明是模型的事，拿不拿得到透明是渠道的事**——所以两件事分开配。
