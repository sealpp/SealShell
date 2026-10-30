use crate::{
    error::{Error, Result},
    storage::{Credential, Store},
};
use futures::StreamExt;
use serde::Deserialize;
use std::{
    collections::HashMap,
    sync::{Arc, Mutex},
    time::Duration,
};
use tokio_util::sync::CancellationToken;

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Request {
    pub id: String,
    pub url: String,
    pub body: serde_json::Value,
    pub credential_id: Option<String>,
    pub api_key: Option<String>,
}

pub struct Http {
    store: Arc<Store>,
    requests: Mutex<HashMap<String, CancellationToken>>,
    client: reqwest::Client,
}
impl Http {
    pub fn new(store: Arc<Store>) -> Result<Self> {
        // Explicitly disable environment proxies. SSH proxy preferences are not
        // implicitly applied to AI providers and credentials never follow redirects.
        let client = reqwest::Client::builder()
            .no_proxy()
            .redirect(reqwest::redirect::Policy::none())
            .connect_timeout(Duration::from_secs(15))
            .timeout(Duration::from_secs(45))
            .build()
            .map_err(|_| Error::new("http_error", "无法初始化 HTTP 客户端"))?;
        Ok(Self {
            store,
            requests: Mutex::new(HashMap::new()),
            client,
        })
    }
    pub fn cancel(&self, id: &str) {
        if let Some(token) = self.requests.lock().unwrap().remove(id) {
            token.cancel();
        }
    }
    pub fn close_all(&self) {
        for (_, token) in self.requests.lock().unwrap().drain() {
            token.cancel();
        }
    }
    pub async fn request(&self, request: Request) -> Result<String> {
        let url = reqwest::Url::parse(&request.url)
            .map_err(|_| Error::new("invalid_url", "模型地址无效"))?;
        if !matches!(url.scheme(), "http" | "https")
            || !url.username().is_empty()
            || url.password().is_some()
        {
            return Err(Error::new("invalid_url", "模型地址无效"));
        }
        let secret = if let Some(id) = request.credential_id {
            let stored = self
                .store
                .get("credentials", &id)?
                .ok_or_else(|| Error::new("missing_credential", "请填写 API Key"))?;
            let value = Store::unprotect(serde_json::from_value::<Credential>(stored)?)?;
            value["apiKey"].as_str().unwrap_or("").to_owned()
        } else {
            request.api_key.unwrap_or_default()
        };
        let secret = zeroize::Zeroizing::new(secret);
        if secret.is_empty() {
            return Err(Error::new("missing_credential", "请填写 API Key"));
        }
        let token = CancellationToken::new();
        self.requests
            .lock()
            .unwrap()
            .insert(request.id.clone(), token.clone());
        let operation = async {
            let response = self
                .client
                .post(url)
                .bearer_auth(secret.as_str())
                .json(&request.body)
                .send()
                .await
                .map_err(|_| Error::new("http_error", "无法连接模型服务"))?;
            if !response.status().is_success() {
                return Err(Error::new(
                    "http_error",
                    format!("云端推荐失败（HTTP {}）", response.status().as_u16()),
                ));
            }
            let mut bytes = Vec::new();
            let mut stream = response.bytes_stream();
            while let Some(chunk) = stream.next().await {
                let chunk = chunk.map_err(|_| Error::new("http_error", "云端响应读取失败"))?;
                if bytes.len() + chunk.len() > 64 * 1024 {
                    return Err(Error::new("response_limit", "云端响应过大"));
                }
                bytes.extend_from_slice(&chunk);
            }
            String::from_utf8(bytes).map_err(|_| Error::new("invalid_response", "云端返回格式无效"))
        };
        let result = tokio::select! {_ = token.cancelled()=>Err(Error::cancelled()),result=operation=>result};
        self.requests.lock().unwrap().remove(&request.id);
        result
    }
}
impl Drop for Http {
    fn drop(&mut self) {
        self.close_all();
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;
    use tokio::{
        io::{AsyncReadExt, AsyncWriteExt},
        net::TcpListener,
    };

    async fn server(
        status: &str,
        body: &[u8],
        extra: &str,
    ) -> (String, tokio::task::JoinHandle<String>) {
        let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
        let address = listener.local_addr().unwrap();
        let response = format!(
            "HTTP/1.1 {status}\r\nContent-Length: {}\r\nConnection: close\r\n{extra}\r\n",
            body.len()
        );
        let body = body.to_vec();
        let handle = tokio::spawn(async move {
            let (mut socket, _) = listener.accept().await.unwrap();
            let mut header = Vec::new();
            while !header.ends_with(b"\r\n\r\n") {
                header.push(socket.read_u8().await.unwrap());
            }
            let header = String::from_utf8(header).unwrap();
            let count: usize = header
                .lines()
                .find_map(|line| {
                    line.to_lowercase()
                        .strip_prefix("content-length:")
                        .and_then(|n| n.trim().parse().ok())
                })
                .unwrap_or(0);
            let mut request = vec![0; count];
            socket.read_exact(&mut request).await.unwrap();
            socket.write_all(response.as_bytes()).await.unwrap();
            let _ = socket.write_all(&body).await;
            header
        });
        (format!("http://{address}/chat/completions"), handle)
    }
    fn request(url: String) -> Request {
        Request {
            id: uuid::Uuid::new_v4().to_string(),
            url,
            body: json!({"messages":[]}),
            credential_id: None,
            api_key: Some("synthetic-secret".into()),
        }
    }

    #[tokio::test]
    async fn errors_hide_provider_bodies_and_oversized_answers_are_rejected() {
        let directory = tempfile::tempdir().unwrap();
        let http = Http::new(Arc::new(
            Store::open(&directory.path().join("state.sqlite")).unwrap(),
        ))
        .unwrap();
        let (url, server) = server(
            "401 Unauthorized",
            b"private context and synthetic-secret",
            "",
        )
        .await;
        let error = http.request(request(url)).await.unwrap_err();
        assert_eq!(error.message, "云端推荐失败（HTTP 401）");
        assert!(
            server
                .await
                .unwrap()
                .to_lowercase()
                .contains("authorization: bearer synthetic-secret")
        );
        let (url, server) = self::server("200 OK", &vec![b'x'; 65 * 1024], "").await;
        assert_eq!(
            http.request(request(url)).await.unwrap_err().code,
            "response_limit"
        );
        server.await.unwrap();
    }

    #[tokio::test]
    async fn redirect_does_not_receive_provider_credentials() {
        let directory = tempfile::tempdir().unwrap();
        let http = Http::new(Arc::new(
            Store::open(&directory.path().join("state.sqlite")).unwrap(),
        ))
        .unwrap();
        let destination = TcpListener::bind("127.0.0.1:0").await.unwrap();
        let (url, server) = server(
            "302 Found",
            b"",
            &format!(
                "Location: http://{}/steal\r\n",
                destination.local_addr().unwrap()
            ),
        )
        .await;
        assert!(http.request(request(url)).await.is_err());
        server.await.unwrap();
        assert!(
            tokio::time::timeout(Duration::from_millis(100), destination.accept())
                .await
                .is_err()
        );
    }

    #[cfg(windows)]
    #[tokio::test]
    async fn native_http_reads_dpapi_credentials_and_cancels_a_pending_response() {
        use crate::storage::Write;
        let directory = tempfile::tempdir().unwrap();
        let store = Arc::new(Store::open(&directory.path().join("state.sqlite")).unwrap());
        let credential =
            Store::protect("ai".into(), json!({"apiKey":"account-protected-secret"})).unwrap();
        store
            .write(
                vec![Write {
                    collection: "credentials".into(),
                    key: "ai".into(),
                    value: Some(serde_json::to_value(credential).unwrap()),
                }],
                None,
            )
            .unwrap();
        let http = Arc::new(Http::new(store).unwrap());
        let (url, server) = server("200 OK", b"{}", "").await;
        let mut req = request(url);
        req.api_key = None;
        req.credential_id = Some("ai".into());
        http.request(req).await.unwrap();
        assert!(
            server
                .await
                .unwrap()
                .to_lowercase()
                .contains("authorization: bearer account-protected-secret")
        );
        let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
        let http_task = http.clone();
        let mut req = request(format!("http://{}/slow", listener.local_addr().unwrap()));
        req.id = "pending".into();
        let pending = tokio::spawn(async move { http_task.request(req).await });
        let (_socket, _) = listener.accept().await.unwrap();
        http.cancel("pending");
        assert_eq!(
            tokio::time::timeout(Duration::from_secs(1), pending)
                .await
                .unwrap()
                .unwrap()
                .unwrap_err()
                .code,
            "cancelled"
        );
        assert!(http.requests.lock().unwrap().is_empty());
    }
}
