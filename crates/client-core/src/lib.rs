//! Rust client-side building blocks shared by the GUI, CLI, and TUI.
//!
//! Storage methods perform synchronous filesystem I/O; async callers should run them in a
//! blocking context. WebSocket/reconnect behavior is intentionally not implemented yet.

mod rest;
mod storage;
mod url;

pub use rest::{ClientError, MessagesQuery, RestClient};
pub use storage::{DraftKey, DraftPlace, LocalStore, StoreError, StoredValue};
pub use url::{ServerUrl, UrlError, normalize_server_url};
