//! Shared, host-validated IPC contracts for a future isolated plugin worker.
//!
//! This crate does not start processes or claim operating-system isolation.
//! A host must bind one [`Dispatcher`] to one host-authorized plugin artifact,
//! run, and generation, then route each returned invocation through its normal
//! permission-aware dispatcher.

use std::collections::{BTreeMap, BTreeSet};
use std::fmt;
use std::io::{self, Write};
use std::sync::Arc;
use std::sync::atomic::{AtomicBool, Ordering};
use std::time::Instant;

use serde::{Deserialize, Serialize};
use serde_json::Value;

pub mod resource_policy;

/// Version 2 adds an explicit cancellation response so a worker can distinguish
/// cancellation from failure. Version 1 is rejected during handshake.
pub const PROTOCOL_VERSION: u16 = 2;
/// Maximum on-wire frame size, including the four-byte length prefix.
pub const MAX_IPC_FRAME_BYTES: usize = 256 * 1024;
pub const MAX_RESULT_BYTES: usize = 64 * 1024;
pub const MAX_PENDING_REQUESTS: usize = 16;
const FRAME_HEADER_BYTES: usize = 4;
const MAX_IPC_PAYLOAD_BYTES: usize = MAX_IPC_FRAME_BYTES - FRAME_HEADER_BYTES;
const MAX_ID_BYTES: usize = 128;

/// Outbound fixture shape for worker frames. It intentionally does not
/// implement `Deserialize`; inbound frames must enter through `Dispatcher`.
/// Identity, trust, grants, run id, and generation are absent from the wire.
///
/// ```compile_fail
/// use modus_plugin_execution_protocol::WorkerFrame;
/// let _: WorkerFrame = serde_json::from_str("{} ").unwrap();
/// ```
#[derive(Clone, Debug, PartialEq, Serialize)]
#[serde(tag = "type", rename_all = "snake_case", deny_unknown_fields)]
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

/// Private worker-to-host input type. External callers cannot deserialize a
/// worker message into an invocation; only `Dispatcher` can mint authority.
#[derive(Debug, Deserialize, PartialEq)]
#[serde(tag = "type", rename_all = "snake_case", deny_unknown_fields)]
enum InboundWorkerFrame {
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

/// Message schema for host responses. It is not accepted as worker input.
#[derive(Clone, Debug, Deserialize, PartialEq, Serialize)]
#[serde(tag = "type", rename_all = "snake_case", deny_unknown_fields)]
pub enum HostFrame {
    Ready {
        protocol_version: u16,
    },
    InvocationSucceeded {
        protocol_version: u16,
        sequence: u64,
        result: Value,
    },
    InvocationFailed {
        protocol_version: u16,
        sequence: u64,
        error: String,
    },
    InvocationCancelled {
        protocol_version: u16,
        sequence: u64,
    },
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub enum ProtocolError {
    InvalidLength,
    FrameTooLarge,
    ResultTooLarge,
    InvalidJson,
    InvalidState,
    InvalidChallenge,
    ChallengeMismatch,
    InvalidIdentity,
    UnsupportedVersion,
    IoFailure(io::ErrorKind),
    AllocationFailed,
    ReadDeadlineExceeded,
    ReadCancelled,
    InvalidCapability,
    CapabilityDenied,
    OutOfOrder,
    TooManyPending,
    UnknownSequence,
    SequenceOverflow,
}

/// Trust classification resolved by the host catalog. It is never accepted
/// from worker IPC.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum HostTrustLevel {
    Core,
    Official,
    Verified,
    Community,
    Local,
}

impl fmt::Display for ProtocolError {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        write!(formatter, "{self:?}")
    }
}

impl std::error::Error for ProtocolError {}

/// Identity captured by the host from its authorized catalog and lifecycle.
/// This type is never serialized into a worker frame.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct HostProvenance {
    plugin_id: String,
    plugin_version: String,
    artifact_sha256: String,
    artifact_origin: String,
    trust_level: HostTrustLevel,
    session_id: String,
    workspace_id: String,
    run_id: String,
    generation: u64,
}

impl HostProvenance {
    /// Construct from host-owned catalog and run state, never from IPC data.
    pub fn from_host_catalog(
        plugin_id: impl Into<String>,
        plugin_version: impl Into<String>,
        artifact_sha256: impl Into<String>,
        artifact_origin: impl Into<String>,
        trust_level: HostTrustLevel,
        session_id: impl Into<String>,
        workspace_id: impl Into<String>,
        run_id: impl Into<String>,
        generation: u64,
    ) -> Result<Self, ProtocolError> {
        let plugin_id = plugin_id.into();
        let plugin_version = plugin_version.into();
        let artifact_sha256 = artifact_sha256.into();
        let artifact_origin = artifact_origin.into();
        let session_id = session_id.into();
        let workspace_id = workspace_id.into();
        let run_id = run_id.into();
        if !valid_opaque_id(&plugin_id)
            || !valid_opaque_id(&plugin_version)
            || !valid_sha256(&artifact_sha256)
            || !valid_opaque_id(&artifact_origin)
            || !valid_opaque_id(&session_id)
            || !valid_opaque_id(&workspace_id)
            || !valid_opaque_id(&run_id)
            || generation == 0
        {
            return Err(ProtocolError::InvalidIdentity);
        }
        Ok(Self {
            plugin_id,
            plugin_version,
            artifact_sha256,
            artifact_origin,
            trust_level,
            session_id,
            workspace_id,
            run_id,
            generation,
        })
    }

    pub fn plugin_id(&self) -> &str {
        &self.plugin_id
    }

    pub fn artifact_sha256(&self) -> &str {
        &self.artifact_sha256
    }

    pub fn plugin_version(&self) -> &str {
        &self.plugin_version
    }

    pub fn artifact_origin(&self) -> &str {
        &self.artifact_origin
    }

    pub fn trust_level(&self) -> HostTrustLevel {
        self.trust_level
    }

    pub fn session_id(&self) -> &str {
        &self.session_id
    }

    pub fn workspace_id(&self) -> &str {
        &self.workspace_id
    }

    pub fn run_id(&self) -> &str {
        &self.run_id
    }

    pub fn generation(&self) -> u64 {
        self.generation
    }
}

#[derive(Clone, Debug)]
pub struct AuthorizedInvocation {
    sequence: u64,
    capability: String,
    payload: Value,
    provenance: HostProvenance,
    generation_active: Arc<AtomicBool>,
}

impl AuthorizedInvocation {
    pub fn sequence(&self) -> u64 {
        self.sequence
    }

    /// Whether this invocation belongs to an open dispatcher generation.
    /// Hosts must check this immediately before each side effect.
    pub fn is_current(&self) -> bool {
        self.generation_active.load(Ordering::Acquire)
    }

    pub fn capability(&self) -> Option<&str> {
        self.is_current().then_some(self.capability.as_str())
    }

    pub fn payload(&self) -> Option<&Value> {
        self.is_current().then_some(&self.payload)
    }

    pub fn provenance(&self) -> Option<&HostProvenance> {
        self.is_current().then_some(&self.provenance)
    }
}

impl PartialEq for AuthorizedInvocation {
    fn eq(&self, other: &Self) -> bool {
        self.sequence == other.sequence
            && self.capability == other.capability
            && self.payload == other.payload
            && self.provenance == other.provenance
            && Arc::ptr_eq(&self.generation_active, &other.generation_active)
    }
}

#[derive(Clone, Debug, PartialEq)]
pub enum DispatchEvent {
    Ready,
    Invocation(AuthorizedInvocation),
}

#[derive(Clone, Debug, PartialEq)]
pub enum InvocationOutcome {
    Success(Value),
    Failure(String),
    Cancelled,
}

/// A stream reader whose implementation enforces the supplied absolute
/// deadline and cancellation. `TimedOut` means deadline elapsed and
/// `Interrupted` means host cancellation. Generic blocking `Read` adapters
/// must not be used without a platform-level read timeout. An `Ok(0)` result
/// denotes EOF, not temporary lack of data.
pub trait DeadlineReader {
    fn read_with_deadline(&mut self, buffer: &mut [u8], deadline: Instant) -> io::Result<usize>;
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
enum SessionState {
    AwaitingHello,
    Ready,
    Closed,
}

/// Stateful validator and mandatory host-side dispatch gate for one worker.
/// It contains no process-global state; callers must create one per worker/run.
pub struct Dispatcher {
    challenge: String,
    provenance: HostProvenance,
    granted_capabilities: BTreeSet<String>,
    state: SessionState,
    next_sequence: u64,
    pending: BTreeMap<u64, Arc<AtomicBool>>,
}

impl Dispatcher {
    pub fn new(
        challenge: impl Into<String>,
        provenance: HostProvenance,
        granted_capabilities: impl IntoIterator<Item = String>,
    ) -> Result<Self, ProtocolError> {
        let challenge = challenge.into();
        if !valid_sha256(&challenge) {
            return Err(ProtocolError::InvalidChallenge);
        }
        let granted_capabilities: BTreeSet<String> = granted_capabilities.into_iter().collect();
        if granted_capabilities
            .iter()
            .any(|capability| !valid_capability(capability))
        {
            return Err(ProtocolError::InvalidCapability);
        }
        Ok(Self {
            challenge,
            provenance,
            granted_capabilities,
            state: SessionState::AwaitingHello,
            next_sequence: 1,
            pending: BTreeMap::new(),
        })
    }

    /// Accept a bounded worker frame. Any protocol violation closes this
    /// dispatcher so malformed or stale traffic cannot be retried in-session.
    pub fn receive(&mut self, bytes: &[u8]) -> Result<DispatchEvent, ProtocolError> {
        if self.state == SessionState::Closed {
            return Err(ProtocolError::InvalidState);
        }
        let result = self.receive_validated(bytes);
        if result.is_err() {
            self.close();
        }
        result
    }

    /// Read one frame from a deadline-aware worker stream and pass it through
    /// this mandatory validator. The adapter must make reads preemptible; this
    /// method cannot safely interrupt a generic blocking `Read`. EOF, timeout,
    /// cancellation, or invalid input closes the generation and clears calls.
    pub fn receive_from_until<R: DeadlineReader>(
        &mut self,
        reader: &mut R,
        deadline: Instant,
    ) -> Result<Option<DispatchEvent>, ProtocolError> {
        if self.state == SessionState::Closed {
            return Err(ProtocolError::InvalidState);
        }
        let result = self.receive_from_validated(reader, deadline);
        if result.is_err() {
            self.close();
        }
        result
    }

    fn receive_from_validated<R: DeadlineReader>(
        &mut self,
        reader: &mut R,
        deadline: Instant,
    ) -> Result<Option<DispatchEvent>, ProtocolError> {
        match read_worker_frame(reader, deadline)? {
            Some(frame) => self.dispatch_frame(frame).map(Some),
            None => {
                self.close();
                Ok(None)
            }
        }
    }

    fn receive_validated(&mut self, bytes: &[u8]) -> Result<DispatchEvent, ProtocolError> {
        let frame = decode_worker_frame(bytes)?;
        self.dispatch_frame(frame)
    }

    fn dispatch_frame(
        &mut self,
        frame: InboundWorkerFrame,
    ) -> Result<DispatchEvent, ProtocolError> {
        match frame {
            InboundWorkerFrame::Hello {
                protocol_version,
                challenge,
            } => {
                if self.state != SessionState::AwaitingHello {
                    return Err(ProtocolError::InvalidState);
                }
                if protocol_version != PROTOCOL_VERSION {
                    return Err(ProtocolError::UnsupportedVersion);
                }
                if challenge != self.challenge {
                    return Err(ProtocolError::ChallengeMismatch);
                }
                self.state = SessionState::Ready;
                Ok(DispatchEvent::Ready)
            }
            InboundWorkerFrame::Invoke {
                protocol_version,
                sequence,
                capability,
                payload,
            } => {
                if self.state != SessionState::Ready {
                    return Err(ProtocolError::InvalidState);
                }
                if protocol_version != PROTOCOL_VERSION {
                    return Err(ProtocolError::UnsupportedVersion);
                }
                if sequence != self.next_sequence {
                    return Err(ProtocolError::OutOfOrder);
                }
                if !valid_capability(&capability) {
                    return Err(ProtocolError::InvalidCapability);
                }
                if !self.granted_capabilities.contains(&capability) {
                    return Err(ProtocolError::CapabilityDenied);
                }
                if self.pending.len() >= MAX_PENDING_REQUESTS {
                    return Err(ProtocolError::TooManyPending);
                }
                let payload_bytes =
                    serde_json::to_vec(&payload).map_err(|_| ProtocolError::InvalidJson)?;
                if payload_bytes.len() > MAX_RESULT_BYTES {
                    return Err(ProtocolError::ResultTooLarge);
                }
                self.next_sequence = self
                    .next_sequence
                    .checked_add(1)
                    .ok_or(ProtocolError::SequenceOverflow)?;
                let generation_active = Arc::new(AtomicBool::new(true));
                self.pending
                    .insert(sequence, Arc::clone(&generation_active));
                Ok(DispatchEvent::Invocation(AuthorizedInvocation {
                    sequence,
                    capability,
                    payload,
                    provenance: self.provenance.clone(),
                    generation_active,
                }))
            }
        }
    }

    /// Encode the host result for one exact, outstanding invocation.
    pub fn complete(
        &mut self,
        sequence: u64,
        outcome: InvocationOutcome,
    ) -> Result<Vec<u8>, ProtocolError> {
        if self.state != SessionState::Ready {
            return Err(ProtocolError::InvalidState);
        }
        if !self.pending.contains_key(&sequence) {
            self.close();
            return Err(ProtocolError::UnknownSequence);
        }

        let response = match outcome {
            InvocationOutcome::Success(result) => {
                serialize_bounded(&result, MAX_RESULT_BYTES, ProtocolError::ResultTooLarge)
                    .inspect_err(|_| self.close())?;
                HostFrame::InvocationSucceeded {
                    protocol_version: PROTOCOL_VERSION,
                    sequence,
                    result,
                }
            }
            InvocationOutcome::Failure(error) => {
                serialize_bounded(&error, MAX_RESULT_BYTES, ProtocolError::ResultTooLarge)
                    .inspect_err(|_| self.close())?;
                HostFrame::InvocationFailed {
                    protocol_version: PROTOCOL_VERSION,
                    sequence,
                    error,
                }
            }
            InvocationOutcome::Cancelled => HostFrame::InvocationCancelled {
                protocol_version: PROTOCOL_VERSION,
                sequence,
            },
        };
        let frame = encode_host_frame(&response)?;
        if let Some(generation_active) = self.pending.remove(&sequence) {
            generation_active.store(false, Ordering::Release);
        }
        Ok(frame)
    }

    /// Stop accepting IPC for this generation. OS process termination/reap is
    /// the responsibility of a platform supervisor and is not implied here.
    pub fn close(&mut self) {
        for generation_active in self.pending.values() {
            generation_active.store(false, Ordering::Release);
        }
        self.pending.clear();
        self.state = SessionState::Closed;
    }

    pub fn is_closed(&self) -> bool {
        self.state == SessionState::Closed
    }
}

impl Drop for Dispatcher {
    fn drop(&mut self) {
        self.close();
    }
}

pub fn encode_worker_frame(message: &WorkerFrame) -> Result<Vec<u8>, ProtocolError> {
    match message {
        WorkerFrame::Hello { challenge, .. } if !valid_sha256(challenge) => {
            return Err(ProtocolError::InvalidChallenge);
        }
        WorkerFrame::Invoke {
            capability,
            payload,
            ..
        } => {
            if !valid_capability(capability) {
                return Err(ProtocolError::InvalidCapability);
            }
            serialize_bounded(payload, MAX_RESULT_BYTES, ProtocolError::ResultTooLarge)?;
        }
        _ => {}
    }
    encode_message(message)
}

fn decode_worker_frame(frame: &[u8]) -> Result<InboundWorkerFrame, ProtocolError> {
    decode_message(frame)
}

pub fn decode_host_frame(frame: &[u8]) -> Result<HostFrame, ProtocolError> {
    let message: HostFrame = decode_message(frame)?;
    let protocol_version = match &message {
        HostFrame::Ready {
            protocol_version, ..
        }
        | HostFrame::InvocationSucceeded {
            protocol_version, ..
        }
        | HostFrame::InvocationFailed {
            protocol_version, ..
        }
        | HostFrame::InvocationCancelled {
            protocol_version, ..
        } => *protocol_version,
    };
    if protocol_version != PROTOCOL_VERSION {
        return Err(ProtocolError::UnsupportedVersion);
    }

    match &message {
        HostFrame::InvocationSucceeded { result, .. } => {
            serialize_bounded(result, MAX_RESULT_BYTES, ProtocolError::ResultTooLarge)?;
        }
        HostFrame::InvocationFailed { error, .. } => {
            serialize_bounded(error, MAX_RESULT_BYTES, ProtocolError::ResultTooLarge)?;
        }
        _ => {}
    }
    Ok(message)
}

fn encode_host_frame(message: &HostFrame) -> Result<Vec<u8>, ProtocolError> {
    encode_message(message)
}

fn encode_message(message: &impl Serialize) -> Result<Vec<u8>, ProtocolError> {
    let payload = serialize_bounded(message, MAX_IPC_PAYLOAD_BYTES, ProtocolError::FrameTooLarge)?;
    if payload.is_empty() {
        return Err(ProtocolError::InvalidLength);
    }
    let length = u32::try_from(payload.len()).map_err(|_| ProtocolError::FrameTooLarge)?;
    let mut frame = Vec::with_capacity(FRAME_HEADER_BYTES + payload.len());
    frame.extend_from_slice(&length.to_be_bytes());
    frame.extend_from_slice(&payload);
    Ok(frame)
}

struct BoundedWriter {
    bytes: Vec<u8>,
    limit: usize,
    exceeded: bool,
}

impl Write for BoundedWriter {
    fn write(&mut self, buffer: &[u8]) -> io::Result<usize> {
        if buffer.len() > self.limit.saturating_sub(self.bytes.len()) {
            self.exceeded = true;
            return Err(io::Error::new(
                io::ErrorKind::WriteZero,
                "serialized protocol value exceeds its byte limit",
            ));
        }
        self.bytes.extend_from_slice(buffer);
        Ok(buffer.len())
    }

    fn flush(&mut self) -> io::Result<()> {
        Ok(())
    }
}

fn serialize_bounded<T: Serialize>(
    value: &T,
    maximum_bytes: usize,
    too_large: ProtocolError,
) -> Result<Vec<u8>, ProtocolError> {
    let mut writer = BoundedWriter {
        bytes: Vec::with_capacity(maximum_bytes),
        limit: maximum_bytes,
        exceeded: false,
    };
    let result = serde_json::to_writer(&mut writer, value);
    if writer.exceeded {
        return Err(too_large);
    }
    result.map_err(|_| ProtocolError::InvalidJson)?;
    Ok(writer.bytes)
}

fn decode_message<T: for<'de> Deserialize<'de>>(frame: &[u8]) -> Result<T, ProtocolError> {
    if frame.len() > MAX_IPC_FRAME_BYTES {
        return Err(ProtocolError::FrameTooLarge);
    }
    if frame.len() < FRAME_HEADER_BYTES {
        return Err(ProtocolError::InvalidLength);
    }
    let declared = u32::from_be_bytes(
        frame[..FRAME_HEADER_BYTES]
            .try_into()
            .map_err(|_| ProtocolError::InvalidLength)?,
    ) as usize;
    if declared == 0 {
        return Err(ProtocolError::InvalidLength);
    }
    if declared > MAX_IPC_PAYLOAD_BYTES {
        return Err(ProtocolError::FrameTooLarge);
    }
    if frame.len() != FRAME_HEADER_BYTES + declared {
        return Err(ProtocolError::InvalidLength);
    }
    serde_json::from_slice(&frame[FRAME_HEADER_BYTES..]).map_err(|_| ProtocolError::InvalidJson)
}

fn read_worker_frame<R: DeadlineReader>(
    reader: &mut R,
    deadline: Instant,
) -> Result<Option<InboundWorkerFrame>, ProtocolError> {
    let mut header = [0; FRAME_HEADER_BYTES];
    loop {
        match deadline_read(reader, &mut header[..1], deadline)? {
            0 => return Ok(None),
            1 => break,
            _ => unreachable!("one-byte read buffer returned more than one byte"),
        }
    }
    deadline_read_exact(reader, &mut header[1..], deadline)?;

    let payload_len = u32::from_be_bytes(header) as usize;
    if payload_len == 0 {
        return Err(ProtocolError::InvalidLength);
    }
    if payload_len > MAX_IPC_PAYLOAD_BYTES {
        return Err(ProtocolError::FrameTooLarge);
    }

    let frame_len = FRAME_HEADER_BYTES + payload_len;
    let mut frame = Vec::new();
    frame
        .try_reserve_exact(frame_len)
        .map_err(|_| ProtocolError::AllocationFailed)?;
    frame.extend_from_slice(&header);
    frame.resize(frame_len, 0);
    deadline_read_exact(reader, &mut frame[FRAME_HEADER_BYTES..], deadline)?;
    decode_worker_frame(&frame).map(Some)
}

fn deadline_read<R: DeadlineReader>(
    reader: &mut R,
    buffer: &mut [u8],
    deadline: Instant,
) -> Result<usize, ProtocolError> {
    if Instant::now() >= deadline {
        return Err(ProtocolError::ReadDeadlineExceeded);
    }
    let read = reader
        .read_with_deadline(buffer, deadline)
        .map_err(map_frame_read_error)?;
    if Instant::now() >= deadline {
        return Err(ProtocolError::ReadDeadlineExceeded);
    }
    Ok(read)
}

fn deadline_read_exact<R: DeadlineReader>(
    reader: &mut R,
    mut buffer: &mut [u8],
    deadline: Instant,
) -> Result<(), ProtocolError> {
    while !buffer.is_empty() {
        match deadline_read(reader, buffer, deadline)? {
            0 => return Err(ProtocolError::InvalidLength),
            count => buffer = &mut buffer[count..],
        }
    }
    Ok(())
}

fn map_frame_read_error(error: io::Error) -> ProtocolError {
    match error.kind() {
        io::ErrorKind::TimedOut => ProtocolError::ReadDeadlineExceeded,
        io::ErrorKind::Interrupted => ProtocolError::ReadCancelled,
        io::ErrorKind::UnexpectedEof => ProtocolError::InvalidLength,
        kind => ProtocolError::IoFailure(kind),
    }
}

fn valid_capability(capability: &str) -> bool {
    !capability.is_empty()
        && capability.len() <= MAX_ID_BYTES
        && capability
            .bytes()
            .all(|byte| byte.is_ascii_alphanumeric() || matches!(byte, b'.' | b'_' | b'-' | b':'))
}

fn valid_opaque_id(id: &str) -> bool {
    !id.is_empty() && id.len() <= MAX_ID_BYTES && id.bytes().all(|byte| byte.is_ascii_graphic())
}

fn valid_sha256(value: &str) -> bool {
    value.len() == 64
        && value
            .bytes()
            .all(|byte| byte.is_ascii_digit() || (b'a'..=b'f').contains(&byte))
}

#[cfg(test)]
mod tests {
    use std::io::Read;
    use std::sync::atomic::{AtomicUsize, Ordering};
    use std::time::Duration;

    use serde::ser::SerializeSeq;
    use serde_json::json;

    use super::*;

    const CHALLENGE: &str = "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
    const DIGEST: &str = "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb";

    struct TestDeadlineReader<R>(R);

    impl<R: Read> DeadlineReader for TestDeadlineReader<R> {
        fn read_with_deadline(
            &mut self,
            buffer: &mut [u8],
            _deadline: Instant,
        ) -> io::Result<usize> {
            self.0.read(buffer)
        }
    }

    fn raw_frame(payload: &[u8]) -> Vec<u8> {
        let mut frame = Vec::with_capacity(FRAME_HEADER_BYTES + payload.len());
        frame.extend_from_slice(&(payload.len() as u32).to_be_bytes());
        frame.extend_from_slice(payload);
        frame
    }

    fn provenance() -> HostProvenance {
        HostProvenance::from_host_catalog(
            "@modus/fixture",
            "1.2.3",
            DIGEST,
            "host://bundled",
            HostTrustLevel::Core,
            "session-fixture-1",
            "workspace-fixture-1",
            "run-fixture-1",
            1,
        )
        .unwrap()
    }

    fn new_dispatcher() -> Dispatcher {
        Dispatcher::new(CHALLENGE, provenance(), ["memory.read".to_string()]).unwrap()
    }

    fn hello() -> Vec<u8> {
        encode_worker_frame(&WorkerFrame::Hello {
            protocol_version: PROTOCOL_VERSION,
            challenge: CHALLENGE.to_string(),
        })
        .unwrap()
    }

    fn invoke(sequence: u64, capability: &str, payload: Value) -> Vec<u8> {
        encode_worker_frame(&WorkerFrame::Invoke {
            protocol_version: PROTOCOL_VERSION,
            sequence,
            capability: capability.to_string(),
            payload,
        })
        .unwrap()
    }

    fn invocation(event: DispatchEvent) -> AuthorizedInvocation {
        match event {
            DispatchEvent::Invocation(invocation) => invocation,
            DispatchEvent::Ready => panic!("expected invocation"),
        }
    }

    struct CountedSequence<'a> {
        elements_serialized: &'a AtomicUsize,
        element_count: usize,
    }

    impl Serialize for CountedSequence<'_> {
        fn serialize<S>(&self, serializer: S) -> Result<S::Ok, S::Error>
        where
            S: serde::Serializer,
        {
            let mut sequence = serializer.serialize_seq(Some(self.element_count))?;
            for _ in 0..self.element_count {
                sequence.serialize_element(&CountedElement(self.elements_serialized))?;
            }
            sequence.end()
        }
    }

    struct CountedElement<'a>(&'a AtomicUsize);

    impl Serialize for CountedElement<'_> {
        fn serialize<S>(&self, serializer: S) -> Result<S::Ok, S::Error>
        where
            S: serde::Serializer,
        {
            self.0.fetch_add(1, Ordering::SeqCst);
            serializer.serialize_str("xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx")
        }
    }

    #[test]
    fn rejects_frames_over_the_protocol_limit_before_json_parsing() {
        let json = format!(
            "{{\"type\":\"hello\",\"protocol_version\":1,\"challenge\":\"{}\",\"padding\":\"{}\"}}",
            CHALLENGE,
            "x".repeat(MAX_IPC_FRAME_BYTES),
        );

        assert_eq!(
            decode_worker_frame(&raw_frame(json.as_bytes())),
            Err(ProtocolError::FrameTooLarge),
        );
    }

    #[test]
    fn stream_reader_accepts_one_frame_at_a_time_and_clean_eof() {
        let mut bytes = hello();
        bytes.extend(invoke(1, "memory.read", json!({ "key": "one" })));
        bytes.extend(invoke(2, "memory.read", json!({ "key": "two" })));
        let mut reader = TestDeadlineReader(io::Cursor::new(bytes));
        let mut dispatcher = new_dispatcher();

        assert_eq!(
            dispatcher.receive_from_until(&mut reader, Instant::now() + Duration::from_secs(1)),
            Ok(Some(DispatchEvent::Ready)),
        );
        for sequence in [1, 2] {
            let event = dispatcher
                .receive_from_until(&mut reader, Instant::now() + Duration::from_secs(1))
                .unwrap()
                .unwrap();
            assert_eq!(invocation(event).sequence(), sequence);
        }
        assert_eq!(
            dispatcher.receive_from_until(&mut reader, Instant::now() + Duration::from_secs(1)),
            Ok(None),
        );
        assert!(dispatcher.is_closed());
    }

    #[test]
    fn stream_reader_rejects_truncated_frames() {
        let mut partial_header = TestDeadlineReader(io::Cursor::new(vec![0, 0]));
        let mut dispatcher = new_dispatcher();
        assert_eq!(
            dispatcher
                .receive_from_until(&mut partial_header, Instant::now() + Duration::from_secs(1),),
            Err(ProtocolError::InvalidLength),
        );
        assert!(dispatcher.is_closed());

        let mut partial_payload = TestDeadlineReader(io::Cursor::new(vec![0, 0, 0, 2, b'{']));
        let mut dispatcher = new_dispatcher();
        assert_eq!(
            dispatcher.receive_from_until(
                &mut partial_payload,
                Instant::now() + Duration::from_secs(1),
            ),
            Err(ProtocolError::InvalidLength),
        );
        assert!(dispatcher.is_closed());
    }

    #[test]
    fn stream_reader_rejects_oversize_before_reading_the_body() {
        struct HeaderOnlyReader {
            header: [u8; FRAME_HEADER_BYTES],
            offset: usize,
        }

        impl DeadlineReader for HeaderOnlyReader {
            fn read_with_deadline(
                &mut self,
                buffer: &mut [u8],
                _deadline: Instant,
            ) -> io::Result<usize> {
                if self.offset == self.header.len() {
                    return Err(io::Error::other("frame body must not be read"));
                }
                let count = buffer.len().min(self.header.len() - self.offset);
                buffer[..count].copy_from_slice(&self.header[self.offset..self.offset + count]);
                self.offset += count;
                Ok(count)
            }
        }

        let length = (MAX_IPC_PAYLOAD_BYTES as u32 + 1).to_be_bytes();
        let mut reader = HeaderOnlyReader {
            header: length,
            offset: 0,
        };
        let mut dispatcher = new_dispatcher();

        assert_eq!(
            dispatcher.receive_from_until(&mut reader, Instant::now() + Duration::from_secs(1),),
            Err(ProtocolError::FrameTooLarge),
        );
        assert_eq!(reader.offset, FRAME_HEADER_BYTES);
        assert!(dispatcher.is_closed());
    }

    #[test]
    fn stream_reader_closes_generation_on_read_deadline_and_cancellation() {
        struct StoppedReader(io::ErrorKind);

        impl DeadlineReader for StoppedReader {
            fn read_with_deadline(
                &mut self,
                _buffer: &mut [u8],
                _deadline: Instant,
            ) -> io::Result<usize> {
                Err(io::Error::from(self.0))
            }
        }

        let mut dispatcher = new_dispatcher();
        assert_eq!(
            dispatcher.receive_from_until(
                &mut StoppedReader(io::ErrorKind::TimedOut),
                Instant::now() + Duration::from_secs(1),
            ),
            Err(ProtocolError::ReadDeadlineExceeded),
        );
        assert!(dispatcher.is_closed());

        let mut dispatcher = new_dispatcher();
        assert_eq!(
            dispatcher.receive_from_until(
                &mut StoppedReader(io::ErrorKind::Interrupted),
                Instant::now() + Duration::from_secs(1),
            ),
            Err(ProtocolError::ReadCancelled),
        );
        assert!(dispatcher.is_closed());
    }

    #[test]
    fn stream_reader_rejects_an_expired_deadline_without_reading() {
        struct NeverRead;

        impl DeadlineReader for NeverRead {
            fn read_with_deadline(
                &mut self,
                _buffer: &mut [u8],
                _deadline: Instant,
            ) -> io::Result<usize> {
                panic!("expired deadline must be checked before reading");
            }
        }

        let mut dispatcher = new_dispatcher();
        assert_eq!(
            dispatcher.receive_from_until(&mut NeverRead, Instant::now() - Duration::from_secs(1)),
            Err(ProtocolError::ReadDeadlineExceeded),
        );
        assert!(dispatcher.is_closed());
    }

    #[test]
    fn wire_frame_limit_includes_the_length_prefix() {
        let exact_value = "x".repeat(MAX_IPC_FRAME_BYTES - FRAME_HEADER_BYTES - 2);
        let exact_frame = encode_message(&exact_value).unwrap();
        assert_eq!(exact_frame.len(), MAX_IPC_FRAME_BYTES);
        assert_eq!(decode_message::<String>(&exact_frame), Ok(exact_value),);

        let oversized_value = "x".repeat(MAX_IPC_FRAME_BYTES - FRAME_HEADER_BYTES - 1);
        assert!(matches!(
            encode_message(&oversized_value),
            Err(ProtocolError::FrameTooLarge)
        ));
        let oversized_payload = serde_json::to_vec(&oversized_value).unwrap();
        assert!(matches!(
            decode_message::<String>(&raw_frame(&oversized_payload)),
            Err(ProtocolError::FrameTooLarge)
        ));
    }

    #[test]
    fn outbound_serialization_stops_at_the_frame_limit() {
        let elements_serialized = AtomicUsize::new(0);
        let value = CountedSequence {
            elements_serialized: &elements_serialized,
            element_count: 16_384,
        };

        assert_eq!(encode_message(&value), Err(ProtocolError::FrameTooLarge));
        let serialized = elements_serialized.load(Ordering::SeqCst);
        assert!(serialized > 0);
        assert!(serialized < value.element_count);
    }

    #[test]
    fn rejects_guest_supplied_host_identity_fields() {
        let json = br#"{"type":"invoke","protocol_version":2,"sequence":1,"capability":"memory.read","payload":{},"plugin_id":"forged","plugin_version":"9.9.9","artifact_sha256":"bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb","artifact_origin":"host://bundled","trust_level":"core","session_id":"other-session","workspace_id":"other-workspace","run_id":"other-run","generation":99}"#;

        assert_eq!(
            decode_worker_frame(&raw_frame(json)),
            Err(ProtocolError::InvalidJson),
        );
    }

    #[test]
    fn provenance_requires_nonempty_host_scope_and_artifact_identity() {
        let invalid_scopes = [("", "workspace-fixture-1"), ("session-fixture-1", "")];

        for (session_id, workspace_id) in invalid_scopes {
            assert_eq!(
                HostProvenance::from_host_catalog(
                    "@modus/fixture",
                    "1.2.3",
                    DIGEST,
                    "host://bundled",
                    HostTrustLevel::Core,
                    session_id,
                    workspace_id,
                    "run-fixture-1",
                    1,
                ),
                Err(ProtocolError::InvalidIdentity),
            );
        }

        assert_eq!(
            HostProvenance::from_host_catalog(
                "@modus/fixture",
                "",
                DIGEST,
                "host://bundled",
                HostTrustLevel::Core,
                "session-fixture-1",
                "workspace-fixture-1",
                "run-fixture-1",
                1,
            ),
            Err(ProtocolError::InvalidIdentity),
        );
    }

    #[test]
    fn rejects_zero_truncated_and_trailing_frame_bytes() {
        assert_eq!(
            decode_worker_frame(&[0, 0, 0, 0]),
            Err(ProtocolError::InvalidLength)
        );
        assert_eq!(
            decode_worker_frame(&[0, 0, 0]),
            Err(ProtocolError::InvalidLength)
        );

        let mut frame = hello();
        frame.push(0);
        assert_eq!(
            decode_worker_frame(&frame),
            Err(ProtocolError::InvalidLength)
        );
    }

    #[test]
    fn handshake_must_match_the_host_challenge_before_invocations() {
        let mut dispatcher = new_dispatcher();
        assert_eq!(
            dispatcher.receive(&invoke(1, "memory.read", json!({}))),
            Err(ProtocolError::InvalidState),
        );
        assert!(dispatcher.is_closed());

        let mut dispatcher = new_dispatcher();
        let wrong = encode_worker_frame(&WorkerFrame::Hello {
            protocol_version: PROTOCOL_VERSION,
            challenge: "cccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccc"
                .to_string(),
        })
        .unwrap();
        assert_eq!(
            dispatcher.receive(&wrong),
            Err(ProtocolError::ChallengeMismatch),
        );
        assert!(dispatcher.is_closed());
    }

    #[test]
    fn rejects_v1_worker_before_negotiating_the_v2_cancellation_frame() {
        let mut dispatcher = new_dispatcher();
        let v1_hello = encode_worker_frame(&WorkerFrame::Hello {
            protocol_version: 1,
            challenge: CHALLENGE.to_string(),
        })
        .unwrap();

        assert_eq!(
            dispatcher.receive(&v1_hello),
            Err(ProtocolError::UnsupportedVersion),
        );
        assert!(dispatcher.is_closed());
    }

    #[test]
    fn rejects_v1_host_responses_after_the_v2_protocol_upgrade() {
        let v1_response = encode_message(&HostFrame::Ready {
            protocol_version: 1,
        })
        .unwrap();

        assert_eq!(
            decode_host_frame(&v1_response),
            Err(ProtocolError::UnsupportedVersion),
        );
    }

    #[test]
    fn invocation_uses_host_identity_and_exact_host_grants() {
        let mut dispatcher = new_dispatcher();
        assert_eq!(dispatcher.receive(&hello()), Ok(DispatchEvent::Ready));
        let invocation = invocation(
            dispatcher
                .receive(&invoke(1, "memory.read", json!({ "key": "fixture" })))
                .unwrap(),
        );
        assert_eq!(invocation.sequence(), 1);
        assert!(invocation.is_current());
        assert_eq!(invocation.capability(), Some("memory.read"));
        assert_eq!(
            invocation.provenance().unwrap().plugin_id(),
            "@modus/fixture"
        );
        assert_eq!(invocation.provenance().unwrap().plugin_version(), "1.2.3");
        assert_eq!(invocation.provenance().unwrap().artifact_sha256(), DIGEST);
        assert_eq!(
            invocation.provenance().unwrap().artifact_origin(),
            "host://bundled"
        );
        assert_eq!(
            invocation.provenance().unwrap().trust_level(),
            HostTrustLevel::Core
        );
        assert_eq!(
            invocation.provenance().unwrap().session_id(),
            "session-fixture-1"
        );
        assert_eq!(
            invocation.provenance().unwrap().workspace_id(),
            "workspace-fixture-1"
        );
        assert_eq!(invocation.provenance().unwrap().run_id(), "run-fixture-1");
        assert_eq!(invocation.provenance().unwrap().generation(), 1);

        assert_eq!(
            dispatcher.receive(&invoke(2, "filesystem.read", json!({}))),
            Err(ProtocolError::CapabilityDenied),
        );
        assert!(dispatcher.is_closed());
    }

    #[test]
    fn dispatcher_close_revokes_only_its_outstanding_invocations() {
        let mut first_dispatcher = new_dispatcher();
        let mut second_dispatcher = Dispatcher::new(
            CHALLENGE,
            HostProvenance::from_host_catalog(
                "@modus/fixture-two",
                "1.2.3",
                DIGEST,
                "host://bundled",
                HostTrustLevel::Core,
                "session-fixture-2",
                "workspace-fixture-2",
                "run-fixture-2",
                2,
            )
            .unwrap(),
            ["memory.read".to_string()],
        )
        .unwrap();
        first_dispatcher.receive(&hello()).unwrap();
        second_dispatcher.receive(&hello()).unwrap();
        let first = invocation(
            first_dispatcher
                .receive(&invoke(1, "memory.read", json!({})))
                .unwrap(),
        );
        let second = invocation(
            second_dispatcher
                .receive(&invoke(1, "memory.read", json!({})))
                .unwrap(),
        );

        first_dispatcher.close();

        assert!(!first.is_current());
        assert_eq!(first.capability(), None);
        assert_eq!(first.payload(), None);
        assert_eq!(first.provenance(), None);
        assert!(second.is_current());
        assert_eq!(second.capability(), Some("memory.read"));
    }

    #[test]
    fn completing_one_invocation_revokes_only_its_authority() {
        let mut dispatcher = new_dispatcher();
        dispatcher.receive(&hello()).unwrap();
        let first = invocation(
            dispatcher
                .receive(&invoke(1, "memory.read", json!({})))
                .unwrap(),
        );
        let second = invocation(
            dispatcher
                .receive(&invoke(2, "memory.read", json!({})))
                .unwrap(),
        );

        dispatcher
            .complete(1, InvocationOutcome::Success(json!({ "ok": true })))
            .unwrap();

        assert!(!first.is_current());
        assert_eq!(first.payload(), None);
        assert!(second.is_current());
        assert_eq!(second.capability(), Some("memory.read"));
    }

    #[test]
    fn cancelled_invocation_has_a_distinct_result_and_revokes_only_its_authority() {
        let mut dispatcher = new_dispatcher();
        dispatcher.receive(&hello()).unwrap();
        let cancelled = invocation(
            dispatcher
                .receive(&invoke(1, "memory.read", json!({})))
                .unwrap(),
        );
        let active = invocation(
            dispatcher
                .receive(&invoke(2, "memory.read", json!({})))
                .unwrap(),
        );

        let response = dispatcher
            .complete(1, InvocationOutcome::Cancelled)
            .unwrap();

        assert_eq!(
            decode_host_frame(&response),
            Ok(HostFrame::InvocationCancelled {
                protocol_version: PROTOCOL_VERSION,
                sequence: 1,
            }),
        );
        assert!(!cancelled.is_current());
        assert!(active.is_current());
    }

    #[test]
    fn dispatcher_provenance_is_isolated_by_session_workspace_and_run() {
        let second_provenance = HostProvenance::from_host_catalog(
            "@modus/fixture",
            "1.2.3",
            DIGEST,
            "host://bundled",
            HostTrustLevel::Core,
            "session-fixture-2",
            "workspace-fixture-2",
            "run-fixture-2",
            2,
        )
        .unwrap();
        let mut first = new_dispatcher();
        let mut second =
            Dispatcher::new(CHALLENGE, second_provenance, ["memory.read".to_string()]).unwrap();

        first.receive(&hello()).unwrap();
        second.receive(&hello()).unwrap();
        let first = invocation(first.receive(&invoke(1, "memory.read", json!({}))).unwrap());
        let second = invocation(
            second
                .receive(&invoke(1, "memory.read", json!({})))
                .unwrap(),
        );

        assert_eq!(
            first.provenance().unwrap().session_id(),
            "session-fixture-1"
        );
        assert_eq!(
            first.provenance().unwrap().workspace_id(),
            "workspace-fixture-1"
        );
        assert_eq!(first.provenance().unwrap().run_id(), "run-fixture-1");
        assert_eq!(
            second.provenance().unwrap().session_id(),
            "session-fixture-2"
        );
        assert_eq!(
            second.provenance().unwrap().workspace_id(),
            "workspace-fixture-2"
        );
        assert_eq!(second.provenance().unwrap().run_id(), "run-fixture-2");
    }

    #[test]
    fn requires_monotonic_sequences_and_correlates_results() {
        let mut dispatcher = new_dispatcher();
        dispatcher.receive(&hello()).unwrap();
        let call = invocation(
            dispatcher
                .receive(&invoke(1, "memory.read", json!({})))
                .unwrap(),
        );
        assert_eq!(call.sequence(), 1);

        let response = dispatcher
            .complete(1, InvocationOutcome::Success(json!({ "found": true })))
            .unwrap();
        assert_eq!(
            decode_host_frame(&response),
            Ok(HostFrame::InvocationSucceeded {
                protocol_version: PROTOCOL_VERSION,
                sequence: 1,
                result: json!({ "found": true }),
            }),
        );
        assert_eq!(
            dispatcher.receive(&invoke(1, "memory.read", json!({}))),
            Err(ProtocolError::OutOfOrder),
        );
    }

    #[test]
    fn rejects_an_unmatched_result_and_closes_the_generation() {
        let mut dispatcher = new_dispatcher();
        dispatcher.receive(&hello()).unwrap();
        dispatcher
            .receive(&invoke(1, "memory.read", json!({})))
            .unwrap();
        assert_eq!(
            dispatcher.complete(2, InvocationOutcome::Success(json!(null))),
            Err(ProtocolError::UnknownSequence),
        );
        assert!(dispatcher.is_closed());
    }

    #[test]
    fn caps_pending_calls_and_response_bytes() {
        let grants = ["memory.read".to_string()];
        let mut dispatcher = Dispatcher::new(CHALLENGE, provenance(), grants).unwrap();
        dispatcher.receive(&hello()).unwrap();
        for sequence in 1..=MAX_PENDING_REQUESTS as u64 {
            dispatcher
                .receive(&invoke(sequence, "memory.read", json!({})))
                .unwrap();
        }
        assert_eq!(
            dispatcher.receive(&invoke(
                MAX_PENDING_REQUESTS as u64 + 1,
                "memory.read",
                json!({}),
            )),
            Err(ProtocolError::TooManyPending),
        );
        assert!(dispatcher.is_closed());

        let mut dispatcher = new_dispatcher();
        dispatcher.receive(&hello()).unwrap();
        dispatcher
            .receive(&invoke(1, "memory.read", json!({})))
            .unwrap();
        assert_eq!(
            dispatcher.complete(
                1,
                InvocationOutcome::Success(Value::String("x".repeat(MAX_RESULT_BYTES))),
            ),
            Err(ProtocolError::ResultTooLarge),
        );
        assert!(dispatcher.is_closed());
    }

    #[test]
    fn caps_serialized_failure_bytes_and_closes_the_pending_generation() {
        // Newlines are escaped as two JSON bytes each, so the in-memory error
        // is below the limit while its serialized representation exceeds it.
        let error = "\n".repeat(MAX_RESULT_BYTES / 2 + 1);
        assert!(error.len() <= MAX_RESULT_BYTES);
        assert!(serde_json::to_vec(&error).unwrap().len() > MAX_RESULT_BYTES);

        let oversized = HostFrame::InvocationFailed {
            protocol_version: PROTOCOL_VERSION,
            sequence: 1,
            error: error.clone(),
        };
        assert_eq!(
            decode_host_frame(&encode_message(&oversized).unwrap()),
            Err(ProtocolError::ResultTooLarge),
        );

        let mut dispatcher = new_dispatcher();
        dispatcher.receive(&hello()).unwrap();
        dispatcher
            .receive(&invoke(1, "memory.read", json!({})))
            .unwrap();
        assert_eq!(
            dispatcher.complete(1, InvocationOutcome::Failure(error)),
            Err(ProtocolError::ResultTooLarge),
        );
        assert!(dispatcher.is_closed());
        assert_eq!(
            dispatcher.complete(1, InvocationOutcome::Failure("retry".to_string())),
            Err(ProtocolError::InvalidState),
        );
    }

    #[test]
    fn close_discards_pending_requests_and_rejects_late_frames() {
        let mut dispatcher = new_dispatcher();
        dispatcher.receive(&hello()).unwrap();
        dispatcher
            .receive(&invoke(1, "memory.read", json!({})))
            .unwrap();
        dispatcher.close();
        assert_eq!(
            dispatcher.complete(1, InvocationOutcome::Success(json!(null))),
            Err(ProtocolError::InvalidState),
        );
        assert_eq!(
            dispatcher.receive(&invoke(2, "memory.read", json!({}))),
            Err(ProtocolError::InvalidState),
        );
    }
}
