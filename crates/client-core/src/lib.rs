//! Rust client-side building blocks shared by the GUI, CLI, and TUI.
//!
//! Storage methods perform synchronous filesystem I/O; async callers should run them in a
//! blocking context. The WebSocket client (`ChatConnection`, `ChatWatch`) is behind the `ws`
//! feature; the desktop GUI does not enable it yet.

mod rest;
mod storage;
mod url;
#[cfg(feature = "ws")]
mod ws;

pub use rest::{ClientError, MessagesQuery, RestClient};
pub use storage::{DraftKey, DraftPlace, LocalStore, StoreError, StoredValue};
pub use url::{ServerUrl, UrlError, normalize_server_url};
#[cfg(feature = "ws")]
pub use ws::{
    ChatConnection, ChatWatch, ConnectOptions, Disconnected, Message, SendOutcome, ServerEvent,
    UnknownReason, User, WatchItem, WsError, new_client_id,
};
