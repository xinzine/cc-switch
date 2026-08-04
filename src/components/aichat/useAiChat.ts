import { useCallback, useRef, useState } from "react";
import { chatDefaultAi, type ToolCall } from "@/lib/api/default-ai";
import type { AppId } from "@/lib/api/types";
import { useChatTools } from "./useChatTools";
import { CHAT_TOOLS, REQUIRES_CONFIRMATION, buildSystemPrompt } from "./tools";

/**
 * 聊天助手的对话状态机。
 *
 * 一轮的流程：用户发言 → 模型回复（可能带工具调用）→ 只读工具立即执行、
 * 写操作挂起等确认 → 工具结果回喂模型 → 循环，直到模型不再请求工具。
 *
 * 挂起的写操作会中断循环：用户点确认/拒绝后再继续。这样模型永远看不到
 * 「我以为改了但其实没改」的中间态。
 */

/** 工具循环的最大轮数。防止模型陷入「取模型→测速→再取」的死循环烧额度。 */
const MAX_TOOL_ROUNDS = 8;

export interface ChatMessage {
  id: string;
  role: "user" | "assistant" | "tool";
  content: string;
  /** 助手这一轮发起的工具调用（用于界面回显）。 */
  toolCalls?: ToolCall[];
  /** role === "tool" 时：对应的工具名与执行结果摘要。 */
  toolName?: string;
  toolOk?: boolean;
}

/** 等待用户确认的写操作。 */
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

        // 写操作要停下来等确认。只挂起第一个——模型一次要求删两个站点时，
        // 逐个确认比一次性批准更安全。
        const writeCall = reply.toolCalls.find((c) =>
          REQUIRES_CONFIRMATION.has(c.name),
        );
        if (writeCall) {
          setPending({
            call: writeCall,
            args: parseArgs(writeCall.arguments),
          });
          // 同一轮里的只读工具先跑掉，免得确认后还要多跑一圈。
          for (const call of reply.toolCalls) {
            if (call.id === writeCall.id) continue;
            const outcome = await executeRead(
              call.name,
              parseArgs(call.arguments),
            );
            pushToolResult(call, outcome.ok, outcome.data);
          }
          return;
        }

        for (const call of reply.toolCalls) {
          const outcome = await executeRead(
            call.name,
            parseArgs(call.arguments),
          );
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
    [appendUi, executeRead, pushToolResult],
  );

  const send = useCallback(
    async (text: string) => {
      const trimmed = text.trim();
      if (!trimmed || isBusy || pending) return;

      setError(null);
      setIsBusy(true);

      if (wireRef.current.length === 0) {
        wireRef.current = [
          { role: "system", content: buildSystemPrompt(appId) },
        ];
      }
      wireRef.current = [
        ...wireRef.current,
        { role: "user", content: trimmed },
      ];
      appendUi({ id: crypto.randomUUID(), role: "user", content: trimmed });

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
