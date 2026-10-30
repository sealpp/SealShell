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
