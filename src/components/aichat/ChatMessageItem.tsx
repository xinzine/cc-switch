import { useState } from "react";
import { useTranslation } from "react-i18next";
import { ChevronDown, ChevronRight, Wrench, XCircle } from "lucide-react";
import { cn } from "@/lib/utils";
import type { ChatMessage } from "./useAiChat";

/** 一条消息。用户 / 助手是气泡，工具执行是可折叠的紧凑行。 */
export function ChatMessageItem({ message }: { message: ChatMessage }) {
  if (message.role === "tool") return <ToolResultRow message={message} />;

  const isUser = message.role === "user";
  return (
    <div className={cn("flex", isUser ? "justify-end" : "justify-start")}>
      <div
        className={cn(
          "max-w-[85%] whitespace-pre-wrap break-words rounded-xl px-3 py-2 text-sm",
          isUser
            ? "bg-primary text-primary-foreground"
            : "border border-border/60 bg-card",
        )}
      >
        {message.content}
        {message.toolCalls && message.toolCalls.length > 0 && (
          <div className="mt-2 flex flex-wrap gap-1.5">
            {message.toolCalls.map((call) => (
              <span
                key={call.id}
                className="inline-flex items-center gap-1 rounded-md bg-muted px-1.5 py-0.5 font-mono text-[11px] text-muted-foreground"
              >
                <Wrench className="h-3 w-3" />
                {call.name}
              </span>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}

/**
 * 工具执行结果。默认折叠——原始 JSON 对用户没什么价值，但出问题时能展开看。
 */
function ToolResultRow({ message }: { message: ChatMessage }) {
  const { t } = useTranslation();
  const [open, setOpen] = useState(false);
  const failed = message.toolOk === false;

  return (
    <div className="text-xs">
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        className={cn(
          "inline-flex items-center gap-1 rounded-md px-1.5 py-0.5 transition-colors hover:bg-muted",
          failed ? "text-destructive" : "text-muted-foreground",
        )}
      >
        {open ? (
          <ChevronDown className="h-3 w-3" />
        ) : (
          <ChevronRight className="h-3 w-3" />
        )}
        {failed ? (
          <XCircle className="h-3 w-3" />
        ) : (
          <Wrench className="h-3 w-3" />
        )}
        <span className="font-mono">{message.toolName}</span>
        <span>
          {failed
            ? t("aiChat.toolFailed", { defaultValue: "执行失败" })
            : t("aiChat.toolDone", { defaultValue: "已执行" })}
        </span>
      </button>
      {open && (
        <pre className="mt-1 max-h-48 overflow-auto rounded-md bg-muted/60 p-2 font-mono text-[11px] leading-relaxed">
          {message.content}
        </pre>
      )}
    </div>
  );
}
