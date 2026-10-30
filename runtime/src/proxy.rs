use crate::error::{Error, Result};
use base64::Engine;
use serde::Deserialize;
use std::{
    future::Future,
    pin::Pin,
    task::{Context, Poll},
    time::Duration,
};
use tokio::{
    io::{AsyncRead, AsyncReadExt, AsyncWrite, AsyncWriteExt, ReadBuf},
    net::TcpStream,
};
use tokio_util::sync::{CancellationToken, WaitForCancellationFutureOwned};

#[derive(Clone, Deserialize)]
pub struct Proxy {
    #[serde(rename = "type")]
    pub kind: String,
    pub host: String,
    pub port: u16,
    pub authentication: String,
    pub username: String,
    pub password: Option<String>,
}

fn failure(stage: &str, reason: impl std::fmt::Display) -> Error {
    Error::new("PROXY_ERROR", format!("代理{stage}失败：{reason}"))
}

/// Read precisely through the handshake. Never consume coalesced SSH banner bytes.
async fn http(stream: &mut TcpStream, host: &str, port: u16, proxy: &Proxy) -> Result<()> {
    let authority = if host.contains(':') {
        format!("[{host}]:{port}")
    } else {
        format!("{host}:{port}")
    };
    if authority.bytes().any(|b| b <= 32 || b == 127) {
        return Err(failure("目标连接", "无效地址"));
    }
    let auth = if proxy.authentication == "password" {
        if proxy.username.contains(':') {
            return Err(failure("认证", "HTTP 代理用户名不能包含冒号"));
        }
        let credentials = format!(
            "{}:{}",
            proxy.username,
            proxy.password.as_deref().unwrap_or("")
        );
        format!(
            "Proxy-Authorization: Basic {}\r\n",
            base64::engine::general_purpose::STANDARD.encode(credentials)
        )
    } else {
        String::new()
    };
    stream
        .write_all(
            format!("CONNECT {authority} HTTP/1.1\r\nHost: {authority}\r\n{auth}\r\n").as_bytes(),
        )
        .await
        .map_err(|e| failure("连接", e))?;
    let mut header = Vec::new();
    while !header.ends_with(b"\r\n\r\n") {
        if header.len() >= 16 * 1024 {
            return Err(failure("目标连接", "代理响应头过大"));
        }
        header.push(stream.read_u8().await.map_err(|e| failure("目标连接", e))?);
    }
    let text = String::from_utf8_lossy(&header);
    let mut status = text.lines().next().unwrap_or("").split_whitespace();
    let version = status.next().unwrap_or("");
    let code = status.next().unwrap_or("");
    if !matches!(version, "HTTP/1.0" | "HTTP/1.1") {
        return Err(failure("目标连接", "无效 HTTP 响应"));
    }
    match code {
        "200" => Ok(()),
        "407" => Err(failure("认证", "代理拒绝了凭据")),
        _ => Err(failure("目标连接", format!("HTTP {code}"))),
    }
}

async fn socks(stream: &mut TcpStream, host: &str, port: u16, proxy: &Proxy) -> Result<()> {
    let method = if proxy.authentication == "password" {
        2
    } else {
        0
    };
    stream
        .write_all(&[5, 1, method])
        .await
        .map_err(|e| failure("连接", e))?;
    let mut reply = [0; 2];
    stream
        .read_exact(&mut reply)
        .await
        .map_err(|e| failure("认证", e))?;
    if reply != [5, method] {
        return Err(failure("认证", "代理未接受指定认证方式"));
    }
    if method == 2 {
        let user = proxy.username.as_bytes();
        let password = proxy.password.as_deref().unwrap_or("").as_bytes();
        if user.is_empty() || user.len() > 255 || password.is_empty() || password.len() > 255 {
            return Err(failure("认证", "用户名和密码必须为 1–255 字节"));
        }
        let mut request = vec![1, user.len() as u8];
        request.extend_from_slice(user);
        request.push(password.len() as u8);
        request.extend_from_slice(password);
        stream
            .write_all(&request)
            .await
            .map_err(|e| failure("认证", e))?;
        stream
            .read_exact(&mut reply)
            .await
            .map_err(|e| failure("认证", e))?;
        if reply != [1, 0] {
            return Err(failure("认证", "代理拒绝了凭据"));
        }
    }
    let mut request = vec![5, 1, 0];
    match host.parse::<std::net::IpAddr>() {
        Ok(std::net::IpAddr::V4(ip)) => {
            request.push(1);
            request.extend(ip.octets());
        }
        Ok(std::net::IpAddr::V6(ip)) => {
            request.push(4);
            request.extend(ip.octets());
        }
        Err(_) => {
            if host.is_empty() || host.len() > 255 {
                return Err(failure("目标连接", "目标域名长度无效"));
            }
            request.extend([3, host.len() as u8]);
            request.extend(host.as_bytes());
        }
    }
    request.extend(port.to_be_bytes());
    stream
        .write_all(&request)
        .await
        .map_err(|e| failure("目标连接", e))?;
    let mut header = [0; 4];
    stream
        .read_exact(&mut header)
        .await
        .map_err(|e| failure("目标连接", e))?;
    if header[0] != 5 || header[2] != 0 || header[1] != 0 {
        return Err(failure("目标连接", format!("SOCKS5 状态 {}", header[1])));
    }
    let count = match header[3] {
        1 => 4,
        4 => 16,
        3 => stream.read_u8().await.map_err(|e| failure("目标连接", e))? as usize,
        _ => return Err(failure("目标连接", "无效 SOCKS5 地址")),
    };
    let mut address = vec![0; count + 2];
    stream
        .read_exact(&mut address)
        .await
        .map_err(|e| failure("目标连接", e))?;
    Ok(())
}

pub async fn connect(
    host: &str,
    port: u16,
    proxy: Option<&Proxy>,
    cancel: &CancellationToken,
) -> Result<CancelStream> {
    let connect = async {
        let (address, service) = proxy
            .map(|p| (p.host.as_str(), p.port))
            .unwrap_or((host, port));
        let mut stream = TcpStream::connect((address, service)).await.map_err(|e| {
            if proxy.is_some() {
                failure("连接", e)
            } else {
                e.into()
            }
        })?;
        stream.set_nodelay(true)?;
        if let Some(proxy) = proxy {
            match proxy.kind.as_str() {
                "http" => http(&mut stream, host, port, proxy).await?,
                "socks5" => socks(&mut stream, host, port, proxy).await?,
                _ => return Err(failure("连接", "不支持的代理类型")),
            }
        }
        Ok(CancelStream {
            stream,
            cancelled: Box::pin(cancel.clone().cancelled_owned()),
        })
    };
    tokio::select! {
        _ = cancel.cancelled() => Err(Error::cancelled()),
        result = tokio::time::timeout(Duration::from_secs(20), connect) => result.map_err(|_| if proxy.is_some() { failure("连接", "超时") } else { Error::new("timeout", "连接超时") })?,
    }
}

/// Cancellation reaches the socket even while russh owns a pending handshake.
pub struct CancelStream {
    stream: TcpStream,
    cancelled: Pin<Box<WaitForCancellationFutureOwned>>,
}

impl CancelStream {
    fn check(&mut self, cx: &mut Context<'_>) -> std::io::Result<()> {
        if self.cancelled.as_mut().poll(cx).is_ready() {
            Err(std::io::Error::new(
                std::io::ErrorKind::ConnectionAborted,
                "session cancelled",
            ))
        } else {
            Ok(())
        }
    }
}
impl AsyncRead for CancelStream {
    fn poll_read(
        mut self: Pin<&mut Self>,
        cx: &mut Context<'_>,
        buf: &mut ReadBuf<'_>,
    ) -> Poll<std::io::Result<()>> {
        self.check(cx)?;
        Pin::new(&mut self.stream).poll_read(cx, buf)
    }
}
impl AsyncWrite for CancelStream {
    fn poll_write(
        mut self: Pin<&mut Self>,
        cx: &mut Context<'_>,
        buf: &[u8],
    ) -> Poll<std::io::Result<usize>> {
        self.check(cx)?;
        Pin::new(&mut self.stream).poll_write(cx, buf)
    }
    fn poll_flush(mut self: Pin<&mut Self>, cx: &mut Context<'_>) -> Poll<std::io::Result<()>> {
        self.check(cx)?;
        Pin::new(&mut self.stream).poll_flush(cx)
    }
    fn poll_shutdown(mut self: Pin<&mut Self>, cx: &mut Context<'_>) -> Poll<std::io::Result<()>> {
        Pin::new(&mut self.stream).poll_shutdown(cx)
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use tokio::net::TcpListener;

    #[tokio::test]
    async fn socks5_authentication_remote_dns_and_coalesced_banner() {
        for authenticated in [false, true] {
            let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
            let port = listener.local_addr().unwrap().port();
            let server = tokio::spawn(async move {
                let (mut socket, _) = listener.accept().await.unwrap();
                let mut greeting = [0; 3];
                socket.read_exact(&mut greeting).await.unwrap();
                let method = if authenticated { 2 } else { 0 };
                assert_eq!(greeting, [5, 1, method]);
                socket.write_all(&[5]).await.unwrap();
                socket.write_all(&[method]).await.unwrap();
                if authenticated {
                    assert_eq!(socket.read_u8().await.unwrap(), 1);
                    let count = socket.read_u8().await.unwrap();
                    let mut user = vec![0; count as usize];
                    socket.read_exact(&mut user).await.unwrap();
                    let count = socket.read_u8().await.unwrap();
                    let mut password = vec![0; count as usize];
                    socket.read_exact(&mut password).await.unwrap();
                    assert_eq!(user, b"alice");
                    assert_eq!(password, "密碼".as_bytes());
                    socket.write_all(&[1, 0]).await.unwrap();
                }
                let mut header = [0; 4];
                socket.read_exact(&mut header).await.unwrap();
                assert_eq!(header, [5, 1, 0, 3]);
                let count = socket.read_u8().await.unwrap();
                let mut host = vec![0; count as usize];
                socket.read_exact(&mut host).await.unwrap();
                assert_eq!(host, b"proxy-only.invalid");
                assert_eq!(socket.read_u16().await.unwrap(), 2222);
                socket.write_all(&[5, 0, 0, 4]).await.unwrap();
                let mut suffix = vec![0; 18];
                suffix.extend_from_slice(b"SSH-2.0-fixture\r\n");
                socket.write_all(&suffix).await.unwrap();
            });
            let proxy = Proxy {
                kind: "socks5".into(),
                host: "127.0.0.1".into(),
                port,
                authentication: if authenticated { "password" } else { "none" }.into(),
                username: "alice".into(),
                password: Some("密碼".into()),
            };
            let mut stream = connect(
                "proxy-only.invalid",
                2222,
                Some(&proxy),
                &CancellationToken::new(),
            )
            .await
            .unwrap();
            let mut banner = Vec::new();
            stream.read_to_end(&mut banner).await.unwrap();
            assert_eq!(banner, b"SSH-2.0-fixture\r\n");
            server.await.unwrap();
        }
    }

    #[tokio::test]
    async fn proxy_rejection_never_falls_back_to_a_reachable_direct_target() {
        let target = TcpListener::bind("127.0.0.1:0").await.unwrap();
        for status in [407, 503] {
            let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
            let port = listener.local_addr().unwrap().port();
            let server = tokio::spawn(async move {
                let (mut socket, _) = listener.accept().await.unwrap();
                let mut header = Vec::new();
                while !header.ends_with(b"\r\n\r\n") {
                    header.push(socket.read_u8().await.unwrap());
                }
                let request = String::from_utf8(header).unwrap();
                assert!(request.contains("Proxy-Authorization: Basic YWxpY2U6c2VjcmV0"));
                socket
                    .write_all(format!("HTTP/1.1 {status} Denied\r\n\r\n").as_bytes())
                    .await
                    .unwrap();
            });
            let proxy = Proxy {
                kind: "http".into(),
                host: "127.0.0.1".into(),
                port,
                authentication: "password".into(),
                username: "alice".into(),
                password: Some("secret".into()),
            };
            let error = connect(
                "127.0.0.1",
                target.local_addr().unwrap().port(),
                Some(&proxy),
                &CancellationToken::new(),
            )
            .await
            .err()
            .unwrap();
            assert_eq!(error.code, "PROXY_ERROR");
            assert!(error.message.contains(if status == 407 {
                "认证"
            } else {
                "目标连接"
            }));
            server.await.unwrap();
            assert!(
                tokio::time::timeout(Duration::from_millis(100), target.accept())
                    .await
                    .is_err()
            );
        }
    }

    #[tokio::test]
    async fn a_stalled_proxy_handshake_can_be_cancelled() {
        let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
        let port = listener.local_addr().unwrap().port();
        let proxy = Proxy {
            kind: "socks5".into(),
            host: "127.0.0.1".into(),
            port,
            authentication: "none".into(),
            username: String::new(),
            password: None,
        };
        let cancel = CancellationToken::new();
        let task_cancel = cancel.clone();
        let pending =
            tokio::spawn(async move { connect("internal", 22, Some(&proxy), &task_cancel).await });
        let (mut socket, _) = listener.accept().await.unwrap();
        let mut greeting = [0; 3];
        socket.read_exact(&mut greeting).await.unwrap();
        cancel.cancel();
        let error = tokio::time::timeout(Duration::from_secs(1), pending)
            .await
            .unwrap()
            .unwrap()
            .err()
            .unwrap();
        assert_eq!(error.code, "cancelled");
    }

    #[tokio::test]
    async fn connect_preserves_banner_coalesced_with_fragmented_http_response() {
        let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
        let port = listener.local_addr().unwrap().port();
        let server = tokio::spawn(async move {
            let (mut socket, _) = listener.accept().await.unwrap();
            let mut request = Vec::new();
            while !request.ends_with(b"\r\n\r\n") {
                request.push(socket.read_u8().await.unwrap());
            }
            assert!(
                String::from_utf8(request)
                    .unwrap()
                    .starts_with("CONNECT proxy-dns.invalid:22 ")
            );
            socket.write_all(b"HTTP/1.1 200 ").await.unwrap();
            socket
                .write_all(b"OK\r\n\r\nSSH-2.0-fixture\r\n")
                .await
                .unwrap();
        });
        let proxy = Proxy {
            kind: "http".into(),
            host: "127.0.0.1".into(),
            port,
            authentication: "none".into(),
            username: String::new(),
            password: None,
        };
        let mut stream = connect(
            "proxy-dns.invalid",
            22,
            Some(&proxy),
            &CancellationToken::new(),
        )
        .await
        .unwrap();
        let mut banner = Vec::new();
        stream.read_to_end(&mut banner).await.unwrap();
        assert_eq!(banner, b"SSH-2.0-fixture\r\n");
        server.await.unwrap();
    }
}
