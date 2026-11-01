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
use zeroize::Zeroizing;

#[derive(Default, Deserialize)]
#[serde(rename_all = "kebab-case")]
pub enum Protocol {
    #[default]
    OpenaiChat,
    OpenaiResponses,
    Anthropic,
}
#[derive(Default, Deserialize)]
#[serde(rename_all = "UPPERCASE")]
pub enum Method {
    #[default]
    Post,
    Get,
}
#[derive(Default, Deserialize)]
#[serde(tag = "mode", rename_all = "lowercase")]
pub enum Proxy {
    #[default]
    Direct,
    System,
    Saved {
        id: String,
    },
}

#[derive(Default, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Request {
    pub id: String,
    pub url: String,
    #[serde(default)]
    pub body: serde_json::Value,
    pub credential_id: Option<String>,
    pub api_key: Option<String>,
    #[serde(default)]
    pub protocol: Protocol,
    #[serde(default)]
    pub method: Method,
    #[serde(default)]
    pub proxy: Proxy,
    pub timeout_ms: Option<u64>,
    pub query: Option<HashMap<String, String>>,
    #[serde(default)]
    pub diagnostic: bool,
}

pub struct Http {
    store: Arc<Store>,
    requests: Mutex<HashMap<String, CancellationToken>>,
    client: reqwest::Client,
}
impl Http {
    fn builder() -> reqwest::ClientBuilder {
        reqwest::Client::builder()
            .redirect(reqwest::redirect::Policy::none())
            .connect_timeout(Duration::from_secs(15))
            .timeout(Duration::from_secs(45))
    }
    pub fn new(store: Arc<Store>) -> Result<Self> {
        let client = Self::builder()
            .no_proxy()
            .build()
            .map_err(|_| Error::new("http_error", "无法初始化 HTTP 客户端"))?;
        Ok(Self {
            store,
            requests: Mutex::new(HashMap::new()),
            client,
        })
    }
    fn secret(&self, id: &str, field: &str) -> Result<Zeroizing<String>> {
        let stored = self
            .store
            .get("credentials", id)?
            .ok_or_else(|| Error::new("missing_credential", "请填写并保存凭据"))?;
        let value = Store::unprotect(serde_json::from_value::<Credential>(stored)?)?;
        Ok(Zeroizing::new(
            value[field].as_str().unwrap_or("").to_owned(),
        ))
    }
    fn client(&self, proxy: &Proxy) -> Result<reqwest::Client> {
        let builder = match proxy {
            Proxy::Direct => return Ok(self.client.clone()),
            Proxy::System => Self::builder(),
            Proxy::Saved { id } => {
                let catalog = self
                    .store
                    .get("meta", "proxyServers")?
                    .ok_or_else(|| Error::new("http_proxy", "代理配置已删除，请重新选择"))?;
                let item = catalog["items"]
                    .as_array()
                    .and_then(|items| {
                        items
                            .iter()
                            .find(|item| item["id"].as_str() == Some(id.as_str()))
                    })
                    .ok_or_else(|| Error::new("http_proxy", "代理配置已删除，请重新选择"))?;
                let host = item["host"].as_str().unwrap_or("");
                let port = item["port"]
                    .as_u64()
                    .filter(|port| *port > 0 && *port <= 65535)
                    .ok_or_else(|| Error::new("http_proxy", "代理端口无效"))?;
                if host.is_empty() {
                    return Err(Error::new("http_proxy", "代理地址为空"));
                }
                let host = if host.contains(':') && !host.starts_with('[') {
                    format!("[{host}]")
                } else {
                    host.to_owned()
                };
                let scheme = match item["type"].as_str() {
                    Some("http") => "http",
                    Some("socks5") => "socks5h",
                    _ => return Err(Error::new("http_proxy", "代理类型无效")),
                };
                let mut route = reqwest::Proxy::all(format!("{scheme}://{host}:{port}"))
                    .map_err(|_| Error::new("http_proxy", "代理地址无效"))?;
                if item["authentication"].as_str() == Some("password") {
                    let password = self.secret(&format!("proxy:{id}"), "password")?;
                    route = route.basic_auth(item["username"].as_str().unwrap_or(""), &password);
                }
                Self::builder().no_proxy().proxy(route)
            }
        };
        builder
            .build()
            .map_err(|_| Error::new("http_proxy", "无法初始化模型代理"))
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
            || url.query().is_some()
            || url.fragment().is_some()
        {
            return Err(Error::new(
                "invalid_url",
                "模型地址须为不含凭据和查询参数的 HTTP 或 HTTPS 地址",
            ));
        }
        let secret = match &request.credential_id {
            Some(id) => self.secret(id, "apiKey")?,
            None => Zeroizing::new(request.api_key.unwrap_or_default()),
        };
        if secret.is_empty() {
            return Err(Error::new("missing_credential", "请填写 API Key"));
        }
        let client = self.client(&request.proxy)?;
        let token = CancellationToken::new();
        self.requests
            .lock()
            .unwrap()
            .insert(request.id.clone(), token.clone());
        let operation = async {
            let is_get = matches!(request.method, Method::Get);
            let mut http = if is_get {
                client.get(url)
            } else {
                client.post(url).json(&request.body)
            };
            if let Some(query) = &request.query {
                http = http.query(query);
            }
            http = match request.protocol {
                Protocol::Anthropic => http
                    .header("x-api-key", secret.as_str())
                    .header("anthropic-version", "2023-06-01"),
                _ => http.bearer_auth(secret.as_str()),
            };
            let response = http
                .timeout(Duration::from_millis(
                    request.timeout_ms.unwrap_or(45_000).clamp(100, 180_000),
                ))
                .send()
                .await
                .map_err(|error| transport_error(error, &request.proxy))?;
            let status = response.status().as_u16();
            if !response.status().is_success() {
                let (code, message) = match status {
                    401 => ("http_auth", "API Key 无效或已过期"),
                    403 => ("http_forbidden", "无权访问该接口或模型"),
                    404 | 405 => (
                        "http_not_found",
                        "接口路径或模型不存在，请核对地址、协议和模型 ID",
                    ),
                    407 => ("http_proxy", "代理认证失败，请检查代理凭据"),
                    429 => ("http_rate_limit", "请求受限或额度不足，请检查平台用量"),
                    500..=599 => ("http_server", "模型服务暂时不可用"),
                    300..=399 => ("http_redirect", "接口要求重定向，请填写最终 API 地址"),
                    _ => ("http_error", "模型请求失败，请检查模型与参数"),
                };
                let mut message = format!("{message}（HTTP {status}）");
                // Only configuration probes opt in; terminal requests never echo provider bodies.
                if request.diagnostic {
                    let mut bytes = Vec::new();
                    let mut stream = response.bytes_stream();
                    while let Some(Ok(chunk)) = stream.next().await {
                        let count = (4096 - bytes.len()).min(chunk.len());
                        bytes.extend_from_slice(&chunk[..count]);
                        if bytes.len() == 4096 {
                            break;
                        }
                    }
                    if let Ok(body) = serde_json::from_slice::<serde_json::Value>(&bytes) {
                        if let Some(detail) = body
                            .pointer("/error/message")
                            .and_then(|value| value.as_str())
                        {
                            let detail: String = detail
                                .replace(secret.as_str(), "[已隐藏]")
                                .chars()
                                .filter(|ch| !ch.is_control())
                                .take(300)
                                .collect();
                            message.push_str(&format!("：{detail}"));
                        }
                    }
                }
                return Err(Error::new(code, message));
            }
            let limit = if is_get { 8 * 1024 * 1024 } else { 1024 * 1024 };
            let mut bytes = Vec::new();
            let mut stream = response.bytes_stream();
            while let Some(chunk) = stream.next().await {
                let chunk = chunk.map_err(|error| transport_error(error, &request.proxy))?;
                if bytes.len() + chunk.len() > limit {
                    return Err(Error::new("response_limit", "模型响应超过大小限制"));
                }
                bytes.extend_from_slice(&chunk);
            }
            String::from_utf8(bytes)
                .map_err(|_| Error::new("invalid_response", "模型返回的文本编码无效"))
        };
        let result = tokio::select! { _ = token.cancelled() => Err(Error::cancelled()), result = operation => result };
        self.requests.lock().unwrap().remove(&request.id);
        result
    }
}
fn transport_error(error: reqwest::Error, proxy: &Proxy) -> Error {
    if error.is_timeout() {
        return Error::new("http_timeout", "模型服务请求超时，请检查网络或增加超时时间");
    }
    if !matches!(proxy, Proxy::Direct) && error.is_connect() {
        return Error::new("http_proxy", "无法通过所选代理连接模型服务，请检查代理配置");
    }
    Error::new("http_network", "无法连接模型服务，请检查地址、网络和证书")
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
            ..Request::default()
        }
    }

    #[tokio::test]
    async fn model_listing_uses_get_and_anthropic_auth_without_bearer_or_body() {
        let directory = tempfile::tempdir().unwrap();
        let http = Http::new(Arc::new(
            Store::open(&directory.path().join("state.sqlite")).unwrap(),
        ))
        .unwrap();
        let (url, task) = server("200 OK", &vec![b' '; 70 * 1024], "").await;
        let mut req = request(url);
        req.method = Method::Get;
        req.protocol = Protocol::Anthropic;
        req.query = Some(HashMap::from([("after_id".into(), "model-1".into())]));
        assert_eq!(http.request(req).await.unwrap().len(), 70 * 1024);
        let captured = task.await.unwrap().to_lowercase();
        assert!(captured.starts_with("get /chat/completions?after_id=model-1 http/1.1"));
        assert!(captured.contains("x-api-key: synthetic-secret"));
        assert!(captured.contains("anthropic-version: 2023-06-01"));
        assert!(!captured.contains("authorization:"));
        assert!(!captured.contains("content-length:"));
    }

    #[tokio::test]
    async fn configuration_probes_report_parameter_errors_but_redact_the_key() {
        let directory = tempfile::tempdir().unwrap();
        let http = Http::new(Arc::new(
            Store::open(&directory.path().join("state.sqlite")).unwrap(),
        ))
        .unwrap();
        let (url, task) = server(
            "400 Bad Request",
            br#"{"error":{"message":"Unsupported temperature for synthetic-secret"}}"#,
            "",
        )
        .await;
        let mut req = request(url);
        req.diagnostic = true;
        let error = http.request(req).await.unwrap_err();
        assert_eq!(error.code, "http_error");
        assert!(
            error
                .message
                .contains("Unsupported temperature for [已隐藏]")
        );
        assert!(!error.message.contains("synthetic-secret"));
        task.await.unwrap();
    }

    #[tokio::test]
    async fn saved_http_proxy_routes_an_unresolvable_provider_and_failure_never_retries_direct() {
        use crate::storage::Write;
        let directory = tempfile::tempdir().unwrap();
        let store = Arc::new(Store::open(&directory.path().join("state.sqlite")).unwrap());
        let (proxy_url, proxy_server) = server("200 OK", b"{}", "").await;
        let proxy_url = reqwest::Url::parse(&proxy_url).unwrap();
        store.write(vec![Write { collection: "meta".into(), key: "proxyServers".into(), value: Some(json!({"items":[{"id":"route","type":"http","host":"127.0.0.1","port":proxy_url.port().unwrap(),"authentication":"none"}]})) }], None).unwrap();
        let http = Http::new(store).unwrap();
        let mut req = request("http://provider.invalid/v1/models".into());
        req.method = Method::Get;
        req.proxy = Proxy::Saved { id: "route".into() };
        assert_eq!(http.request(req).await.unwrap(), "{}");
        assert!(
            proxy_server
                .await
                .unwrap()
                .starts_with("GET http://provider.invalid/v1/models HTTP/1.1")
        );
        let destination = TcpListener::bind("127.0.0.1:0").await.unwrap();
        let mut req = request(format!(
            "http://{}/v1/models",
            destination.local_addr().unwrap()
        ));
        req.proxy = Proxy::Saved { id: "route".into() };
        assert_eq!(http.request(req).await.unwrap_err().code, "http_proxy");
        assert!(
            tokio::time::timeout(Duration::from_millis(100), destination.accept())
                .await
                .is_err()
        );
    }

    #[tokio::test]
    async fn saved_socks_proxy_resolves_the_provider_at_the_proxy() {
        use crate::storage::Write;
        let directory = tempfile::tempdir().unwrap();
        let store = Arc::new(Store::open(&directory.path().join("state.sqlite")).unwrap());
        let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
        let port = listener.local_addr().unwrap().port();
        store.write(vec![Write { collection: "meta".into(), key: "proxyServers".into(), value: Some(json!({"items":[{"id":"socks","type":"socks5","host":"127.0.0.1","port":port,"authentication":"none"}]})) }], None).unwrap();
        let task = tokio::spawn(async move {
            let (mut socket, _) = listener.accept().await.unwrap();
            assert_eq!(socket.read_u8().await.unwrap(), 5);
            let count = socket.read_u8().await.unwrap();
            let mut methods = vec![0; count as usize];
            socket.read_exact(&mut methods).await.unwrap();
            socket.write_all(&[5, 0]).await.unwrap();
            let mut header = [0; 4];
            socket.read_exact(&mut header).await.unwrap();
            assert_eq!(header, [5, 1, 0, 3]);
            let len = socket.read_u8().await.unwrap();
            let mut name = vec![0; len as usize];
            socket.read_exact(&mut name).await.unwrap();
            assert_eq!(name, b"provider.invalid");
            assert_eq!(socket.read_u16().await.unwrap(), 80);
            socket
                .write_all(&[5, 0, 0, 1, 127, 0, 0, 1, 0, 80])
                .await
                .unwrap();
            let mut request = Vec::new();
            while !request.ends_with(b"\r\n\r\n") {
                request.push(socket.read_u8().await.unwrap());
            }
            assert!(request.starts_with(b"GET /v1/models HTTP/1.1"));
            socket
                .write_all(b"HTTP/1.1 200 OK\r\nContent-Length: 2\r\nConnection: close\r\n\r\n{}")
                .await
                .unwrap();
        });
        let http = Http::new(store).unwrap();
        let mut req = request("http://provider.invalid/v1/models".into());
        req.method = Method::Get;
        req.proxy = Proxy::Saved { id: "socks".into() };
        assert_eq!(http.request(req).await.unwrap(), "{}");
        task.await.unwrap();
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
        assert_eq!(error.message, "API Key 无效或已过期（HTTP 401）");
        assert!(
            server
                .await
                .unwrap()
                .to_lowercase()
                .contains("authorization: bearer synthetic-secret")
        );
        let (url, server) = self::server("200 OK", &vec![b'x'; 1024 * 1024 + 1], "").await;
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
