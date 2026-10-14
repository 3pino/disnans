//! Rust client-side building blocks shared by the GUI, CLI, and TUI.
//!
//! Storage methods perform synchronous filesystem I/O; async callers should run them in a
//! blocking context. The WebSocket client (`ChatConnection`, `ChatWatch`, `ChatSession`) is behind the `ws`
//! feature; the desktop GUI does not enable it yet.

mod rest;
mod rest_api;
mod storage;
mod url;
#[cfg(feature = "ws")]
mod ws;

#[cfg(feature = "ws")]
pub use disnans_shared::ClientEvent;
pub use rest::{ClientError, MessagesQuery, RestClient};
pub use rest_api::{
    MessageSearchQuery, ReadFailure, UploadAbortHandle, UploadAbortRegistration, messages_path,
    search_path, session_path, thread_path,
};
pub use storage::{DraftKey, DraftPlace, LocalStore, StoreError, StoredValue};
pub use url::{ServerUrl, UrlError, normalize_server_url};
#[cfg(feature = "ws")]
pub use ws::{
    ChatConnection, ChatSession, ChatWatch, ConnectOptions, Disconnected, EmitError, Message,
    SendOutcome, SendRequest, ServerEvent, SessionSender, UnknownReason, User, WatchItem, WsError,
    new_client_id,
};
