import path from "node:path";
import { defineConfig } from "vitest/config";
import react from "@vitejs/plugin-react";

export default defineConfig({
  plugins: [react()],
  resolve: {
    alias: {
      "@": path.resolve(__dirname, "./src"),
    },
  },
  test: {
    environment: "jsdom",
    setupFiles: ["./tests/setupGlobals.ts", "./tests/setupTests.ts"],
    globals: true,
    // 并发上限：136 个测试文件默认全量铺开（本机 12 核），重型「渲染真实表单 +
    // userEvent 逐步交互」用例会因 CPU 饥饿从单跑 3-4s 膨胀到 20s+，失败点随负载
    // 在同类用例间漂移（每轮挂的用例都不同，单跑全绿）。限制 fork 数后全量稳定通过
    // （96s，与不限并发时的 77-92s 基本持平）。
    poolOptions: {
      forks: {
        minForks: 1,
        maxForks: 6,
      },
    },
    // 即便限了并发，CI 上更慢的机器仍可能抖动，给重用例留足预算；真正的死锁/回归
    // 依然会超时暴露。
    testTimeout: 20000,
    coverage: {
      reporter: ["text", "lcov"],
    },
  },
});
