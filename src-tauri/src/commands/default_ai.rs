//! 默认 AI 命令
//!
//! 「默认 AI」驱动内置的聊天助手，凭据独立于供应商列表存储。
//!
//! 安全边界：本组命令**不代为执行**助手请求的任何工具。`chat_default_ai` 只把
//! 模型想调用的工具原样回传给前端；新增 / 修改由前端走既有命令直接执行，删除则
//! 必须经用户确认后再走 `delete_provider`。后端绝不因为模型「说要删」就去删。

use serde::Serialize;
use serde_json::Value;
use tauri::{ipc::Channel, State};

use crate::error::AppError;
use crate::services::default_ai::{ChatReply, DefaultAiConfig, DefaultAiService};
use crate::services::model_fetch::FetchedModel;
use crate::services::model_probe::ModelProbeResult;
use crate::store::AppState;

/// 通过 Tauri Channel 推送给前端的流式事件。
///
/// 只传文本增量；完整 `ChatReply`（含 tool calls）由 `invoke` 的返回值承载，
/// 前端在 Promise 完成后才执行工具，避免接收到尚未闭合的参数。
#[derive(Debug, Serialize, Clone)]
#[serde(tag = "type", rename_all = "camelCase")]
pub enum ChatStreamEvent {
    TextDelta { delta: String },
}

/// 读取默认 AI 配置。未配置时返回空结构（前端据此显示引导）。
#[tauri::command]
pub fn get_default_ai_config(state: State<'_, AppState>) -> Result<DefaultAiConfig, AppError> {
    state.db.get_default_ai_config()
}

/// 保存默认 AI 配置。
#[tauri::command]
pub fn save_default_ai_config(
    state: State<'_, AppState>,
    config: DefaultAiConfig,
) -> Result<(), AppError> {
    state.db.set_default_ai_config(&config)
}

/// 测试默认 AI 是否可用：发一次真实流式请求，回传首字 / 总耗时。
///
/// `config` 可选：传入时测的是**未保存的草稿**（设置页的「测试」按钮），
/// 不传则测已保存的配置。
#[tauri::command(rename_all = "camelCase")]
pub async fn test_default_ai(
    state: State<'_, AppState>,
    config: Option<DefaultAiConfig>,
) -> Result<ModelProbeResult, AppError> {
    let config = match config {
        Some(c) => c,
        None => state.db.get_default_ai_config()?,
    };
    Ok(DefaultAiService::test(&config).await)
}

/// 拉取默认 AI 可用的模型列表。
#[tauri::command(rename_all = "camelCase")]
pub async fn fetch_default_ai_models(
    state: State<'_, AppState>,
    config: Option<DefaultAiConfig>,
) -> Result<Vec<FetchedModel>, String> {
    let config = match config {
        Some(c) => c,
        None => state
            .db
            .get_default_ai_config()
            .map_err(|e| e.to_string())?,
    };
    DefaultAiService::fetch_models(&config).await
}

/// 发一轮带工具的流式对话。
///
/// 文本增量通过 `on_event` Channel 实时推送到前端；完整回复（含 tool calls）
/// 在流结束后由 invoke Promise 一次性返回。工具由前端执行——见顶部安全边界说明。
#[tauri::command(rename_all = "camelCase")]
pub async fn chat_default_ai(
    state: State<'_, AppState>,
    messages: Vec<Value>,
    tools: Option<Vec<Value>>,
    on_event: Channel<ChatStreamEvent>,
) -> Result<ChatReply, AppError> {
    let config = state.db.get_default_ai_config()?;
    DefaultAiService::chat(&config, messages, tools.unwrap_or_default(), |delta| {
        on_event
            .send(ChatStreamEvent::TextDelta { delta })
            .map_err(|e| AppError::Message(e.to_string()))
    })
    .await
}
