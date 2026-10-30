pub mod error;
pub mod files;
pub mod forwarding;
pub mod http;
pub mod path_memory;
pub mod proxy;
pub mod runtime;
pub mod ssh;
pub mod storage;
pub mod transfers;

pub type Events = std::sync::Arc<dyn Fn(serde_json::Value) + Send + Sync>;
