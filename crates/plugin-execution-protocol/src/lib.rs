use serde::{Deserialize, Serialize};
use serde_json::Value;

pub const PROTOCOL_VERSION: u16 = 1;
pub const MAX_IPC_FRAME_BYTES: usize = 256 * 1024;
pub const MAX_RESULT_BYTES: usize = 64 * 1024;
const FRAME_HEADER_BYTES: usize = 4;

#[derive(Clone, Debug, Deserialize, PartialEq, Serialize)]
#[serde(tag = "type", rename_all = "snake_case")]
pub enum WorkerFrame {
    Hello {
        protocol_version: u16,
        challenge: String,
    },
    Invoke {
        protocol_version: u16,
        sequence: u64,
        capability: String,
        payload: Value,
    },
}

#[derive(Debug, PartialEq, Eq)]
pub enum ProtocolError {
    InvalidLength,
    FrameTooLarge,
    InvalidJson,
}

pub fn encode_worker_frame(message: &WorkerFrame) -> Result<Vec<u8>, ProtocolError> {
    let payload = serde_json::to_vec(message).map_err(|_| ProtocolError::InvalidJson)?;
    let length = u32::try_from(payload.len()).map_err(|_| ProtocolError::FrameTooLarge)?;
    let mut frame = Vec::with_capacity(FRAME_HEADER_BYTES + payload.len());
    frame.extend_from_slice(&length.to_be_bytes());
    frame.extend_from_slice(&payload);
    Ok(frame)
}

pub fn decode_worker_frame(frame: &[u8]) -> Result<WorkerFrame, ProtocolError> {
    if frame.len() < FRAME_HEADER_BYTES {
        return Err(ProtocolError::InvalidLength);
    }
    let declared = u32::from_be_bytes(
        frame[..FRAME_HEADER_BYTES]
            .try_into()
            .map_err(|_| ProtocolError::InvalidLength)?,
    ) as usize;
    if declared == 0 || frame.len() != FRAME_HEADER_BYTES + declared {
        return Err(ProtocolError::InvalidLength);
    }
    serde_json::from_slice(&frame[FRAME_HEADER_BYTES..]).map_err(|_| ProtocolError::InvalidJson)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn raw_frame(payload: &[u8]) -> Vec<u8> {
        let mut frame = Vec::with_capacity(FRAME_HEADER_BYTES + payload.len());
        frame.extend_from_slice(&(payload.len() as u32).to_be_bytes());
        frame.extend_from_slice(payload);
        frame
    }

    #[test]
    fn rejects_frames_over_the_protocol_limit_before_json_parsing() {
        let json = format!(
            "{{\"type\":\"hello\",\"protocol_version\":1,\"challenge\":\"{}\",\"padding\":\"{}\"}}",
            "a".repeat(64),
            "x".repeat(MAX_IPC_FRAME_BYTES),
        );

        assert_eq!(
            decode_worker_frame(&raw_frame(json.as_bytes())),
            Err(ProtocolError::FrameTooLarge),
        );
    }

    #[test]
    fn rejects_guest_supplied_host_identity_fields() {
        let json = br#"{"type":"invoke","protocol_version":1,"sequence":1,"capability":"memory.read","payload":{},"plugin_id":"forged"}"#;

        assert_eq!(
            decode_worker_frame(&raw_frame(json)),
            Err(ProtocolError::InvalidJson),
        );
    }
}
