//! Bundled, inert worker bootstrap endpoint.
//!
//! This binary only proves that the expected packaged process can complete the
//! bounded protocol handshake. It accepts no artifact data and exits after the
//! host's `ready` frame. It does not execute plugins or claim OS isolation.

use std::io::{self, Read, Write};

use modus_plugin_execution_protocol::{
    MAX_IPC_FRAME_BYTES, PROTOCOL_VERSION, ProtocolError, WorkerFrame,
    decode_worker_bootstrap_ready, encode_worker_frame,
};

pub const BOOTSTRAP_CHALLENGE_ENV: &str = "MODUS_WORKER_BOOTSTRAP_CHALLENGE";

/// Perform the inert worker-side handshake over bounded IPC streams.
pub fn run_bootstrap<R: Read, W: Write>(
    mut input: R,
    mut output: W,
    challenge: &str,
) -> Result<(), ProtocolError> {
    let hello = encode_worker_frame(&WorkerFrame::Hello {
        protocol_version: PROTOCOL_VERSION,
        challenge: challenge.to_owned(),
    })?;
    output
        .write_all(&hello)
        .and_then(|()| output.flush())
        .map_err(|error| ProtocolError::IoFailure(error.kind()))?;

    let frame = read_bounded_frame(&mut input)?;
    decode_worker_bootstrap_ready(&frame)
}

fn read_bounded_frame<R: Read>(input: &mut R) -> Result<Vec<u8>, ProtocolError> {
    let mut header = [0; 4];
    input
        .read_exact(&mut header)
        .map_err(|error| ProtocolError::IoFailure(error.kind()))?;
    let payload_length = u32::from_be_bytes(header) as usize;
    let frame_length = payload_length
        .checked_add(header.len())
        .ok_or(ProtocolError::FrameTooLarge)?;
    if payload_length == 0 {
        return Err(ProtocolError::InvalidLength);
    }
    if frame_length > MAX_IPC_FRAME_BYTES {
        return Err(ProtocolError::FrameTooLarge);
    }

    let mut frame = Vec::with_capacity(frame_length);
    frame.extend_from_slice(&header);
    frame.resize(frame_length, 0);
    input
        .read_exact(&mut frame[header.len()..])
        .map_err(|error| ProtocolError::IoFailure(error.kind()))?;
    Ok(frame)
}

pub fn bootstrap_error_to_io(error: ProtocolError) -> io::Error {
    io::Error::new(io::ErrorKind::InvalidData, error)
}

#[cfg(test)]
mod tests {
    use std::io::Cursor;

    use super::*;
    use modus_plugin_execution_protocol::{
        ProtocolError, decode_worker_bootstrap_ready, validate_worker_bootstrap_hello,
    };

    const CHALLENGE: &str = "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";

    fn framed(payload: &[u8]) -> Vec<u8> {
        let mut frame = (payload.len() as u32).to_be_bytes().to_vec();
        frame.extend_from_slice(payload);
        frame
    }

    #[test]
    fn bootstrap_emits_host_challenged_hello_and_accepts_only_ready() {
        let ready = modus_plugin_execution_protocol::encode_worker_bootstrap_ready().unwrap();
        let mut output = Vec::new();
        run_bootstrap(Cursor::new(ready), &mut output, CHALLENGE).unwrap();
        validate_worker_bootstrap_hello(&output, CHALLENGE).unwrap();
    }

    #[test]
    fn bootstrap_rejects_execution_frames_and_oversized_input() {
        let execute = framed(
            br#"{"type":"execute","protocol_version":3,"sequence":1,"capability":"plugin.transform","payload":{"artifact":"synthetic"}}"#,
        );
        let mut output = Vec::new();
        assert_eq!(
            run_bootstrap(Cursor::new(execute), &mut output, CHALLENGE),
            Err(ProtocolError::InvalidJson)
        );

        let mut oversized = (u32::MAX).to_be_bytes().to_vec();
        oversized.resize(8, 0);
        assert_eq!(
            run_bootstrap(Cursor::new(oversized), &mut Vec::new(), CHALLENGE),
            Err(ProtocolError::FrameTooLarge)
        );
    }

    #[test]
    fn bootstrap_requires_a_host_supplied_valid_challenge() {
        let ready = modus_plugin_execution_protocol::encode_worker_bootstrap_ready().unwrap();
        assert!(run_bootstrap(Cursor::new(ready), &mut Vec::new(), "invalid").is_err());
    }

    #[test]
    fn eof_after_hello_is_a_cancelled_bootstrap_and_sends_no_ready() {
        let mut output = Vec::new();
        assert_eq!(
            run_bootstrap(Cursor::new(Vec::<u8>::new()), &mut output, CHALLENGE),
            Err(ProtocolError::IoFailure(io::ErrorKind::UnexpectedEof))
        );
        validate_worker_bootstrap_hello(&output, CHALLENGE).unwrap();
        assert_eq!(
            decode_worker_bootstrap_ready(&output),
            Err(ProtocolError::InvalidJson)
        );
    }
}
