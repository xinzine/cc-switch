//! 模型可用性探测命令
//!
//! 与 `commands::stream_check`（只探 base_url 可达）的区别：本组命令发**真实的
//! 流式 chat 请求**，能测出模型是否真的可用、首字延迟与总耗时，代价是消耗少量额度。
//!
//! 探测结果**不落库**：前端只把它放在内存里就地展示，刷新即丢。这是刻意的——
//! 探测是「此刻能不能用」的一次性观察，存下来只会给出过期的判断。

use futures::stream::{self, StreamExt};
use serde::Serialize;

use crate::app_config::AppType;
use crate::commands::copilot::CopilotAuthState;
use crate::error::AppError;
use crate::provider::Provider;
use crate::services::model_fetch::FetchedModel;
use crate::services::model_probe::{
    ApiFormat, ModelProbeConfig, ModelProbeResult, ModelProbeService,
};
use crate::store::AppState;
use tauri::State;

/// 探测单个供应商的模型。
///
/// `model` 为空时从供应商配置里读当前默认模型；读不到则回传「未配置模型」的失败
/// 结果，**不**自动挑一个——猜出来的数字没有参考价值。
#[tauri::command(rename_all = "camelCase")]
pub async fn probe_provider_model(
    state: State<'_, AppState>,
    copilot_state: State<'_, CopilotAuthState>,
    app_type: AppType,
    provider_id: String,
    model: Option<String>,
) -> Result<ModelProbeResult, AppError> {
    let config = state.db.get_model_probe_config()?;
    let providers = state.db.get_all_providers(app_type.as_str())?;
    let provider = providers
        .get(&provider_id)
        .ok_or_else(|| AppError::Message(format!("供应商 {provider_id} 不存在")))?;

    let model = match model
        .map(|m| m.trim().to_string())
        .filter(|m| !m.is_empty())
    {
        Some(m) => m,
        None => resolve_configured_model(&app_type, provider).unwrap_or_default(),
    };

    let base_url_override =
        crate::commands::stream_check::resolve_copilot_base_url_override(provider, &copilot_state)
            .await?;

    Ok(ModelProbeService::probe(&app_type, provider, &model, &config, base_url_override).await)
}

/// 批量探测多个供应商的默认模型。
///
/// `provider_ids` 为空时探测该应用下的全部供应商（跳过官方账号类）。
/// 按配置的并发上限并行——全并发容易触发上游限流，反而测出假的慢。
#[tauri::command(rename_all = "camelCase")]
pub async fn probe_all_provider_models(
    state: State<'_, AppState>,
    copilot_state: State<'_, CopilotAuthState>,
    app_type: AppType,
    provider_ids: Option<Vec<String>>,
) -> Result<Vec<(String, ModelProbeResult)>, AppError> {
    let config = state.db.get_model_probe_config()?.sanitized();
    let providers = state.db.get_all_providers(app_type.as_str())?;

    // 先把需要的凭据 / 端点解析完，再进并发阶段：Tauri 的 State 不是 Send 友好的，
    // 不能跨 await 点带进并发任务里。
    let mut targets: Vec<(String, Provider, String, Option<String>)> = Vec::new();
    for (id, provider) in providers {
        // 官方账号类供应商没有用户配置的探测目标，前端也已隐藏其按钮。
        if provider.category.as_deref() == Some("official") {
            continue;
        }
        if let Some(ids) = &provider_ids {
            if !ids.contains(&id) {
                continue;
            }
        }
        let model = resolve_configured_model(&app_type, &provider).unwrap_or_default();
        let base_url_override = crate::commands::stream_check::resolve_copilot_base_url_override(
            &provider,
            &copilot_state,
        )
        .await?;
        targets.push((id, provider, model, base_url_override));
    }

    // `sanitized()` 已把并发数收敛到 1..=16；0 会让 buffer_unordered 永久挂住。
    let concurrency = config.max_concurrency;
    let results = stream::iter(targets.into_iter().map(
        |(id, provider, model, base_url_override)| {
            let app_type = app_type.clone();
            let config = config.clone();
            async move {
                let result = ModelProbeService::probe(
                    &app_type,
                    &provider,
                    &model,
                    &config,
                    base_url_override,
                )
                .await;
                (id, result)
            }
        },
    ))
    .buffer_unordered(concurrency)
    .collect::<Vec<_>>()
    .await;

    Ok(results)
}

/// 拉取指定供应商的可用模型列表。
///
/// 与表单里的 `fetch_models_for_config` 的区别：那个从表单草稿取 baseUrl/apiKey，
/// 这个从**已保存的**供应商配置里取，供列表页的「获取模型」按钮使用。
///
/// `models_url` 可选覆写：预设里的精确 `/models` 端点只存在于前端配置
/// （`config/claudeProviderPresets.ts`），后端 `ProviderMeta` 里没有该字段，
/// 故由前端在需要时传入。
#[tauri::command(rename_all = "camelCase")]
pub async fn fetch_models_for_provider(
    state: State<'_, AppState>,
    app_type: AppType,
    provider_id: String,
    models_url: Option<String>,
) -> Result<Vec<FetchedModel>, String> {
    let providers = state
        .db
        .get_all_providers(app_type.as_str())
        .map_err(|e| e.to_string())?;
    let provider = providers
        .get(&provider_id)
        .ok_or_else(|| format!("供应商 {provider_id} 不存在"))?;

    let base_url =
        crate::services::stream_check::StreamCheckService::resolve_base_url(&app_type, provider)
            .map_err(|e| e.to_string())?;
    let api_key =
        extract_api_key(&app_type, provider).ok_or_else(|| "该供应商未配置 API Key".to_string())?;

    let meta = provider.meta.as_ref();
    let is_full_url = meta.and_then(|m| m.is_full_url).unwrap_or(false);
    let user_agent = meta.and_then(|m| m.custom_user_agent_header().ok().flatten());
    let prefer_anthropic = ApiFormat::resolve(&app_type, provider) == ApiFormat::Anthropic;

    crate::services::model_fetch::fetch_models(
        &base_url,
        &api_key,
        is_full_url,
        models_url
            .as_deref()
            .map(str::trim)
            .filter(|s| !s.is_empty()),
        user_agent,
        prefer_anthropic,
    )
    .await
}

/// 批量获取单个供应商的结果。显式结构比直接序列化 Rust `Result` 更稳定，
/// 避免前端依赖 `{ Ok: ... } / { Err: ... }` 这样的实现细节。
#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct BatchFetchModelsResult {
    pub provider_id: String,
    pub success: bool,
    pub models: Vec<FetchedModel>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub error: Option<String>,
}

/// 批量拉取多个供应商的模型列表（有界并发）。
///
/// `provider_ids` 省略时拉取该应用下全部（跳过官方账号类，与批量探测同一取舍）。
#[tauri::command(rename_all = "camelCase")]
pub async fn batch_fetch_provider_models(
    state: State<'_, AppState>,
    app_type: AppType,
    provider_ids: Option<Vec<String>>,
) -> Result<Vec<BatchFetchModelsResult>, AppError> {
    let all_providers = state.db.get_all_providers(app_type.as_str())?;
    let concurrency = state
        .db
        .get_model_probe_config()?
        .sanitized()
        .max_concurrency;

    // 筛选候选：与批量探测一致，排除官方账号类；显式传入 IDs 时也保持
    // 同一安全边界，避免把官方 OAuth 账户误当成普通 API Key 供应商。
    let candidates: Vec<_> = match provider_ids {
        Some(ids) => ids
            .into_iter()
            .filter_map(|id| {
                all_providers.get(&id).and_then(|provider| {
                    (provider.category.as_deref() != Some("official"))
                        .then(|| (id, provider.clone()))
                })
            })
            .collect(),
        None => all_providers
            .iter()
            .filter(|(_, provider)| provider.category.as_deref() != Some("official"))
            .map(|(id, provider)| (id.clone(), provider.clone()))
            .collect(),
    };

    let tasks = stream::iter(candidates.into_iter().map(|(provider_id, provider)| {
        let app_type = app_type.clone();
        async move {
            let result = async {
                let base_url = crate::services::stream_check::StreamCheckService::resolve_base_url(
                    &app_type, &provider,
                )
                .map_err(|e| e.to_string())?;
                let api_key = extract_api_key(&app_type, &provider)
                    .ok_or_else(|| "该供应商未配置 API Key".to_string())?;

                let meta = provider.meta.as_ref();
                let is_full_url = meta.and_then(|m| m.is_full_url).unwrap_or(false);
                let user_agent = meta.and_then(|m| m.custom_user_agent_header().ok().flatten());
                let prefer_anthropic =
                    ApiFormat::resolve(&app_type, &provider) == ApiFormat::Anthropic;

                crate::services::model_fetch::fetch_models(
                    &base_url,
                    &api_key,
                    is_full_url,
                    None,
                    user_agent,
                    prefer_anthropic,
                )
                .await
            }
            .await;

            match result {
                Ok(models) => BatchFetchModelsResult {
                    provider_id,
                    success: true,
                    models,
                    error: None,
                },
                Err(error) => BatchFetchModelsResult {
                    provider_id,
                    success: false,
                    models: Vec::new(),
                    error: Some(error),
                },
            }
        }
    }))
    .buffer_unordered(concurrency)
    .collect::<Vec<_>>()
    .await;

    Ok(tasks)
}

/// 获取模型探测配置
#[tauri::command]
pub fn get_model_probe_config(state: State<'_, AppState>) -> Result<ModelProbeConfig, AppError> {
    state.db.get_model_probe_config()
}

/// 保存模型探测配置
#[tauri::command]
pub fn save_model_probe_config(
    state: State<'_, AppState>,
    config: ModelProbeConfig,
) -> Result<(), AppError> {
    state.db.set_model_probe_config(&config)
}

/// 读取供应商当前配置的默认（兜底）模型。
///
/// 各应用的 `settings_config` 结构不同，与前端 `utils/providerModel.ts` 保持同一口径：
/// - Claude / Claude Desktop：`env.ANTHROPIC_MODEL`
/// - Gemini：`env.GEMINI_MODEL`
/// - Codex / GrokBuild：TOML 顶层 `model`
/// - OpenClaw / Hermes / OpenCode：各自的 model 约定
fn resolve_configured_model(app_type: &AppType, provider: &Provider) -> Option<String> {
    let config = &provider.settings_config;
    let value = match app_type {
        AppType::Claude | AppType::ClaudeDesktop => config
            .pointer("/env/ANTHROPIC_MODEL")
            .and_then(|v| v.as_str())
            .map(strip_one_m_marker),
        AppType::Gemini => config
            .pointer("/env/GEMINI_MODEL")
            .and_then(|v| v.as_str())
            .map(str::to_string),
        AppType::Codex | AppType::GrokBuild => config
            .get("config")
            .and_then(|v| v.as_str())
            .and_then(extract_toml_top_level_model),
        AppType::Hermes => config
            .pointer("/model/default")
            .and_then(|v| v.as_str())
            .map(str::to_string),
        AppType::OpenClaw => config
            .pointer("/models/0/id")
            .and_then(|v| v.as_str())
            .map(str::to_string),
        AppType::OpenCode => config
            .get("models")
            .and_then(|v| v.as_object())
            .and_then(|m| m.keys().next().cloned()),
    };
    value
        .map(|v| v.trim().to_string())
        .filter(|v| !v.is_empty())
}

/// Claude 模型值可能带 `[1M]` 长上下文标记，探测时要用裸模型 ID。
fn strip_one_m_marker(model: &str) -> String {
    model.trim().trim_end_matches("[1M]").trim().to_string()
}

/// 从 Codex TOML 里取顶层 `model`（不进 section 内部）。
///
/// 与前端 `extractCodexModelName` 同口径：只认第一个 section 之前的顶层键。
fn extract_toml_top_level_model(toml: &str) -> Option<String> {
    for line in toml.lines() {
        let trimmed = line.trim();
        // 进入 section 后的 model 属于该 section，不是顶层默认模型。
        if trimmed.starts_with('[') {
            break;
        }
        let Some(rest) = trimmed.strip_prefix("model") else {
            continue;
        };
        let rest = rest.trim_start();
        let Some(value) = rest.strip_prefix('=') else {
            continue;
        };
        let value = value.trim().trim_matches('"').trim_matches('\'');
        if !value.is_empty() {
            return Some(value.to_string());
        }
    }
    None
}

/// 按应用类型提取 API Key。与 adapter 的 `extract_auth` 相比，这里要的是裸 key
/// 而不是构造好的请求头（`/models` 端点的鉴权口径由 `fetch_models` 决定）。
fn extract_api_key(app_type: &AppType, provider: &Provider) -> Option<String> {
    let config = &provider.settings_config;
    let value = match app_type {
        AppType::Claude | AppType::ClaudeDesktop => config
            .pointer("/env/ANTHROPIC_AUTH_TOKEN")
            .or_else(|| config.pointer("/env/ANTHROPIC_API_KEY"))
            .and_then(|v| v.as_str()),
        AppType::Gemini => config
            .pointer("/env/GEMINI_API_KEY")
            .or_else(|| config.pointer("/env/GOOGLE_API_KEY"))
            .and_then(|v| v.as_str()),
        AppType::Codex | AppType::GrokBuild => config
            .pointer("/auth/OPENAI_API_KEY")
            .and_then(|v| v.as_str()),
        AppType::OpenClaw | AppType::Hermes => config.get("apiKey").and_then(|v| v.as_str()),
        AppType::OpenCode => config.pointer("/options/apiKey").and_then(|v| v.as_str()),
    };
    value
        .map(|s| s.trim().to_string())
        .filter(|s| !s.is_empty())
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::provider::ProviderMeta;
    use serde_json::json;

    fn provider_with(config: serde_json::Value) -> Provider {
        Provider {
            id: "p".to_string(),
            name: "test".to_string(),
            settings_config: config,
            website_url: None,
            category: None,
            created_at: None,
            sort_index: None,
            notes: None,
            meta: None,
            icon: None,
            icon_color: None,
            in_failover_queue: false,
        }
    }

    #[test]
    fn reads_claude_model_from_env() {
        let p = provider_with(json!({ "env": { "ANTHROPIC_MODEL": "claude-opus-5" } }));
        assert_eq!(
            resolve_configured_model(&AppType::Claude, &p).as_deref(),
            Some("claude-opus-5")
        );
        assert_eq!(
            resolve_configured_model(&AppType::ClaudeDesktop, &p).as_deref(),
            Some("claude-opus-5")
        );
    }

    #[test]
    fn strips_one_m_marker_from_claude_model() {
        // `[1M]` 是 cc-switch 的长上下文标记，不是模型 ID 的一部分。
        let p = provider_with(json!({ "env": { "ANTHROPIC_MODEL": "claude-sonnet-5[1M]" } }));
        assert_eq!(
            resolve_configured_model(&AppType::Claude, &p).as_deref(),
            Some("claude-sonnet-5")
        );
    }

    #[test]
    fn reads_gemini_model_from_env() {
        let p = provider_with(json!({ "env": { "GEMINI_MODEL": "gemini-3.6-flash" } }));
        assert_eq!(
            resolve_configured_model(&AppType::Gemini, &p).as_deref(),
            Some("gemini-3.6-flash")
        );
    }

    #[test]
    fn reads_codex_model_from_toml_top_level() {
        let p = provider_with(json!({
            "auth": { "OPENAI_API_KEY": "sk-x" },
            "config": "model = \"gpt-5.5\"\nmodel_provider = \"custom\"\n\n[model_providers.custom]\nmodel = \"ignored\"\n"
        }));
        assert_eq!(
            resolve_configured_model(&AppType::Codex, &p).as_deref(),
            Some("gpt-5.5")
        );
    }

    #[test]
    fn ignores_codex_model_inside_sections() {
        // section 里的 model 不是顶层默认模型，不能误取。
        let p = provider_with(json!({
            "config": "model_provider = \"custom\"\n\n[model_providers.custom]\nmodel = \"inner\"\n"
        }));
        assert!(resolve_configured_model(&AppType::Codex, &p).is_none());
    }

    #[test]
    fn missing_or_blank_model_resolves_to_none() {
        let p = provider_with(json!({ "env": {} }));
        assert!(resolve_configured_model(&AppType::Claude, &p).is_none());

        let p = provider_with(json!({ "env": { "ANTHROPIC_MODEL": "   " } }));
        assert!(resolve_configured_model(&AppType::Claude, &p).is_none());
    }

    #[test]
    fn extracts_api_key_per_app() {
        let p = provider_with(json!({ "env": { "ANTHROPIC_AUTH_TOKEN": "sk-a" } }));
        assert_eq!(
            extract_api_key(&AppType::Claude, &p).as_deref(),
            Some("sk-a")
        );

        // 只有 ANTHROPIC_API_KEY 时也要能取到。
        let p = provider_with(json!({ "env": { "ANTHROPIC_API_KEY": "sk-b" } }));
        assert_eq!(
            extract_api_key(&AppType::Claude, &p).as_deref(),
            Some("sk-b")
        );

        let p = provider_with(json!({ "auth": { "OPENAI_API_KEY": "sk-c" } }));
        assert_eq!(
            extract_api_key(&AppType::Codex, &p).as_deref(),
            Some("sk-c")
        );

        let p = provider_with(json!({ "apiKey": "sk-d" }));
        assert_eq!(
            extract_api_key(&AppType::OpenClaw, &p).as_deref(),
            Some("sk-d")
        );
    }

    #[test]
    fn blank_api_key_treated_as_missing() {
        let p = provider_with(json!({ "env": { "ANTHROPIC_AUTH_TOKEN": "  " } }));
        assert!(extract_api_key(&AppType::Claude, &p).is_none());
    }

    #[test]
    fn api_format_resolves_from_provider_meta() {
        let mut p = provider_with(json!({}));
        // 无 meta 时按 app 默认。
        assert_eq!(
            ApiFormat::resolve(&AppType::Claude, &p),
            ApiFormat::Anthropic
        );
        // meta 显式指定时覆盖 app 默认——中转站常把 OpenAI 格式挂在 claude 应用下。
        p.meta = Some(ProviderMeta {
            api_format: Some("openai_chat".to_string()),
            ..Default::default()
        });
        assert_eq!(
            ApiFormat::resolve(&AppType::Claude, &p),
            ApiFormat::OpenAiChat
        );
    }

    #[test]
    fn toml_model_parser_handles_quoting_and_spacing() {
        assert_eq!(
            extract_toml_top_level_model("model=\"a\"").as_deref(),
            Some("a")
        );
        assert_eq!(
            extract_toml_top_level_model("model   =   'b'").as_deref(),
            Some("b")
        );
        // `model_provider` 不是 `model`，不能被前缀匹配误认。
        assert!(extract_toml_top_level_model("model_provider = \"x\"").is_none());
    }
}
