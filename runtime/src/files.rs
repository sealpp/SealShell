use crate::{
    Events,
    error::{Error, Result},
    ssh::{Connection, SshService},
};
use russh_sftp::{
    client::SftpSession,
    protocol::{FileAttributes, OpenFlags, StatusCode},
};
use serde::{Deserialize, Serialize};
use std::{
    collections::HashMap,
    path::{Path, PathBuf},
    sync::{Arc, Mutex},
    time::UNIX_EPOCH,
};
use tokio::{
    fs,
    io::{AsyncReadExt, AsyncSeekExt, AsyncWriteExt},
};
use tokio_util::sync::CancellationToken;

pub const CHUNK: usize = 256 * 1024;

#[derive(Clone, Deserialize)]
#[serde(tag = "kind", rename_all = "lowercase")]
pub enum Endpoint {
    Local,
    Sftp { connection: Connection },
}

#[derive(Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Entry {
    pub name: String,
    pub path: String,
    pub kind: String,
    pub size: u64,
    pub modified_at: u64,
    pub mode: Option<u32>,
    pub hidden: bool,
}

enum Provider {
    Local,
    Sftp(SftpSession),
}

pub struct Backend {
    pub id: String,
    pub endpoint: Endpoint,
    pub cancel: CancellationToken,
    provider: Provider,
    handles: Mutex<HashMap<String, Arc<tokio::sync::Mutex<File>>>>,
}

pub enum File {
    Local(fs::File, bool),
    Sftp(russh_sftp::client::fs::File),
}

impl File {
    pub async fn read(&mut self, offset: u64, length: usize) -> Result<Vec<u8>> {
        let mut buffer = vec![0; length.min(CHUNK)];
        let count = match self {
            Self::Local(file, _) => {
                file.seek(std::io::SeekFrom::Start(offset)).await?;
                file.read(&mut buffer).await?
            }
            Self::Sftp(file) => {
                file.seek(std::io::SeekFrom::Start(offset)).await?;
                file.read(&mut buffer).await?
            }
        };
        buffer.truncate(count);
        Ok(buffer)
    }
    pub async fn write(&mut self, offset: u64, bytes: &[u8]) -> Result<()> {
        match self {
            Self::Local(file, _) => {
                file.seek(std::io::SeekFrom::Start(offset)).await?;
                file.write_all(bytes).await?;
            }
            Self::Sftp(file) => {
                file.seek(std::io::SeekFrom::Start(offset)).await?;
                file.write_all(bytes).await?;
            }
        }
        Ok(())
    }
    pub async fn close(&mut self) -> Result<()> {
        match self {
            Self::Local(file, write) => {
                if *write {
                    file.flush().await?;
                    file.sync_all().await?;
                }
            }
            Self::Sftp(file) => file.shutdown().await?,
        }
        Ok(())
    }
}

impl Backend {
    pub fn local(&self) -> bool {
        matches!(self.provider, Provider::Local)
    }
    pub fn namespace(&self) -> String {
        match &self.endpoint {
            Endpoint::Local => "local".into(),
            Endpoint::Sftp { connection: c } => format!(
                "sftp:{}:{}:{}:{}",
                c.host,
                c.port,
                c.username,
                c.proxy
                    .as_ref()
                    .map(|p| format!("{}:{}:{}:{}", p.kind, p.host, p.port, p.username))
                    .unwrap_or_default()
            ),
        }
    }
    pub fn join(&self, parent: &str, name: &str) -> Result<String> {
        if name.is_empty()
            || matches!(name, "." | "..")
            || name.contains(['/', '\0'])
            || (self.local() && name.contains(['\\', ':']))
        {
            return Err(Error::new("invalid_path", "文件名无效"));
        }
        Ok(if self.local() {
            Path::new(parent).join(name).to_string_lossy().into_owned()
        } else {
            format!("{}/{}", parent.trim_end_matches('/'), name)
        })
    }
    pub fn temporary(&self, path: &str, suffix: &str) -> Result<String> {
        let parent = if self.local() {
            Path::new(path)
                .parent()
                .map(|p| p.to_string_lossy().into_owned())
                .ok_or_else(|| Error::new("invalid_path", "无法替换根目录"))?
        } else {
            path.rsplit_once('/')
                .map(|(parent, _)| if parent.is_empty() { "/" } else { parent }.to_owned())
                .ok_or_else(|| Error::new("invalid_path", "需要绝对路径"))?
        };
        self.join(
            &parent,
            &format!(".sealshell-{}.{}", uuid::Uuid::new_v4(), suffix),
        )
    }
    pub fn path_key(&self, path: &str) -> String {
        let value = if self.local() {
            path.replace('\\', "/").to_lowercase()
        } else {
            path.into()
        };
        let mut parts = Vec::new();
        for part in value.split('/') {
            match part {
                "." => {}
                ".." => {
                    parts.pop();
                }
                _ => parts.push(part),
            }
        }
        parts.join("/").trim_end_matches('/').into()
    }
    pub async fn stat(&self, path: &str, follow: bool) -> Result<Entry> {
        match &self.provider {
            Provider::Local => {
                let meta = if follow {
                    fs::metadata(path).await?
                } else {
                    fs::symlink_metadata(path).await?
                };
                Ok(local_entry(path, meta))
            }
            Provider::Sftp(sftp) => {
                let meta = if follow {
                    sftp.metadata(path).await?
                } else {
                    sftp.symlink_metadata(path).await?
                };
                Ok(remote_entry(path, meta))
            }
        }
    }
    pub async fn exists(&self, path: &str) -> Result<Option<Entry>> {
        match self.stat(path, false).await {
            Ok(entry) => Ok(Some(entry)),
            Err(e) if e.code == "not_found" => Ok(None),
            Err(e) => Err(e),
        }
    }
    pub async fn list(&self, path: &str) -> Result<Vec<Entry>> {
        match &self.provider {
            Provider::Local => {
                let mut dir = fs::read_dir(path).await?;
                let mut result = Vec::new();
                while let Some(entry) = dir.next_entry().await? {
                    let path = entry.path().to_string_lossy().into_owned();
                    result.push(local_entry(
                        &path,
                        fs::symlink_metadata(entry.path()).await?,
                    ));
                }
                Ok(result)
            }
            Provider::Sftp(sftp) => Ok(sftp
                .read_dir(path)
                .await?
                .map(|entry| remote_entry(&entry.path(), entry.metadata()))
                .collect()),
        }
    }
    pub async fn open(
        &self,
        path: &str,
        write: bool,
        exclusive: bool,
        truncate: bool,
    ) -> Result<File> {
        match &self.provider {
            Provider::Local => {
                let mut options = fs::OpenOptions::new();
                options.read(!write).write(write);
                if write {
                    options
                        .create(!exclusive)
                        .create_new(exclusive)
                        .truncate(truncate && !exclusive);
                }
                Ok(File::Local(options.open(path).await?, write))
            }
            Provider::Sftp(sftp) => {
                let mut flags = if write {
                    OpenFlags::WRITE | OpenFlags::CREATE
                } else {
                    OpenFlags::READ
                };
                if exclusive {
                    flags |= OpenFlags::EXCLUDE;
                }
                if truncate {
                    flags |= OpenFlags::TRUNCATE;
                }
                Ok(File::Sftp(sftp.open_with_flags(path, flags).await?))
            }
        }
    }
    pub async fn open_handle(&self, path: &str, write: bool) -> Result<String> {
        let file = self.open(path, write, write, false).await?;
        let id = uuid::Uuid::new_v4().to_string();
        self.handles
            .lock()
            .unwrap()
            .insert(id.clone(), Arc::new(tokio::sync::Mutex::new(file)));
        Ok(id)
    }
    pub fn handle(&self, id: &str) -> Result<Arc<tokio::sync::Mutex<File>>> {
        self.handles
            .lock()
            .unwrap()
            .get(id)
            .cloned()
            .ok_or_else(|| Error::new("invalid_handle", "文件句柄已关闭"))
    }
    pub async fn close_handle(&self, id: &str) -> Result<()> {
        let handle = self.handles.lock().unwrap().remove(id);
        if let Some(handle) = handle {
            handle.lock().await.close().await?;
        }
        Ok(())
    }
    pub async fn mkdir(&self, path: &str) -> Result<()> {
        match &self.provider {
            Provider::Local => fs::create_dir(path).await?,
            Provider::Sftp(sftp) => sftp.create_dir(path).await?,
        }
        Ok(())
    }
    pub async fn remove(&self, path: &str, recursive: bool) -> Result<()> {
        let entry = self.stat(path, false).await?;
        if entry.kind == "directory" && recursive {
            for child in self.list(path).await? {
                Box::pin(self.remove(&child.path, true)).await?;
            }
        }
        match &self.provider {
            Provider::Local => {
                // Windows directory symlinks/junctions must be removed with
                // remove_dir; symlink_metadata prevents traversal of their targets.
                let meta = fs::symlink_metadata(path).await?;
                if meta.is_dir() || local_directory_link(&meta) {
                    fs::remove_dir(path).await?;
                } else {
                    fs::remove_file(path).await?;
                }
            }
            Provider::Sftp(sftp) => {
                if entry.kind == "directory" {
                    sftp.remove_dir(path).await?;
                } else {
                    sftp.remove_file(path).await?;
                }
            }
        }
        Ok(())
    }
    pub async fn rename(&self, source: &str, target: &str, replace: bool) -> Result<bool> {
        match &self.provider {
            Provider::Local => {
                let source = source.to_owned();
                let target = target.to_owned();
                tokio::task::spawn_blocking(move || local_rename(&source, &target, replace))
                    .await
                    .map_err(|e| Error::new("io_error", e.to_string()))??;
                Ok(true)
            }
            Provider::Sftp(sftp) => {
                if replace {
                    return Err(Error::new("unsupported", "SFTP 替换必须通过临时文件提交"));
                }
                if self.exists(target).await?.is_some() {
                    return Err(Error::new("already_exists", "目标已存在"));
                }
                sftp.rename(source, target).await?;
                Ok(false)
            }
        }
    }
    pub async fn chmod(&self, path: &str, mode: u32) -> Result<()> {
        match &self.provider {
            Provider::Sftp(sftp) => {
                sftp.set_metadata(
                    path,
                    FileAttributes {
                        permissions: Some(mode),
                        ..Default::default()
                    },
                )
                .await?
            }
            Provider::Local => return Err(Error::new("unsupported", "Windows 不支持 POSIX 权限")),
        }
        Ok(())
    }
    pub async fn utimes(&self, path: &str, modified_at: u64) -> Result<()> {
        match &self.provider {
            Provider::Sftp(sftp) => {
                let time = (modified_at / 1000) as u32;
                sftp.set_metadata(
                    path,
                    FileAttributes {
                        atime: Some(time),
                        mtime: Some(time),
                        ..Default::default()
                    },
                )
                .await?;
            }
            Provider::Local => {
                let path = PathBuf::from(path);
                tokio::task::spawn_blocking(move || {
                    let file = std::fs::OpenOptions::new().write(true).open(path)?;
                    file.set_times(
                        std::fs::FileTimes::new().set_modified(
                            UNIX_EPOCH + std::time::Duration::from_millis(modified_at),
                        ),
                    )
                })
                .await
                .map_err(|e| Error::new("io_error", e.to_string()))??;
            }
        }
        Ok(())
    }
    pub async fn readlink(&self, path: &str) -> Result<String> {
        match &self.provider {
            Provider::Local => Ok(fs::read_link(path).await?.to_string_lossy().into_owned()),
            Provider::Sftp(sftp) => Ok(sftp.read_link(path).await?),
        }
    }
    pub async fn symlink(&self, target: &str, path: &str) -> Result<()> {
        match &self.provider {
            Provider::Local => {
                let target = target.to_owned();
                let path = path.to_owned();
                tokio::task::spawn_blocking(move || local_symlink(&target, &path))
                    .await
                    .map_err(|e| Error::new("io_error", e.to_string()))??;
            }
            Provider::Sftp(sftp) => sftp.symlink(path, target).await?,
        }
        Ok(())
    }
}

fn local_entry(path: &str, meta: std::fs::Metadata) -> Entry {
    let name = Path::new(path)
        .file_name()
        .map(|v| v.to_string_lossy().into_owned())
        .unwrap_or_else(|| path.into());
    #[cfg(windows)]
    let hidden = {
        use std::os::windows::fs::MetadataExt;
        meta.file_attributes() & 2 != 0 || name.starts_with('.')
    };
    #[cfg(not(windows))]
    let hidden = name.starts_with('.');
    Entry {
        name,
        path: path.into(),
        kind: if meta.is_symlink() {
            "symlink"
        } else if meta.is_dir() {
            "directory"
        } else if meta.is_file() {
            "file"
        } else {
            "unknown"
        }
        .into(),
        size: meta.len(),
        modified_at: meta
            .modified()
            .ok()
            .and_then(|v| v.duration_since(UNIX_EPOCH).ok())
            .map(|v| v.as_millis() as u64)
            .unwrap_or(0),
        mode: None,
        hidden,
    }
}
fn remote_entry(path: &str, meta: FileAttributes) -> Entry {
    let name = path
        .trim_end_matches('/')
        .rsplit('/')
        .next()
        .unwrap_or(path)
        .to_owned();
    // FileAttributes::is_dir uses bit containment; a symlink must be tested first.
    Entry {
        hidden: name.starts_with('.'),
        name,
        path: path.into(),
        kind: if meta.is_symlink() {
            "symlink"
        } else if meta.is_dir() {
            "directory"
        } else if meta.is_regular() {
            "file"
        } else {
            "unknown"
        }
        .into(),
        size: meta.size.unwrap_or(0),
        modified_at: meta.mtime.unwrap_or(0) as u64 * 1000,
        mode: meta.permissions,
    }
}

#[cfg(windows)]
fn local_directory_link(meta: &std::fs::Metadata) -> bool {
    use std::os::windows::fs::FileTypeExt;
    meta.file_type().is_symlink_dir()
}
#[cfg(not(windows))]
fn local_directory_link(_: &std::fs::Metadata) -> bool {
    false
}

#[cfg(windows)]
fn local_rename(source: &str, target: &str, replace: bool) -> Result<()> {
    use std::os::windows::ffi::OsStrExt;
    use windows_sys::Win32::Storage::FileSystem::{
        MOVEFILE_REPLACE_EXISTING, MOVEFILE_WRITE_THROUGH, MoveFileExW,
    };
    let source: Vec<u16> = std::ffi::OsStr::new(source)
        .encode_wide()
        .chain(Some(0))
        .collect();
    let target: Vec<u16> = std::ffi::OsStr::new(target)
        .encode_wide()
        .chain(Some(0))
        .collect();
    let flags = MOVEFILE_WRITE_THROUGH
        | if replace {
            MOVEFILE_REPLACE_EXISTING
        } else {
            0
        };
    if unsafe { MoveFileExW(source.as_ptr(), target.as_ptr(), flags) } == 0 {
        return Err(std::io::Error::last_os_error().into());
    }
    Ok(())
}
#[cfg(not(windows))]
fn local_rename(source: &str, target: &str, replace: bool) -> Result<()> {
    if !replace && Path::new(target).symlink_metadata().is_ok() {
        return Err(Error::new("already_exists", "目标已存在"));
    }
    std::fs::rename(source, target)?;
    Ok(())
}
#[cfg(windows)]
fn local_symlink(target: &str, path: &str) -> std::io::Result<()> {
    let resolved = Path::new(path)
        .parent()
        .unwrap_or(Path::new("."))
        .join(target);
    if resolved.is_dir() {
        std::os::windows::fs::symlink_dir(target, path)
    } else {
        std::os::windows::fs::symlink_file(target, path)
    }
}
#[cfg(not(windows))]
fn local_symlink(target: &str, path: &str) -> std::io::Result<()> {
    std::os::unix::fs::symlink(target, path)
}

impl From<russh_sftp::client::error::Error> for Error {
    fn from(error: russh_sftp::client::error::Error) -> Self {
        let code = match &error {
            russh_sftp::client::error::Error::Status(status) => match status.status_code {
                StatusCode::NoSuchFile => "not_found",
                StatusCode::PermissionDenied => "permission_denied",
                _ => "sftp_error",
            },
            _ => "sftp_error",
        };
        Error::new(code, error.to_string())
    }
}

pub struct FileService {
    ssh: Arc<SshService>,
    backends: Mutex<HashMap<String, Arc<Backend>>>,
}
impl FileService {
    pub fn new(ssh: Arc<SshService>) -> Self {
        Self {
            ssh,
            backends: Mutex::new(HashMap::new()),
        }
    }
    pub async fn connect(
        &self,
        id: String,
        endpoint: Endpoint,
        events: Events,
        cancel: CancellationToken,
    ) -> Result<Arc<Backend>> {
        let provider = match &endpoint {
            Endpoint::Local => Provider::Local,
            Endpoint::Sftp { connection } => {
                let session = self
                    .ssh
                    .connect(id.clone(), connection, events, cancel.clone())
                    .await?;
                let open = async {
                    let channel = session.handle.channel_open_session().await?;
                    channel.request_subsystem(true, "sftp").await?;
                    Ok::<_, Error>(SftpSession::new(channel.into_stream()).await?)
                };
                let result = tokio::select! {_ = cancel.cancelled()=>Err(Error::cancelled()),result=open=>result};
                match result {
                    Ok(sftp) => {
                        sftp.set_timeout(15);
                        Provider::Sftp(sftp)
                    }
                    Err(error) => {
                        self.ssh.close(&id);
                        return Err(error);
                    }
                }
            }
        };
        if cancel.is_cancelled() {
            self.ssh.close(&id);
            return Err(Error::cancelled());
        }
        let backend = Arc::new(Backend {
            id: id.clone(),
            endpoint,
            cancel,
            provider,
            handles: Mutex::new(HashMap::new()),
        });
        self.backends.lock().unwrap().insert(id, backend.clone());
        Ok(backend)
    }
    pub fn get(&self, id: &str) -> Result<Arc<Backend>> {
        self.backends
            .lock()
            .unwrap()
            .get(id)
            .filter(|b| !b.cancel.is_cancelled())
            .cloned()
            .ok_or_else(|| Error::new("disconnected", "文件会话不可用"))
    }
    pub fn close(&self, id: &str) {
        if let Some(backend) = self.backends.lock().unwrap().remove(id) {
            backend.cancel.cancel();
            backend.handles.lock().unwrap().clear();
        }
        self.ssh.close(id);
    }
    pub fn close_all(&self) {
        let ids: Vec<_> = self.backends.lock().unwrap().keys().cloned().collect();
        for id in ids {
            self.close(&id);
        }
    }
    pub fn info() -> serde_json::Value {
        let home = std::env::var("USERPROFILE").unwrap_or_else(|_| "C:\\".into());
        let roots: Vec<_> = (b'A'..=b'Z')
            .map(|letter| format!("{}:\\", letter as char))
            .filter(|path| Path::new(path).exists())
            .collect();
        serde_json::json!({"home":home,"roots":roots,"platform":"win32","maxChunkBytes":CHUNK})
    }
}
impl Drop for FileService {
    fn drop(&mut self) {
        self.close_all();
    }
}
