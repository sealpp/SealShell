use crate::error::{Error, Result};
use rusqlite::{Connection, OptionalExtension, params};
use serde::{Deserialize, Serialize};
use serde_json::Value;
use std::{path::Path, sync::Mutex};

pub struct Store(Mutex<Connection>);

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Write {
    pub collection: String,
    pub key: String,
    pub value: Option<Value>,
}

#[derive(Deserialize, Serialize)]
pub struct Credential {
    pub id: String,
    pub ciphertext: String,
}

impl Store {
    pub fn open(path: &Path) -> Result<Self> {
        if let Some(parent) = path.parent() {
            std::fs::create_dir_all(parent)?;
        }
        let connection = Connection::open(path)?;
        connection.execute_batch(
            "PRAGMA journal_mode=WAL; PRAGMA foreign_keys=ON;
            CREATE TABLE IF NOT EXISTS records (
                collection TEXT NOT NULL, key TEXT NOT NULL, value TEXT NOT NULL,
                PRIMARY KEY(collection, key));",
        )?;
        Ok(Self(Mutex::new(connection)))
    }

    pub fn get(&self, collection: &str, key: &str) -> Result<Option<Value>> {
        let connection = self.0.lock().unwrap();
        let raw: Option<String> = connection
            .query_row(
                "SELECT value FROM records WHERE collection=?1 AND key=?2",
                params![collection, key],
                |r| r.get(0),
            )
            .optional()?;
        raw.map(|v| serde_json::from_str(&v).map_err(Into::into))
            .transpose()
    }

    pub fn list(&self, collection: &str) -> Result<Vec<Value>> {
        let connection = self.0.lock().unwrap();
        let mut statement =
            connection.prepare("SELECT value FROM records WHERE collection=?1 ORDER BY key")?;
        let rows = statement.query_map([collection], |row| row.get::<_, String>(0))?;
        rows.map(|row| Ok(serde_json::from_str(&row?)?)).collect()
    }

    /// A batch either commits fully or rolls back, including profile/credential edits.
    pub fn write(&self, changes: Vec<Write>, require_host: Option<&str>) -> Result<bool> {
        let mut connection = self.0.lock().unwrap();
        let transaction = connection.transaction()?;
        if let Some(host) = require_host {
            let exists: bool = transaction.query_row(
                "SELECT EXISTS(SELECT 1 FROM records WHERE collection='hosts' AND key=?1)",
                [host],
                |r| r.get(0),
            )?;
            if !exists {
                return Ok(false);
            }
        }
        for change in changes {
            if let Some(value) = change.value {
                transaction.execute("INSERT INTO records VALUES (?1, ?2, ?3) ON CONFLICT(collection,key) DO UPDATE SET value=excluded.value",
                    params![change.collection, change.key, serde_json::to_string(&value)?])?;
            } else {
                transaction.execute(
                    "DELETE FROM records WHERE collection=?1 AND key=?2",
                    params![change.collection, change.key],
                )?;
            }
        }
        transaction.commit()?;
        Ok(true)
    }

    pub fn protect(id: String, value: Value) -> Result<Credential> {
        use base64::Engine;
        let bytes = zeroize::Zeroizing::new(serde_json::to_vec(&value)?);
        let ciphertext = protect_bytes(&bytes, id.as_bytes(), false)?;
        Ok(Credential {
            id,
            ciphertext: base64::engine::general_purpose::STANDARD.encode(ciphertext),
        })
    }

    pub fn unprotect(record: Credential) -> Result<Value> {
        use base64::Engine;
        let bytes = base64::engine::general_purpose::STANDARD
            .decode(&record.ciphertext)
            .map_err(|e| Error::new("credential_error", e.to_string()))?;
        let clear = zeroize::Zeroizing::new(protect_bytes(&bytes, record.id.as_bytes(), true)?);
        Ok(serde_json::from_slice(&clear)?)
    }
}

#[cfg(windows)]
fn protect_bytes(input: &[u8], entropy: &[u8], decrypt: bool) -> Result<Vec<u8>> {
    use windows_sys::Win32::{Foundation::LocalFree, Security::Cryptography::*};
    let data = CRYPT_INTEGER_BLOB {
        cbData: input.len() as u32,
        pbData: input.as_ptr() as *mut u8,
    };
    let extra = CRYPT_INTEGER_BLOB {
        cbData: entropy.len() as u32,
        pbData: entropy.as_ptr() as *mut u8,
    };
    let mut output = CRYPT_INTEGER_BLOB {
        cbData: 0,
        pbData: std::ptr::null_mut(),
    };
    // DPAPI binds credentials to the current Windows account. The record id is
    // authenticated entropy, preventing a ciphertext being reassigned to another host.
    unsafe {
        let ok = if decrypt {
            CryptUnprotectData(
                &data,
                std::ptr::null_mut(),
                &extra,
                std::ptr::null(),
                std::ptr::null(),
                CRYPTPROTECT_UI_FORBIDDEN,
                &mut output,
            )
        } else {
            CryptProtectData(
                &data,
                std::ptr::null(),
                &extra,
                std::ptr::null(),
                std::ptr::null(),
                CRYPTPROTECT_UI_FORBIDDEN,
                &mut output,
            )
        };
        if ok == 0 {
            return Err(std::io::Error::last_os_error().into());
        }
        let result = std::slice::from_raw_parts(output.pbData, output.cbData as usize).to_vec();
        if decrypt {
            std::ptr::write_bytes(output.pbData, 0, output.cbData as usize);
        }
        LocalFree(output.pbData as _);
        Ok(result)
    }
}

#[cfg(not(windows))]
fn protect_bytes(_: &[u8], _: &[u8], _: bool) -> Result<Vec<u8>> {
    Err(Error::new(
        "unsupported_platform",
        "Credential storage currently requires Windows",
    ))
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;
    #[test]
    fn host_deletion_prevents_background_settings_resurrection() {
        let dir = tempfile::tempdir().unwrap();
        let store = Store::open(&dir.path().join("test.sqlite")).unwrap();
        assert!(
            !store
                .write(
                    vec![Write {
                        collection: "meta".into(),
                        key: "ports:missing".into(),
                        value: Some(json!({"items": []}))
                    }],
                    Some("missing")
                )
                .unwrap()
        );
        assert!(store.list("meta").unwrap().is_empty());
    }
    #[cfg(windows)]
    #[test]
    fn credentials_are_account_protected_and_bound_to_the_record() {
        let value = json!({"password":"secret", "inlineProxyPassword":"proxy"});
        let mut record = Store::protect("host-a".into(), value.clone()).unwrap();
        assert!(!record.ciphertext.contains("secret"));
        assert_eq!(
            Store::unprotect(Store::protect("host-a".into(), value.clone()).unwrap()).unwrap(),
            value
        );
        record.id = "host-b".into();
        assert!(Store::unprotect(record).is_err());
    }
}
