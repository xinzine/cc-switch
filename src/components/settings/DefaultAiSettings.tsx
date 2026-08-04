import { useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { Bot, Gauge, Loader2, Save } from "lucide-react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import ApiKeyInput from "@/components/providers/forms/ApiKeyInput";
import { ModelInputWithFetch } from "@/components/providers/forms/shared/ModelInputWithFetch";
import {
  getDefaultAiConfig,
  saveDefaultAiConfig,
  testDefaultAi,
  fetchDefaultAiModels,
  EMPTY_DEFAULT_AI_CONFIG,
  type DefaultAiConfig,
} from "@/lib/api/default-ai";
import type { FetchedModel } from "@/lib/api/model-fetch";
import { formatSeconds } from "@/hooks/useModelProbe";

/**
 * 默认 AI 设置。
 *
 * 这个模型驱动内置的站点管理助手，凭据**独立于站点列表存储**（settings 表的
 * `default_ai_config` 键），所以删站点不会把助手一起弄坏。
 *
 * 自管后端状态（draft + dirty），照 `GlobalProxySettings` 的模式；不走
 * `SettingsPage` 的 autoSave 通道——那个通道会把整个表单回传，apiKey 会随任何
 * 无关设置的保存一起进出。
 */
export function DefaultAiSettings() {
  const { t } = useTranslation();
  const queryClient = useQueryClient();
  const { data, isLoading } = useQuery({
    queryKey: ["defaultAiConfig"],
    queryFn: getDefaultAiConfig,
  });

  const [draft, setDraft] = useState<DefaultAiConfig>(EMPTY_DEFAULT_AI_CONFIG);
  const [dirty, setDirty] = useState(false);
  const [saving, setSaving] = useState(false);
  const [testing, setTesting] = useState(false);
  const [models, setModels] = useState<FetchedModel[]>([]);
  const [fetchingModels, setFetchingModels] = useState(false);

  // 后端数据到达后同步到草稿；用户已改过就不覆盖，避免打断输入。
  useEffect(() => {
    if (data && !dirty) setDraft(data);
  }, [data, dirty]);

  const patch = (updates: Partial<DefaultAiConfig>) => {
    setDraft((prev) => ({ ...prev, ...updates }));
    setDirty(true);
  };

  const handleSave = async () => {
    setSaving(true);
    try {
      await saveDefaultAiConfig(draft);
      await queryClient.invalidateQueries({ queryKey: ["defaultAiConfig"] });
      setDirty(false);
      toast.success(
        t("defaultAi.saved", { defaultValue: "默认 AI 配置已保存" }),
      );
    } catch (e) {
      toast.error(
        t("defaultAi.saveError", {
          error: String(e),
          defaultValue: `保存失败: ${String(e)}`,
        }),
      );
    } finally {
      setSaving(false);
    }
  };

  /** 测的是**当前草稿**，不必先保存——填错了不用为了验证而先污染已存配置。 */
  const handleTest = async () => {
    setTesting(true);
    try {
      const result = await testDefaultAi(draft);
      if (result.success) {
        toast.success(
          t("defaultAi.testOk", {
            firstToken: formatSeconds(result.firstTokenMs),
            duration: formatSeconds(result.durationMs),
            defaultValue: `可用 · 首字 ${formatSeconds(result.firstTokenMs)} 秒 · 总耗时 ${formatSeconds(result.durationMs)} 秒`,
          }),
          { description: result.responseText || undefined },
        );
      } else {
        toast.error(
          t("defaultAi.testFailed", {
            message: result.message,
            defaultValue: `测试失败: ${result.message}`,
          }),
          { duration: 8000, closeButton: true },
        );
      }
    } catch (e) {
      toast.error(
        t("defaultAi.testError", {
          error: String(e),
          defaultValue: `测试出错: ${String(e)}`,
        }),
      );
    } finally {
      setTesting(false);
    }
  };

  const handleFetchModels = async () => {
    setFetchingModels(true);
    try {
      const list = await fetchDefaultAiModels(draft);
      setModels(list);
      if (list.length === 0) {
        toast.warning(
          t("defaultAi.noModels", { defaultValue: "没有返回任何模型" }),
        );
      }
    } catch (e) {
      toast.error(
        t("defaultAi.fetchModelsError", {
          error: String(e),
          defaultValue: `获取模型失败: ${String(e)}`,
        }),
      );
    } finally {
      setFetchingModels(false);
    }
  };

  const canTest = Boolean(
    draft.baseUrl.trim() && draft.apiKey.trim() && draft.model.trim(),
  );

  if (isLoading) {
    return (
      <section className="space-y-4">
        <SectionHeader />
        <div className="flex items-center gap-2 text-xs text-muted-foreground">
          <Loader2 className="h-3 w-3 animate-spin" />
          {t("common.loading", { defaultValue: "加载中…" })}
        </div>
      </section>
    );
  }

  return (
    <section className="space-y-4">
      <SectionHeader />

      <div className="space-y-3">
        <div className="space-y-1.5">
          <Label htmlFor="default-ai-base-url">
            {t("defaultAi.baseUrl", { defaultValue: "Base URL" })}
          </Label>
          <Input
            id="default-ai-base-url"
            value={draft.baseUrl}
            onChange={(e) => patch({ baseUrl: e.target.value })}
            placeholder="https://api.example.com/v1"
          />
        </div>

        <ApiKeyInput
          id="default-ai-api-key"
          value={draft.apiKey}
          onChange={(value) => patch({ apiKey: value })}
          placeholder="sk-..."
        />

        <div className="space-y-1.5">
          <Label htmlFor="default-ai-format">
            {t("defaultAi.apiFormat", { defaultValue: "接口格式" })}
          </Label>
          <Select
            value={draft.apiFormat || "openai_chat"}
            onValueChange={(value) => patch({ apiFormat: value })}
          >
            <SelectTrigger id="default-ai-format">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="openai_chat">
                OpenAI Chat Completions
              </SelectItem>
              <SelectItem value="anthropic">Anthropic Messages</SelectItem>
            </SelectContent>
          </Select>
          <p className="text-xs text-muted-foreground">
            {t("defaultAi.apiFormatHint", {
              defaultValue:
                "助手需要 function calling 支持。多数中转站是 OpenAI 格式。",
            })}
          </p>
        </div>

        <div className="space-y-1.5">
          <Label htmlFor="default-ai-model">
            {t("defaultAi.model", { defaultValue: "模型" })}
          </Label>
          <ModelInputWithFetch
            id="default-ai-model"
            value={draft.model}
            onChange={(value) => patch({ model: value })}
            fetchedModels={models}
            isLoading={fetchingModels}
            onFetch={
              draft.baseUrl.trim() && draft.apiKey.trim()
                ? handleFetchModels
                : undefined
            }
            placeholder="gpt-5.5"
          />
        </div>
      </div>

      <div className="flex items-center gap-2">
        <Button
          size="sm"
          className="gap-1.5"
          onClick={handleSave}
          disabled={!dirty || saving}
        >
          {saving ? (
            <Loader2 className="h-3.5 w-3.5 animate-spin" />
          ) : (
            <Save className="h-3.5 w-3.5" />
          )}
          {t("common.save", { defaultValue: "保存" })}
        </Button>
        <Button
          size="sm"
          variant="outline"
          className="gap-1.5"
          onClick={handleTest}
          disabled={!canTest || testing}
          title={t("defaultAi.testHint", {
            defaultValue: "发一次真实请求验证配置（消耗少量额度）",
          })}
        >
          {testing ? (
            <Loader2 className="h-3.5 w-3.5 animate-spin" />
          ) : (
            <Gauge className="h-3.5 w-3.5" />
          )}
          {t("defaultAi.test", { defaultValue: "测试" })}
        </Button>
      </div>
    </section>
  );
}

function SectionHeader() {
  const { t } = useTranslation();
  return (
    <div className="flex items-center gap-2 border-b border-border/40 pb-2">
      <Bot className="h-4 w-4 text-primary" />
      <div>
        <h3 className="text-sm font-medium">
          {t("defaultAi.title", { defaultValue: "默认 AI" })}
        </h3>
        <p className="text-xs text-muted-foreground">
          {t("defaultAi.description", {
            defaultValue:
              "驱动站点管理助手的模型。凭据独立存储，不受站点增删影响。",
          })}
        </p>
      </div>
    </div>
  );
}
