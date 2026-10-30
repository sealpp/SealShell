use serde::Serialize;

#[derive(Debug, Clone, Serialize, thiserror::Error)]
#[error("{message}")]
#[serde(rename_all = "camelCase")]
pub struct Error {
    pub code: String,
    pub message: String,
}

impl Error {
    pub fn new(code: impl Into<String>, message: impl Into<String>) -> Self {
        Self {
            code: code.into(),
            message: message.into(),
        }
    }
    pub fn cancelled() -> Self {
        Self::new("cancelled", "操作已取消")
    }
}

impl From<std::io::Error> for Error {
    fn from(value: std::io::Error) -> Self {
        let code = match value.kind() {
            std::io::ErrorKind::NotFound => "not_found",
            std::io::ErrorKind::PermissionDenied => "permission_denied",
            std::io::ErrorKind::AlreadyExists => "already_exists",
            _ => "io_error",
        };
        Self::new(code, value.to_string())
    }
}

impl From<rusqlite::Error> for Error {
    fn from(value: rusqlite::Error) -> Self {
        Self::new("storage_error", value.to_string())
    }
}

impl From<serde_json::Error> for Error {
    fn from(value: serde_json::Error) -> Self {
        Self::new("invalid_data", value.to_string())
    }
}

pub type Result<T> = std::result::Result<T, Error>;

impl From<russh::Error> for Error {
    fn from(value: russh::Error) -> Self {
        Self::new("SSH_ERROR", value.to_string())
    }
}
