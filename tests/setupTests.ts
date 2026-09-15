import "@testing-library/jest-dom";
import { afterAll, afterEach, beforeAll, vi } from "vitest";
import { cleanup } from "@testing-library/react";
import i18n from "i18next";
import { initReactI18next } from "react-i18next";
import { server } from "./msw/server";
import { resetProviderState } from "./msw/state";
import "./msw/tauriMocks";

// `src/hooks/useSettingsForm.ts` imports the production `@/i18n` singleton（不能用
// `useTranslation()`：react-i18next 16.6.6 的包装实例会在语言切换时换身份，把它放进
// dep 数组会让表单 hydration 重跑）。副作用是这个模块在被 import 时会在模块作用域
// 执行一次 `init()`，把下面 beforeAll 里的空资源 **覆盖成真实语言包**，并按
// `navigator.language`（CI/本机通常是 en）选语言。
//
// 结果：`t("skills.checkUpdates")` 返回真实译文而不是原始 key，按 key 断言的上游测试
// 会失败；反过来按下文 `defaultValue` 写死中文的测试也会因语言是 en 而失败。
// 测试里把 `@/i18n` 指回下面这份空资源实例，让两种断言口径都成立：
// 没有 defaultValue 的 key 原样返回，有 defaultValue 的走兜底文案。
vi.mock("@/i18n", async () => ({
  default: (await import("i18next")).default,
}));

beforeAll(async () => {
  server.listen({ onUnhandledRequest: "warn" });
  await i18n.use(initReactI18next).init({
    lng: "zh",
    fallbackLng: "zh",
    resources: {
      zh: { translation: {} },
      en: { translation: {} },
    },
    interpolation: {
      escapeValue: false,
    },
  });
});

afterEach(() => {
  cleanup();
  resetProviderState();
  server.resetHandlers();
  vi.clearAllMocks();
});

afterAll(() => {
  server.close();
});
