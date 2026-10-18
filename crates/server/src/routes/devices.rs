//! `/api/me/devices`（自分のデバイスの一覧・登録・設定）。デバイス ID はクライアントが決める（認証ではない）。

use axum::Json;
use axum::extract::{Path, State};
use axum::http::StatusCode;
use disnans_shared::{DeviceInfo, DevicePrefs, PutDevice, PutDevicePrefs};

use crate::auth::CurrentUser;
use crate::db;
use crate::error::{AppError, AppResult};
use crate::routes::users::MAX_PREFS_BYTES;
use crate::state::SharedState;
use crate::store::devices::{self, DeviceRow};

/// デバイス 1 人あたりの上限（ユーザーごと）。
const MAX_DEVICES: i64 = 50;
/// デバイス名の最大文字数。
const MAX_DEVICE_NAME_CHARS: usize = 64;

/// デバイス ID の形（1〜64 文字、英数字とハイフン）。
fn check_device_id(id: &str) -> AppResult<()> {
    let ok = !id.is_empty()
        && id.len() <= 64
        && id.bytes().all(|b| b.is_ascii_alphanumeric() || b == b'-');
    if ok {
        Ok(())
    } else {
        Err(AppError::bad_request(
            "invalid_device_id",
            "デバイス ID が不正です",
        ))
    }
}

fn info(row: DeviceRow) -> DeviceInfo {
    DeviceInfo {
        device_id: row.device_id,
        name: row.name,
        created_at: row.created_at,
        last_seen_at: row.last_seen_at,
        has_prefs: row.has_prefs,
    }
}

/// 自分のデバイスの一覧（新しい順）。
pub async fn list(
    State(state): State<SharedState>,
    CurrentUser(user): CurrentUser,
) -> AppResult<Json<Vec<DeviceInfo>>> {
    let rows = devices::list(&state.pool, &user.id).await?;
    Ok(Json(rows.into_iter().map(info).collect()))
}

/// デバイスを登録する（初回）、または名前を変える。上限を超える新規は `409 too_many_devices`。
pub async fn put(
    State(state): State<SharedState>,
    CurrentUser(user): CurrentUser,
    Path(device_id): Path<String>,
    Json(req): Json<PutDevice>,
) -> AppResult<Json<DeviceInfo>> {
    check_device_id(&device_id)?;
    let name = req.name.trim();
    if name.is_empty() {
        return Err(AppError::bad_request(
            "invalid_device_name",
            "デバイス名を入力してください",
        ));
    }
    if name.chars().count() > MAX_DEVICE_NAME_CHARS {
        return Err(AppError::bad_request(
            "device_name_too_long",
            format!("デバイス名は {MAX_DEVICE_NAME_CHARS} 文字までです"),
        ));
    }

    let _guard = state.write_lock().await;
    let existing = devices::get(&state.pool, &user.id, &device_id).await?;
    if existing.is_none() && devices::count(&state.pool, &user.id).await? >= MAX_DEVICES {
        return Err(AppError::new(
            StatusCode::CONFLICT,
            "too_many_devices",
            format!("デバイスは {MAX_DEVICES} 台までです。使わないデバイスを削除してください"),
        ));
    }
    let mut conn = state.pool.acquire().await.map_err(AppError::internal)?;
    devices::upsert(&mut conn, &user.id, &device_id, name, db::now_ms()).await?;
    drop(conn);
    let row = devices::get(&state.pool, &user.id, &device_id)
        .await?
        .ok_or_else(|| AppError::internal("デバイスが保存されませんでした"))?;
    Ok(Json(info(row)))
}

/// デバイスとその設定を消す。
pub async fn delete(
    State(state): State<SharedState>,
    CurrentUser(user): CurrentUser,
    Path(device_id): Path<String>,
) -> AppResult<StatusCode> {
    check_device_id(&device_id)?;
    let _guard = state.write_lock().await;
    if devices::delete(&state.pool, &user.id, &device_id).await? {
        Ok(StatusCode::NO_CONTENT)
    } else {
        Err(AppError::not_found("デバイスが見つかりません"))
    }
}

/// このデバイスの設定。デバイスがなければ、設定がなければ `404 not_found`。
pub async fn get_prefs(
    State(state): State<SharedState>,
    CurrentUser(user): CurrentUser,
    Path(device_id): Path<String>,
) -> AppResult<Json<DevicePrefs>> {
    check_device_id(&device_id)?;
    if devices::get(&state.pool, &user.id, &device_id)
        .await?
        .is_none()
    {
        return Err(AppError::not_found("デバイスが見つかりません"));
    }
    let (saved, updated_at) = devices::prefs_get(&state.pool, &user.id, &device_id)
        .await?
        .ok_or_else(|| AppError::not_found("設定がありません"))?;
    devices::touch(&state.pool, &user.id, &device_id, db::now_ms()).await?;
    // 壊れたものが入っていても、空として扱う（次の保存で直る）
    let prefs = serde_json::from_str::<serde_json::Value>(&saved)
        .ok()
        .filter(serde_json::Value::is_object)
        .unwrap_or_else(|| serde_json::json!({}));
    Ok(Json(DevicePrefs { prefs, updated_at }))
}

/// このデバイスの設定をまるごと置き換える。デバイスが登録されていなければ `404`。
pub async fn put_prefs(
    State(state): State<SharedState>,
    CurrentUser(user): CurrentUser,
    Path(device_id): Path<String>,
    Json(req): Json<PutDevicePrefs>,
) -> AppResult<Json<DevicePrefs>> {
    check_device_id(&device_id)?;
    if !req.prefs.is_object() {
        return Err(AppError::bad_request(
            "invalid_prefs",
            "設定は JSON のオブジェクトにしてください",
        ));
    }
    let json = serde_json::to_string(&req.prefs).map_err(AppError::internal)?;
    if json.len() > MAX_PREFS_BYTES {
        return Err(AppError::new(
            StatusCode::PAYLOAD_TOO_LARGE,
            "prefs_too_large",
            format!("設定は {} KB までです", MAX_PREFS_BYTES / 1024),
        ));
    }

    let _guard = state.write_lock().await;
    let now = db::now_ms();
    if !devices::prefs_set(&state.pool, &user.id, &device_id, &json, now).await? {
        return Err(AppError::not_found("デバイスが見つかりません"));
    }
    devices::touch(&state.pool, &user.id, &device_id, now).await?;
    Ok(Json(DevicePrefs {
        prefs: req.prefs,
        updated_at: now,
    }))
}
