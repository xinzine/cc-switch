/**
 * 扩充 React 的 CSSProperties，补充 Electron / Tauri 拖拽区域所需的非标准属性。
 * 声明后 App.tsx 里所有 `style={{ WebkitAppRegion: ... } as any}` 可去掉 `as any`。
 */
import "react";

declare module "react" {
  interface CSSProperties {
    /** Tauri / Electron 拖拽区域控制属性（非标准 CSS，由宿主环境支持）。 */
    WebkitAppRegion?: "drag" | "no-drag";
  }
}
