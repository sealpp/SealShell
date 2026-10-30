use crate::{
    Events,
    error::{Error, Result},
    files::{Backend, CHUNK, Endpoint, Entry, FileService},
};
use serde::{Deserialize, Serialize};
use serde_json::json;
use std::{
    collections::{HashMap, HashSet},
    sync::{Arc, Mutex},
    time::Duration,
};
use tokio::sync::{Notify, oneshot};
use tokio_util::sync::CancellationToken;

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct TransferResult {
    pub source_path: String,
    pub target_path: String,
    pub bytes: u64,
    pub atomic: bool,
    pub metadata_applied: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub orphan_path: Option<String>,
}

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Snapshot {
    pub id: String,
    pub label: String,
    pub state: String,
    pub progress: f64,
    pub error: Option<String>,
    pub proxy_source: Option<serde_json::Value>,
    pub result: Option<TransferResult>,
    pub orphan_path: Option<String>,
}

#[derive(Clone)]
pub struct Spec {
    pub source: Endpoint,
    pub target: Endpoint,
    pub paths: Vec<String>,
    pub directory: String,
    pub move_files: bool,
}

#[derive(Deserialize)]
pub struct Decision {
    pub action: String,
    pub name: Option<String>,
    #[serde(default)]
    pub all: bool,
}

struct Task {
    spec: Spec,
    snapshot: Mutex<Snapshot>,
    cancel: Mutex<CancellationToken>,
    done: Notify,
}

struct Queue {
    concurrency: usize,
    running: usize,
    tasks: Vec<Arc<Task>>,
}

pub struct Transfers {
    files: Arc<FileService>,
    events: Events,
    queue: Mutex<Queue>,
    decisions: Mutex<HashMap<String, oneshot::Sender<Decision>>>,
}

impl Transfers {
    pub fn new(files: Arc<FileService>, events: Events) -> Arc<Self> {
        Arc::new(Self {
            files,
            events,
            queue: Mutex::new(Queue {
                concurrency: 2,
                running: 0,
                tasks: Vec::new(),
            }),
            decisions: Mutex::new(HashMap::new()),
        })
    }
    pub fn list(&self) -> Vec<Snapshot> {
        self.queue
            .lock()
            .unwrap()
            .tasks
            .iter()
            .map(|t| t.snapshot.lock().unwrap().clone())
            .collect()
    }
    pub fn concurrency(self: &Arc<Self>, value: usize) -> usize {
        let value = value.clamp(1, 4);
        self.queue.lock().unwrap().concurrency = value;
        self.pump();
        value
    }
    pub fn enqueue(self: &Arc<Self>, id: String, label: String, spec: Spec) -> Result<()> {
        let mut queue = self.queue.lock().unwrap();
        if queue
            .tasks
            .iter()
            .any(|t| t.snapshot.lock().unwrap().id == id)
        {
            return Err(Error::new("invalid_state", "传输标识重复"));
        }
        let task = Arc::new(Task {
            spec,
            snapshot: Mutex::new(Snapshot {
                id,
                label,
                state: "queued".into(),
                progress: 0.,
                error: None,
                proxy_source: None,
                result: None,
                orphan_path: None,
            }),
            cancel: Mutex::new(CancellationToken::new()),
            done: Notify::new(),
        });
        queue.tasks.push(task.clone());
        drop(queue);
        self.emit(&task);
        self.pump();
        Ok(())
    }
    fn task(&self, id: &str) -> Option<Arc<Task>> {
        self.queue
            .lock()
            .unwrap()
            .tasks
            .iter()
            .find(|t| t.snapshot.lock().unwrap().id == id)
            .cloned()
    }
    fn emit(&self, task: &Task) {
        let snapshot = task.snapshot.lock().unwrap().clone();
        if !self
            .queue
            .lock()
            .unwrap()
            .tasks
            .iter()
            .any(|task| task.snapshot.lock().unwrap().id == snapshot.id)
        {
            return;
        }
        (self.events)(json!({"type":"transfer","task":snapshot}));
    }
    pub async fn wait(&self, id: &str) -> Result<TransferResult> {
        let task = self
            .task(id)
            .ok_or_else(|| Error::new("not_found", "传输不存在"))?;
        loop {
            let notified = task.done.notified();
            {
                let snapshot = task.snapshot.lock().unwrap();
                match snapshot.state.as_str() {
                    "completed" => {
                        return snapshot
                            .result
                            .clone()
                            .ok_or_else(|| Error::new("invalid_state", "传输结果缺失"));
                    }
                    "failed" | "cancelled" => {
                        let mut error = Error::new(
                            if snapshot.state == "cancelled" {
                                "cancelled"
                            } else {
                                "transfer_error"
                            },
                            snapshot.error.clone().unwrap_or_default(),
                        );
                        error.orphan_path = snapshot.orphan_path.clone();
                        return Err(error);
                    }
                    _ => {}
                }
            }
            notified.await;
        }
    }
    pub fn cancel(&self, id: &str) -> bool {
        let Some(task) = self.task(id) else {
            return false;
        };
        let mut snapshot = task.snapshot.lock().unwrap();
        if !matches!(snapshot.state.as_str(), "queued" | "running") {
            return false;
        }
        task.cancel.lock().unwrap().cancel();
        if snapshot.state == "queued" {
            snapshot.state = "cancelled".into();
            snapshot.error = Some("传输已取消".into());
            task.done.notify_waiters();
        }
        drop(snapshot);
        self.emit(&task);
        true
    }
    pub fn retry(self: &Arc<Self>, id: &str) -> bool {
        let Some(task) = self.task(id) else {
            return false;
        };
        let mut snapshot = task.snapshot.lock().unwrap();
        if !matches!(snapshot.state.as_str(), "failed" | "cancelled") {
            return false;
        }
        snapshot.state = "queued".into();
        snapshot.progress = 0.;
        snapshot.error = None;
        snapshot.result = None;
        snapshot.proxy_source = None;
        *task.cancel.lock().unwrap() = CancellationToken::new();
        drop(snapshot);
        self.emit(&task);
        self.pump();
        true
    }
    pub fn dismiss(&self, id: &str) -> bool {
        let mut queue = self.queue.lock().unwrap();
        let index = queue.tasks.iter().position(|task| {
            let s = task.snapshot.lock().unwrap();
            s.id == id && !matches!(s.state.as_str(), "queued" | "running")
        });
        if let Some(index) = index {
            queue.tasks.remove(index);
            true
        } else {
            false
        }
    }
    pub fn decide(&self, id: &str, decision: Decision) {
        if let Some(sender) = self.decisions.lock().unwrap().remove(id) {
            let _ = sender.send(decision);
        }
    }
    pub fn close_all(&self) {
        for task in &self.queue.lock().unwrap().tasks {
            task.cancel.lock().unwrap().cancel();
        }
        self.decisions.lock().unwrap().clear();
    }
    pub fn reset_page(&self) {
        let mut queue = self.queue.lock().unwrap();
        for task in &queue.tasks {
            task.cancel.lock().unwrap().cancel();
            let mut snapshot = task.snapshot.lock().unwrap();
            if snapshot.state == "queued" {
                snapshot.state = "cancelled".into();
                task.done.notify_waiters();
            }
        }
        // Running jobs retain their own Arc until cleanup finishes. The shared
        // running count still limits new work, but stale UI records cannot return.
        queue.tasks.clear();
    }
    fn pump(self: &Arc<Self>) {
        let mut queue = self.queue.lock().unwrap();
        let mut ready = Vec::new();
        for task in &queue.tasks {
            if queue.running + ready.len() >= queue.concurrency {
                break;
            }
            let mut snapshot = task.snapshot.lock().unwrap();
            if snapshot.state == "queued" {
                snapshot.state = "running".into();
                ready.push(task.clone());
            }
        }
        queue.running += ready.len();
        drop(queue);
        for task in ready {
            self.emit(&task);
            let service = self.clone();
            tokio::spawn(async move {
                let result = service.execute(&task).await;
                {
                    let mut snapshot = task.snapshot.lock().unwrap();
                    match result {
                        Ok(result) => {
                            snapshot.state = "completed".into();
                            snapshot.progress = 1.;
                            if result.orphan_path.is_some() {
                                snapshot.orphan_path = result.orphan_path.clone();
                            }
                            snapshot.result = Some(result);
                        }
                        Err(error) => {
                            snapshot.state = if error.code == "cancelled" {
                                "cancelled"
                            } else {
                                "failed"
                            }
                            .into();
                            snapshot.error = Some(error.message);
                            if error.orphan_path.is_some() {
                                snapshot.orphan_path = error.orphan_path;
                            }
                            if error.code == "PROXY_ERROR" {
                                snapshot.proxy_source = match &task.spec.target {
                                    Endpoint::Sftp { connection } => {
                                        connection.proxy_source.clone()
                                    }
                                    _ => None,
                                }
                                .or_else(|| match &task.spec.source {
                                    Endpoint::Sftp { connection } => {
                                        connection.proxy_source.clone()
                                    }
                                    _ => None,
                                });
                            }
                        }
                    }
                }
                service.queue.lock().unwrap().running -= 1;
                service.emit(&task);
                task.done.notify_waiters();
                service.pump();
            });
        }
    }
    async fn conflict(
        &self,
        task: &Task,
        path: &str,
        kind: &str,
        cancel: &CancellationToken,
    ) -> Result<Decision> {
        let id = uuid::Uuid::new_v4().to_string();
        let (send, receive) = oneshot::channel();
        self.decisions.lock().unwrap().insert(id.clone(), send);
        (self.events)(
            json!({"type":"conflict","requestId":id,"id":task.snapshot.lock().unwrap().id,"path":path,"kind":kind}),
        );
        let result = tokio::select! {_ = cancel.cancelled()=>Err(Error::cancelled()),value=receive=>value.map_err(|_|Error::cancelled())};
        self.decisions.lock().unwrap().remove(&id);
        result
    }
    async fn execute(&self, task: &Task) -> Result<TransferResult> {
        let source_id = uuid::Uuid::new_v4().to_string();
        let target_id = uuid::Uuid::new_v4().to_string();
        let cancel = task.cancel.lock().unwrap().clone();
        let open = async {
            let source = self
                .files
                .connect(
                    source_id.clone(),
                    task.spec.source.clone(),
                    self.events.clone(),
                    CancellationToken::new(),
                )
                .await?;
            let target = self
                .files
                .connect(
                    target_id.clone(),
                    task.spec.target.clone(),
                    self.events.clone(),
                    CancellationToken::new(),
                )
                .await?;
            Ok::<_, Error>((source, target))
        };
        let backends =
            tokio::select! {_ = cancel.cancelled()=>Err(Error::cancelled()),result=open=>result};
        let result = match backends {
            Ok((source, target)) => self.copy_batch(task, &source, &target, &cancel).await,
            Err(error) => Err(error),
        };
        self.files.close(&source_id);
        self.files.close(&target_id);
        result
    }
    async fn copy_batch(
        &self,
        task: &Task,
        source: &Arc<Backend>,
        target: &Arc<Backend>,
        cancel: &CancellationToken,
    ) -> Result<TransferResult> {
        let mut result = TransferResult {
            source_path: task.spec.paths.first().cloned().unwrap_or_default(),
            target_path: task.spec.directory.clone(),
            bytes: 0,
            atomic: false,
            metadata_applied: false,
            orphan_path: None,
        };
        let mut replace_all = HashSet::new();
        let mut skip_all = HashSet::new();
        for (index, path) in task.spec.paths.iter().enumerate() {
            check_cancel(cancel)?;
            let item = tokio::select! {_ = cancel.cancelled()=>return Err(Error::cancelled()),result=source.stat(path,false)=>result?};
            let mut destination = target.join(&task.spec.directory, &item.name)?;
            let same = source.namespace() == target.namespace();
            if same && source.path_key(path) == target.path_key(&destination) {
                if task.spec.move_files {
                    continue;
                }
                let mut suffix = 1;
                loop {
                    destination = target.join(
                        &task.spec.directory,
                        &format!(
                            "{}-copy{}",
                            item.name,
                            if suffix == 1 {
                                String::new()
                            } else {
                                format!("-{suffix}")
                            }
                        ),
                    )?;
                    if target.exists(&destination).await?.is_none() {
                        break;
                    }
                    suffix += 1;
                }
            }
            check_overlap(source, target, path, &destination, &item)?;
            let mut skip = false;
            while let Some(existing) = target.exists(&destination).await? {
                if existing.kind != item.kind {
                    return Err(Error::new(
                        "type_conflict",
                        format!("文件类型冲突：{destination}"),
                    ));
                }
                if skip_all.contains(&item.kind) {
                    skip = true;
                    break;
                }
                if replace_all.contains(&item.kind) {
                    break;
                }
                let decision = self
                    .conflict(task, &destination, &item.kind, cancel)
                    .await?;
                match decision.action.as_str() {
                    "replace" => {
                        if decision.all {
                            replace_all.insert(item.kind.clone());
                        }
                        break;
                    }
                    "skip" => {
                        if decision.all {
                            skip_all.insert(item.kind.clone());
                        }
                        skip = true;
                        break;
                    }
                    "rename" => {
                        destination = target
                            .join(&task.spec.directory, decision.name.as_deref().unwrap_or(""))?;
                        check_overlap(source, target, path, &destination, &item)?;
                    }
                    "cancel" => return Ok(result),
                    _ => return Err(Error::new("invalid_decision", "无效冲突选择")),
                }
            }
            if skip {
                continue;
            }
            check_cancel(cancel)?;
            let progress = |bytes: u64, total: u64| {
                let mut snapshot = task.snapshot.lock().unwrap();
                snapshot.progress = (index as f64
                    + if total > 0 {
                        bytes as f64 / total as f64
                    } else {
                        0.
                    })
                    / task.spec.paths.len().max(1) as f64;
                drop(snapshot);
                self.emit(task);
            };
            result = if task.spec.move_files {
                move_entry(target, path, &destination).await?
            } else {
                self.copy_entry(source, target, &destination, &item, cancel, &progress)
                    .await?
            };
            progress(1, 1);
        }
        Ok(result)
    }
    async fn copy_entry(
        &self,
        source: &Backend,
        target: &Backend,
        destination: &str,
        item: &Entry,
        cancel: &CancellationToken,
        progress: &(dyn Fn(u64, u64) + Sync),
    ) -> Result<TransferResult> {
        let path = item.path.as_str();
        let temporary = target.temporary(destination, "tmp")?;
        let copying = copy_tree(source, target, path, &temporary, item, progress);
        let copied =
            tokio::select! {_ = cancel.cancelled()=>Err(Error::cancelled()),value=copying=>value};
        let result = match copied {
            Ok((bytes, metadata)) => {
                if cancel.is_cancelled() {
                    Err(Error::cancelled())
                } else {
                    commit(target, &temporary, destination)
                        .await
                        .map(|(atomic, orphan_path)| TransferResult {
                            source_path: path.into(),
                            target_path: destination.into(),
                            bytes,
                            atomic,
                            metadata_applied: metadata,
                            orphan_path,
                        })
                }
            }
            Err(error) => Err(error),
        };
        match result {
            Ok(result) => Ok(result),
            Err(error) => {
                if cancel.is_cancelled() {
                    self.files.close(&source.id);
                    self.files.close(&target.id);
                }
                // Reconnect after any interrupted operation: the server may have
                // created staging before the request's reply was lost.
                let cleanup_id = uuid::Uuid::new_v4().to_string();
                let cleanup = async {
                    let backend = self
                        .files
                        .connect(
                            cleanup_id.clone(),
                            target.endpoint.clone(),
                            self.events.clone(),
                            CancellationToken::new(),
                        )
                        .await?;
                    if backend.exists(&temporary).await?.is_some() {
                        backend.remove(&temporary, true).await?;
                    }
                    Ok::<_, Error>(())
                };
                let cleaned = tokio::time::timeout(Duration::from_secs(15), cleanup).await;
                self.files.close(&cleanup_id);
                if matches!(cleaned, Ok(Ok(()))) {
                    Err(error)
                } else {
                    Err(error.with_orphan(&temporary))
                }
            }
        }
    }
}

fn check_cancel(cancel: &CancellationToken) -> Result<()> {
    if cancel.is_cancelled() {
        Err(Error::cancelled())
    } else {
        Ok(())
    }
}
fn check_overlap(
    source: &Backend,
    target: &Backend,
    path: &str,
    destination: &str,
    item: &Entry,
) -> Result<()> {
    if source.namespace() != target.namespace() {
        return Ok(());
    }
    let source = source.path_key(path);
    let target = target.path_key(destination);
    if source == target
        || (item.kind == "directory"
            && (target.starts_with(&format!("{source}/"))
                || source.starts_with(&format!("{target}/"))))
    {
        return Err(Error::new(
            "invalid_target",
            "不能向自身、子目录或祖先目录复制/移动目录",
        ));
    }
    Ok(())
}

async fn copy_tree(
    source: &Backend,
    target: &Backend,
    path: &str,
    destination: &str,
    item: &Entry,
    progress: &(dyn Fn(u64, u64) + Sync),
) -> Result<(u64, bool)> {
    match item.kind.as_str() {
        "file" => {
            let mut reader = source.open(path, false, false, false).await?;
            let mut writer = target.open(destination, true, true, false).await?;
            let copy = async {
                let mut bytes = 0;
                while bytes < item.size {
                    let data = reader
                        .read(bytes, (item.size - bytes).min(CHUNK as u64) as usize)
                        .await?;
                    if data.is_empty() {
                        return Err(Error::new("file_changed", "源文件在传输完成前结束"));
                    }
                    writer.write(bytes, &data).await?;
                    bytes += data.len() as u64;
                    progress(bytes, item.size);
                }
                Ok::<_, Error>(bytes)
            }
            .await;
            let closed = writer.close().await;
            drop(writer);
            drop(reader);
            let bytes = copy?;
            closed?;
            if target.stat(destination, false).await?.size != item.size {
                return Err(Error::new("size_mismatch", "传输文件大小校验失败"));
            }
            let mut metadata = true;
            if let Some(mode) = item.mode
                && !target.local()
                && target.chmod(destination, mode).await.is_err()
            {
                metadata = false;
            }
            if target.utimes(destination, item.modified_at).await.is_err() {
                metadata = false;
            }
            Ok((bytes, metadata))
        }
        "directory" => {
            target.mkdir(destination).await?;
            let entries = source.list(path).await?;
            let mut bytes = 0;
            for (index, child) in entries.iter().enumerate() {
                let next = target.join(destination, &child.name)?;
                bytes += Box::pin(copy_tree(
                    source,
                    target,
                    &child.path,
                    &next,
                    child,
                    &|_, _| {},
                ))
                .await?
                .0;
                progress(index as u64 + 1, entries.len() as u64);
            }
            Ok((bytes, false))
        }
        "symlink" => {
            target
                .symlink(&source.readlink(path).await?, destination)
                .await?;
            Ok((0, false))
        }
        _ => Err(Error::new("unsupported", "不支持复制此文件类型")),
    }
}

pub async fn commit(
    backend: &Backend,
    temporary: &str,
    target: &str,
) -> Result<(bool, Option<String>)> {
    let Some(previous) = backend.exists(target).await? else {
        return Ok((backend.rename(temporary, target, false).await?, None));
    };
    let incoming = backend.stat(temporary, false).await?;
    if previous.kind != incoming.kind {
        return Err(Error::new(
            "type_conflict",
            "目标与源的文件类型不同，不能替换",
        ));
    }
    if incoming.kind == "file" && backend.local() {
        return Ok((backend.rename(temporary, target, true).await?, None));
    }
    let backup = backend.temporary(target, "previous")?;
    backend.rename(target, &backup, false).await?;
    if let Err(error) = backend.rename(temporary, target, false).await {
        return match backend.rename(&backup, target, false).await {
            Ok(_) => Err(error),
            Err(_) => Err(error.with_orphan(&backup)),
        };
    }
    let orphan = if backend.remove(&backup, true).await.is_err() {
        Some(backup)
    } else {
        None
    };
    Ok((false, orphan))
}

async fn move_entry(backend: &Backend, source: &str, target: &str) -> Result<TransferResult> {
    let (atomic, orphan_path) = if backend.exists(target).await?.is_some() {
        let staging = backend.temporary(target, "tmp")?;
        backend.rename(source, &staging, false).await?;
        match commit(backend, &staging, target).await {
            Ok(result) => result,
            Err(error) => {
                return match backend.rename(&staging, source, false).await {
                    Ok(_) => Err(error),
                    Err(_) => Err(error.with_orphan(&staging)),
                };
            }
        }
    } else {
        (backend.rename(source, target, false).await?, None)
    };
    Ok(TransferResult {
        source_path: source.into(),
        target_path: target.into(),
        bytes: 0,
        atomic,
        metadata_applied: false,
        orphan_path,
    })
}

pub async fn write_atomic(backend: &Backend, path: &str, data: &[u8]) -> Result<TransferResult> {
    let temporary = backend.temporary(path, "tmp")?;
    let result = async {
        let previous = backend.exists(path).await?;
        let mut file = backend.open(&temporary, true, true, false).await?;
        for (index, chunk) in data.chunks(CHUNK).enumerate() {
            file.write((index * CHUNK) as u64, chunk).await?;
        }
        file.close().await?;
        drop(file);
        let mut metadata = true;
        if let Some(mode) = previous.and_then(|entry| entry.mode)
            && !backend.local()
            && backend.chmod(&temporary, mode).await.is_err()
        {
            metadata = false;
        }
        let (atomic, orphan_path) = commit(backend, &temporary, path).await?;
        Ok::<_, Error>(TransferResult {
            source_path: path.into(),
            target_path: path.into(),
            bytes: data.len() as u64,
            atomic,
            metadata_applied: metadata,
            orphan_path,
        })
    }
    .await;
    if let Err(error) = result {
        if backend.exists(&temporary).await?.is_some()
            && backend.remove(&temporary, true).await.is_err()
        {
            return Err(error.with_orphan(&temporary));
        }
        return Err(error);
    }
    result
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::{ssh::SshService, storage::Store};
    #[cfg(windows)]
    fn private_bytes() -> usize {
        use windows_sys::Win32::System::{
            ProcessStatus::{GetProcessMemoryInfo, PROCESS_MEMORY_COUNTERS_EX},
            Threading::GetCurrentProcess,
        };
        let mut memory: PROCESS_MEMORY_COUNTERS_EX = unsafe { std::mem::zeroed() };
        memory.cb = std::mem::size_of_val(&memory) as u32;
        assert_ne!(
            unsafe {
                GetProcessMemoryInfo(GetCurrentProcess(), &mut memory as *mut _ as _, memory.cb)
            },
            0
        );
        memory.PrivateUsage
    }
    #[cfg(windows)]
    #[tokio::test]
    async fn a_large_transfer_keeps_memory_bounded_and_rejects_recursive_destinations() {
        use std::io::{Read, Write};
        use std::sync::atomic::{AtomicUsize, Ordering};
        let dir = tempfile::tempdir().unwrap();
        let source = dir.path().join("large.bin");
        let target = dir.path().join("target");
        std::fs::create_dir(&target).unwrap();
        let chunk = vec![42; CHUNK];
        let mut file = std::fs::File::create(&source).unwrap();
        for _ in 0..512 {
            file.write_all(&chunk).unwrap();
        }
        drop(file);
        let files = Arc::new(FileService::new(Arc::new(SshService::new(Arc::new(
            Store::open(&dir.path().join("state.sqlite")).unwrap(),
        )))));
        let peak = Arc::new(AtomicUsize::new(private_bytes()));
        let sample = peak.clone();
        let before = private_bytes();
        let transfers = Transfers::new(
            files,
            Arc::new(move |_| {
                sample.fetch_max(private_bytes(), Ordering::Relaxed);
            }),
        );
        transfers
            .enqueue(
                "large".into(),
                "128 MiB".into(),
                Spec {
                    source: Endpoint::Local,
                    target: Endpoint::Local,
                    paths: vec![source.to_string_lossy().into()],
                    directory: target.to_string_lossy().into(),
                    move_files: false,
                },
            )
            .unwrap();
        let result = transfers.wait("large").await.unwrap();
        assert_eq!(result.bytes, 128 * 1024 * 1024);
        let delta = peak.load(Ordering::Relaxed).saturating_sub(before);
        eprintln!("128 MiB streaming copy: peak private-memory increase {delta} bytes");
        assert!(
            delta < 64 * 1024 * 1024,
            "128 MiB copy grew private memory by {delta} bytes"
        );
        let mut file = std::fs::File::open(target.join("large.bin")).unwrap();
        let mut buffer = vec![0; CHUNK];
        let mut count = 0;
        loop {
            let read = file.read(&mut buffer).unwrap();
            if read == 0 {
                break;
            }
            assert!(buffer[..read].iter().all(|&value| value == 42));
            count += read;
        }
        assert_eq!(count, 128 * 1024 * 1024);
        transfers
            .enqueue(
                "recursive".into(),
                "invalid".into(),
                Spec {
                    source: Endpoint::Local,
                    target: Endpoint::Local,
                    paths: vec![target.to_string_lossy().into()],
                    directory: target.to_string_lossy().into(),
                    move_files: false,
                },
            )
            .unwrap();
        assert!(
            transfers
                .wait("recursive")
                .await
                .err()
                .unwrap()
                .message
                .contains("不能向自身")
        );
    }
    #[tokio::test]
    async fn directory_replacement_is_whole_and_same_path_copy_gets_new_name() {
        let dir = tempfile::tempdir().unwrap();
        let source = dir.path().join("source");
        let destination = dir.path().join("destination");
        std::fs::create_dir_all(source.join("tree")).unwrap();
        std::fs::create_dir_all(destination.join("tree")).unwrap();
        std::fs::write(source.join("tree/new.txt"), b"new").unwrap();
        std::fs::write(destination.join("tree/old.txt"), b"old").unwrap();
        let files = Arc::new(FileService::new(Arc::new(SshService::new(Arc::new(
            Store::open(&dir.path().join("store.sqlite")).unwrap(),
        )))));
        let (send, mut receive) = tokio::sync::mpsc::unbounded_channel();
        let transfers = Transfers::new(
            files,
            Arc::new(move |event| {
                let _ = send.send(event);
            }),
        );
        transfers
            .enqueue(
                "copy".into(),
                "test".into(),
                Spec {
                    source: Endpoint::Local,
                    target: Endpoint::Local,
                    paths: vec![source.join("tree").to_string_lossy().into()],
                    directory: destination.to_string_lossy().into(),
                    move_files: false,
                },
            )
            .unwrap();
        while let Some(event) = receive.recv().await {
            if event["type"] == "conflict" {
                transfers.decide(
                    event["requestId"].as_str().unwrap(),
                    Decision {
                        action: "replace".into(),
                        name: None,
                        all: false,
                    },
                );
                break;
            }
        }
        transfers.wait("copy").await.unwrap();
        assert!(!destination.join("tree/old.txt").exists());
        assert_eq!(
            std::fs::read(destination.join("tree/new.txt")).unwrap(),
            b"new"
        );
        transfers
            .enqueue(
                "same".into(),
                "test".into(),
                Spec {
                    source: Endpoint::Local,
                    target: Endpoint::Local,
                    paths: vec![source.join("tree").to_string_lossy().into()],
                    directory: source.to_string_lossy().into(),
                    move_files: false,
                },
            )
            .unwrap();
        transfers.wait("same").await.unwrap();
        assert!(source.join("tree-copy/new.txt").exists());
    }
}
