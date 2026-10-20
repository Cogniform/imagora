# frontend/ — 规则层

继承根规则，见 [../AGENTS.md](../AGENTS.md)。

frontend/ 特有约束：
- 契约双端同步：改后端接口必须同步 [src/types.ts](src/types.ts) + [src/api.ts](src/api.ts)，漏一处即断链
- 严格开关已全开（[tsconfig.json](tsconfig.json)：`noUncheckedIndexedAccess` + `exactOptionalPropertyTypes`）：数组/记录下标访问先收窄再直接用；可选属性不要显式赋 `undefined`（`{ k: undefined }` 与「不提供该键」在 eOPT 下不是一回事）。判据是 `npx tsc --noEmit -p tsconfig.json` 零错，不是「CLI 加开关跑过」——两开关单独开都可能为 0 错、同时开才暴露交互位点
- 动效/样式类收敛 [src/index.css](src/index.css)（`:root` 设计 token + `@layer components`）；组件只引用类名，尺寸/圆角/颜色走 token 不写死值；容器角落装饰统一用 `.corner-deco`（编号长在容器内，靠 `__clip` 裁切层截断溢出，浓度走 `--mark-ink`）/ `.corner-rings` / `.corner-note` / `.chip`；小尺寸按钮用 `.btn-sm` / `.btn-xs`（禁止 `!px-*` 内联覆盖），动画只动 transform/opacity
- 新增公共类 / token 时：定义在 [src/index.css](src/index.css) 后同步登记到 [README.md](README.md)「样式体系」节，否则下一个人会另造一套；跨容器观感一律走全局方案——滚动条用 `--sb-*`（轨道恒 transparent，跟随所在容器底色，不在组件里写局部 `scrollbar-color`），模态内容区用 `.modal-body`（高度过渡 + 滚动条占位 + 变高窗口裁切），不在组件里自算高度或手动 `overflow`
- 纯函数模块（src 根 *.ts）必须配同名 `*.test.ts` 单测；新纯逻辑进纯函数模块，不进组件
- 静态图放 `public/`，代码里用**站点根路径**引用：构建期原样拷进 `dist/`、不经打包器改写。大图别塞进 `src/assets` 走 import（路径被哈希化后不好在 CSS 里静态引用），也别走 `--bg-image` 材质通道（那条是 `repeat`，铺大图会出接缝）。**整页背景图不进 `public/`**：只支持用户自选（`wallpaperStore` 存 IndexedDB，原图不入库）——内置预设壁纸已于 2026-10-03 移除
- 行尾按文件不同（`types.ts` / `workflow.test.ts` / `components/CanvasPage.tsx` 为 CRLF，其余多为 LF）：批量脚本改写必须逐文件保留原行尾，否则整文件翻行尾、diff 爆炸
- 文件索引（纯函数 / hooks / 组件 / 变更路由）→ [README.md](README.md)，不在此重复
- 设计背景（动效约束/按钮体系/预览统一）→ [../docs/ARCHITECTURE.md](../docs/ARCHITECTURE.md)
