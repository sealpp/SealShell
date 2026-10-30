pub mod error;
pub mod proxy;
pub mod ssh;
pub mod storage;

pub type Events = std::sync::Arc<dyn Fn(serde_json::Value) + Send + Sync>;
