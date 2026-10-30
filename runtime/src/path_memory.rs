use crate::error::{Error, Result};
use rusqlite::{Connection, OptionalExtension, params};
use serde::{Deserialize, Serialize};
use serde_json::{Value, json};
use std::collections::BTreeMap;
use std::time::{SystemTime, UNIX_EPOCH};

const MAX_NODES: usize = 4096;
const MAX_INPUTS: usize = 512;
const COLLECTION: &str = "pathMemory";

#[derive(Clone, Copy, Deserialize, Serialize, PartialEq, Eq, Debug)]
#[serde(rename_all = "lowercase")]
pub enum Kind {
    Directory,
    File,
}

#[derive(Clone, Default, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
struct Node {
    kind: Option<Kind>,
    seen_at: u64,
    used_at: u64,
    uses: u32,
    source: String,
    children: BTreeMap<String, Node>,
}

#[derive(Default, Deserialize, Serialize)]
struct Tree {
    scope: String,
    root: Node,
}

#[derive(Clone, Deserialize, Serialize, Debug)]
#[serde(rename_all = "camelCase")]
pub struct Entry {
    pub path: String,
    pub kind: Kind,
    pub seen_at: u64,
    #[serde(default)]
    pub used_at: u64,
    #[serde(default)]
    pub uses: u32,
    pub source: String,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Observation {
    path: String,
    kind: Kind,
    observed_at: u64,
    source: String,
    #[serde(default)]
    used: bool,
}

#[derive(Deserialize)]
#[serde(
    tag = "action",
    rename_all = "camelCase",
    rename_all_fields = "camelCase"
)]
pub enum Request {
    Search {
        host_id: String,
        scope: String,
        query: String,
        cwd: String,
        kind: Option<Kind>,
    },
    Observe {
        host_id: String,
        scope: String,
        generation: Option<u64>,
        entries: Vec<Observation>,
        #[serde(default)]
        missing: Vec<String>,
    },
    Clear,
}

#[derive(Default, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
struct State {
    generation: u64,
    cleared_at: u64,
}

fn now() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap()
        .as_millis() as u64
}
fn valid_path(path: &str) -> bool {
    path.starts_with('/')
        && path.len() <= 2048
        && !path.chars().any(char::is_control)
        && (path == "/"
            || !path.ends_with('/')
                && path[1..]
                    .split('/')
                    .all(|p| !p.is_empty() && p != "." && p != ".."))
        && path.split('/').count() <= 64
}
fn read<T: for<'a> Deserialize<'a> + Default>(
    db: &Connection,
    collection: &str,
    key: &str,
) -> Result<T> {
    let raw: Option<String> = db
        .query_row(
            "SELECT value FROM records WHERE collection=?1 AND key=?2",
            params![collection, key],
            |row| row.get(0),
        )
        .optional()?;
    Ok(match raw {
        Some(raw) => serde_json::from_str(&raw)?,
        None => T::default(),
    })
}
fn write<T: Serialize>(db: &Connection, collection: &str, key: &str, value: &T) -> Result<()> {
    db.execute("INSERT INTO records VALUES (?1,?2,?3) ON CONFLICT(collection,key) DO UPDATE SET value=excluded.value", params![collection,key,serde_json::to_string(value)?])?;
    Ok(())
}
fn flatten(node: &Node, path: &str, entries: &mut Vec<Entry>) {
    if let Some(kind) = node.kind {
        entries.push(Entry {
            path: path.into(),
            kind,
            seen_at: node.seen_at,
            used_at: node.used_at,
            uses: node.uses,
            source: node.source.clone(),
        });
    }
    for (name, child) in &node.children {
        flatten(
            child,
            &format!("{}/{name}", path.trim_end_matches('/')),
            entries,
        );
    }
}
fn node_mut<'a>(root: &'a mut Node, path: &str) -> &'a mut Node {
    let mut node = root;
    for name in path.split('/').filter(|s| !s.is_empty()) {
        // A newly observed descendant establishes that this ancestor is no longer a file.
        if node.kind == Some(Kind::File) {
            node.kind = None;
        }
        node = node.children.entry(name.into()).or_default();
    }
    node
}
fn remove(root: &mut Node, path: &str) {
    let components: Vec<_> = path.split('/').filter(|s| !s.is_empty()).collect();
    let mut parent = root;
    for name in components.iter().take(components.len().saturating_sub(1)) {
        let Some(child) = parent.children.get_mut(*name) else {
            return;
        };
        parent = child;
    }
    if let Some(name) = components.last() {
        parent.children.remove(*name);
    }
}
fn count(node: &Node) -> usize {
    1 + node.children.values().map(count).sum::<usize>()
}
fn missing_nodes(root: &Node, path: &str) -> usize {
    let parts: Vec<_> = path.split('/').filter(|s| !s.is_empty()).collect();
    let mut node = root;
    for (index, name) in parts.iter().enumerate() {
        match node.children.get(*name) {
            Some(child) => node = child,
            None => return parts.len() - index,
        }
    }
    0
}
fn fold(text: &str) -> String {
    text.chars()
        .filter(|c| c.is_alphanumeric())
        .flat_map(char::to_lowercase)
        .collect()
}
fn activity(entry: &Entry, time: u64) -> u64 {
    let age = time.saturating_sub(entry.used_at) / 3_600_000;
    let recency = if age < 1 {
        4
    } else if age < 24 {
        2
    } else if age < 168 {
        1
    } else {
        0
    };
    (entry.uses.min(100) as u64) * (recency + 1) + recency * 20
}
fn select(entries: &[Entry], query: &str, cwd: &str, kind: Option<Kind>, time: u64) -> Vec<Entry> {
    let terms: Vec<_> = query
        .split_whitespace()
        .skip(1)
        .filter(|t| !t.starts_with('-'))
        .map(fold)
        .filter(|t| !t.is_empty())
        .collect();
    let mut ranked: Vec<_> = entries
        .iter()
        .filter(|e| kind.is_none_or(|k| e.kind == k))
        .map(|e| {
            let full = fold(&e.path);
            let name = fold(e.path.rsplit('/').next().unwrap_or(""));
            let matching: u64 = terms
                .iter()
                .map(|t| {
                    if name == *t {
                        300
                    } else if name.starts_with(t) {
                        160
                    } else if full.contains(t) {
                        80
                    } else {
                        0
                    }
                })
                .sum();
            let local = if e
                .path
                .starts_with(&format!("{}/", cwd.trim_end_matches('/')))
            {
                10
            } else {
                0
            };
            (matching, activity(e, time) + local, e)
        })
        .collect();
    ranked.sort_by(|a, b| {
        b.0.cmp(&a.0)
            .then(b.1.cmp(&a.1))
            .then(b.2.seen_at.cmp(&a.2.seen_at))
            .then(a.2.path.cmp(&b.2.path))
    });
    let mut selected: Vec<Entry> = ranked
        .iter()
        .filter(|r| r.0 > 0)
        .take(16)
        .map(|r| r.2.clone())
        .collect();
    // Reserve space for semantic targets that share no literal name with the input.
    ranked.sort_by(|a, b| {
        b.1.cmp(&a.1)
            .then(b.2.seen_at.cmp(&a.2.seen_at))
            .then(a.2.path.cmp(&b.2.path))
    });
    let mut branches: Vec<String> = selected
        .iter()
        .map(|e| e.path.rsplit_once('/').unwrap().0.to_owned())
        .collect();
    for (_, _, entry) in &ranked {
        if selected.len() == 24 {
            break;
        }
        let parent = entry.path.rsplit_once('/').unwrap().0;
        if !branches.iter().any(|p| p == parent) {
            selected.push((*entry).clone());
            branches.push(parent.to_owned());
        }
    }
    for (_, _, entry) in ranked {
        if selected.len() == 24 {
            break;
        }
        if !selected.iter().any(|e| e.path == entry.path) {
            selected.push(entry.clone());
        }
    }
    selected
}
fn prune(tree: &mut Tree, time: u64) -> usize {
    let mut entries = Vec::new();
    flatten(&tree.root, "/", &mut entries);
    let before = entries.len();
    entries.retain(|e| {
        time.saturating_sub(e.seen_at) < 90 * 86_400_000
            || e.uses > 0 && time.saturating_sub(e.used_at) < 180 * 86_400_000
    });
    entries.sort_by(|a, b| {
        activity(b, time)
            .cmp(&activity(a, time))
            .then(b.seen_at.cmp(&a.seen_at))
    });
    let mut root = Node::default();
    let mut kept = 0;
    let mut nodes = 1;
    for entry in entries {
        let extra = missing_nodes(&root, &entry.path);
        if nodes + extra > MAX_NODES {
            continue;
        }
        let node = node_mut(&mut root, &entry.path);
        node.kind = Some(entry.kind);
        node.seen_at = entry.seen_at;
        node.used_at = entry.used_at;
        node.uses = entry.uses;
        node.source = entry.source;
        nodes += extra;
        kept += 1;
    }
    tree.root = root;
    before - kept
}

/// The caller holds the store mutex; each merge and clear is one SQLite transaction.
pub fn call(db: &mut Connection, request: Request) -> Result<Value> {
    let tx = db.transaction()?;
    let mut state: State = read(&tx, "meta", "pathMemoryState")?;
    if matches!(request, Request::Clear) {
        state.generation += 1;
        state.cleared_at = now();
        tx.execute("DELETE FROM records WHERE collection=?1", [COLLECTION])?;
        write(&tx, "meta", "pathMemoryState", &state)?;
        tx.commit()?;
        return Ok(json!({"generation":state.generation}));
    }
    let (host_id, scope) = match &request {
        Request::Search { host_id, scope, .. } | Request::Observe { host_id, scope, .. } => {
            (host_id, scope)
        }
        Request::Clear => unreachable!(),
    };
    if host_id.is_empty() || scope.is_empty() || scope.len() > 4096 {
        return Err(Error::new("invalid_argument", "路径记忆作用域不可用"));
    }
    let exists: bool = tx.query_row(
        "SELECT EXISTS(SELECT 1 FROM records WHERE collection='hosts' AND key=?1)",
        [host_id],
        |r| r.get(0),
    )?;
    if !exists {
        return Ok(
            json!({"generation":state.generation,"entries":[],"stored":0,"available":false}),
        );
    }
    let mut tree: Tree = read(&tx, COLLECTION, host_id)?;
    if tree.scope != *scope {
        tree = Tree {
            scope: scope.clone(),
            ..Tree::default()
        };
    }
    let time = now();
    let result = match request {
        Request::Search {
            query, cwd, kind, ..
        } => {
            let mut entries = Vec::new();
            flatten(&tree.root, "/", &mut entries);
            json!({"generation":state.generation,"available":true,"stored":count(&tree.root),"entries":select(&entries,&query,&cwd,kind,time)})
        }
        Request::Observe {
            host_id,
            generation,
            entries,
            missing,
            ..
        } => {
            if entries.len() + missing.len() > MAX_INPUTS {
                return Err(Error::new("invalid_argument", "路径记忆条目超限"));
            }
            if generation.is_some_and(|g| g != state.generation) {
                return Ok(json!({"generation":state.generation,"ignored":true}));
            }
            for path in missing {
                if valid_path(&path) && path != "/" {
                    remove(&mut tree.root, &path);
                }
            }
            for entry in entries {
                if !valid_path(&entry.path)
                    || entry.observed_at <= state.cleared_at
                    || entry.observed_at > time + 1000
                {
                    continue;
                }
                if !["context", "cwd", "sftp"].contains(&entry.source.as_str()) {
                    return Err(Error::new("invalid_argument", "路径记忆来源不可用"));
                }
                let node = node_mut(&mut tree.root, &entry.path);
                if entry.observed_at >= node.seen_at {
                    node.kind = Some(entry.kind);
                    node.seen_at = entry.observed_at;
                    node.source = entry.source;
                    if entry.kind == Kind::File {
                        node.children.clear();
                    }
                }
                if entry.used && entry.observed_at > node.used_at {
                    node.uses = node.uses.saturating_add(1);
                    node.used_at = entry.observed_at;
                }
            }
            let pruned = prune(&mut tree, time);
            write(&tx, COLLECTION, &host_id, &tree)?;
            json!({"generation":state.generation,"stored":count(&tree.root),"pruned":pruned})
        }
        Request::Clear => unreachable!(),
    };
    tx.commit()?;
    Ok(result)
}

#[cfg(test)]
mod tests {
    use super::*;
    fn run(db: &mut Connection, value: Value) -> Value {
        call(db, serde_json::from_value(value).unwrap()).unwrap()
    }
    fn database() -> Connection {
        let db = Connection::open_in_memory().unwrap();
        db.execute_batch("CREATE TABLE records(collection TEXT,key TEXT,value TEXT,PRIMARY KEY(collection,key)); INSERT INTO records VALUES('hosts','a','{}'); INSERT INTO records VALUES('hosts','b','{}');").unwrap();
        db
    }
    fn observe(db: &mut Connection, path: &str, used: bool) {
        run(
            db,
            json!({"action":"observe","hostId":"a","scope":"login","entries":[{"path":path,"kind":"directory","source":"cwd","observedAt":now(),"used":used}]}),
        );
    }
    fn search(db: &mut Connection, host: &str, scope: &str) -> Value {
        run(
            db,
            json!({"action":"search","hostId":host,"scope":scope,"query":"cd aiecho","cwd":"/root","kind":"directory"}),
        )
    }
    #[test]
    fn tree_merges_overlaps_and_observation_does_not_count_as_usage() {
        let mut db = database();
        observe(&mut db, "/data/aiecho", true);
        observe(&mut db, "/data/aiecho/src", false);
        observe(&mut db, "/data/aiecho", false);
        let result = search(&mut db, "a", "login");
        assert_eq!(result["stored"], 4);
        assert_eq!(result["entries"][0]["path"], "/data/aiecho");
        assert_eq!(result["entries"][0]["uses"], 1);
        assert!(
            search(&mut db, "b", "login")["entries"]
                .as_array()
                .unwrap()
                .is_empty()
        );
        assert!(
            search(&mut db, "a", "other-namespace")["entries"]
                .as_array()
                .unwrap()
                .is_empty()
        );
    }
    #[test]
    fn clear_rejects_late_observations_and_deleted_hosts_cannot_return() {
        let mut db = database();
        observe(&mut db, "/data/aiecho", true);
        run(&mut db, json!({"action":"clear"}));
        run(
            &mut db,
            json!({"action":"observe","hostId":"a","scope":"login","generation":0,"entries":[{"path":"/old","kind":"directory","source":"context","observedAt":now()}]}),
        );
        assert!(
            search(&mut db, "a", "login")["entries"]
                .as_array()
                .unwrap()
                .is_empty()
        );
        db.execute(
            "DELETE FROM records WHERE collection='hosts' AND key='a'",
            [],
        )
        .unwrap();
        observe(&mut db, "/no-resurrection", true);
        assert_eq!(search(&mut db, "a", "login")["available"], false);
    }
    #[test]
    fn full_paths_match_ancestors_and_exact_targets_lead_popular_near_matches() {
        let mut db = database();
        observe(&mut db, "/root/echo", true);
        observe(&mut db, "/data/aiecho", false);
        assert_eq!(
            search(&mut db, "a", "login")["entries"][0]["path"],
            "/data/aiecho"
        );
        run(
            &mut db,
            json!({"action":"observe","hostId":"a","scope":"login","entries":[{"path":"/srv/nginx/logs/console.log","kind":"file","source":"sftp","observedAt":now(),"used":true}]}),
        );
        let result = run(
            &mut db,
            json!({"action":"search","hostId":"a","scope":"login","query":"tail -f nginx","cwd":"/root","kind":"file"}),
        );
        assert_eq!(result["entries"][0]["path"], "/srv/nginx/logs/console.log");
        run(
            &mut db,
            json!({"action":"observe","hostId":"a","scope":"login","entries":[],"missing":["/srv/nginx"]}),
        );
        assert_eq!(
            run(
                &mut db,
                json!({"action":"search","hostId":"a","scope":"login","query":"tail nginx","cwd":"/root","kind":"file"})
            )["entries"],
            json!([])
        );
    }
    #[test]
    fn memory_survives_reopening_sqlite_and_stays_bounded() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("memory.sqlite");
        let mut db = Connection::open(&path).unwrap();
        db.execute_batch("CREATE TABLE records(collection TEXT,key TEXT,value TEXT,PRIMARY KEY(collection,key)); INSERT INTO records VALUES('hosts','a','{}');").unwrap();
        observe(&mut db, "/data/aiecho", true);
        drop(db);
        let mut db = Connection::open(path).unwrap();
        assert_eq!(
            search(&mut db, "a", "login")["entries"][0]["path"],
            "/data/aiecho"
        );
        let mut tree = Tree::default();
        for i in 0..5000 {
            let node = node_mut(&mut tree.root, &format!("/data/project{i}"));
            node.kind = Some(Kind::Directory);
            node.seen_at = now();
        }
        assert!(prune(&mut tree, now()) > 0);
        assert!(count(&tree.root) <= MAX_NODES);
    }
    #[test]
    fn semantic_fallback_keeps_multiple_working_branches() {
        let mut entries: Vec<_> = (0..30)
            .map(|i| Entry {
                path: format!("/srv/first/logs/{i}.log"),
                kind: Kind::File,
                seen_at: now(),
                used_at: now(),
                uses: 10,
                source: "context".into(),
            })
            .collect();
        entries.push(Entry {
            path: "/srv/second/logs/console.log".into(),
            kind: Kind::File,
            seen_at: now(),
            used_at: 0,
            uses: 0,
            source: "context".into(),
        });
        let selected = select(
            &entries,
            "tail -f 应用日志",
            "/root",
            Some(Kind::File),
            now(),
        );
        assert_eq!(selected.len(), 24);
        assert!(selected.iter().any(|e| e.path.starts_with("/srv/second/")));
    }
}
