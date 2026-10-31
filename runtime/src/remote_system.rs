use crate::{
    error::{Error, Result},
    ssh::Session,
};
use russh::ChannelMsg;
use serde::{Deserialize, Serialize};
use serde_json::Value;
use std::time::Duration;

const POSIX_PROBE: &str = "printf '__SEAL_SYSTEM_V1__\\n'; uname -s; if [ -r /etc/os-release ]; then cat /etc/os-release; elif [ -r /usr/lib/os-release ]; then cat /usr/lib/os-release; fi";
const WINDOWS_PROBE: &str = "cmd /d /c ver";

#[derive(Clone, Deserialize, Serialize)]
pub struct Target {
    pub address: String,
    pub port: u16,
    pub username: String,
}

impl Target {
    pub fn matches_profile(&self, profile: &Value) -> bool {
        profile["address"] == self.address
            && profile["port"] == self.port
            && profile["username"] == self.username
    }
}

#[derive(Debug, Clone, Deserialize, Serialize, PartialEq)]
pub struct SystemInfo {
    pub family: String,
    pub id: String,
    pub name: String,
}

#[derive(Deserialize, Serialize)]
pub struct HostSystem {
    pub id: String,
    pub target: Target,
    pub info: SystemInfo,
}

pub async fn detect(session: &Session) -> Option<SystemInfo> {
    if let Ok(output) = probe(session, POSIX_PROBE).await {
        if let Some(info) = parse_posix(&output) {
            return Some(info);
        }
    }
    let output = probe(session, WINDOWS_PROBE).await.ok()?;
    output
        .to_ascii_lowercase()
        .contains("windows")
        .then(|| SystemInfo {
            family: "windows".into(),
            id: "windows".into(),
            name: "Windows".into(),
        })
}

// Optional discovery must never cancel the interactive session on timeout.
async fn probe(session: &Session, command: &str) -> Result<String> {
    let deadline = tokio::time::Instant::now() + Duration::from_secs(2);
    let open = tokio::select! {
        _ = session.cancel.cancelled() => return Err(Error::cancelled()),
        result = tokio::time::timeout_at(deadline, session.handle.channel_open_session()) => result,
    };
    let mut channel = open.map_err(|_| Error::new("timeout", "系统识别超时"))??;
    let collect = async {
        channel.exec(true, command).await?;
        channel.eof().await?;
        let mut output = Vec::new();
        let mut total = 0;
        let mut status = None;
        while let Some(message) = channel.wait().await {
            match message {
                ChannelMsg::Data { data } => {
                    total += data.len();
                    output.extend_from_slice(&data);
                }
                ChannelMsg::ExtendedData { data, .. } => total += data.len(),
                ChannelMsg::ExitStatus { exit_status } => status = Some(exit_status),
                ChannelMsg::Failure => return Err(Error::new("EXEC_DENIED", "系统识别被拒绝")),
                _ => {}
            }
            if total > 16 * 1024 {
                return Err(Error::new("output_limit", "系统识别输出超出限制"));
            }
        }
        if status != Some(0) {
            return Err(Error::new("probe_failed", "系统识别命令不可用"));
        }
        Ok(String::from_utf8_lossy(&output).into_owned())
    };
    let result = tokio::select! {
        _ = session.cancel.cancelled() => Err(Error::cancelled()),
        result = tokio::time::timeout_at(deadline, collect) => result.unwrap_or_else(|_| Err(Error::new("timeout", "系统识别超时"))),
    };
    let _ = tokio::time::timeout(Duration::from_millis(100), channel.close()).await;
    result
}

fn parse_posix(output: &str) -> Option<SystemInfo> {
    let mut lines = output
        .lines()
        .skip_while(|line| line.trim() != "__SEAL_SYSTEM_V1__");
    lines.next()?;
    let kernel = lines.next()?.trim();
    let family = match kernel {
        "Linux" => "linux",
        "Darwin" => "macos",
        "FreeBSD" => "freebsd",
        "OpenBSD" => "openbsd",
        "NetBSD" => "netbsd",
        value
            if value.starts_with("MINGW")
                || value.starts_with("MSYS")
                || value.starts_with("CYGWIN") =>
        {
            "windows"
        }
        _ => return None,
    };
    let mut id = family.to_owned();
    let mut pretty_name = None;
    let mut name = None;
    if family == "linux" {
        for line in lines {
            let Some((key, raw)) = line.split_once('=') else {
                continue;
            };
            let raw = raw.trim();
            let value = if raw.len() >= 2
                && (raw.starts_with('"') && raw.ends_with('"')
                    || raw.starts_with('\'') && raw.ends_with('\''))
            {
                &raw[1..raw.len() - 1]
            } else {
                raw
            };
            match key.trim() {
                "ID" if !value.is_empty()
                    && value
                        .bytes()
                        .all(|ch| ch.is_ascii_alphanumeric() || ch == b'_' || ch == b'-') =>
                {
                    id = value.to_ascii_lowercase()
                }
                "PRETTY_NAME" => pretty_name = Some(value.to_owned()),
                "NAME" => name = Some(value.to_owned()),
                _ => {}
            }
        }
    }
    let fallback = match family {
        "macos" => "macOS",
        "windows" => "Windows",
        _ => kernel,
    };
    let name: String = pretty_name
        .or(name)
        .unwrap_or_else(|| fallback.into())
        .chars()
        .filter(|ch| !ch.is_control())
        .take(256)
        .collect();
    Some(SystemInfo {
        family: family.into(),
        id,
        name: if name.is_empty() {
            fallback.into()
        } else {
            name
        },
    })
}

#[cfg(test)]
mod tests {
    use super::{SystemInfo, Target, parse_posix};
    use crate::storage::{Store, Write};
    use serde_json::json;

    #[test]
    fn reads_distribution_identity_without_executing_release_values() {
        let info = parse_posix("login banner\n__SEAL_SYSTEM_V1__\nLinux\nID=ubuntu\nID_LIKE=debian\nPRETTY_NAME=\"Ubuntu 24.04 LTS\"\n").unwrap();
        assert_eq!(
            info,
            SystemInfo {
                family: "linux".into(),
                id: "ubuntu".into(),
                name: "Ubuntu 24.04 LTS".into()
            }
        );
        let literal =
            parse_posix("__SEAL_SYSTEM_V1__\nLinux\nID='arch'\nNAME='$(touch sentinel)'\n")
                .unwrap();
        assert_eq!(literal.name, "$(touch sentinel)");
        assert_eq!(literal.id, "arch");
    }

    #[test]
    fn recognizes_kernel_fallbacks_and_rejects_unrelated_output() {
        for (kernel, family, name) in [
            ("Linux", "linux", "Linux"),
            ("Darwin", "macos", "macOS"),
            ("FreeBSD", "freebsd", "FreeBSD"),
            ("MINGW64_NT-10.0", "windows", "Windows"),
        ] {
            let info = parse_posix(&format!("__SEAL_SYSTEM_V1__\r\n{kernel}\r\n")).unwrap();
            assert_eq!((info.family.as_str(), info.name.as_str()), (family, name));
        }
        assert!(parse_posix("unknown command").is_none());
        assert!(parse_posix("__SEAL_SYSTEM_V1__\n").is_none());
        assert!(parse_posix("__SEAL_SYSTEM_V1__\nPlan9\n").is_none());
        let unknown =
            parse_posix("__SEAL_SYSTEM_V1__\nLinux\nID=../../ubuntu\nPRETTY_NAME=\"\"\n").unwrap();
        assert_eq!(
            (unknown.id.as_str(), unknown.name.as_str()),
            ("linux", "Linux")
        );
    }

    #[test]
    fn saves_only_for_the_current_target_without_overwriting_profile_edits() {
        let directory = tempfile::tempdir().unwrap();
        let store = Store::open(&directory.path().join("test.sqlite")).unwrap();
        let target = Target {
            address: "host".into(),
            port: 22,
            username: "root".into(),
        };
        let info = parse_posix("__SEAL_SYSTEM_V1__\nLinux\nID=ubuntu\n").unwrap();
        let mut host = json!({"id":"a","name":"Renamed during probe","address":"host","port":22,"username":"root","folderId":"new-folder"});
        let save = |value| {
            store
                .write(
                    vec![Write {
                        collection: "hosts".into(),
                        key: "a".into(),
                        value,
                    }],
                    None,
                )
                .unwrap()
        };
        save(Some(host.clone()));
        assert!(
            store
                .save_host_system("a", &target, info.clone())
                .unwrap()
                .is_some()
        );
        assert_eq!(store.get("hosts", "a").unwrap().unwrap(), host);
        assert_eq!(
            store.get("hostSystems", "a").unwrap().unwrap()["info"]["id"],
            "ubuntu"
        );
        host["address"] = json!("another-host");
        save(Some(host));
        assert!(
            store
                .save_host_system("a", &target, info.clone())
                .unwrap()
                .is_none()
        );
        save(None);
        assert!(store.get("hostSystems", "a").unwrap().is_none());
        assert!(
            store
                .save_host_system("a", &target, info)
                .unwrap()
                .is_none()
        );
    }
}
