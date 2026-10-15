use modus_decision_runtime::protocol::{parse_request, read_frame, MAX_REQUEST_BYTES};
use std::io::Cursor;

#[test]
fn rejects_oversize_frame_without_reading_unbounded_input() {
    let mut input = Cursor::new(vec![b'x'; MAX_REQUEST_BYTES + 1024]);
    assert!(read_frame(&mut input).is_err());
    assert!(input.position() <= (MAX_REQUEST_BYTES + 1) as u64);
}
#[test]
fn rejects_partial_frames_and_invalid_utf8() {
    assert!(read_frame(&mut Cursor::new(b"partial")).is_err());
    assert!(read_frame(&mut Cursor::new([255, b'\n'])).is_err());
    assert!(read_frame(&mut Cursor::new(b"")).unwrap().is_none());
}
#[test]
fn requires_protocol_version_generation_and_bounded_identifiers() {
    let good = r#"{"version":1,"generation":"g1","requestId":"r1","type":"cancel"}"#;
    assert!(parse_request(good, "g1").is_ok());
    assert!(parse_request(good, "other").is_err());
    assert!(parse_request(&good.replace("\"version\":1", "\"version\":2"), "g1").is_err());
    assert!(parse_request(&good.replace("\"r1\"", "\"\""), "g1").is_err());
    assert!(parse_request(
        &good.replace(
            "\"type\":\"cancel\"",
            "\"type\":\"cancel\",\"code\":\"arbitrary\""
        ),
        "g1"
    )
    .is_err());
}
#[test]
fn rejects_observations_without_input_and_commands_with_extra_input() {
    let observation = r#"{"version":1,"generation":"g","requestId":"r","type":"observe"}"#;
    assert!(parse_request(observation, "g").is_err());
    let cancel = r#"{"version":1,"generation":"g","requestId":"r","type":"cancel","input":{"question":"q","state":"s","options":[]}}"#;
    assert!(parse_request(cancel, "g").is_err());
}
#[test]
fn preserves_complete_frames_across_stream_reads() {
    let frame = "{\"a\":1}\n{\"b\":2}\n";
    let mut reader = std::io::BufReader::with_capacity(2, Cursor::new(frame));
    assert_eq!(read_frame(&mut reader).unwrap().unwrap(), "{\"a\":1}");
    assert_eq!(read_frame(&mut reader).unwrap().unwrap(), "{\"b\":2}");
    assert!(read_frame(&mut reader).unwrap().is_none());
}
#[test]
fn does_not_load_dependencies_from_an_uncovered_manifest() {
    use modus_decision_runtime::inference::{digest, Engine};
    let path = std::env::temp_dir().join(format!("thx-manifest-test-{}", std::process::id()));
    std::fs::write(&path,br#"{"graph":"/host/model.onnx","tokenizer":"/host/tokenizer.json","tokenizer_config":"/host/config.json","calibration":"/host/calibration.json","ort_library":"/host/lib.so","ort_version":"1.22.0","files":[]}"#).unwrap();
    assert!(Engine::load(&path, &"0".repeat(64)).is_err());
    let error = Engine::load(&path, &digest(&path).unwrap())
        .err()
        .unwrap()
        .to_string();
    assert_eq!(error, "artifact_unlisted");
    std::fs::remove_file(path).unwrap();
}
