import { useEffect, useRef, useState } from "react";
import { selectFolder } from "../api";
import { Icon } from "./Icon";

interface FolderPickerProps {
  value: string;
  onChange: (path: string) => void;
  /** 紧凑容器中优先显示路径末端，完整值通过 title 查看。 */
  alignEnd?: boolean;
  /**
   * 只显示一枚文件夹图标按钮（节点卡用）。
   *
   * 为什么不全局改成图标：这个组件有两个调用点，空间条件差一个量级 ——
   * 提示词卡固定 380px，输入框 +「选择文件夹」五个汉字会把路径挤成一截；
   * 经典表单是整页宽，空间富余，文字本来就更明确。
   * 所以做成**档位**而不是替换默认，表单那边不会退步。
   */
  icon?: boolean;
}

/**
 * 输出路径：可手输，或点击按钮弹出系统文件夹选择器（取消则保留原值）
 */
export function FolderPicker({
  value,
  onChange,
  alignEnd = false,
  icon = false,
}: FolderPickerProps) {
  const [picking, setPicking] = useState(false);
  const inputRef = useRef<HTMLInputElement>(null);

  // alignEnd 模式：路径变化后滚动到末尾，让路径尾部（如 .../aigc）可见
  useEffect(() => {
    if (alignEnd && inputRef.current) {
      inputRef.current.scrollLeft = inputRef.current.scrollWidth;
    }
  }, [value, alignEnd]);

  const handlePick = async () => {
    setPicking(true);
    try {
      const { path } = await selectFolder(value);
      if (path) {
        onChange(path);
      }
    } finally {
      setPicking(false);
    }
  };

  /* 根节点挂 `folder-picker`：输入框与按钮的**同高**由 index.css 按这个类定死，
     而不是让两边各自带着 py-* 各算各的。
     踩过的坑：节点里 `.field-control` 已钉成 --h-ctl(28)，而 `.btn-ghost` 还是
     py-2 + text-sm 算出来的 36 —— 同一行差 8px，看着就是「按钮比输入框高一截」。 */
  return (
    <div className="folder-picker flex items-center gap-2">
      <input
        ref={inputRef}
        value={value}
        onChange={(e) => onChange(e.target.value)}
        placeholder="图片保存目录"
        title={value}
        className={`field-control min-w-0 flex-1 ${alignEnd ? "text-right" : ""}`}
      />
      {icon ? (
        <button
          type="button"
          onClick={handlePick}
          disabled={picking}
          className="btn-ghost btn-icon"
          title="选择文件夹"
          aria-label="选择文件夹"
        >
          <Icon name="folder" size={14} />
        </button>
      ) : (
        <button type="button" onClick={handlePick} disabled={picking} className="btn-ghost">
          {picking ? "选择中..." : "选择文件夹"}
        </button>
      )}
    </div>
  );
}
