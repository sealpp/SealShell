use seal_runtime::runtime::Runtime;
use serde_json::{Value, json};
use std::{
    io::{BufRead, BufReader},
    path::PathBuf,
    process::{Child, Command, Stdio},
    sync::Arc,
    time::Duration,
};
use tokio::{
    io::{AsyncReadExt, AsyncWriteExt},
    net::{TcpListener, TcpStream},
};

struct Fixture(Child);
impl Drop for Fixture {
    fn drop(&mut self) {
        let _ = self.0.kill();
        let _ = self.0.wait();
    }
}

#[tokio::test(flavor = "multi_thread")]
async fn native_ssh_sftp_transfers_and_forwarding() {
    let root = PathBuf::from(env!("CARGO_MANIFEST_DIR"))
        .parent()
        .unwrap()
        .to_owned();
    let python = std::env::var("SEAL_PYTHON")
        .map(PathBuf::from)
        .unwrap_or_else(|_| root.join("node/.venv/Scripts/python.exe"));
    let directory = tempfile::tempdir().unwrap();
    let remote = directory.path().join("remote");
    std::fs::create_dir(&remote).unwrap();
    let control = directory.path().join("control.json");
    std::fs::write(&control, b"{}").unwrap();
    let mut child = Command::new(python)
        .arg(root.join(".agents/skills/seal-e2e/mock-ssh-server.py"))
        .env("MOCK_SFTP_ROOT", &remote)
        .env("MOCK_SFTP_CONTROL_PATH", &control)
        .env("PYTHONIOENCODING", "utf-8")
        .env("MOCK_SSH_PASSWORD", "fixture-password")
        .env("MOCK_SSH_FORWARDING", "1")
        .env("MOCK_SSH_STATE_PATH", directory.path().join("state.json"))
        .env("MOCK_SSH_REPORT_CWD", "1")
        .stdout(Stdio::piped())
        .stderr(Stdio::inherit())
        .spawn()
        .expect("run scripts/setup.py to install mock SSH dependencies");
    let mut line = String::new();
    BufReader::new(child.stdout.take().unwrap())
        .read_line(&mut line)
        .unwrap();
    let _fixture = Fixture(child);
    let port: u16 = line
        .trim()
        .strip_prefix("MOCK_SSH_PORT=")
        .expect(&line)
        .parse()
        .unwrap();
    let (send, mut events) = tokio::sync::mpsc::unbounded_channel();
    let runtime = Arc::new(
        Runtime::new(
            &directory.path().join("data"),
            Arc::new(move |event| {
                let _ = send.send(event);
            }),
        )
        .unwrap(),
    );
    let approval_runtime = runtime.clone();
    let (output_send, mut outputs) = tokio::sync::mpsc::unbounded_channel();
    let event_task = tokio::spawn(async move {
        while let Some(event) = events.recv().await {
            if event["type"] == "hostKey" {
                approval_runtime
                    .call(
                        "host_key_decision",
                        json!({"requestId":event["requestId"],"accepted":true}),
                    )
                    .await
                    .unwrap();
            } else if event["type"] == "conflict" {
                approval_runtime
                    .call(
                        "transfer_decision",
                        json!({"requestId":event["requestId"],"decision":{"action":"replace"}}),
                    )
                    .await
                    .unwrap();
            } else {
                let _ = output_send.send(event);
            }
        }
    });
    let connection =
        json!({"host":"127.0.0.1","port":port,"username":"fixture","password":"fixture-password"});
    tokio::time::timeout(
        Duration::from_secs(15),
        runtime.call(
            "ssh_connect",
            json!({"id":"terminal","connection":connection}),
        ),
    )
    .await
    .unwrap()
    .unwrap();
    let output = runtime
        .call(
            "ssh_exec",
            json!({"id":"terminal","command":"printf exec-ok"}),
        )
        .await
        .unwrap();
    assert_eq!(
        String::from_utf8(serde_json::from_value(output["stdout"].clone()).unwrap()).unwrap(),
        "exec-ok"
    );
    runtime
        .call(
            "ssh_shell",
            json!({"id":"terminal","columns":117,"rows":39}),
        )
        .await
        .unwrap();
    runtime
        .call(
            "ssh_send",
            json!({"id":"terminal","data":b"pwd\n".to_vec()}),
        )
        .await
        .unwrap();
    tokio::time::timeout(Duration::from_secs(5), async {
        while let Some(event) = outputs.recv().await {
            if event["type"] == "output" {
                break;
            }
        }
    })
    .await
    .unwrap();
    let state: Value =
        serde_json::from_slice(&std::fs::read(directory.path().join("state.json")).unwrap())
            .unwrap();
    assert_eq!(state["shell_initial_sizes"]["1"], json!([117, 39]));
    runtime
        .call(
            "file_connect",
            json!({"id":"local","endpoint":{"kind":"local"}}),
        )
        .await
        .unwrap();
    runtime
        .call(
            "file_connect",
            json!({"id":"remote","endpoint":{"kind":"sftp","connection":connection}}),
        )
        .await
        .unwrap();
    let data: Vec<u8> = (0..3 * 1024 * 1024).map(|i| (i % 251) as u8).collect();
    let source = directory.path().join("large.bin");
    std::fs::write(&source, &data).unwrap();
    runtime.call("transfer_enqueue",json!({"id":"upload","label":"upload","sourceId":"local","targetId":"remote","paths":[source],"directory":"/"})).await.unwrap();
    tokio::time::timeout(
        Duration::from_secs(30),
        runtime.call("transfer_wait", json!({"id":"upload"})),
    )
    .await
    .unwrap()
    .unwrap();
    assert_eq!(std::fs::read(remote.join("large.bin")).unwrap(), data);
    let destination = directory.path().join("download");
    std::fs::create_dir(&destination).unwrap();
    runtime.call("transfer_enqueue",json!({"id":"download","label":"download","sourceId":"remote","targetId":"local","paths":["/large.bin"],"directory":destination})).await.unwrap();
    // A task owns snapshots and continues after both originating panes close.
    runtime
        .call("file_close", json!({"id":"local"}))
        .await
        .unwrap();
    runtime
        .call("file_close", json!({"id":"remote"}))
        .await
        .unwrap();
    tokio::time::timeout(
        Duration::from_secs(30),
        runtime.call("transfer_wait", json!({"id":"download"})),
    )
    .await
    .unwrap()
    .unwrap();
    assert_eq!(std::fs::read(destination.join("large.bin")).unwrap(), data);
    // Rollback, cancellation, queue ownership and retained paths use the real
    // SFTP server; fault injection is confined to the fixture.
    runtime
        .call(
            "file_connect",
            json!({"id":"local","endpoint":{"kind":"local"}}),
        )
        .await
        .unwrap();
    runtime
        .call(
            "file_connect",
            json!({"id":"remote","endpoint":{"kind":"sftp","connection":connection}}),
        )
        .await
        .unwrap();
    let set_control = |value: Value| {
        let pending = control.with_extension("pending");
        std::fs::write(&pending, serde_json::to_vec(&value).unwrap()).unwrap();
        std::fs::rename(pending, &control).unwrap();
    };
    set_control(json!({"failRead":true}));
    std::fs::write(destination.join("large.bin"), b"preserve original").unwrap();
    runtime.call("transfer_enqueue",json!({"id":"failed-read","label":"failed-read","sourceId":"remote","targetId":"local","paths":["/large.bin"],"directory":destination})).await.unwrap();
    assert!(
        runtime
            .call("transfer_wait", json!({"id":"failed-read"}))
            .await
            .is_err()
    );
    assert_eq!(
        std::fs::read(destination.join("large.bin")).unwrap(),
        b"preserve original"
    );
    set_control(json!({"failCommitTarget":"/large.bin"}));
    std::fs::write(&source, b"replacement").unwrap();
    runtime.call("transfer_enqueue",json!({"id":"rollback","label":"rollback","sourceId":"local","targetId":"remote","paths":[source],"directory":"/"})).await.unwrap();
    assert!(
        runtime
            .call("transfer_wait", json!({"id":"rollback"}))
            .await
            .is_err()
    );
    assert_eq!(std::fs::read(remote.join("large.bin")).unwrap(), data);
    set_control(json!({"writeDelayMs":1000,"failCleanup":true}));
    let before: Value =
        serde_json::from_slice(&std::fs::read(directory.path().join("state.json")).unwrap())
            .unwrap();
    runtime
        .call("transfer_concurrency", json!({"value":1}))
        .await
        .unwrap();
    runtime.call("transfer_enqueue",json!({"id":"cancel","label":"cancel","sourceId":"local","targetId":"remote","paths":[source],"directory":"/"})).await.unwrap();
    runtime.call("transfer_enqueue",json!({"id":"queued","label":"queued","sourceId":"local","targetId":"remote","paths":[source],"directory":"/"})).await.unwrap();
    assert_eq!(
        runtime
            .call("transfer_cancel", json!({"id":"queued"}))
            .await
            .unwrap(),
        true
    );
    assert_eq!(
        runtime
            .call("transfer_dismiss", json!({"id":"queued"}))
            .await
            .unwrap(),
        true
    );
    assert_eq!(
        runtime
            .call("transfer_retry", json!({"id":"queued"}))
            .await
            .unwrap(),
        false
    );
    assert_eq!(
        runtime
            .call("transfer_dismiss", json!({"id":"upload"}))
            .await
            .unwrap(),
        true
    );
    tokio::time::timeout(Duration::from_secs(5), async {
        loop {
            let state = std::fs::read(directory.path().join("state.json"))
                .ok()
                .and_then(|b| serde_json::from_slice::<Value>(&b).ok());
            if state.is_some_and(|v| {
                v["sftp_writes"].as_u64().unwrap_or(0) > before["sftp_writes"].as_u64().unwrap_or(0)
            }) {
                break;
            }
            tokio::time::sleep(Duration::from_millis(20)).await;
        }
    })
    .await
    .unwrap();
    runtime
        .call("transfer_cancel", json!({"id":"cancel"}))
        .await
        .unwrap();
    let error = tokio::time::timeout(
        Duration::from_secs(5),
        runtime.call("transfer_wait", json!({"id":"cancel"})),
    )
    .await
    .unwrap()
    .unwrap_err();
    assert_eq!(error.code, "cancelled");
    let orphan = error
        .orphan_path
        .expect("cleanup failure must report staging");
    assert!(remote.join(orphan.trim_start_matches('/')).exists());
    assert_eq!(std::fs::read(remote.join("large.bin")).unwrap(), data);
    set_control(json!({}));
    assert_eq!(
        runtime
            .call("transfer_retry", json!({"id":"cancel"}))
            .await
            .unwrap(),
        true
    );
    runtime
        .call("transfer_wait", json!({"id":"cancel"}))
        .await
        .unwrap();
    assert_eq!(
        std::fs::read(remote.join("large.bin")).unwrap(),
        b"replacement"
    );
    let tasks = runtime.call("transfer_list", json!({})).await.unwrap();
    assert_eq!(
        tasks
            .as_array()
            .unwrap()
            .iter()
            .find(|t| t["id"] == "cancel")
            .unwrap()["orphanPath"],
        orphan
    );
    let echo = TcpListener::bind("127.0.0.1:0").await.unwrap();
    let echo_port = echo.local_addr().unwrap().port();
    let echo_task = tokio::spawn(async move {
        let (mut socket, _) = echo.accept().await.unwrap();
        let mut request = Vec::new();
        socket.read_to_end(&mut request).await.unwrap();
        assert_eq!(request, b"request before FIN");
        socket.write_all(b"response after FIN").await.unwrap();
        socket.shutdown().await.unwrap();
    });
    let occupied = TcpListener::bind("127.0.0.1:0").await.unwrap();
    let occupied_port = occupied.local_addr().unwrap().port();
    let actual=runtime.call("forward_start",json!({"id":"forward","connection":connection,"target":{"host":"127.0.0.1","port":echo_port,"localPort":occupied_port},"bindHost":"127.0.0.1"})).await.unwrap().as_u64().unwrap() as u16;
    assert_ne!(actual, occupied_port);
    let mut socket = TcpStream::connect(("127.0.0.1", actual)).await.unwrap();
    socket.write_all(b"request before FIN").await.unwrap();
    socket.shutdown().await.unwrap();
    let mut response = Vec::new();
    tokio::time::timeout(Duration::from_secs(5), socket.read_to_end(&mut response))
        .await
        .unwrap()
        .unwrap();
    assert_eq!(response, b"response after FIN");
    echo_task.await.unwrap();
    runtime
        .call("forward_close", json!({"id":"forward"}))
        .await
        .unwrap();
    assert!(TcpStream::connect(("127.0.0.1", actual)).await.is_err());
    runtime
        .call("ssh_close", json!({"id":"terminal"}))
        .await
        .unwrap();
    let mut bad = connection.clone();
    bad["password"] = json!("wrong");
    let failure = runtime
        .call("ssh_connect", json!({"id":"bad-password","connection":bad}))
        .await
        .unwrap_err();
    assert_eq!(failure.code, "AUTHENTICATION_FAILED");
    runtime.call("store_write",json!({"changes":[{"collection":"knownHosts","key":format!("127.0.0.1\0{port}"),"value":{"publicKey":"changed"}}]})).await.unwrap();
    let failure = runtime
        .call(
            "ssh_connect",
            json!({"id":"changed-key","connection":connection}),
        )
        .await
        .unwrap_err();
    assert_eq!(failure.code, "HOST_KEY_MISMATCH");
    runtime.close_all();
    event_task.abort();
    let _ = event_task.await;
}
