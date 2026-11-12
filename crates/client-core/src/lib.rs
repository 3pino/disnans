//! Rust client-side building blocks shared by the GUI, CLI, and TUI.
//!
//! Storage methods perform synchronous filesystem I/O; async callers should run them in a
//! blocking context. The WebSocket client (`ChatConnection`, `ChatWatch`, `ChatSession`) is always
//! compiled; the Tauri app (Windows, Linux, Android), the CLI and the TUI use it.

pub mod dev_plugins;
mod platform;
mod rest;
mod rest_api;
mod storage;
mod url;
pub mod view;
mod ws;

pub use disnans_shared::ClientEvent;
pub use platform::{
    Capabilities, PlatformInfo, Surface, capabilities_for, host_os, info_for, terminal_info,
};
pub use rest::{ClientError, MessagesQuery, RestClient};
pub use rest_api::{
    MessageSearchQuery, ReadFailure, SharedDownload, UploadAbortHandle, UploadAbortRegistration,
    encode_path_segment, messages_path, search_path, session_path, shared_path,
};
pub use storage::{DraftKey, DraftPlace, LocalStore, StoreError, StoredValue, is_valid_device_id};
pub use url::{ServerUrl, UrlError, normalize_server_url};
pub use ws::{
    ChatConnection, ChatSession, ChatWatch, ConnectOptions, Disconnected, EmitError, Message,
    ReactOutcome, SendOutcome, SendRequest, ServerEvent, SessionSender, UnknownReason, User,
    WatchItem, WsError, new_client_id,
};
