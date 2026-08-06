import { useCallback, useRef, useState } from "react";
import { chatDefaultAi, type ToolCall } from "@/lib/api/default-ai";
import type { AppId } from "@/lib/api/types";
import { useChatTools } from "./useChatTools";
import {
  CHAT_TOOLS,
  REQUIRES_CONFIRMATION,
  WRITE_TOOLS,
  buildSystemPrompt,
} from "./tools";

/**
 * 聊天助手的对话状态机。
 *
 * 一轮的流程：用户发言 → 模型回复（可能带工具调用）→ 工具执行 →
 * 结果回喂模型 → 循环，直到模型不再请求工具。
 *
 * 工具分派看 `WRITE_TOOLS`（决定执行器），确认看 `REQUIRES_CONFIRMATION`
 * （只有删除）。挂起的删除会中断循环：用户点确认/拒绝后再继续，这样模型
 * 永远看不到「我以为删了但其实没删」的中间态。
 */

/** 工具循环的最大轮数。防止模型陷入「取模型→测速→再取」的死循环烧额度。 */
const MAX_TOOL_ROUNDS = 8;

/** 用户附带的图片。`dataUrl` 是 `data:image/png;base64,...` 形式。 */
export interface ChatImage {
  dataUrl: string;
  name: string;
}

export interface ChatMessage {
  id: string;
  role: "user" | "assistant" | "tool";
  content: string;
  /** 用户这条消息附带的图片（用于界面回显）。 */
  images?: ChatImage[];
  /** 助手这一轮发起的工具调用（用于界面回显）。 */
  toolCalls?: ToolCall[];
  /** role === "tool" 时：对应的工具名与执行结果摘要。 */
  toolName?: string;
  toolOk?: boolean;
}

/** 等待用户确认的写操作（当前只有删除）。 */
export interface PendingAction {
  call: ToolCall;
  args: Record<string, unknown>;
}

/** 解析工具参数。模型给的 JSON 可能不合法，容错处理。 */
function parseArgs(raw: string): Record<string, unknown> {
  try {
    const parsed = JSON.parse(raw || "{}");
    return typeof parsed === "object" && parsed !== null
      ? (parsed as Record<string, unknown>)
      : {};
  } catch {
    return {};
  }
}

export function useAiChat(appId: AppId) {
  const { executeRead, executeWrite } = useChatTools(appId);
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [isBusy, setIsBusy] = useState(false);
  const [pending, setPending] = useState<PendingAction | null>(null);
  const [error, setError] = useState<string | null>(null);

  /**
   * 发给模型的完整消息历史（OpenAI 形状）。
   *
   * 与界面用的 `messages` 分开维护：界面要展示的东西（工具执行摘要）和模型需要
   * 的东西（严格的 tool_calls / tool_call_id 配对）形状不同，混在一起会两边都别扭。
   */
  const wireRef = useRef<unknown[]>([]);
  const appendUi = useCallback((msg: ChatMessage) => {
    setMessages((prev) => [...prev, msg]);
  }, []);

  /** 把一个工具的执行结果同时写进模型历史和界面。 */
  const pushToolResult = useCallback(
    (call: ToolCall, ok: boolean, data: unknown) => {
      wireRef.current = [
        ...wireRef.current,
        {
          role: "tool",
          tool_call_id: call.id,
          content: JSON.stringify(data),
        },
      ];
      appendUi({
        id: crypto.randomUUID(),
        role: "tool",
        content: JSON.stringify(data),
        toolName: call.name,
        toolOk: ok,
      });
    },
    [appendUi],
  );

  /**
   * 驱动工具循环，直到模型不再请求工具、或撞上待确认的写操作。
   *
   * 返回后 `wireRef` 已包含本轮全部消息，可直接续跑。
   */
  const runLoop = useCallback(
    async (startRound = 0) => {
      for (let round = startRound; round < MAX_TOOL_ROUNDS; round += 1) {
        // 每轮生成稳定的助手消息 ID，流式增量 upsert 同一条消息。
        const assistantMsgId = crypto.randomUUID();

        const reply = await chatDefaultAi(
          wireRef.current,
          CHAT_TOOLS,
          (delta) => {
            // 实时 upsert：找到则追加，否则插入新消息
            setMessages((prev) => {
              const idx = prev.findIndex((m) => m.id === assistantMsgId);
              if (idx >= 0) {
                const updated = [...prev];
                updated[idx] = {
                  ...updated[idx],
                  content: updated[idx].content + delta,
                };
                return updated;
              }
              return [
                ...prev,
                {
                  id: assistantMsgId,
                  role: "assistant" as const,
                  content: delta,
                },
              ];
            });
          },
        );

        // Promise 完成：用权威值修正文本并附上 tool calls
        setMessages((prev) => {
          const idx = prev.findIndex((m) => m.id === assistantMsgId);
          const finalMsg = {
            id: assistantMsgId,
            role: "assistant" as const,
            content: reply.content,
            toolCalls: reply.toolCalls.length > 0 ? reply.toolCalls : undefined,
          };
          if (idx >= 0) {
            const updated = [...prev];
            updated[idx] = finalMsg;
            return updated;
          }
          // 纯 tool-call 回复（无文本），流中没有产生气泡，补一条
          if (reply.toolCalls.length > 0) {
            return [...prev, finalMsg];
          }
          return prev;
        });

        // 只有在正常完成后才把助手消息写入 wire history
        wireRef.current = [
          ...wireRef.current,
          {
            role: "assistant",
            content: reply.content || null,
            ...(reply.toolCalls.length > 0
              ? {
                  tool_calls: reply.toolCalls.map((c) => ({
                    id: c.id,
                    type: "function",
                    function: { name: c.name, arguments: c.arguments },
                  })),
                }
              : {}),
          },
        ];

        if (reply.toolCalls.length === 0) return;

        /** 按工具名选执行器。写工具走 `executeWrite`，其余走 `executeRead`。 */
        const runCall = (call: ToolCall) => {
          const args = parseArgs(call.arguments);
          return WRITE_TOOLS.has(call.name)
            ? executeWrite(call.name, args)
            : executeRead(call.name, args);
        };

        // 需确认的操作（当前只有删除）要停下来等用户。只挂起第一个——模型一次
        // 要求删两个站点时，逐个确认比一次性批准更安全。
        const confirmCall = reply.toolCalls.find((c) =>
          REQUIRES_CONFIRMATION.has(c.name),
        );
        if (confirmCall) {
          setPending({
            call: confirmCall,
            args: parseArgs(confirmCall.arguments),
          });
          // 同一轮里不需确认的工具先跑掉，免得确认后还要多跑一圈。
          // 如果模型同一轮发了多个删除，只挂起第一个，其余明确标记为未执行；
          // 绝不能因为它不是当前挂起项就绕过确认。
          for (const call of reply.toolCalls) {
            if (call.id === confirmCall.id) continue;
            if (REQUIRES_CONFIRMATION.has(call.name)) {
              pushToolResult(call, false, {
                ok: false,
                error:
                  "同一轮只能确认一个删除。此删除未执行；请等待用户处理当前删除后，再单独发起。",
              });
              continue;
            }
            const outcome = await runCall(call);
            pushToolResult(call, outcome.ok, outcome.data);
          }
          return;
        }

        for (const call of reply.toolCalls) {
          const outcome = await runCall(call);
          pushToolResult(call, outcome.ok, outcome.data);
        }
      }

      // 撞上轮数上限：告知用户而不是静默停下。
      appendUi({
        id: crypto.randomUUID(),
        role: "assistant",
        content:
          "工具调用轮数达到上限，已停止。请换个说法再试，或把任务拆小一些。",
      });
    },
    [appendUi, executeRead, executeWrite, pushToolResult],
  );

  const send = useCallback(
    async (text: string, images?: ChatImage[]) => {
      const trimmed = text.trim();
      const hasImages = Boolean(images && images.length > 0);
      // 只发图不打字是合理的用法（「看这张截图」），故文本可空。
      if ((!trimmed && !hasImages) || isBusy || pending) return;

      setError(null);
      setIsBusy(true);

      if (wireRef.current.length === 0) {
        wireRef.current = [
          { role: "system", content: buildSystemPrompt(appId) },
        ];
      }
      // 带图时用 OpenAI 多模态 content 数组；纯文本仍发字符串，避免给
      // 不支持数组形式的兼容端点添麻烦。
      wireRef.current = [
        ...wireRef.current,
        {
          role: "user",
          content: hasImages
            ? [
                ...(trimmed ? [{ type: "text", text: trimmed }] : []),
                ...images!.map((img) => ({
                  type: "image_url",
                  image_url: { url: img.dataUrl },
                })),
              ]
            : trimmed,
        },
      ];
      appendUi({
        id: crypto.randomUUID(),
        role: "user",
        content: trimmed,
        images: hasImages ? images : undefined,
      });

      try {
        await runLoop();
      } catch (e) {
        setError(String(e));
      } finally {
        setIsBusy(false);
      }
    },
    [appId, appendUi, isBusy, pending, runLoop],
  );

  /** 用户确认了挂起的写操作：执行它，把结果回喂模型并继续循环。 */
  const confirmPending = useCallback(async () => {
    if (!pending) return;
    const { call, args } = pending;
    setPending(null);
    setIsBusy(true);
    try {
      const outcome = await executeWrite(call.name, args);
      pushToolResult(call, outcome.ok, outcome.data);
      await runLoop();
    } catch (e) {
      setError(String(e));
    } finally {
      setIsBusy(false);
    }
  }, [executeWrite, pending, pushToolResult, runLoop]);

  /** 用户拒绝了：告知模型被拒绝，让它换个方案而不是重复请求。 */
  const rejectPending = useCallback(async () => {
    if (!pending) return;
    const { call } = pending;
    setPending(null);
    setIsBusy(true);
    try {
      pushToolResult(call, false, {
        ok: false,
        error: "用户拒绝了这个操作。不要重试，改为询问用户想怎么做。",
      });
      await runLoop();
    } catch (e) {
      setError(String(e));
    } finally {
      setIsBusy(false);
    }
  }, [pending, pushToolResult, runLoop]);

  const reset = useCallback(() => {
    wireRef.current = [];
    setMessages([]);
    setPending(null);
    setError(null);
  }, []);

  return {
    messages,
    isBusy,
    pending,
    error,
    send,
    confirmPending,
    rejectPending,
    reset,
  };
}
