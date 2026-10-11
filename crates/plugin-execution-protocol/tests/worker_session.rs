use std::collections::VecDeque;
use std::io;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};

use modus_plugin_execution_protocol::resource_policy::APPROVED_RESOURCE_POLICY;
use modus_plugin_execution_protocol::worker_admission::{
    AdmissionAssessmentToken, AssessedWorker, EnforcementControl, PlatformAssessment,
    WorkerTransport,
};
use modus_plugin_execution_protocol::{
    decode_host_frame, encode_worker_frame, DispatchEvent, HostFrame, HostProvenance,
    HostTrustLevel, InvocationOutcome, WorkerFrame, WorkerSession, PROTOCOL_VERSION,
};
use serde_json::json;

const CHALLENGE: &str = "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";

struct FixtureTransport {
    incoming: VecDeque<u8>,
    outgoing: Arc<Mutex<Vec<u8>>>,
    terminated: Arc<AtomicBool>,
    reaped: Arc<AtomicBool>,
}

impl modus_plugin_execution_protocol::DeadlineReader for FixtureTransport {
    fn read_with_deadline(&mut self, buffer: &mut [u8], deadline: Instant) -> io::Result<usize> {
        if Instant::now() >= deadline {
            return Err(io::Error::new(io::ErrorKind::TimedOut, "fixture deadline"));
        }
        let count = buffer.len().min(self.incoming.len());
        for byte in &mut buffer[..count] {
            *byte = self.incoming.pop_front().expect("bounded by fixture input");
        }
        Ok(count)
    }
}

unsafe impl WorkerTransport for FixtureTransport {
    fn write_with_deadline(&mut self, frame: &[u8], deadline: Instant) -> io::Result<()> {
        if Instant::now() >= deadline {
            return Err(io::Error::new(io::ErrorKind::TimedOut, "fixture deadline"));
        }
        self.outgoing.lock().unwrap().extend_from_slice(frame);
        Ok(())
    }

    fn request_termination(&mut self) {
        self.terminated.store(true, Ordering::SeqCst);
    }

    fn reap_until(&mut self, deadline: Instant) -> io::Result<()> {
        if Instant::now() >= deadline {
            return Err(io::Error::new(
                io::ErrorKind::TimedOut,
                "fixture reap deadline",
            ));
        }
        self.reaped.store(true, Ordering::SeqCst);
        Ok(())
    }
}

fn provenance() -> HostProvenance {
    HostProvenance::from_host_catalog(
        "fixture/plugin",
        "1.0.0",
        "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb",
        "fixture-catalog",
        HostTrustLevel::Verified,
        "fixture-session",
        "fixture-workspace",
        "fixture-run",
        1,
    )
    .unwrap()
}

fn session(
    input: Vec<u8>,
) -> (
    WorkerSession<FixtureTransport>,
    Arc<Mutex<Vec<u8>>>,
    Arc<AtomicBool>,
    Arc<AtomicBool>,
) {
    let provenance = provenance();
    let outgoing = Arc::new(Mutex::new(Vec::new()));
    let terminated = Arc::new(AtomicBool::new(false));
    let reaped = Arc::new(AtomicBool::new(false));
    let transport = FixtureTransport {
        incoming: input.into(),
        outgoing: Arc::clone(&outgoing),
        terminated: Arc::clone(&terminated),
        reaped: Arc::clone(&reaped),
    };
    let controls = [
        EnforcementControl::ArtifactLimitBeforeParsing,
        EnforcementControl::BoundedIpcResultsAndOutput,
        EnforcementControl::WasmMemoryAndFuel,
        EnforcementControl::HelperAndAggregateRss,
        EnforcementControl::CpuRatePerCore,
        EnforcementControl::StartupExecutionAndBrokerDeadlines,
        EnforcementControl::PreemptibleTerminationAndTreeReap,
        EnforcementControl::HostcallAndPendingRequestLimits,
        EnforcementControl::GuestProcessAndKernelHandleLimits,
        EnforcementControl::AmbientFilesystemNetworkAndCredentialDenial,
    ];
    // Safe fixture claims are local test data only; no process is created.
    let assessment = unsafe {
        PlatformAssessment::from_adapter(provenance.clone(), APPROVED_RESOURCE_POLICY, controls)
    };
    let worker = unsafe { AssessedWorker::from_adapter(assessment, transport) };
    let token = AdmissionAssessmentToken::validate(worker, provenance).unwrap();
    let session = WorkerSession::new(token, CHALLENGE, ["memory.read".to_owned()]).unwrap();
    (session, outgoing, terminated, reaped)
}

fn append_frame(buffer: &mut Vec<u8>, frame: WorkerFrame) {
    buffer.extend(encode_worker_frame(&frame).unwrap());
}

#[test]
fn runtime_session_keeps_handshake_invocation_and_response_on_assessed_transport() {
    let mut input = Vec::new();
    append_frame(
        &mut input,
        WorkerFrame::Hello {
            protocol_version: PROTOCOL_VERSION,
            challenge: CHALLENGE.to_owned(),
        },
    );
    append_frame(
        &mut input,
        WorkerFrame::Invoke {
            protocol_version: PROTOCOL_VERSION,
            sequence: 1,
            capability: "memory.read".to_owned(),
            payload: json!({ "key": "fixture" }),
        },
    );

    let (mut session, outgoing, terminated, reaped) = session(input);
    let deadline = Instant::now() + Duration::from_secs(1);
    assert_eq!(
        session.receive_until(deadline),
        Ok(Some(DispatchEvent::Ready))
    );
    let invocation = match session.receive_until(deadline).unwrap().unwrap() {
        DispatchEvent::Invocation(invocation) => invocation,
        DispatchEvent::Ready => panic!("hello is only accepted once"),
    };
    assert_eq!(invocation.sequence(), 1);
    assert_eq!(invocation.provenance(), Some(&provenance()));
    session
        .complete_until(
            invocation.sequence(),
            InvocationOutcome::Success(json!({ "value": "fixture" })),
            deadline,
        )
        .unwrap();

    let output = outgoing.lock().unwrap();
    let ready_length = 4 + u32::from_be_bytes(output[..4].try_into().unwrap()) as usize;
    assert_eq!(
        decode_host_frame(&output[..ready_length]).unwrap(),
        HostFrame::Ready {
            protocol_version: PROTOCOL_VERSION,
        },
    );
    assert_eq!(
        decode_host_frame(&output[ready_length..]).unwrap(),
        HostFrame::InvocationSucceeded {
            protocol_version: PROTOCOL_VERSION,
            sequence: 1,
            result: json!({ "value": "fixture" }),
        },
    );
    drop(output);

    session
        .shutdown_until(Instant::now() + Duration::from_secs(1))
        .unwrap();
    assert!(terminated.load(Ordering::SeqCst));
    assert!(reaped.load(Ordering::SeqCst));
}
