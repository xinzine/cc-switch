import { Channel, invoke } from "@tauri-apps/api/core";
import type { FetchedModel } from "./model-fetch";
import type { ModelProbeResult } from "./model-probe";

/**
 * 默认 AI API（驱动内置聊天助手）。
 *
 * 凭据独立于供应商列表存储（settings 表的 `default_ai_config` 键），
 * 这样删站点不会把助手的配置一起带走。
 *
 * 安全边界：`chatDefaultAi` 只把模型想调用的工具**原样回传**，后端不代为执行。
 * 新增 / 修改由前端直接走既有 provider 命令；删除必须经用户确认。
 */

export interface DefaultAiConfig {
  baseUrl: string;
  apiKey: string;
  model: string;
  /** "openai_chat"（默认）或 "anthropic" */
  apiFormat: string;
}

export const EMPTY_DEFAULT_AI_CONFIG: DefaultAiConfig = {
  baseUrl: "",
  apiKey: "",
  model: "",
  apiFormat: "openai_chat",
};

export interface ToolCall {
  id: string;
  name: string;
  /** 工具参数的 JSON 字符串。可能不是合法 JSON，解析时需容错。 */
  arguments: string;
}

export interface ChatReply {
  /** 文本回复；模型只发起工具调用时可能为空 */
  content: string;
  toolCalls: ToolCall[];
  finishReason?: string;
}

/** 后端通过 Channel 推过来的流式事件。 */
type ChatStreamEvent = { type: "textDelta"; delta: string };

export async function getDefaultAiConfig(): Promise<DefaultAiConfig> {
  return invoke("get_default_ai_config");
}

export async function saveDefaultAiConfig(
  config: DefaultAiConfig,
): Promise<void> {
  return invoke("save_default_ai_config", { config });
}

/**
 * 测试默认 AI 是否可用（发一次真实流式请求）。
 *
 * `config` 传入时测的是未保存的草稿，便于设置页在保存前先验证。
 */
export async function testDefaultAi(
  config?: DefaultAiConfig,
): Promise<ModelProbeResult> {
  return invoke("test_default_ai", { config });
}

export async function fetchDefaultAiModels(
  config?: DefaultAiConfig,
): Promise<FetchedModel[]> {
  return invoke("fetch_default_ai_models", { config });
}

/**
 * 发一轮带工具的流式对话。
 *
 * `onTextDelta` 每收到一个文本增量就调用一次（实时打字效果）。
 * Promise resolve 时返回完整 `ChatReply`（tool calls 在流结束后才可用）。
 *
 * `messages` 按 OpenAI 约定组装 `{ role, content, tool_calls?, tool_call_id? }`；
 * Anthropic 格式由后端转换。
 */
export async function chatDefaultAi(
  messages: unknown[],
  tools: unknown[] | undefined,
  onTextDelta: (delta: string) => void,
): Promise<ChatReply> {
  const onEvent = new Channel<ChatStreamEvent>((event) => {
    if (event.type === "textDelta") onTextDelta(event.delta);
  });
  return invoke("chat_default_ai", { messages, tools, onEvent });
}
