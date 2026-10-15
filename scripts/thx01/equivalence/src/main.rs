//! Standalone Linux development validator. No Electron, plugins, or production IPC.
use ort::{execution_providers::CPUExecutionProvider, session::Session};
use serde::Deserialize;
use serde_json::{json, Value};
use std::{fs, io::Write, path::Path, time::Instant};
use tokenizers::Tokenizer;

use modus_decision_runtime::inference::{
    build_inputs, calibrate, digest, infer, raw_error, rss, verify, Fixture, Inputs,
    Manifest, Result,
};
#[derive(Deserialize)]
struct Fixtures {
    fixtures: Vec<Fixture>,
}
#[derive(Deserialize)]
struct ReferenceRow {
    id: String,
    inputs: Inputs,
    logits: Vec<f32>,
    act_logits: Vec<f32>,
    probabilities: Vec<f32>,
    confidence: f64,
    temperature: f64,
    choice: String,
    top_two_margin: f64,
}
#[derive(Deserialize)]
struct Reference {
    fixture_sha256: String,
    rows: Vec<ReferenceRow>,
}
fn main() -> Result<()> {
    let entry = Instant::now();
    let args: Vec<String> = std::env::args().collect();
    if args.len() != 6 {
        return Err(
            "usage: thx01-equivalence MANIFEST FIXTURES REFERENCE OUTPUT EXPECTED_FIXTURE_SHA256"
                .into(),
        );
    }
    let manifest: Manifest = serde_json::from_slice(&fs::read(&args[1])?)?;
    for artifact in &manifest.files {
        verify(artifact)?;
    }
    let fixture_sha = digest(Path::new(&args[2]))?;
    if fixture_sha != args[5] {
        return Err("Frozen fixture digest mismatch".into());
    }
    let frozen: Fixtures = serde_json::from_slice(&fs::read(&args[2])?)?;
    let reference: Reference = serde_json::from_slice(&fs::read(&args[3])?)?;
    if fixture_sha != reference.fixture_sha256
        || frozen.fixtures.len() != 24
        || reference.rows.len() != 24
    {
        return Err("Frozen reference/fixture mismatch".into());
    }
    let pt = frozen
        .fixtures
        .iter()
        .filter(|f| f.language == "pt")
        .count();
    let en = frozen
        .fixtures
        .iter()
        .filter(|f| f.language == "en")
        .count();
    if pt != 12 || en != 12 {
        return Err("Expected 12 Portuguese and 12 English fixtures".into());
    }
    let config: Value = serde_json::from_slice(&fs::read(&manifest.tokenizer_config)?)?;
    let calibration: Value = serde_json::from_slice(&fs::read(&manifest.calibration)?)?;
    let temperature = calibration["temperature_by_options"]["choice:3-5"]
        .as_f64()
        .ok_or("Missing original calibration")?
        .clamp(0.5, 5.0);
    let token_start = Instant::now();
    let mut tokenizer = Tokenizer::from_file(&manifest.tokenizer)?;
    tokenizer.with_truncation(None)?;
    tokenizer.with_padding(None);
    let tokenizer_load_ms = token_start.elapsed().as_secs_f64() * 1000.0;
    let mut inputs = Vec::new();
    for (fixture, row) in frozen.fixtures.iter().zip(&reference.rows) {
        if fixture.id != row.id || (row.temperature - temperature).abs() > 1e-12 {
            return Err("Reference identity/calibration mismatch".into());
        }
        let actual = build_inputs(&tokenizer, &config, &calibration, fixture)?;
        if actual != row.inputs {
            return Err(format!("{}: input tensor parity failed", fixture.id).into());
        }
        inputs.push(actual);
    }
    let pre_model_ms = entry.elapsed().as_secs_f64() * 1000.0;
    let start = Instant::now();
    ort::init_from(manifest.ort_library.to_string_lossy())
        .with_name("thx01-equivalence")
        .with_telemetry(false)
        .commit()?;
    let mut session = Session::builder()?
        .with_intra_threads(2)?
        .with_inter_threads(1)?
        .with_execution_providers([CPUExecutionProvider::default()
            .with_arena_allocator(true)
            .build()])?
        .commit_from_file(&manifest.graph)?;
    let model_load_ms = start.elapsed().as_secs_f64() * 1000.0;
    let startup_ms = entry.elapsed().as_secs_f64() * 1000.0;
    println!(
        "{}",
        json!({"event":"ready","startup_from_main_ms":startup_ms})
    );
    std::io::stdout().flush()?;
    let warm = Instant::now();
    let _ = infer(&mut session, &inputs[0])?;
    let warmup_ms = warm.elapsed().as_secs_f64() * 1000.0;
    let mut results = Vec::new();
    for ((fixture, row), input) in frozen.fixtures.iter().zip(&reference.rows).zip(&inputs) {
        let start = Instant::now();
        let (logits, act) = infer(&mut session, input)?;
        let elapsed = start.elapsed().as_secs_f64() * 1000.0;
        let raw = raw_error(&row.logits, &logits)?;
        let act_error = raw_error(&row.act_logits, &act)?;
        let (probabilities, confidence, index) = calibrate(&logits, temperature)?;
        if row.probabilities.len() != 3 || !row.confidence.is_finite() {
            return Err("Invalid reference probabilities/confidence".into());
        }
        let prob_error = probabilities
            .iter()
            .zip(&row.probabilities)
            .map(|(a, r)| (*a as f64 - *r as f64).abs())
            .fold(0.0, f64::max);
        if row.probabilities.iter().any(|p| !p.is_finite())
            || prob_error > 1e-4
            || (confidence - row.confidence).abs() > 1e-4
        {
            return Err(format!("{}: calibrated result differs", fixture.id).into());
        }
        let choice = &fixture.options[index].key;
        if choice != &row.choice {
            return Err(format!("{}: selected choice differs", fixture.id).into());
        }
        let record = json!({"id":fixture.id,"language":fixture.language,"tokens":input.input_ids[0].len(),"padding":fixture.padding,
            "inputs":input,"input_parity":true,"logits":logits,"act_logits":act,"probabilities":probabilities,"confidence":confidence,
            "reference_choice":row.choice,"rust_choice":choice,"max_logit_abs_error":raw.0,"max_logit_tolerance_ratio":raw.1,
            "max_action_logit_abs_error":act_error.0,"max_probability_abs_error":prob_error,"confidence_abs_error":(confidence-row.confidence).abs(),
            "reference_top_two_margin":row.top_two_margin,"inference_ms_after_warmup":elapsed,"peak_rss_kib":rss("VmHWM:"),"status":"passed"});
        results.push(record);
        fs::write(
            &args[4],
            serde_json::to_vec_pretty(&json!({"status":"in_progress","rows":results}))?,
        )?;
    }
    for artifact in &manifest.files {
        verify(artifact)?;
    }
    let result = json!({"status":"passed","fixture_sha256":fixture_sha,"rows":results,
        "versions":{"validator_package_version":env!("CARGO_PKG_VERSION"),"ort":"2.0.0-rc.10","tokenizers":"0.22.2","onnx_runtime":manifest.ort_version,"ort_build_info":ort::info()},
        "device":"CPUExecutionProvider","intra_op_threads":2,"inter_op_threads":1,"pre_model_initialization_ms":pre_model_ms,
        "tokenizer_load_ms":tokenizer_load_ms,"model_and_ort_environment_load_ms":model_load_ms,"startup_from_main_ms":startup_ms,
        "warmup_calls":1,"warmup_fixture":frozen.fixtures[0].id,"warmup_ms":warmup_ms,
        "process_peak_rss_kib":rss("VmHWM:"),"process_current_rss_kib":rss("VmRSS:"),"artifact_verification_before_after":true});
    fs::write(&args[4], serde_json::to_vec_pretty(&result)?)?;
    println!(
        "{}",
        json!({"event":"completed","fixtures":24,"peak_rss_kib":rss("VmHWM:")})
    );
    Ok(())
}
