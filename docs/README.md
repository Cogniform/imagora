# docs/ — 辅助文档索引

- [`ARCHITECTURE.md`](ARCHITECTURE.md) — 设计圣经：不变决策 / 数据流 / 契约 / 防错清单
- [`config-editor-ui-design.md`](config-editor-ui-design.md) — 配置弹窗交互设计（为什么只留两个选择器 / 字段与写入目标 / 联动与保存状态机 / 争议取舍）
- [`config-write-api-design.md`](config-write-api-design.md) — 配置写入接口契约（请求响应 / 三层防护 / 令牌下发 / mtime 冲突）
- [`prompt-import-format.md`](prompt-import-format.md) — 通用粘贴导入格式（`=== 标题 ===` + 代码围栏 + `ratio: N:M`）
- [`ecom-prompt-import-format.md`](ecom-prompt-import-format.md) — 电商专用模板（固定轮播/详情批次）

配置数据只有一份（`.env` / `config.json`），界面是它的一个编辑入口——分层与归属见 [ARCHITECTURE.md](ARCHITECTURE.md) 4.4。

导入格式的解析实现与容错规则见 [frontend/src/promptImportFormat.ts](../frontend/src/promptImportFormat.ts)（单测 [promptImportFormat.test.ts](../frontend/src/promptImportFormat.test.ts)）。

本目录约束见 [AGENTS.md](AGENTS.md)，维护仪表盘见 [../AGENTS.md](../AGENTS.md)。