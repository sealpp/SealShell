use crate::{
    Events,
    error::{Error, Result},
    ssh::{Connection, SshService},
};
use serde::Deserialize;
use serde_json::json;
use std::{
    collections::HashMap,
    sync::{Arc, Mutex},
    time::Duration,
};
use tokio::{net::TcpListener, task::JoinSet};
use tokio_util::sync::CancellationToken;

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Target {
    pub host: String,
    pub port: u16,
    pub local_port: u16,
}

struct Forward {
    cancel: CancellationToken,
    done: tokio::task::JoinHandle<()>,
}
pub struct Forwarding {
    ssh: Arc<SshService>,
    items: Mutex<HashMap<String, Forward>>,
}

impl Forwarding {
    pub fn new(ssh: Arc<SshService>) -> Self {
        Self {
            ssh,
            items: Mutex::new(HashMap::new()),
        }
    }
    pub async fn start(
        &self,
        id: String,
        connection: Connection,
        target: Target,
        bind_host: String,
        events: Events,
    ) -> Result<u16> {
        if !matches!(bind_host.as_str(), "127.0.0.1" | "0.0.0.0") {
            return Err(Error::new("invalid_bind", "不支持的监听范围"));
        }
        let cancel = CancellationToken::new();
        let session = self
            .ssh
            .connect(id.clone(), &connection, events.clone(), cancel.clone())
            .await?;
        let port = if target.local_port == 0 {
            target.port
        } else {
            target.local_port
        };
        let bind = async {
            match TcpListener::bind((bind_host.as_str(), port)).await {
                Ok(listener) => Ok(listener),
                Err(error) if error.kind() == std::io::ErrorKind::AddrInUse => {
                    TcpListener::bind((bind_host.as_str(), 0)).await
                }
                Err(error) => Err(error),
            }
        }
        .await;
        let listener = match bind {
            Ok(listener) => listener,
            Err(error) => {
                self.ssh.close(&id);
                return Err(error.into());
            }
        };
        let actual = listener.local_addr()?.port();
        let token = cancel.clone();
        let resource_id = id.clone();
        let done = tokio::spawn(async move {
            let mut streams = JoinSet::new();
            let mut check = tokio::time::interval(Duration::from_secs(1));
            loop {
                tokio::select! {
                    _ = token.cancelled()=>break,
                    _ = check.tick()=>{if session.handle.is_closed(){events(json!({"type":"forward","id":id,"fatal":true,"error":"SSH 连接已断开"}));break;}},
                    _ = streams.join_next(), if !streams.is_empty()=>{},
                    accepted=listener.accept()=>{
                        let (mut socket,address)=match accepted{Ok(value)=>value,Err(error)=>{events(json!({"type":"forward","id":id,"fatal":true,"error":error.to_string()}));break;}};
                        let session=session.clone();let target_host=target.host.clone();let events=events.clone();let id=id.clone();
                        streams.spawn(async move {
                            let bridge=async{
                                let channel=session.handle.channel_open_direct_tcpip(target_host,target.port as u32,address.ip().to_string(),address.port() as u32).await?;
                                events(json!({"type":"forward","id":id,"fatal":false,"error":null}));
                                // copy_bidirectional propagates each EOF independently;
                                // a client FIN must still allow the remote response.
                                let mut remote=channel.into_stream();tokio::io::copy_bidirectional(&mut socket,&mut remote).await?;Ok::<_,Error>(())
                            }.await;
                            if let Err(error)=bridge&& !session.cancel.is_cancelled(){events(json!({"type":"forward","id":id,"fatal":false,"error":error.message}));}
                        });
                    }
                }
            }
            drop(listener);
            streams.abort_all();
            while streams.join_next().await.is_some() {}
            session.cancel.cancel();
        });
        self.items
            .lock()
            .unwrap()
            .insert(resource_id, Forward { cancel, done });
        Ok(actual)
    }
    pub async fn close(&self, id: &str) {
        // Also cancels a connect which has not yet created its listener.
        self.ssh.close(id);
        let item = self.items.lock().unwrap().remove(id);
        if let Some(item) = item {
            item.cancel.cancel();
            let _ = item.done.await;
        }
    }
    pub fn close_all(&self) {
        for (id, item) in self.items.lock().unwrap().drain() {
            item.cancel.cancel();
            self.ssh.close(&id);
        }
    }
}

impl Drop for Forwarding {
    fn drop(&mut self) {
        self.close_all();
    }
}
