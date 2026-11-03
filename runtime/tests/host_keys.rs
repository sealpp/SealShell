use seal_runtime::runtime::Runtime;
use serde_json::{Value, json};
use std::{
    io::{BufRead, BufReader},
    path::PathBuf,
    process::{Child, Command, Stdio},
    sync::Arc,
    time::Duration,
};
use tokio::sync::mpsc::{UnboundedReceiver, unbounded_channel};

struct Fixture(Child);
impl Drop for Fixture {
    fn drop(&mut self) {
        let _ = self.0.kill();
        let _ = self.0.wait();
    }
}

async fn next_prompt(events: &mut UnboundedReceiver<Value>) -> Value {
    tokio::time::timeout(Duration::from_secs(5), async {
        loop {
            let event = events.recv().await.unwrap();
            if event["type"] == "hostKey" {
                return event;
            }
        }
    })
    .await
    .expect("an unknown or changed key must request confirmation")
}

#[tokio::test(flavor = "multi_thread")]
async fn changed_host_keys_wait_for_confirmation_and_only_save_on_acceptance() {
    let root = PathBuf::from(env!("CARGO_MANIFEST_DIR"))
        .parent()
        .unwrap()
        .to_owned();
    let python = std::env::var("SEAL_PYTHON")
        .map(PathBuf::from)
        .unwrap_or_else(|_| root.join(".venv/Scripts/python.exe"));
    let directory = tempfile::tempdir().unwrap();
    let mut child = Command::new(python)
        .arg(root.join(".agents/skills/seal-e2e/mock-ssh-server.py"))
        .env("MOCK_SFTP_ROOT", directory.path().join("remote"))
        .env("MOCK_SSH_PASSWORD", "fixture-password")
        .env("PYTHONIOENCODING", "utf-8")
        .stdout(Stdio::piped())
        .stderr(Stdio::inherit())
        .spawn()
        .unwrap();
    let mut line = String::new();
    BufReader::new(child.stdout.take().unwrap())
        .read_line(&mut line)
        .unwrap();
    let _fixture = Fixture(child);
    let port: u16 = line
        .trim()
        .strip_prefix("MOCK_SSH_PORT=")
        .unwrap()
        .parse()
        .unwrap();
    let (send, mut events) = unbounded_channel();
    let data = directory.path().join("data");
    let runtime = Arc::new(
        Runtime::new(
            &data,
            Arc::new(move |event| {
                let _ = send.send(event);
            }),
        )
        .unwrap(),
    );
    let connection =
        json!({"host":"127.0.0.1","port":port,"username":"fixture","password":"fixture-password"});
    let key = format!("127.0.0.1\0{port}");
    let read = json!({"collection":"knownHosts","key":key});
    let connect = |id: &'static str| {
        let runtime = runtime.clone();
        let connection = connection.clone();
        tokio::spawn(async move {
            runtime
                .call("ssh_connect", json!({"id":id,"connection":connection}))
                .await
        })
    };

    let rejected = connect("first-rejected");
    let first = next_prompt(&mut events).await;
    assert!(first["previousFingerprint"].is_null());
    assert!(
        runtime
            .call("store_get", read.clone())
            .await
            .unwrap()
            .is_null()
    );
    runtime
        .call(
            "host_key_decision",
            json!({"requestId":first["requestId"],"accepted":false}),
        )
        .await
        .unwrap();
    assert!(rejected.await.unwrap().is_err());
    assert!(
        runtime
            .call("store_get", read.clone())
            .await
            .unwrap()
            .is_null()
    );

    let accepted = connect("first-accepted");
    let first = next_prompt(&mut events).await;
    assert!(first["previousFingerprint"].is_null());
    runtime
        .call(
            "host_key_decision",
            json!({"requestId":first["requestId"],"accepted":true}),
        )
        .await
        .unwrap();
    accepted.await.unwrap().unwrap();
    let trusted = runtime.call("store_get", read.clone()).await.unwrap();
    assert_eq!(trusted["fingerprint"], first["fingerprint"]);
    runtime
        .call("ssh_close", json!({"id":"first-accepted"}))
        .await
        .unwrap();

    let mut previous = trusted.clone();
    previous["publicKey"] = json!("previous-server-key");
    previous["fingerprint"] = json!("SHA256:previous-server-fingerprint");
    runtime
        .call(
            "store_write",
            json!({"changes":[{"collection":"knownHosts","key":key,"value":previous}]}),
        )
        .await
        .unwrap();

    for (id, close_session) in [("changed-rejected", false), ("changed-cancelled", true)] {
        let attempt = connect(id);
        let prompt = next_prompt(&mut events).await;
        assert_eq!(prompt["previousFingerprint"], previous["fingerprint"]);
        assert_eq!(prompt["fingerprint"], trusted["fingerprint"]);
        assert!(
            !attempt.is_finished(),
            "connection must wait for a decision"
        );
        assert_eq!(
            runtime.call("store_get", read.clone()).await.unwrap(),
            previous
        );
        if close_session {
            runtime.call("ssh_close", json!({"id":id})).await.unwrap();
        } else {
            runtime
                .call(
                    "host_key_decision",
                    json!({"requestId":prompt["requestId"],"accepted":false}),
                )
                .await
                .unwrap();
        }
        assert!(attempt.await.unwrap().is_err());
        // A late response after closing the session must not change trust.
        runtime
            .call(
                "host_key_decision",
                json!({"requestId":prompt["requestId"],"accepted":true}),
            )
            .await
            .unwrap();
        assert_eq!(
            runtime.call("store_get", read.clone()).await.unwrap(),
            previous
        );
    }

    let accepted = connect("changed-accepted");
    let prompt = next_prompt(&mut events).await;
    assert_eq!(prompt["previousFingerprint"], previous["fingerprint"]);
    runtime
        .call(
            "host_key_decision",
            json!({"requestId":prompt["requestId"],"accepted":true}),
        )
        .await
        .unwrap();
    accepted.await.unwrap().unwrap();
    assert_eq!(
        runtime.call("store_get", read.clone()).await.unwrap(),
        trusted
    );
    runtime
        .call("ssh_close", json!({"id":"changed-accepted"}))
        .await
        .unwrap();
    while events.try_recv().is_ok() {}

    let unchanged = connect("unchanged");
    tokio::time::timeout(Duration::from_secs(5), unchanged)
        .await
        .unwrap()
        .unwrap()
        .unwrap();
    assert!(
        events.try_recv().is_err(),
        "a trusted key must not prompt again"
    );
    runtime.close_all();

    let restored = Runtime::new(&data, Arc::new(|_| {})).unwrap();
    assert_eq!(restored.call("store_get", read).await.unwrap(), trusted);
}
