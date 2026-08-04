/**
 * 聊天助手可调用的工具（OpenAI function calling schema）。
 *
 * ## 安全模型
 *
 * 工具分两类，由 [`REQUIRES_CONFIRMATION`] 划分：
 * - **只读 / 无副作用**（列站点、取模型、测速）：助手请求即执行。
 * - **写操作**（新增 / 编辑 / 删除站点）：**不直接执行**，先在聊天里渲染确认卡，
 *   用户点确认后才落库。模型误判很常见，让它直接改用户的配置不可接受。
 *
 * 后端不参与工具执行（见 `services/default_ai.rs`），全部在前端跑。
 */

/** 需要用户确认才执行的工具。 */
export const REQUIRES_CONFIRMATION = new Set([
  "createProvider",
  "updateProvider",
  "deleteProvider",
]);

/** 破坏性工具：确认卡用醒目样式，且文案要说清不可撤销。 */
export const DESTRUCTIVE_TOOLS = new Set(["deleteProvider"]);

const APP_ID_ENUM = [
  "claude",
  "claude-desktop",
  "codex",
  "gemini",
  "grokbuild",
  "opencode",
  "openclaw",
  "hermes",
];

export const CHAT_TOOLS = [
  {
    type: "function",
    function: {
      name: "listProviders",
      description:
        "列出指定应用下的所有站点（供应商），返回 id、名称、baseUrl、当前模型、是否为当前使用的站点。这是了解现状的第一步。",
      parameters: {
        type: "object",
        properties: {
          appId: {
            type: "string",
            enum: APP_ID_ENUM,
            description: "应用标识，省略则用用户当前正在查看的应用",
          },
        },
      },
    },
  },
  {
    type: "function",
    function: {
      name: "getProvider",
      description:
        "读取单个站点的完整配置（含 settingsConfig）。API Key 会被打码，不会返回明文。",
      parameters: {
        type: "object",
        properties: {
          id: { type: "string", description: "站点 id" },
          appId: { type: "string", enum: APP_ID_ENUM },
        },
        required: ["id"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "createProvider",
      description:
        "新增一个站点。需要用户在界面上确认后才会真正创建。baseUrl 和 apiKey 必填。",
      parameters: {
        type: "object",
        properties: {
          appId: { type: "string", enum: APP_ID_ENUM },
          name: { type: "string", description: "站点显示名称" },
          baseUrl: { type: "string", description: "API 基础地址" },
          apiKey: { type: "string", description: "API 密钥" },
          model: { type: "string", description: "默认模型，可选" },
          notes: { type: "string", description: "备注，可选" },
        },
        required: ["name", "baseUrl", "apiKey"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "updateProvider",
      description:
        "修改已有站点。只传需要改的字段，未传的保持原值。需要用户确认后才生效。",
      parameters: {
        type: "object",
        properties: {
          id: { type: "string", description: "要修改的站点 id" },
          appId: { type: "string", enum: APP_ID_ENUM },
          name: { type: "string" },
          baseUrl: { type: "string" },
          apiKey: { type: "string" },
          model: { type: "string" },
          notes: { type: "string" },
        },
        required: ["id"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "deleteProvider",
      description:
        "删除一个站点。不可撤销，必须由用户在界面上确认。删除前应先用 listProviders 确认目标正确。",
      parameters: {
        type: "object",
        properties: {
          id: { type: "string", description: "要删除的站点 id" },
          appId: { type: "string", enum: APP_ID_ENUM },
        },
        required: ["id"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "fetchModels",
      description: "获取某站点上可用的模型列表（调用其 /models 端点）。",
      parameters: {
        type: "object",
        properties: {
          id: { type: "string", description: "站点 id" },
          appId: { type: "string", enum: APP_ID_ENUM },
        },
        required: ["id"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "probeModel",
      description:
        "测试某站点的模型是否可用，返回首字延迟与总耗时。会发一次真实请求，消耗少量额度。model 省略时用该站点配置的默认模型。",
      parameters: {
        type: "object",
        properties: {
          id: { type: "string", description: "站点 id" },
          appId: { type: "string", enum: APP_ID_ENUM },
          model: { type: "string", description: "要测试的模型，可选" },
        },
        required: ["id"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "probeAllModels",
      description:
        "批量测试多个站点的默认模型，返回每个站点的首字延迟与总耗时。会对每个站点各发一次真实请求。ids 省略时测该应用下全部站点。",
      parameters: {
        type: "object",
        properties: {
          appId: { type: "string", enum: APP_ID_ENUM },
          ids: {
            type: "array",
            items: { type: "string" },
            description: "要测试的站点 id 列表，省略则测全部",
          },
        },
      },
    },
  },
];

/** 助手的系统提示。 */
export function buildSystemPrompt(appId: string): string {
  return [
    "你是 cc-switch 的站点管理助手。cc-switch 是一个管理 AI 编程工具（Claude Code、Codex、Gemini CLI 等）供应商配置的工具。",
    `用户当前正在查看的应用是「${appId}」。工具调用中省略 appId 时默认使用它。`,
    "",
    "你可以帮用户：查看和搜索站点、新增/修改/删除站点、获取站点可用模型、测试模型的首字延迟与总耗时。",
    "",
    "工作方式：",
    "- 动手前先用 listProviders 确认现状，不要凭猜测操作。",
    "- 新增/修改/删除会先弹确认卡给用户，你不需要额外征求同意，直接发起工具调用即可；但要在回复里说清你打算做什么。",
    "- 测速会消耗真实额度。用户没明确要求时不要主动批量测速。",
    "- 用户要求「找最快的站点」这类任务时，先列出站点，再批量测速，最后按首字延迟排序汇报。",
    "- 报告延迟用秒（一位小数），例如「首字 2.2 秒」。",
    "",
    "回复用中文，简洁直接。不要复述工具返回的原始 JSON，用自然语言总结。",
  ].join("\n");
}
