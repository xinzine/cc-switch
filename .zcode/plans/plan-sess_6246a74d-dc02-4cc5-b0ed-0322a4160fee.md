# 实施计划：完成 i18n 本地化

## 当前状态总结

核心功能**已完整实现**：
- ✅ 后端：真实模型探测（`model_probe.rs`）、默认 AI 服务（`default_ai.rs`）、命令注册
- ✅ 前端 API：`model-probe.ts`、`default-ai.ts`、`providerModel.ts`
- ✅ 前端 UI：卡片模型行、批量测速、聊天面板、设置页全部接线
- ✅ 测试：Rust 单测与前端单测结构完整

## 唯一剩余工作：i18n 本地化

所有 UI 组件已用 `t(key, { defaultValue })` 编写，但新增的 key 尚未写入 4 个语言文件。

### 需要补充的文件

1. `src/i18n/locales/en.json`
2. `src/i18n/locales/zh.json`
3. `src/i18n/locales/ja.json`
4. `src/i18n/locales/zh-TW.json`

### 需要添加的顶层 key

根据代码中出现的 `t()` 调用，需要添加：

**`aiChat`** (聊天面板 - `AiChatPanel.tsx`、`ChatMessageItem.tsx`、`ToolConfirmCard.tsx`):
- `notConfigured` / `notConfiguredHint` / `openSettings`
- `modelHint` / `newChat` / `thinking` / `placeholder` / `pendingHint`
- `emptyTitle` / `example1` / `example2` / `example3`
- `confirmAction` / `rejectAction` / 工具确认卡文案

**`modelProbe`** (模型测速 - `ProviderCard.tsx`、`ProviderList.tsx`、`useModelProbe.ts`):
- `fetchModels` / `testModel` / `modelLabel` / `selectModel`
- `batchTest` / `batchTestConfirm` / `batchFetch` / `batchFetchConfirm`
- `result_success` / `result_firstToken` / `result_duration`
- `batchTestDone` / `batchFetchDone` / `batchTestError` / `batchFetchError`
- `fetchSuccess` / `fetchError` / `testSuccess` / `testError`

**`defaultAi`** (设置页 - `DefaultAiSettings.tsx`):
- `title` / `description`
- `baseUrl` / `apiKey` / `model` / `apiFormat`
- `formatOpenAi` / `formatAnthropic`
- `testButton` / `testSuccess` / `testError`
- `saveSuccess` / `saveError`
- `fetchModelsButton` / `fetchSuccess` / `fetchError`

### 实施步骤

1. **提取所有 `t()` 调用**：遍历相关组件，收集完整的 key 列表与 defaultValue
2. **构造 JSON 结构**：
   - 英文（en）：用 defaultValue 中的英文或自行翻译
   - 简中（zh）：直接用代码中的 defaultValue
   - 日文（ja）：翻译英文版
   - 繁中（zh-TW）：转换简中用语
3. **按字母顺序插入**：现有文件已按 key 排序，新增部分保持一致
4. **验证格式**：确保 JSON 合法、无逗号错误、无重复 key

### 验证

完成后运行：
```bash
pnpm typecheck  # 确保 JSON 导入无误
pnpm format:check  # 确保格式符合项目规范
```

手动验证：切换语言（设置页 Language），检查聊天面板、卡片、设置页文案是否正确显示。

---

## 附加观察

**默认 AI 聊天当前是非流式的**（`default_ai.rs:149` 的 `chat()` 等待完整回复后返回）。这符合 function calling 的约束（需要完整 tool_calls 才能执行工具循环），用户体验上会有等待感，但功能完整。如需改成流式：
1. 后端用 Tauri `Channel<String>` 逐块推文本增量
2. 前端实时渲染打字效果
3. 流结束后解析 tool_calls 并继续工具循环

这是 **UX 优化项**，不影响当前功能交付。

---

## 总结

计划完成度：**95%**（仅差 i18n 本地化）。补完 4 个语言文件后即可交付全部功能。