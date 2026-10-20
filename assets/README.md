# assets/ — 文档配图

- 职责：仓库自己的文档配图，只服务 markdown 渲染（GitHub 与本地预览），**不是应用资源**。
- 子目录：`screenshots/` 放 README「界面一览」用的界面截图。将来若有架构示意图，另开 `assets/diagrams/`，不与截图混放。
- **本目录目前只有 `screenshots/` 一类，是有意保留的层级**：`diagrams/` 类出现时直接并列，不动现有结构。
- 命名：`<界面或场景>-<视角>.png`，全小写 kebab-case（现有：`canvas-overview` / `form-view` / `terminal-window`）。
- 被谁引用：根 [README.md](../README.md)「界面一览」。改文件名要同改那里三处链接。
- 变更影响路由：新增或改名 → 同改根 README 的链接，以及根 [AGENTS.md](../AGENTS.md) 待办里指向本目录的那条；跑 `python scripts/check_docs.py` 确认不断链。
- 本目录不放的东西：应用运行时资源在 `frontend/public/`（图标等静态文件），程序产物与资产库在 `output/`，个人素材在 `personal/`（git 忽略）。

## 重拍要拍到哪些状态

少一项就又是一轮"图与界面不符"：

- **无限画布全景**：至少一个提示词卡 + 一张图片 + 一条连线 + 一个已回流的结果节点。
- **经典表单**：带参考图、有结果、结果区处于完成态（不是排队或生成中）。
- **多窗口**：交互菜单在跑、至少两个编号窗口。
- **外观弹窗打开态**（主体色预设 + 卡片通透度滑杆）与**一张铺了壁纸的整页效果** —— 根 [README.md](../README.md) 与其英文版 [README_en.md](../README_en.md) 均已留槽位与图注，补图后把两处注释一并删掉。
