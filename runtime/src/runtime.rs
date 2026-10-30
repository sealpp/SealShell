use crate::{
    Events,
    error::{Error, Result},
    files::{Backend, CHUNK, Endpoint, FileService},
    forwarding::Forwarding,
    http::Http,
    ssh::{Connection, SshService},
    storage::Store,
    transfers::{self, Spec, Transfers},
};
use serde::{Serialize, de::DeserializeOwned};
use serde_json::{Value, json};
use std::{
    collections::HashMap,
    path::Path,
    sync::{Arc, Mutex},
};
use tokio_util::sync::CancellationToken;

pub struct Runtime {
    pub store: Arc<Store>,
    pub ssh: Arc<SshService>,
    pub files: Arc<FileService>,
    pub transfers: Arc<Transfers>,
    pub forwarding: Forwarding,
    pub http: Http,
    events: Events,
    probes: Mutex<HashMap<String, CancellationToken>>,
}

fn decode<T: DeserializeOwned>(value: Value) -> Result<T> {
    Ok(serde_json::from_value(value)?)
}
fn encode<T: Serialize>(value: T) -> Result<Value> {
    Ok(serde_json::to_value(value)?)
}
fn string<'a>(args: &'a Value, key: &str) -> Result<&'a str> {
    args[key]
        .as_str()
        .ok_or_else(|| Error::new("invalid_argument", format!("缺少参数 {key}")))
}
fn number(args: &Value, key: &str, default: u64) -> u64 {
    args[key].as_u64().unwrap_or(default)
}
fn flag(args: &Value, key: &str) -> bool {
    args[key].as_bool().unwrap_or(false)
}

impl Runtime {
    pub fn new(directory: &Path, events: Events) -> Result<Self> {
        let store = Arc::new(Store::open(&directory.join("sealshell.sqlite"))?);
        let ssh = Arc::new(SshService::new(store.clone()));
        let files = Arc::new(FileService::new(ssh.clone()));
        Ok(Self {
            transfers: Transfers::new(files.clone(), events.clone()),
            forwarding: Forwarding::new(ssh.clone()),
            http: Http::new(store.clone())?,
            store,
            ssh,
            files,
            events,
            probes: Mutex::new(HashMap::new()),
        })
    }
    pub fn close_all(&self) {
        for (_, token) in self.probes.lock().unwrap().drain() {
            token.cancel();
        }
        self.transfers.close_all();
        self.forwarding.close_all();
        self.files.close_all();
        self.ssh.close_all();
        self.http.close_all();
    }
    pub async fn call(&self, operation: &str, args: Value) -> Result<Value> {
        match operation {
            "proxy_test" => {
                let id = string(&args, "id")?.to_owned();
                let proxy: crate::proxy::Proxy = decode(args["proxy"].clone())?;
                let cancel = CancellationToken::new();
                self.probes
                    .lock()
                    .unwrap()
                    .insert(id.clone(), cancel.clone());
                (self.events)(json!({"type":"proxyStage","id":id,"stage":"connect"}));
                let result = crate::proxy::connect(
                    string(&args, "host")?,
                    number(&args, "port", 22) as u16,
                    Some(&proxy),
                    &cancel,
                )
                .await;
                self.probes.lock().unwrap().remove(&id);
                result?;
                Ok(Value::Null)
            }
            "proxy_cancel" => {
                if let Some(token) = self.probes.lock().unwrap().remove(string(&args, "id")?) {
                    token.cancel();
                }
                Ok(Value::Null)
            }
            "store_get" => encode(
                self.store
                    .get(string(&args, "collection")?, string(&args, "key")?)?,
            ),
            "store_list" => encode(self.store.list(string(&args, "collection")?)?),
            "store_write" => encode(self.store.write(
                decode(args["changes"].clone())?,
                args["requireHost"].as_str(),
            )?),
            "credential_protect" => encode(Store::protect(
                string(&args, "id")?.into(),
                args["value"].clone(),
            )?),
            "credential_unprotect" => Store::unprotect(decode(args["record"].clone())?),
            "host_key_decision" => {
                self.ssh
                    .approve(string(&args, "requestId")?, flag(&args, "accepted"));
                Ok(Value::Null)
            }
            "ssh_connect" => {
                let connection: Connection = decode(args["connection"].clone())?;
                self.ssh
                    .connect(
                        string(&args, "id")?.into(),
                        &connection,
                        self.events.clone(),
                        CancellationToken::new(),
                    )
                    .await?;
                Ok(Value::Null)
            }
            "ssh_shell" => {
                let id = string(&args, "id")?;
                let session = self.ssh.get(id)?;
                let shell = session.start_shell(
                    id.into(),
                    number(&args, "columns", 80) as u32,
                    number(&args, "rows", 24) as u32,
                    args["command"].as_str().map(str::to_owned),
                    self.events.clone(),
                );
                tokio::select! {_ = session.cancel.cancelled()=>return Err(Error::cancelled()),result=tokio::time::timeout(std::time::Duration::from_secs(20),shell)=>result.map_err(|_|Error::new("timeout","终端启动超时"))??};
                Ok(Value::Null)
            }
            "ssh_exec" => encode(
                self.ssh
                    .get(string(&args, "id")?)?
                    .exec(
                        string(&args, "command")?.into(),
                        number(&args, "timeoutMs", 30_000),
                        number(&args, "maxOutputBytes", 4 * 1024 * 1024) as usize,
                    )
                    .await?,
            ),
            "ssh_send" => {
                self.ssh
                    .get(string(&args, "id")?)?
                    .send(decode(args["data"].clone())?)
                    .await?;
                Ok(Value::Null)
            }
            "ssh_resize" => {
                self.ssh
                    .get(string(&args, "id")?)?
                    .resize(
                        number(&args, "columns", 80) as u32,
                        number(&args, "rows", 24) as u32,
                    )
                    .await?;
                Ok(Value::Null)
            }
            "ssh_close" => {
                self.ssh.close(string(&args, "id")?);
                Ok(Value::Null)
            }
            "file_connect" => {
                let endpoint: Endpoint = decode(args["endpoint"].clone())?;
                let backend = self
                    .files
                    .connect(
                        string(&args, "id")?.into(),
                        endpoint,
                        self.events.clone(),
                        CancellationToken::new(),
                    )
                    .await?;
                Ok(
                    json!({"namespace":backend.namespace(),"atomicReplace":backend.local(),"info":if backend.local(){FileService::info()}else{Value::Null}}),
                )
            }
            "file_close" => {
                self.files.close(string(&args, "id")?);
                Ok(Value::Null)
            }
            "file_call" => {
                let backend = self.files.get(string(&args, "id")?)?;
                // Commits finish their bounded rename/rollback sequence once started.
                if args["method"] == "writeAtomic" {
                    return file_call(&backend, &args).await;
                }
                tokio::select! {_ = backend.cancel.cancelled()=>Err(Error::cancelled()),result=file_call(&backend,&args)=>result}
            }
            "transfer_enqueue" => {
                let source = self.files.get(string(&args, "sourceId")?)?;
                let target = self.files.get(string(&args, "targetId")?)?;
                self.transfers.enqueue(
                    string(&args, "id")?.into(),
                    string(&args, "label")?.into(),
                    Spec {
                        source: source.endpoint.clone(),
                        target: target.endpoint.clone(),
                        paths: decode(args["paths"].clone())?,
                        directory: string(&args, "directory")?.into(),
                        move_files: flag(&args, "moveFiles"),
                    },
                )?;
                Ok(Value::Null)
            }
            "transfer_list" => encode(self.transfers.list()),
            "transfer_concurrency" => encode(
                self.transfers
                    .concurrency(number(&args, "value", 2) as usize),
            ),
            "transfer_wait" => encode(self.transfers.wait(string(&args, "id")?).await?),
            "transfer_cancel" => encode(self.transfers.cancel(string(&args, "id")?)),
            "transfer_retry" => encode(self.transfers.retry(string(&args, "id")?)),
            "transfer_dismiss" => encode(self.transfers.dismiss(string(&args, "id")?)),
            "transfer_decision" => {
                self.transfers.decide(
                    string(&args, "requestId")?,
                    decode(args["decision"].clone())?,
                );
                Ok(Value::Null)
            }
            "forward_start" => encode(
                self.forwarding
                    .start(
                        string(&args, "id")?.into(),
                        decode(args["connection"].clone())?,
                        decode(args["target"].clone())?,
                        string(&args, "bindHost")?.into(),
                        self.events.clone(),
                    )
                    .await?,
            ),
            "forward_close" => {
                self.forwarding.close(string(&args, "id")?).await;
                Ok(Value::Null)
            }
            "http_request" => encode(self.http.request(decode(args)?).await?),
            "http_cancel" => {
                self.http.cancel(string(&args, "id")?);
                Ok(Value::Null)
            }
            "runtime_close" => {
                self.close_all();
                Ok(Value::Null)
            }
            _ => Err(Error::new(
                "unknown_operation",
                format!("未知操作：{operation}"),
            )),
        }
    }
}

async fn file_call(backend: &Backend, args: &Value) -> Result<Value> {
    let path = || string(args, "path");
    match string(args, "method")? {
        "list" => {
            let entries = backend.list(path()?).await?;
            Ok(json!({"path":path()?,"entries":entries}))
        }
        "stat" => encode(backend.stat(path()?, flag(args, "followLinks")).await?),
        "read" => {
            let mut file = backend.open(path()?, false, false, false).await?;
            encode(
                file.read(
                    number(args, "offset", 0),
                    number(args, "length", CHUNK as u64) as usize,
                )
                .await?,
            )
        }
        "write" => {
            let offset = number(args, "offset", 0);
            let data: Vec<u8> = decode(args["data"].clone())?;
            let mut file = backend.open(path()?, true, false, offset == 0).await?;
            file.write(offset, &data).await?;
            file.close().await?;
            Ok(Value::Null)
        }
        "writeAtomic" => {
            let data: Vec<u8> = decode(args["data"].clone())?;
            encode(transfers::write_atomic(backend, path()?, &data).await?)
        }
        "openReader" => encode(backend.open_handle(path()?, false).await?),
        "openWriter" => encode(backend.open_handle(path()?, true).await?),
        "readHandle" => encode(
            backend
                .handle(string(args, "handle")?)?
                .lock()
                .await
                .read(
                    number(args, "offset", 0),
                    number(args, "length", CHUNK as u64) as usize,
                )
                .await?,
        ),
        "writeHandle" => {
            backend
                .handle(string(args, "handle")?)?
                .lock()
                .await
                .write(
                    number(args, "offset", 0),
                    &decode::<Vec<u8>>(args["data"].clone())?,
                )
                .await?;
            Ok(Value::Null)
        }
        "closeHandle" => {
            backend.close_handle(string(args, "handle")?).await?;
            Ok(Value::Null)
        }
        "mkdir" => {
            backend.mkdir(path()?).await?;
            Ok(Value::Null)
        }
        "remove" => {
            backend.remove(path()?, flag(args, "recursive")).await?;
            Ok(Value::Null)
        }
        "rename" => Ok(
            json!({"atomic":backend.rename(string(args,"source")?,string(args,"target")?,flag(args,"overwrite")).await?}),
        ),
        "chmod" => {
            backend
                .chmod(path()?, number(args, "mode", 0) as u32)
                .await?;
            Ok(Value::Null)
        }
        "utimes" => {
            backend
                .utimes(path()?, number(args, "modifiedAt", 0))
                .await?;
            Ok(Value::Null)
        }
        "readlink" => encode(backend.readlink(path()?).await?),
        "symlink" => {
            backend.symlink(string(args, "target")?, path()?).await?;
            Ok(Value::Null)
        }
        method => Err(Error::new(
            "unknown_operation",
            format!("未知文件操作：{method}"),
        )),
    }
}
