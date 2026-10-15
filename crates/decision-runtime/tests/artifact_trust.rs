#![cfg(target_os = "linux")]
use modus_decision_runtime::artifacts::{read_locator, read_snapshot, SealedLibrary};
use sha2::{Digest, Sha256};
use std::{fs, io::Write, os::unix::fs::symlink};
fn fixture(name: &str) -> std::path::PathBuf {
    let dir = std::env::temp_dir().join(format!("thx-trust-{}-{name}", std::process::id()));
    let _ = fs::remove_dir_all(&dir);
    fs::create_dir_all(&dir).unwrap();
    dir
}
#[test]
fn snapshot_is_the_consumer_after_path_replacement_or_inplace_mutation() {
    let dir = fixture("replace");
    let path = dir.join("data");
    fs::write(&path, b"approved").unwrap();
    let digest = format!("{:x}", Sha256::digest(b"approved"));
    let bytes = read_snapshot(&path, 8, &digest).unwrap();
    fs::rename(&path, dir.join("old")).unwrap();
    fs::write(&path, b"attacker").unwrap();
    assert_eq!(bytes, b"approved");
    assert!(read_snapshot(&path, 8, &digest).is_err());
    fs::write(dir.join("old"), b"modified").unwrap();
    assert_eq!(bytes, b"approved");
    fs::remove_dir_all(dir).unwrap();
}
#[test]
fn rejects_symlinked_file_ancestor_traversal_and_nonregular_input() {
    let dir = fixture("aliases");
    let path = dir.join("data");
    fs::write(&path, b"approved").unwrap();
    let sha = format!("{:x}", Sha256::digest(b"approved"));
    symlink(&path, dir.join("link")).unwrap();
    assert!(read_snapshot(&dir.join("link"), 8, &sha).is_err());
    symlink(&dir, dir.join("ancestor")).unwrap();
    assert!(read_snapshot(&dir.join("ancestor/data"), 8, &sha).is_err());
    assert!(read_snapshot(&dir.join("../aliases/data"), 8, &sha).is_err());
    assert!(read_snapshot(&dir, 8, &sha).is_err());
    fs::remove_dir_all(dir).unwrap();
}
#[test]
fn rejects_size_mismatch_and_manifest_change_before_parse() {
    let dir = fixture("bounds");
    let path = dir.join("locator");
    fs::write(&path, b"{}").unwrap();
    assert!(read_snapshot(&path, 1, &format!("{:x}", Sha256::digest(b"{"))).is_err());
    assert!(read_locator(&path, &"0".repeat(64)).is_err());
    fs::remove_dir_all(dir).unwrap();
}
#[test]
fn library_bytes_are_kernel_sealed_even_for_same_uid_fd_writes() {
    let library = SealedLibrary::new(b"synthetic-no-execution").unwrap();
    let mut other = fs::OpenOptions::new()
        .write(true)
        .open(library.path())
        .unwrap();
    assert!(other.write_all(b"modified").is_err());
    assert!(other.set_len(0).is_err());
    assert_eq!(fs::read(library.path()).unwrap(), b"synthetic-no-execution");
}
#[test]
fn a_sidecar_cannot_authorize_a_different_library_or_extra_external_file() {
    use modus_decision_runtime::artifacts::{trust_root, Bundle};
    let dir = fixture("root");
    let root = trust_root().unwrap();
    let graph = dir.join("model.onnx");
    let data = std::path::PathBuf::from(format!("{}.data", graph.display()));
    let roles = [
        ("graph", graph.clone()),
        ("external_data", data),
        ("tokenizer", dir.join("tokenizer.json")),
        ("tokenizer_config", dir.join("config.json")),
        ("calibration", dir.join("calibration.json")),
        ("ort_library", dir.join("lib.so")),
    ];
    let mut entries:Vec<_>=roles.iter().map(|(role,path)|serde_json::json!({"path":path,"bytes":root.artifacts[*role].bytes,"sha256":root.artifacts[*role].sha256})).collect();
    entries[5]["sha256"] = serde_json::json!("0".repeat(64));
    let mut locator = serde_json::json!({"graph":graph,"tokenizer":roles[2].1,"tokenizer_config":roles[3].1,"calibration":roles[4].1,"ort_library":roles[5].1,"ort_version":"1.22.0","files":entries});
    let path = dir.join("locator.json");
    let check = |locator: &serde_json::Value| {
        let bytes = serde_json::to_vec(locator).unwrap();
        fs::write(&path, &bytes).unwrap();
        Bundle::load(&path, &format!("{:x}", Sha256::digest(&bytes)))
            .err()
            .unwrap()
            .to_string()
    };
    assert_eq!(check(&locator), "artifact_unapproved_identity");
    locator["files"].as_array_mut().unwrap().push(
        serde_json::json!({"path":dir.join("unapproved.data"),"bytes":4,"sha256":"0".repeat(64)}),
    );
    assert_eq!(check(&locator), "artifact_unlisted");
    fs::remove_dir_all(dir).unwrap();
}
