//! REST と WebSocket で共通のエラー型。

use axum::Json;
use axum::http::StatusCode;
use axum::response::{IntoResponse, Response};
use disnans_shared::ApiError;

#[derive(Debug)]
pub struct AppError {
    pub status: StatusCode,
    /// 機械向けの短いコード（例: `not_found`）。
    pub code: &'static str,
    /// 人間向けの説明。
    pub message: String,
}

pub type AppResult<T> = Result<T, AppError>;

impl AppError {
    pub fn new(status: StatusCode, code: &'static str, message: impl Into<String>) -> Self {
        Self {
            status,
            code,
            message: message.into(),
        }
    }

    pub fn bad_request(code: &'static str, message: impl Into<String>) -> Self {
        Self::new(StatusCode::BAD_REQUEST, code, message)
    }

    pub fn not_found(message: impl Into<String>) -> Self {
        Self::new(StatusCode::NOT_FOUND, "not_found", message)
    }

    pub fn forbidden(message: impl Into<String>) -> Self {
        Self::new(StatusCode::FORBIDDEN, "forbidden", message)
    }

    pub fn unauthorized(message: impl Into<String>) -> Self {
        Self::new(StatusCode::UNAUTHORIZED, "unauthorized", message)
    }

    /// 内部エラー。詳細はログにだけ出し、クライアントには伝えない。
    pub fn internal(err: impl std::fmt::Display) -> Self {
        tracing::error!("内部エラー: {err}");
        Self::new(
            StatusCode::INTERNAL_SERVER_ERROR,
            "internal",
            "サーバー内部でエラーが発生しました",
        )
    }

    pub fn to_api_error(&self) -> ApiError {
        ApiError {
            code: self.code.to_string(),
            message: self.message.clone(),
        }
    }
}

impl From<sqlx::Error> for AppError {
    fn from(err: sqlx::Error) -> Self {
        Self::internal(err)
    }
}

impl From<std::io::Error> for AppError {
    fn from(err: std::io::Error) -> Self {
        Self::internal(err)
    }
}

impl IntoResponse for AppError {
    fn into_response(self) -> Response {
        (self.status, Json(self.to_api_error())).into_response()
    }
}
