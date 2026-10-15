use crate::inference::OptionEntry;
use serde::{Deserialize, Serialize};
use std::io::BufRead;

pub const VERSION: u8 = 1;
pub const MAX_REQUEST_BYTES: usize = 64 * 1024;
pub const MAX_RESPONSE_BYTES: usize = 16 * 1024;
pub const MAX_QUEUED: usize = 4;
pub const INFERENCE_TIMEOUT_SECS: u64 = 5;

#[derive(Clone, Deserialize, Serialize)]
#[serde(deny_unknown_fields)]
pub struct ObservationInput {
    pub question: String,
    pub state: String,
    pub options: Vec<OptionEntry>,
}
#[derive(Deserialize, PartialEq)]
#[serde(rename_all = "snake_case")]
pub enum Kind {
    Observe,
    Cancel,
    Shutdown,
}
#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct Request {
    pub version: u8,
    pub generation: String,
    pub request_id: String,
    #[serde(rename = "type")]
    pub kind: Kind,
    pub input: Option<ObservationInput>,
}
pub fn parse_request(line: &str, generation: &str) -> Result<Request, &'static str> {
    let request: Request = serde_json::from_str(line).map_err(|_| "protocol_json")?;
    let valid_id = |s: &str| {
        !s.is_empty()
            && s.len() <= 128
            && s.bytes()
                .all(|b| b.is_ascii_alphanumeric() || b"-_".contains(&b))
    };
    if request.version != VERSION
        || request.generation != generation
        || !valid_id(&request.request_id)
        || !valid_id(generation)
    {
        return Err("protocol_identity");
    }
    if (request.kind == Kind::Observe) != request.input.is_some() {
        return Err("protocol_shape");
    }
    Ok(request)
}
/// Bounded even for streams with no delimiter. An incomplete EOF is not a frame.
pub fn read_frame(reader: &mut impl BufRead) -> Result<Option<String>, &'static str> {
    let mut frame = Vec::new();
    loop {
        let buf = reader.fill_buf().map_err(|_| "protocol_read")?;
        if buf.is_empty() {
            return if frame.is_empty() {
                Ok(None)
            } else {
                Err("protocol_partial")
            };
        }
        let newline = buf.iter().position(|&b| b == b'\n');
        let n = newline.unwrap_or(buf.len());
        if frame.len() + n > MAX_REQUEST_BYTES {
            return Err("protocol_frame_size");
        }
        frame.extend_from_slice(&buf[..n]);
        reader.consume(n + usize::from(newline.is_some()));
        if newline.is_some() {
            if frame.is_empty() {
                return Err("protocol_empty");
            }
            return String::from_utf8(frame)
                .map(Some)
                .map_err(|_| "protocol_utf8");
        }
    }
}
