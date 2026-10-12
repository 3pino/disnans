# disnans-client-core

Shared Rust client-side primitives for the GUI, CLI, and TUI. The initial API provides normalized server URLs, REST reads (`me`, `users`, and message history), and shared local config/draft storage. WebSocket transport, reconnect policy, and send-result correlation are deliberately not implemented in this crate yet.

## Storage contract

`LocalStore` methods do synchronous filesystem I/O; async callers must use a blocking context. Config and drafts live separately under platform user directories. Draft keys include normalized server URL, user ID, and main/thread place. Writes are serialized across processes with OS file locks and committed through a same-directory temporary file plus atomic replacement. Missing values and explicit clears are distinct (`StoredValue::Missing` vs `StoredValue::Cleared`); clears are persisted as tombstones so legacy values cannot reappear. `import_*_if_missing` methods import legacy data only when no shared value (including a tombstone) exists. Corrupt or unknown-schema data returns an error and is not overwritten.

Linux uses XDG config/data roots (falling back to `~/.config` and `~/.local/share` if unset or non-absolute); Windows uses APPDATA/LOCALAPPDATA. Absolute `DISNANS_CLIENT_CONFIG_DIR` and `DISNANS_CLIENT_DATA_DIR` overrides support isolated tests; a present relative/empty override is an error. Newly created Unix directories/files are restricted to user-only permissions without changing permissions on existing directories. Windows relies on the user-profile directory ACL. Storage operations can fail and callers must preserve old values until a new write has succeeded.
