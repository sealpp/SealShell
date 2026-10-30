use crate::{
    Events,
    error::{Error, Result},
    proxy::{self, Proxy},
    storage::Store,
};
use base64::Engine;
use russh::{Channel, ChannelMsg, client};
use serde::{Deserialize, Serialize};
use serde_json::json;
use std::{
    collections::HashMap,
    sync::{Arc, Mutex},
    time::Duration,
};
use tokio::sync::{mpsc, oneshot};
use tokio_util::sync::CancellationToken;

#[derive(Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Connection {
    pub host: String,
    pub port: u16,
    pub username: String,
    pub password: String,
    pub proxy: Option<Proxy>,
    pub proxy_source: Option<serde_json::Value>,
}

pub struct Verifier {
    id: String,
    host: String,
    port: u16,
    store: Arc<Store>,
    approvals: Arc<Mutex<HashMap<String, oneshot::Sender<bool>>>>,
    events: Events,
    cancel: CancellationToken,
}

impl client::Handler for Verifier {
    type Error = Error;

    async fn check_server_key(
        &mut self,
        server: &russh::keys::PublicKeyOrCertificate,
    ) -> Result<bool> {
        let public = server.public_key();
        let key = base64::engine::general_purpose::STANDARD.encode(
            public
                .to_bytes()
                .map_err(|e| Error::new("SSH_ERROR", e.to_string()))?,
        );
        let fingerprint = public.fingerprint(russh::keys::HashAlg::Sha256).to_string();
        let record_id = format!("{}\0{}", self.host, self.port);
        if let Some(known) = self.store.get("knownHosts", &record_id)? {
            if known["publicKey"] == key {
                return Ok(true);
            }
            return Err(Error::new(
                "HOST_KEY_MISMATCH",
                "远端主机指纹与已保存记录不符，已拒绝连接",
            ));
        }
        let request_id = uuid::Uuid::new_v4().to_string();
        let (send, receive) = oneshot::channel();
        self.approvals
            .lock()
            .unwrap()
            .insert(request_id.clone(), send);
        (self.events)(
            json!({"type":"hostKey", "id":self.id, "requestId":request_id, "host":self.host, "port":self.port, "fingerprint":fingerprint}),
        );
        let accepted = tokio::select! { _ = self.cancel.cancelled() => false, answer = receive => answer.unwrap_or(false) };
        self.approvals.lock().unwrap().remove(&request_id);
        if accepted {
            // Trust is checked and inserted in one transaction, including when
            // two first-use prompts were accepted concurrently.
            self.store
                .trust_host(&self.host, self.port, &key, &fingerprint)?;
        }
        Ok(accepted)
    }
}

pub struct Session {
    pub handle: client::Handle<Verifier>,
    pub cancel: CancellationToken,
    shell: Mutex<Option<mpsc::Sender<ShellInput>>>,
}

enum ShellInput {
    Data(Vec<u8>),
    Resize(u32, u32),
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ExecOutput {
    pub stdout: Vec<u8>,
    pub stderr: Vec<u8>,
    pub exit_code: i32,
}

impl Session {
    pub async fn exec(
        &self,
        command: String,
        timeout_ms: u64,
        max_bytes: usize,
    ) -> Result<ExecOutput> {
        let operation = async {
            let mut channel = self.handle.channel_open_session().await?;
            channel.exec(true, command).await?;
            channel.eof().await?;
            let mut output = ExecOutput {
                stdout: Vec::new(),
                stderr: Vec::new(),
                exit_code: -1,
            };
            while let Some(message) = channel.wait().await {
                match message {
                    ChannelMsg::Data { data } => output.stdout.extend_from_slice(&data),
                    ChannelMsg::ExtendedData { data, .. } => output.stderr.extend_from_slice(&data),
                    ChannelMsg::ExitStatus { exit_status } => output.exit_code = exit_status as i32,
                    ChannelMsg::Failure => {
                        let _ = channel.close().await;
                        return Err(Error::new("EXEC_DENIED", "服务器拒绝执行命令"));
                    }
                    _ => {}
                }
                if output.stdout.len() + output.stderr.len() > max_bytes {
                    let _ = channel.close().await;
                    return Err(Error::new("output_limit", "SSH 命令输出超出限制"));
                }
            }
            Ok(output)
        };
        tokio::select! {
            _ = self.cancel.cancelled() => Err(Error::cancelled()),
            result = tokio::time::timeout(Duration::from_millis(timeout_ms), operation) => {
                match result {
                    Ok(result) => result,
                    Err(_) => { self.cancel.cancel(); Err(Error::new("timeout", "SSH 命令超时，请重新连接后重试")) }
                }
            }
        }
    }

    pub async fn start_shell(
        self: &Arc<Self>,
        id: String,
        columns: u32,
        rows: u32,
        command: Option<String>,
        events: Events,
    ) -> Result<()> {
        if self.shell.lock().unwrap().is_some() {
            return Err(Error::new("invalid_state", "终端已经打开"));
        }
        let mut channel = self.handle.channel_open_session().await?;
        channel
            .request_pty(
                true,
                "xterm-256color",
                columns.max(1),
                rows.max(1),
                0,
                0,
                &[],
            )
            .await?;
        request_ok(&mut channel).await?;
        if let Some(command) = command {
            channel.exec(true, command).await?;
        } else {
            channel.request_shell(true).await?;
        }
        request_ok(&mut channel).await?;
        let (send, mut receive) = mpsc::channel(64);
        *self.shell.lock().unwrap() = Some(send);
        let session = self.clone();
        tokio::spawn(async move {
            let result: Result<()> = async {
                loop {
                    tokio::select! {
                        _ = session.cancel.cancelled() => break,
                        input = receive.recv() => match input {
                            Some(ShellInput::Data(data)) => channel.data_bytes(data).await?,
                            Some(ShellInput::Resize(columns, rows)) => channel.window_change(columns, rows, 0, 0).await?,
                            None => break,
                        },
                        message = channel.wait() => match message {
                            Some(ChannelMsg::Data { data } | ChannelMsg::ExtendedData { data, .. }) => events(json!({"type":"output", "id":id,"data":data.as_ref()})),
                            None | Some(ChannelMsg::Close) => break,
                            _ => {},
                        }
                    }
                }
                Ok(())
            }.await;
            let _ = channel.close().await;
            if !session.cancel.is_cancelled() {
                match result {
                    Ok(()) => events(json!({"type":"state","id":id,"state":"idle"})),
                    Err(error) => events(
                        json!({"type":"state","id":id,"state":"error","error":error.message}),
                    ),
                }
            }
            session.cancel.cancel();
            session.shell.lock().unwrap().take();
        });
        Ok(())
    }

    pub async fn send(&self, bytes: Vec<u8>) -> Result<()> {
        self.input(ShellInput::Data(bytes)).await
    }
    pub async fn resize(&self, columns: u32, rows: u32) -> Result<()> {
        self.input(ShellInput::Resize(columns.max(1), rows.max(1)))
            .await
    }
    async fn input(&self, input: ShellInput) -> Result<()> {
        let send = self
            .shell
            .lock()
            .unwrap()
            .clone()
            .ok_or_else(|| Error::new("disconnected", "终端未连接"))?;
        tokio::select! {
            _ = self.cancel.cancelled() => Err(Error::cancelled()),
            result = send.send(input) => result.map_err(|_| Error::new("disconnected", "终端已关闭")),
        }
    }
}

async fn request_ok(channel: &mut Channel<client::Msg>) -> Result<()> {
    loop {
        match channel.wait().await {
            Some(ChannelMsg::Success) => return Ok(()),
            Some(ChannelMsg::Failure) | Some(ChannelMsg::Close) | None => {
                return Err(Error::new("EXEC_DENIED", "服务器拒绝终端请求"));
            }
            _ => {}
        }
    }
}

struct Entry {
    cancel: CancellationToken,
    session: Option<Arc<Session>>,
    events: Events,
}

pub struct SshService {
    store: Arc<Store>,
    sessions: Mutex<HashMap<String, Entry>>,
    approvals: Arc<Mutex<HashMap<String, oneshot::Sender<bool>>>>,
}

impl SshService {
    pub fn new(store: Arc<Store>) -> Self {
        Self {
            store,
            sessions: Mutex::new(HashMap::new()),
            approvals: Arc::new(Mutex::new(HashMap::new())),
        }
    }

    pub fn approve(&self, id: &str, accepted: bool) {
        if let Some(send) = self.approvals.lock().unwrap().remove(id) {
            let _ = send.send(accepted);
        }
    }

    pub async fn connect(
        &self,
        id: String,
        connection: &Connection,
        events: Events,
        cancel: CancellationToken,
    ) -> Result<Arc<Session>> {
        {
            let mut sessions = self.sessions.lock().unwrap();
            if sessions.contains_key(&id) {
                return Err(Error::new("invalid_state", "会话标识重复"));
            }
            sessions.insert(
                id.clone(),
                Entry {
                    cancel: cancel.clone(),
                    session: None,
                    events: events.clone(),
                },
            );
        }
        let operation = async {
            let socket = proxy::connect(
                &connection.host,
                connection.port,
                connection.proxy.as_ref(),
                &cancel,
            )
            .await?;
            let verifier = Verifier {
                id: id.clone(),
                host: connection.host.clone(),
                port: connection.port,
                store: self.store.clone(),
                approvals: self.approvals.clone(),
                events,
                cancel: cancel.clone(),
            };
            let config = client::Config {
                keepalive_interval: Some(Duration::from_secs(15)),
                keepalive_max: 3,
                ..Default::default()
            };
            let mut handle = client::connect_stream(Arc::new(config), socket, verifier).await?;
            if !handle
                .authenticate_password(&connection.username, &connection.password)
                .await?
                .success()
            {
                return Err(Error::new("AUTHENTICATION_FAILED", "用户名或密码错误"));
            }
            Ok(Arc::new(Session {
                handle,
                cancel: cancel.clone(),
                shell: Mutex::new(None),
            }))
        };
        // Host-key confirmation is interactive, so it is cancellable rather than
        // sharing the short TCP timeout. Transport keepalives detect dead peers.
        let result = tokio::select! { _ = cancel.cancelled() => Err(Error::cancelled()), result = operation => result };
        match result {
            Ok(session) => {
                let mut sessions = self.sessions.lock().unwrap();
                if let Some(entry) = sessions.get_mut(&id) {
                    entry.session = Some(session.clone());
                    Ok(session)
                } else {
                    cancel.cancel();
                    Err(Error::cancelled())
                }
            }
            Err(error) => {
                self.close(&id);
                Err(error)
            }
        }
    }

    pub fn get(&self, id: &str) -> Result<Arc<Session>> {
        self.sessions
            .lock()
            .unwrap()
            .get(id)
            .and_then(|entry| entry.session.clone())
            .filter(|s| !s.cancel.is_cancelled())
            .ok_or_else(|| Error::new("disconnected", "SSH 会话不可用"))
    }
    pub fn close(&self, id: &str) {
        if let Some(entry) = self.sessions.lock().unwrap().remove(id) {
            entry.cancel.cancel();
            (entry.events)(json!({"type":"sessionClosed","id":id}));
        }
    }
    pub fn close_all(&self) {
        for (id, entry) in self.sessions.lock().unwrap().drain() {
            entry.cancel.cancel();
            (entry.events)(json!({"type":"sessionClosed","id":id}));
        }
    }
}

impl Drop for SshService {
    fn drop(&mut self) {
        self.close_all();
    }
}
