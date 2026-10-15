//! Input construction and arithmetic promoted unchanged from the Marco 1.3 validator.
use ort::{execution_providers::CPUExecutionProvider, session::Session, value::Tensor};
use serde::{Deserialize, Serialize};
use serde_json::Value;
use sha2::{Digest, Sha256};
use std::{
    collections::BTreeSet,
    fs,
    io::Read,
    path::{Path, PathBuf},
};
use tokenizers::Tokenizer;

pub type Result<T> = std::result::Result<T, Box<dyn std::error::Error + Send + Sync>>;
const KEYS: [&str; 3] = [
    "context_sufficient",
    "retrieve_local_context",
    "insufficient_information",
];
#[derive(Clone, Deserialize, Serialize)]
#[serde(deny_unknown_fields)]
pub struct OptionEntry {
    pub key: String,
    pub description: String,
}
#[derive(Deserialize)]
pub struct Fixture {
    pub id: String,
    pub language: String,
    pub question: String,
    pub state: String,
    pub options: Vec<OptionEntry>,
    pub padding: usize,
    pub tokens_with_padding: usize,
}
#[derive(Clone, Debug, PartialEq, Deserialize, Serialize)]
pub struct Inputs {
    pub input_ids: Vec<Vec<i64>>,
    pub attention_mask: Vec<Vec<i64>>,
    pub marker_pos: Vec<Vec<i64>>,
    pub marker_mask: Vec<Vec<bool>>,
    pub qtype: Vec<i64>,
}
#[derive(Deserialize)]
pub struct Artifact {
    pub path: PathBuf,
    pub bytes: u64,
    pub sha256: String,
}
#[derive(Deserialize)]
pub struct Manifest {
    pub graph: PathBuf,
    pub tokenizer: PathBuf,
    pub tokenizer_config: PathBuf,
    pub calibration: PathBuf,
    pub ort_library: PathBuf,
    pub ort_version: String,
    pub files: Vec<Artifact>,
}

pub fn digest(path: &Path) -> Result<String> {
    let mut source = fs::File::open(path)?;
    let mut hash = Sha256::new();
    let mut buffer = vec![0u8; 1024 * 1024];
    loop {
        let n = source.read(&mut buffer)?;
        if n == 0 {
            break;
        }
        hash.update(&buffer[..n]);
    }
    Ok(format!("{:x}", hash.finalize()))
}
pub fn verify(artifact: &Artifact) -> Result<()> {
    if fs::metadata(&artifact.path)?.len() != artifact.bytes
        || digest(&artifact.path)? != artifact.sha256
    {
        return Err(format!("Artifact digest/size mismatch: {}", artifact.path.display()).into());
    }
    Ok(())
}
pub fn length_guard(length: usize) -> Result<()> {
    if !(65..=1024).contains(&length) {
        return Err(format!(
            "Unsupported sequence length {length}; expected 65..1024, no truncation"
        )
        .into());
    }
    Ok(())
}
fn ids(tokenizer: &Tokenizer, text: &str) -> Result<Vec<i64>> {
    Ok(tokenizer
        .encode(text, false)?
        .get_ids()
        .iter()
        .map(|&n| n as i64)
        .collect())
}
fn special(tokenizer: &Tokenizer, config: &Value, key: &str) -> Result<(String, i64)> {
    let token = config[key]
        .as_str()
        .or_else(|| config[key]["content"].as_str())
        .ok_or_else(|| format!("Missing special token {key}"))?;
    let id = tokenizer
        .token_to_id(token)
        .ok_or_else(|| format!("Special token not found: {token}"))?;
    Ok((token.into(), id as i64))
}
pub fn build_inputs(
    tokenizer: &Tokenizer,
    config: &Value,
    calibration: &Value,
    fixture: &Fixture,
) -> Result<Inputs> {
    let keys: BTreeSet<_> = fixture.options.iter().map(|o| o.key.as_str()).collect();
    if fixture.options.len() != 3 || keys != KEYS.into_iter().collect() {
        return Err("Expected exactly the three context choices".into());
    }
    let (mask_token, mask) = special(tokenizer, config, "mask_token")?;
    let (_, cls) = special(tokenizer, config, "cls_token")?;
    let (_, sep) = special(tokenizer, config, "sep_token")?;
    let (_, pad) = special(tokenizer, config, "pad_token")?;
    let options: Vec<String> = fixture
        .options
        .iter()
        .map(|o| {
            if o.description.is_empty() {
                o.key.clone()
            } else {
                format!("{}: {}", o.key, o.description)
            }
        })
        .collect();
    let base = calibration["head_max_len"].as_u64().unwrap_or(192) as usize;
    let max_len = calibration["max_len"].as_u64().unwrap_or(512) as usize;
    if max_len != 1024 {
        return Err("Unexpected checkpoint input limit".into());
    }
    let need = 24
        + options
            .iter()
            .map(|o| ids(tokenizer, &format!(" {o}")).map(|v| (v.len() + 1).min(49)))
            .collect::<Result<Vec<_>>>()?
            .iter()
            .sum::<usize>();
    let head_budget = if calibration["auto_head_budget"].as_bool().unwrap_or(true) {
        base.max(need).min(max_len / 2)
    } else {
        base
    };
    let mut head = ids(
        tokenizer,
        &format!(
            "choice question: {}",
            fixture.question.replace(&mask_token, " ")
        ),
    )?;
    let mut option_ids = Vec::new();
    for option in &options {
        let encoded = ids(tokenizer, &format!(" {}", option.replace(&mask_token, " ")))?;
        if encoded.len() > 48 {
            return Err("Option truncation would be required; not allowed in this scope".into());
        }
        let mut item = vec![mask];
        item.extend(encoded);
        option_ids.push(item);
    }
    let opt_count = option_ids.iter().map(Vec::len).sum::<usize>();
    let mut opt_budget = head_budget as isize - opt_count as isize;
    if opt_budget < 16 {
        let per = ((head_budget.saturating_sub(16)) / 3).max(4);
        if option_ids.iter().any(|o| o.len() > per) {
            return Err("Option truncation would be required".into());
        }
        opt_budget = head_budget as isize - option_ids.iter().map(Vec::len).sum::<usize>() as isize;
    }
    if head.len() > opt_budget.max(8) as usize {
        return Err("Question truncation would be required".into());
    }
    let mut sequence = vec![cls];
    sequence.append(&mut head);
    sequence.push(sep);
    let mut markers = Vec::new();
    for option in option_ids {
        markers.push(sequence.len() as i64);
        sequence.extend(option);
    }
    sequence.push(sep);
    sequence.extend(ids(tokenizer, &fixture.state.replace(&mask_token, " "))?);
    sequence.push(sep);
    let valid = sequence.len();
    let total = valid
        .checked_add(fixture.padding)
        .ok_or("Length overflow")?;
    length_guard(total)?;
    if fixture.tokens_with_padding != 0 && total != fixture.tokens_with_padding {
        return Err(format!("{}: unexpected length {total}", fixture.id).into());
    }
    sequence.resize(total, pad);
    let mut attention = vec![1; valid];
    attention.resize(total, 0);
    Ok(Inputs {
        input_ids: vec![sequence],
        attention_mask: vec![attention],
        marker_pos: vec![markers],
        marker_mask: vec![vec![true; 3]],
        qtype: vec![0],
    })
}
pub fn first_argmax(values: &[f32]) -> Result<usize> {
    if values.is_empty() || values.iter().any(|x| !x.is_finite()) {
        return Err("Non-finite/empty values".into());
    }
    let mut best = 0;
    for i in 1..values.len() {
        if values[i] > values[best] {
            best = i;
        }
    }
    Ok(best)
}
pub fn calibrate(logits: &[f32], temperature: f64) -> Result<(Vec<f32>, f64, usize)> {
    if logits.len() != 3 || !temperature.is_finite() {
        return Err("Invalid logits or temperature".into());
    }
    let scale = temperature.clamp(0.5, 5.0) as f32;
    let z: Vec<f32> = logits.iter().map(|v| *v / scale).collect();
    let max = z[first_argmax(&z)?];
    let mut p: Vec<f32> = z.iter().map(|v| (*v - max).exp()).collect();
    let sum: f32 = p.iter().sum();
    for v in &mut p {
        *v /= sum;
    }
    let entropy: f32 = -p.iter().map(|v| *v * v.max(1e-12).ln()).sum::<f32>();
    let confidence = (1.0 - (entropy as f64) / 3.0f64.ln()).clamp(0.0, 1.0);
    let choice = first_argmax(&p)?;
    Ok((p, confidence, choice))
}
pub fn raw_error(reference: &[f32], actual: &[f32]) -> Result<(f64, f64)> {
    if reference.len() != actual.len() {
        return Err("Output shape mismatch".into());
    }
    let (mut absolute, mut ratio) = (0.0f64, 0.0f64);
    for (&r, &a) in reference.iter().zip(actual) {
        if !r.is_finite() || !a.is_finite() {
            return Err("Non-finite logits".into());
        }
        let error = (a as f64 - r as f64).abs();
        let bound = 1e-4 + 1e-3 * (r as f64).abs();
        absolute = absolute.max(error);
        ratio = ratio.max(error / bound);
        if error > bound {
            return Err(format!("Logit error {error} exceeds {bound}").into());
        }
    }
    Ok((absolute, ratio))
}
pub fn rss(key: &str) -> Option<u64> {
    fs::read_to_string("/proc/self/status")
        .ok()?
        .lines()
        .find(|line| line.starts_with(key))?
        .split_whitespace()
        .nth(1)?
        .parse()
        .ok()
}
pub fn infer(session: &mut Session, inputs: &Inputs) -> Result<(Vec<f32>, Vec<f32>)> {
    infer_with_options(session, inputs, &ort::session::RunOptions::new()?)
}

pub fn infer_with_options(
    session: &mut Session,
    inputs: &Inputs,
    options: &ort::session::RunOptions,
) -> Result<(Vec<f32>, Vec<f32>)> {
    let l = inputs.input_ids[0].len();
    let result = session.run_with_options(
        ort::inputs![
            "input_ids"=>Tensor::from_array(([1usize,l],inputs.input_ids[0].clone()))?,
            "attention_mask"=>Tensor::from_array(([1usize,l],inputs.attention_mask[0].clone()))?,
            "marker_pos"=>Tensor::from_array(([1usize,3],inputs.marker_pos[0].clone()))?,
            "marker_mask"=>Tensor::from_array(([1usize,3],inputs.marker_mask[0].clone()))?,
            "qtype"=>Tensor::from_array(([1usize],inputs.qtype.clone()))?
        ],
        options,
    )?;
    let (shape, logits) = result["logits"].try_extract_tensor::<f32>()?;
    let (act_shape, act) = result["act_logits"].try_extract_tensor::<f32>()?;
    if shape.as_ref() != [1, 3] || act_shape.as_ref() != [1, 2] {
        return Err("Unexpected output dimensions".into());
    }
    Ok((logits.to_vec(), act.to_vec()))
}

pub struct Engine {
    session: Session,
    tokenizer: Tokenizer,
    config: Value,
    calibration: Value,
    temperature: f64,
}
impl Engine {
    pub fn load(path: &Path, trusted_manifest_sha256: &str) -> Result<Self> {
        if trusted_manifest_sha256.len() != 64
            || !trusted_manifest_sha256
                .bytes()
                .all(|c| c.is_ascii_hexdigit())
            || digest(path)? != trusted_manifest_sha256
        {
            return Err("artifact_manifest".into());
        }
        if fs::metadata(path)?.len() > 64 * 1024 {
            return Err("artifact_manifest_size".into());
        }
        let manifest: Manifest = serde_json::from_slice(&fs::read(path)?)?;
        // Require all actually loaded dependencies to be covered, not merely any file list.
        let data = PathBuf::from(format!("{}.data", manifest.graph.display()));
        for required in [
            &manifest.graph,
            &data,
            &manifest.tokenizer,
            &manifest.tokenizer_config,
            &manifest.calibration,
            &manifest.ort_library,
        ] {
            if !required.is_absolute()
                || manifest
                    .files
                    .iter()
                    .filter(|a| &a.path == required)
                    .count()
                    != 1
            {
                return Err("artifact_unlisted".into());
            }
        }
        for file in &manifest.files {
            verify(file)?;
        }
        if digest(&manifest.graph)?
            != "13a870e7211257b3a6eb93696ec25f8ff91488638bc308a6738957edf9024a58"
            || digest(&data)? != "8e5c1f58aa060e9279ebd07d27f3cc160dd0cc1ee7a9407819ac54c200e58f5c"
            || manifest.ort_version != "1.22.0"
        {
            return Err("artifact_unapproved_graph".into());
        }
        let config: Value = serde_json::from_slice(&fs::read(&manifest.tokenizer_config)?)?;
        let calibration: Value = serde_json::from_slice(&fs::read(&manifest.calibration)?)?;
        let temperature = calibration["temperature_by_options"]["choice:3-5"]
            .as_f64()
            .ok_or("artifact_calibration")?;
        if temperature != 2.55 {
            return Err("artifact_calibration".into());
        }
        let mut tokenizer = Tokenizer::from_file(&manifest.tokenizer)?;
        tokenizer.with_truncation(None)?;
        tokenizer.with_padding(None);
        ort::init_from(manifest.ort_library.to_string_lossy())
            .with_name("modus-decision-runtime")
            .with_telemetry(false)
            .commit()?;
        let session = Session::builder()?
            .with_intra_threads(2)?
            .with_inter_threads(1)?
            .with_execution_providers([CPUExecutionProvider::default()
                .with_arena_allocator(true)
                .build()])?
            .commit_from_file(&manifest.graph)?;
        Ok(Self {
            session,
            tokenizer,
            config,
            calibration,
            temperature,
        })
    }
    pub fn observe(
        &mut self,
        input: &crate::protocol::ObservationInput,
        run: &ort::session::RunOptions,
    ) -> Result<Value> {
        let started = std::time::Instant::now();
        let fixture = Fixture {
            id: String::new(),
            language: String::new(),
            question: input.question.clone(),
            state: input.state.clone(),
            options: input.options.clone(),
            padding: 0,
            tokens_with_padding: 0,
        };
        // Tokenize and reject unsupported lengths before allocating ORT tensors.
        let inputs = build_inputs(&self.tokenizer, &self.config, &self.calibration, &fixture)?;
        let (logits, act) = infer_with_options(&mut self.session, &inputs, run)?;
        if logits.iter().chain(&act).any(|v| !v.is_finite()) {
            return Err("nonfinite".into());
        }
        let (probabilities, confidence, choice) = calibrate(&logits, self.temperature)?;
        if !confidence.is_finite() || probabilities.iter().any(|v| !v.is_finite()) {
            return Err("nonfinite".into());
        }
        Ok(
            serde_json::json!({"decision":{"choices":input.options.iter().map(|o| &o.key).collect::<Vec<_>>(),"choice":input.options[choice].key,"logits":logits,"probabilities":probabilities,"confidence":confidence,"temperature":self.temperature},
            "tokens":inputs.input_ids[0].len(),"durationMs":started.elapsed().as_secs_f64()*1000.0,"rssKiB":rss("VmHWM:")}),
        )
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn ties_preserve_first_alternative() {
        assert_eq!(first_argmax(&[0.5, 0.5, 0.1]).unwrap(), 0);
    }
    #[test]
    fn nonfinite_values_rejected() {
        assert!(first_argmax(&[f32::NAN, 1.0]).is_err());
        assert!(raw_error(&[0.0], &[f32::INFINITY]).is_err());
    }
    #[test]
    fn bounds_do_not_truncate() {
        assert!(length_guard(65).is_ok());
        assert!(length_guard(1024).is_ok());
        assert!(length_guard(64).is_err());
        assert!(length_guard(1025).is_err());
    }
    #[test]
    fn logits_outside_tolerance_rejected() {
        assert!(raw_error(&[0.0], &[0.01]).is_err());
    }
    #[test]
    fn calibration_uniform_distribution() {
        let (p, c, i) = calibrate(&[1.0, 1.0, 1.0], 2.55).unwrap();
        assert_eq!(i, 0);
        assert!(p.iter().all(|x| (*x - 1.0 / 3.0).abs() < 1e-7));
        assert!(c < 1e-6);
    }
    #[test]
    fn artifact_change_is_rejected() {
        let path = std::env::temp_dir().join(format!("thx-hash-test-{}", std::process::id()));
        fs::write(&path, b"original").unwrap();
        let artifact = Artifact {
            path: path.clone(),
            bytes: 8,
            sha256: digest(&path).unwrap(),
        };
        assert!(verify(&artifact).is_ok());
        fs::write(&path, b"modified").unwrap();
        assert!(verify(&artifact).is_err());
        fs::remove_file(path).unwrap();
    }
}
