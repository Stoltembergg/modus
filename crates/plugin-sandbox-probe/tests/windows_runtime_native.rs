#![cfg(windows)]

#[path = "windows_runtime_native/guardian.rs"]
mod guardian;
#[path = "../src/platform/windows_runtime/native.rs"]
mod native;
#[path = "../src/platform/windows_runtime/ownership.rs"]
mod ownership;

use std::sync::mpsc;
use std::thread;
use std::time::{Duration, Instant};

#[test]
fn qpc_post_wait_recheck_rejects_signaled_result_after_cutoff() {
    use ownership::{CaseClock, QpcOrigin, QpcSource};
    use std::sync::Arc;
    use std::sync::atomic::{AtomicI64, Ordering};

    struct AdvancingQpc(AtomicI64);
    impl QpcSource for AdvancingQpc {
        fn counter(&self) -> Result<i64, u32> {
            Ok(self.0.load(Ordering::SeqCst))
        }
        fn frequency(&self) -> Result<i64, u32> {
            Ok(10)
        }
        fn after_wait(&self) {
            self.0.store(1_031, Ordering::SeqCst);
        }
    }

    let clock = CaseClock::from_shared_qpc(
        QpcOrigin {
            counter: 1_000,
            frequency: 10,
        },
        Arc::new(AdvancingQpc(AtomicI64::new(1_000))),
    )
    .unwrap();
    let cutoff = ownership::CaseTimestamp::SharedQpc(1_030);
    let (error, expired) = native::post_wait_evidence(
        WAIT_OBJECT_0,
        || 0,
        || {
            clock.after_wait_for_test();
            clock.is_due(cutoff).unwrap_or(true)
        },
    );
    assert_eq!(error, None);
    assert!(expired, "signaled completion after cutoff is not timely");
}

#[test]
fn actual_native_root_wait_rejects_signaled_result_after_qpc_cutoff() {
    use ownership::{CaseClock, QpcOrigin, QpcSource};
    use std::sync::Arc;
    use std::sync::atomic::{AtomicI64, Ordering};
    use windows_sys::Win32::System::Threading::{CreateEventW, SetEvent};

    struct AdvancingQpc(AtomicI64);
    impl QpcSource for AdvancingQpc {
        fn counter(&self) -> Result<i64, u32> {
            Ok(self.0.load(Ordering::SeqCst))
        }
        fn frequency(&self) -> Result<i64, u32> {
            Ok(10)
        }
        fn after_wait(&self) {
            self.0.store(1_031, Ordering::SeqCst);
        }
    }

    let clock = CaseClock::from_shared_qpc(
        QpcOrigin {
            counter: 1_000,
            frequency: 10,
        },
        Arc::new(AdvancingQpc(AtomicI64::new(1_000))),
    )
    .unwrap();
    let event = unsafe { CreateEventW(std::ptr::null(), 1, 1, std::ptr::null()) };
    assert!(!event.is_null());
    assert_ne!(unsafe { SetEvent(event) }, 0);

    let result = native::wait_until(event, &clock, ownership::CaseTimestamp::SharedQpc(1_030));
    unsafe { windows_sys::Win32::Foundation::CloseHandle(event) };

    assert_eq!(
        result,
        Ok(false),
        "a signal after the absolute cutoff is late"
    );
}

#[test]
fn watchdog_result_receive_rejects_completion_delivered_after_qpc_cutoff() {
    use ownership::{CaseClock, QpcOrigin, QpcSource};
    use std::sync::Arc;
    use std::sync::atomic::{AtomicI64, Ordering};

    struct AdvancingQpc(AtomicI64);
    impl QpcSource for AdvancingQpc {
        fn counter(&self) -> Result<i64, u32> {
            Ok(self.0.load(Ordering::SeqCst))
        }
        fn frequency(&self) -> Result<i64, u32> {
            Ok(10)
        }
        fn after_receive(&self) {
            self.0.store(1_031, Ordering::SeqCst);
        }
    }

    let clock = CaseClock::from_shared_qpc(
        QpcOrigin {
            counter: 1_000,
            frequency: 10,
        },
        Arc::new(AdvancingQpc(AtomicI64::new(1_000))),
    )
    .unwrap();
    let (sender, receiver) = mpsc::channel();
    sender.send(()).unwrap();

    let (completion, timely) = native::receive_watchdog_result_until(
        &receiver,
        Duration::from_secs(1),
        &clock,
        ownership::CaseTimestamp::SharedQpc(1_030),
    );
    assert_eq!(
        completion,
        Ok(()),
        "completion was delivered to the consumer"
    );
    assert!(!timely, "delivery after the absolute cutoff is not timely");
}

#[test]
fn watchdog_wait_caller_rejects_completion_after_qpc_cutoff() {
    use ownership::{CaseClock, QpcOrigin, QpcSource};
    use std::sync::Arc;
    use std::sync::atomic::{AtomicI64, Ordering};

    struct AdvancingQpc(AtomicI64);
    impl QpcSource for AdvancingQpc {
        fn counter(&self) -> Result<i64, u32> {
            Ok(self.0.load(Ordering::SeqCst))
        }
        fn frequency(&self) -> Result<i64, u32> {
            Ok(10)
        }
        fn after_receive(&self) {
            self.0.store(1_031, Ordering::SeqCst);
        }
    }

    let clock = CaseClock::from_shared_qpc(
        QpcOrigin {
            counter: 1_000,
            frequency: 10,
        },
        Arc::new(AdvancingQpc(AtomicI64::new(1_000))),
    )
    .unwrap();
    assert!(
        !native::watchdog_wait_for_completed_result_for_test(
            &clock,
            ownership::CaseTimestamp::SharedQpc(1_030),
        ),
        "the actual caller must reject a result delivered after cutoff"
    );
}

#[test]
fn shared_qpc_rejects_origin_without_full_absolute_schedule() {
    use ownership::{CaseClock, QpcOrigin, QpcSource};
    use std::sync::Arc;

    struct StaticQpc;
    impl QpcSource for StaticQpc {
        fn counter(&self) -> Result<i64, u32> {
            Ok(1)
        }
        fn frequency(&self) -> Result<i64, u32> {
            Ok(10)
        }
    }

    let result = CaseClock::from_shared_qpc(
        QpcOrigin {
            counter: i64::MAX - 2,
            frequency: 10,
        },
        Arc::new(StaticQpc),
    );
    assert!(matches!(result, Err(ownership::ClockError::Overflow)));
}

#[test]
fn setup_clock_error_is_latched_when_failure_observation_recovers() {
    use ownership::{CaseClock, QpcOrigin, QpcSource};
    use std::sync::Arc;
    use std::sync::atomic::{AtomicUsize, Ordering};

    struct RecoveringQpc(AtomicUsize);
    impl QpcSource for RecoveringQpc {
        fn counter(&self) -> Result<i64, u32> {
            if self.0.fetch_add(1, Ordering::SeqCst) == 0 {
                Err(77)
            } else {
                Ok(1_002)
            }
        }
        fn frequency(&self) -> Result<i64, u32> {
            Ok(10)
        }
    }

    let failure = match native::NativeSession::prepare_with_shared_qpc_for_test(
        CaseClock::from_shared_qpc(
            QpcOrigin {
                counter: 1_000,
                frequency: 10,
            },
            Arc::new(RecoveringQpc(AtomicUsize::new(0))),
        )
        .unwrap(),
        |_| None,
        native::ValidationOverrides::default(),
        None,
    ) {
        Err(failure) => failure,
        Ok(session) => {
            drop(session);
            panic!("setup QPC error must abort")
        }
    };
    assert_eq!(failure.failure_observed_qpc, Some(1_002));
    assert_eq!(failure.cleanup.clock_error, Some(77));
    assert!(failure.cleanup.clock_invalid);
    assert!(!failure.cleanup.continuation_safe);
}

#[test]
fn wait_failed_error_is_captured_before_qpc_recheck_mutates_last_error() {
    use std::cell::Cell;

    let last_error = Cell::new(0x1234);
    let (error, _) = native::post_wait_evidence(
        windows_sys::Win32::Foundation::WAIT_FAILED,
        || last_error.get(),
        || {
            last_error.set(0x5678);
            false
        },
    );
    assert_eq!(error, Some(0x1234));
    assert_eq!(last_error.get(), 0x5678);
}

#[test]
fn qpc_late_watchdog_wake_attempts_root_containment_but_is_not_timely() {
    use ownership::{CaseClock, CaseTimestamp, QpcOrigin, QpcSource};
    use std::sync::Arc;
    use std::sync::atomic::{AtomicBool, AtomicI64, Ordering};

    struct LateWakeQpc {
        counter: AtomicI64,
        arm: AtomicBool,
        advanced: AtomicBool,
    }
    impl QpcSource for LateWakeQpc {
        fn counter(&self) -> Result<i64, u32> {
            Ok(self.counter.load(Ordering::SeqCst))
        }
        fn frequency(&self) -> Result<i64, u32> {
            Ok(10)
        }
        fn after_receive(&self) {
            if self.arm.load(Ordering::SeqCst) {
                self.counter.store(1_041, Ordering::SeqCst);
                self.advanced.store(true, Ordering::SeqCst);
            }
        }
    }

    let (entered_tx, entered_rx) = mpsc::channel();
    let (release_tx, release_rx) = mpsc::channel();
    let source = Arc::new(LateWakeQpc {
        counter: AtomicI64::new(1_000),
        arm: AtomicBool::new(false),
        advanced: AtomicBool::new(false),
    });
    let clock_source: Arc<dyn QpcSource> = source.clone();
    let mut session = native::NativeSession::prepare_with_shared_qpc_for_test(
        CaseClock::from_shared_qpc(
            QpcOrigin {
                counter: 1_000,
                frequency: 10,
            },
            clock_source,
        )
        .unwrap(),
        move |stage| {
            if stage == native::NativeStage::CleanupTerminateJob {
                let _ = entered_tx.send(());
                let _ = release_rx.recv_timeout(Duration::from_secs(2));
            }
            None
        },
        native::ValidationOverrides::default(),
        None,
    )
    .expect("session setup should complete before arming the delayed wake");
    let mut independent = TestRootReaper::open(session.root_pid())
        .expect("independent reaper must hold root custody");
    let containment_attempted = session.watchdog_late_containment_attempted_for_test();
    source.counter.store(1_020, Ordering::SeqCst);
    source.arm.store(true, Ordering::SeqCst);

    let source_for_helper = Arc::clone(&source);
    let helper = thread::spawn(move || {
        let parent_blocked = entered_rx.recv_timeout(Duration::from_secs(2)).is_ok();
        let advance_deadline = Instant::now() + Duration::from_secs(2);
        while !containment_attempted.load(Ordering::SeqCst) && Instant::now() < advance_deadline {
            thread::yield_now();
        }
        let watchdog_reached_late_clock = source_for_helper.advanced.load(Ordering::SeqCst)
            && containment_attempted.load(Ordering::SeqCst);
        source_for_helper.counter.store(1_039, Ordering::SeqCst);
        let _ = release_tx.send(());
        (parent_blocked, watchdog_reached_late_clock)
    });

    let evidence = session.cleanup_timestamp_for_test(CaseTimestamp::SharedQpc(1_020));
    let (parent_blocked, watchdog_reached_late_clock) = helper.join().unwrap();
    let independently_reaped = independent.terminate_and_wait();
    assert!(parent_blocked);
    assert!(watchdog_reached_late_clock);
    assert!(
        independently_reaped,
        "root containment must be independently confirmed"
    );
    assert!(evidence.watchdog_fired, "{evidence:?}");
    assert!(evidence.root_termination_attempted, "{evidence:?}");
    assert!(evidence.watchdog_intervened, "{evidence:?}");
    assert!(!evidence.watchdog_recovery_confirmed, "{evidence:?}");
    assert!(!evidence.continuation_safe, "{evidence:?}");
    assert_eq!(evidence.cleanup_deadline_qpc, Some(1_040));
}

#[test]
fn qpc_watchdog_clock_failure_remains_invalid_after_later_reads_recover() {
    use ownership::{CaseClock, CaseTimestamp, QpcOrigin, QpcSource};
    use std::sync::Arc;
    use std::sync::atomic::{AtomicBool, AtomicI64, AtomicUsize, Ordering};

    struct FailingAfterReceive {
        counter: AtomicI64,
        fail: AtomicBool,
        failed_reads: AtomicUsize,
    }
    impl QpcSource for FailingAfterReceive {
        fn counter(&self) -> Result<i64, u32> {
            if self.fail.swap(false, Ordering::SeqCst) {
                self.failed_reads.fetch_add(1, Ordering::SeqCst);
                Err(0xCAFE)
            } else {
                Ok(self.counter.load(Ordering::SeqCst))
            }
        }
        fn frequency(&self) -> Result<i64, u32> {
            Ok(10)
        }
    }

    let source = Arc::new(FailingAfterReceive {
        counter: AtomicI64::new(1_000),
        fail: AtomicBool::new(false),
        failed_reads: AtomicUsize::new(0),
    });
    let clock_source: Arc<dyn QpcSource> = source.clone();
    let mut session = native::NativeSession::prepare_with_shared_qpc_for_test(
        CaseClock::from_shared_qpc(
            QpcOrigin {
                counter: 1_000,
                frequency: 10,
            },
            clock_source,
        )
        .unwrap(),
        |_| None,
        native::ValidationOverrides::default(),
        None,
    )
    .expect("QPC-backed session should prepare");
    let mut independent = TestRootReaper::open(session.root_pid())
        .expect("independent reaper must hold root custody");
    let (gate_entered, gate_release) = session.watchdog_recovery_gate_for_test();
    let shorten_watchdog = session.watchdog_timestamp_shortener_for_test();
    assert!(shorten_watchdog(
        CaseTimestamp::SharedQpc(1_010),
        CaseTimestamp::SharedQpc(1_040)
    ));
    drop(shorten_watchdog);
    assert!(
        gate_entered.recv_timeout(Duration::from_secs(2)).is_ok(),
        "watchdog must reach the test gate before inducing the QPC failure"
    );
    source.fail.store(true, Ordering::SeqCst);
    session.disconnect_watchdog_commands_for_test();
    gate_release
        .send(())
        .expect("watchdog recovery gate should release");
    let failure_deadline = Instant::now() + Duration::from_secs(2);
    while source.failed_reads.load(Ordering::SeqCst) == 0 && Instant::now() < failure_deadline {
        thread::yield_now();
    }
    assert!(
        source.failed_reads.load(Ordering::SeqCst) > 0,
        "watchdog disconnect must observe the one-shot QPC counter error before recovery"
    );
    source.counter.store(1_020, Ordering::SeqCst);
    let evidence = session.cleanup_timestamp_for_test(CaseTimestamp::SharedQpc(1_010));
    let independently_reaped = independent.terminate_and_wait();
    assert!(source.failed_reads.load(Ordering::SeqCst) > 0);
    assert!(independently_reaped);
    assert!(evidence.clock_invalid, "{evidence:?}");
    assert!(
        evidence.watchdog_recovery_confirmed,
        "later recovered QPC reads must reach a successful root recovery confirmation: {evidence:?}"
    );
    assert!(!evidence.continuation_safe, "{evidence:?}");
}

#[test]
fn attribute_list_expiry_qpc_error_is_preserved_before_cleanup() {
    use ownership::{CaseClock, QpcOrigin, QpcSource};
    use std::sync::Arc;
    use std::sync::atomic::{AtomicUsize, Ordering};

    struct FailingExpiryRead {
        reads: AtomicUsize,
        failures: std::sync::atomic::AtomicUsize,
    }
    impl QpcSource for FailingExpiryRead {
        fn counter(&self) -> Result<i64, u32> {
            let read = self.reads.fetch_add(1, Ordering::SeqCst) + 1;
            if read == 16 {
                self.failures.fetch_add(1, Ordering::SeqCst);
                Err(77)
            } else {
                Ok(1_002)
            }
        }
        fn frequency(&self) -> Result<i64, u32> {
            Ok(10)
        }
    }

    let source = Arc::new(FailingExpiryRead {
        reads: AtomicUsize::new(0),
        failures: std::sync::atomic::AtomicUsize::new(0),
    });
    let failure = match native::NativeSession::prepare_with_shared_qpc_for_test(
        CaseClock::from_shared_qpc(
            QpcOrigin {
                counter: 1_000,
                frequency: 10,
            },
            source.clone(),
        )
        .unwrap(),
        |_| None,
        native::ValidationOverrides::default(),
        None,
    ) {
        Err(failure) => failure,
        Ok(session) => {
            drop(session);
            panic!("attribute-list expiry QPC query error must abort setup")
        }
    };

    assert!(source.reads.load(Ordering::SeqCst) > 16);
    assert_eq!(source.failures.load(Ordering::SeqCst), 1);
    assert_eq!(
        failure.initiating.stage,
        native::NativeStage::CreateAttributeList
    );
    assert!(failure.cleanup.clock_invalid, "{:#?}", failure.cleanup);
    assert_eq!(failure.cleanup.clock_error, Some(77));
    assert!(!failure.cleanup.continuation_safe, "{:#?}", failure.cleanup);
}

#[test]
fn qpc_watchdog_shortening_is_applied_before_recovery_and_root_is_contained() {
    use ownership::{CaseClock, CaseTimestamp, QpcOrigin, QpcSource};
    use std::sync::Arc;
    use std::sync::atomic::{AtomicI64, Ordering};

    struct ControlledQpc(AtomicI64);
    impl QpcSource for ControlledQpc {
        fn counter(&self) -> Result<i64, u32> {
            Ok(self.0.load(Ordering::SeqCst))
        }
        fn frequency(&self) -> Result<i64, u32> {
            Ok(10)
        }
    }

    let (parent_entered_tx, parent_entered_rx) = mpsc::channel();
    let (parent_release_tx, parent_release_rx) = mpsc::channel();
    let source = Arc::new(ControlledQpc(AtomicI64::new(10_010)));
    let clock_source: Arc<dyn QpcSource> = source.clone();
    let mut session = native::NativeSession::prepare_with_shared_qpc_for_test(
        CaseClock::from_shared_qpc(
            QpcOrigin {
                counter: 10_000,
                frequency: 10,
            },
            clock_source,
        )
        .unwrap(),
        move |stage| {
            if stage == native::NativeStage::CleanupTerminateJob {
                let _ = parent_entered_tx.send(());
                let _ = parent_release_rx.recv_timeout(Duration::from_secs(3));
            }
            None
        },
        native::ValidationOverrides::default(),
        None,
    )
    .expect("shared-QPC session should prepare");
    let observer = session.watchdog_recovery_observer_for_test();
    let (gate_entered, gate_release) = session.watchdog_recovery_gate_for_test();
    let shorten = session.watchdog_timestamp_shortener_for_test();
    let mut independent = TestRootReaper::open(session.root_pid())
        .expect("independent reaper must hold root custody");
    let source_for_helper = Arc::clone(&source);
    let helper = thread::spawn(move || {
        let gate_is_closed = gate_entered.recv_timeout(Duration::from_secs(2)).is_ok();
        let parent_is_blocked = parent_entered_rx
            .recv_timeout(Duration::from_secs(2))
            .is_ok();
        let shortened = shorten(
            CaseTimestamp::SharedQpc(10_015),
            CaseTimestamp::SharedQpc(10_025),
        );
        source_for_helper.0.store(10_016, Ordering::SeqCst);
        let _ = gate_release.send(());
        let recovered = observer.recv_timeout(Duration::from_secs(2)).ok();
        let _ = parent_release_tx.send(());
        (gate_is_closed, parent_is_blocked, shortened, recovered)
    });

    let evidence = session.cleanup_timestamp_for_test(CaseTimestamp::SharedQpc(10_010));
    let independently_reaped = independent.terminate_and_wait();
    let (gate_is_closed, parent_is_blocked, shortened, recovered) = helper.join().unwrap();

    assert!(gate_is_closed);
    assert!(parent_is_blocked);
    assert!(shortened);
    assert_eq!(
        recovered,
        Some((true, true, CaseTimestamp::SharedQpc(10_025)))
    );
    assert!(independently_reaped);
    assert!(evidence.watchdog_fired, "{evidence:?}");
    assert!(evidence.watchdog_intervened, "{evidence:?}");
    assert_eq!(evidence.cleanup_deadline_qpc, Some(10_030));
    assert!(!evidence.continuation_safe, "{evidence:?}");
}

#[test]
fn qpc_root_confirmation_cancels_pending_watchdog_recovery() {
    use ownership::{CaseClock, CaseTimestamp, QpcOrigin, QpcSource};
    use std::sync::Arc;

    struct StaticQpc;
    impl QpcSource for StaticQpc {
        fn counter(&self) -> Result<i64, u32> {
            Ok(10_010)
        }
        fn frequency(&self) -> Result<i64, u32> {
            Ok(10)
        }
    }

    let mut session = native::NativeSession::prepare_with_shared_qpc_for_test(
        CaseClock::from_shared_qpc(
            QpcOrigin {
                counter: 10_000,
                frequency: 10,
            },
            Arc::new(StaticQpc),
        )
        .unwrap(),
        |_| None,
        native::ValidationOverrides::default(),
        None,
    )
    .expect("shared-QPC session should prepare");
    let confirmer = session.watchdog_confirmer_for_test();
    assert!(
        confirmer(),
        "the QPC watchdog should accept the confirmation command"
    );
    let mut independent = TestRootReaper::open(session.root_pid())
        .expect("independent reaper must hold root custody");

    let evidence = session.cleanup_timestamp_for_test(CaseTimestamp::SharedQpc(10_010));
    let independently_reaped = independent.terminate_and_wait();
    assert!(independently_reaped);
    assert!(evidence.root_wait_completed, "{evidence:?}");
    assert!(evidence.watchdog_recovery_confirmed, "{evidence:?}");
    assert!(!evidence.watchdog_fired, "{evidence:?}");
    assert!(!evidence.watchdog_intervened, "{evidence:?}");
    assert!(evidence.continuation_safe, "{evidence:?}");
}

fn recv_until<T>(receiver: &mpsc::Receiver<T>, deadline: Instant) -> Option<T> {
    receiver
        .recv_timeout(deadline.saturating_duration_since(Instant::now()))
        .ok()
}

#[test]
fn shared_clock_setup_expiry_prevents_create_job_at_delayed_entry() {
    use ownership::{CaseClock, QpcOrigin, QpcSource};
    use std::sync::Arc;
    use std::sync::atomic::{AtomicI64, Ordering};

    struct FakeQpc(AtomicI64);

    impl QpcSource for FakeQpc {
        fn counter(&self) -> Result<i64, u32> {
            Ok(self.0.load(Ordering::SeqCst))
        }

        fn frequency(&self) -> Result<i64, u32> {
            Ok(10)
        }
    }

    let clock = CaseClock::from_shared_qpc(
        QpcOrigin {
            counter: 1_000,
            frequency: 10,
        },
        Arc::new(FakeQpc(AtomicI64::new(1_032))),
    )
    .unwrap();
    let failure = match native::NativeSession::prepare_with_shared_qpc_for_test(
        clock,
        |_| None,
        native::ValidationOverrides::default(),
        None,
    ) {
        Err(failure) => failure,
        Ok(session) => {
            drop(session);
            panic!("late shared-QPC setup must fail before creating the Job")
        }
    };

    assert_eq!(failure.initiating.stage, native::NativeStage::CreateJob);
    assert_eq!(failure.initiating.raw_os_error, None);
    assert_eq!(failure.root_pid, None);
    assert_eq!(
        failure.qpc_origin_for_test,
        Some(ownership::QpcOrigin {
            counter: 1_000,
            frequency: 10
        })
    );
    assert_eq!(failure.cleanup.cleanup_deadline_qpc, Some(1_050));
    assert!(failure.cleanup.cleanup_deadline.is_none());
}

#[test]
fn shared_cleanup_timestamp_domain_mismatch_never_reports_safe_cleanup() {
    use ownership::{CaseClock, CaseTimestamp, QpcOrigin, QpcSource};
    use std::sync::Arc;

    struct FakeQpc;
    impl QpcSource for FakeQpc {
        fn counter(&self) -> Result<i64, u32> {
            Ok(1_000)
        }
        fn frequency(&self) -> Result<i64, u32> {
            Ok(10)
        }
    }

    let mut session = native::NativeSession::prepare_with_shared_qpc_for_test(
        CaseClock::from_shared_qpc(
            QpcOrigin {
                counter: 1_000,
                frequency: 10,
            },
            Arc::new(FakeQpc),
        )
        .unwrap(),
        |_| None,
        native::ValidationOverrides::default(),
        None,
    )
    .expect("shared-QPC session should prepare");

    let evidence = session.cleanup_timestamp_for_test(CaseTimestamp::Local(Instant::now()));
    assert!(evidence.clock_invalid, "{evidence:?}");
    assert!(!evidence.continuation_safe, "{evidence:?}");

    let mut local_session = native::NativeSession::prepare_with_hook(|_| None)
        .expect("local-clock session should prepare");
    let evidence = local_session.cleanup_timestamp_for_test(CaseTimestamp::SharedQpc(1_000));
    assert!(evidence.clock_invalid, "{evidence:?}");
    assert!(!evidence.continuation_safe, "{evidence:?}");
}

#[test]
fn shared_clock_failure_observation_and_cleanup_keep_absolute_qpc_cutoffs() {
    use ownership::{CaseClock, CaseTimestamp, QpcOrigin, QpcSource};
    use std::sync::Arc;
    use std::sync::atomic::{AtomicI64, Ordering};

    struct FakeQpc(AtomicI64);
    impl QpcSource for FakeQpc {
        fn counter(&self) -> Result<i64, u32> {
            Ok(self.0.load(Ordering::SeqCst))
        }
        fn frequency(&self) -> Result<i64, u32> {
            Ok(10)
        }
    }

    let source = Arc::new(FakeQpc(AtomicI64::new(1_000)));
    let hook_source = Arc::clone(&source);
    let failure = match native::NativeSession::prepare_with_shared_qpc_for_test(
        CaseClock::from_shared_qpc(
            QpcOrigin {
                counter: 1_000,
                frequency: 10,
            },
            source,
        )
        .unwrap(),
        move |stage| {
            if stage == native::NativeStage::ConfigureJob {
                hook_source.0.store(1_032, Ordering::SeqCst);
                Some(55)
            } else {
                None
            }
        },
        native::ValidationOverrides::default(),
        None,
    ) {
        Err(failure) => failure,
        Ok(session) => {
            drop(session);
            panic!("injected setup failure should be returned")
        }
    };
    assert_eq!(failure.initiating.stage, native::NativeStage::ConfigureJob);
    assert_eq!(failure.case_origin_for_test, None);
    assert_eq!(failure.failure_observed_qpc, Some(1_032));
    assert_eq!(failure.scheduled_stop_qpc, Some(1_030));
    assert_eq!(failure.cleanup.cleanup_deadline_qpc, Some(1_050));
    assert_eq!(failure.cleanup.completed_at, None);
    assert_eq!(failure.cleanup.completed_at_qpc, Some(1_032));

    let cleanup_source = Arc::new(FakeQpc(AtomicI64::new(10_000)));
    let mut session = native::NativeSession::prepare_with_shared_qpc_for_test(
        CaseClock::from_shared_qpc(
            QpcOrigin {
                counter: 10_000,
                frequency: 10,
            },
            cleanup_source,
        )
        .unwrap(),
        |_| None,
        native::ValidationOverrides::default(),
        None,
    )
    .expect("shared-QPC preparation should use the passed clock and options");
    let evidence = session.cleanup_timestamp_for_test(CaseTimestamp::SharedQpc(10_040));

    assert_eq!(evidence.cleanup_deadline_qpc, Some(10_060));
    assert!(evidence.cleanup_deadline.is_none());
    assert!(evidence.root_wait_completed);
    assert!(evidence.watchdog_completed);
    assert!(evidence.continuation_safe, "{evidence:?}");
}

#[test]
fn barrier_delivered_setup_failure_preserves_original_stop_and_cleanup_cutoff() {
    use ownership::{CaseClock, QpcOrigin, QpcSource};
    use std::sync::Arc;
    use std::sync::atomic::{AtomicI64, Ordering};

    struct ControlledQpc(AtomicI64);
    impl QpcSource for ControlledQpc {
        fn counter(&self) -> Result<i64, u32> {
            Ok(self.0.load(Ordering::SeqCst))
        }
        fn frequency(&self) -> Result<i64, u32> {
            Ok(10)
        }
    }

    let (entered_tx, entered_rx) = mpsc::channel();
    let (release_tx, release_rx) = mpsc::channel();
    let source = Arc::new(ControlledQpc(AtomicI64::new(1_000)));
    let hook_source = Arc::clone(&source);
    let helper = thread::spawn(move || {
        let entered = entered_rx.recv_timeout(Duration::from_secs(2)).is_ok();
        hook_source.0.store(1_051, Ordering::SeqCst);
        let released = release_tx.send(()).is_ok();
        (entered, released)
    });

    let failure = match native::NativeSession::prepare_with_shared_qpc_for_test(
        CaseClock::from_shared_qpc(
            QpcOrigin {
                counter: 1_000,
                frequency: 10,
            },
            source,
        )
        .unwrap(),
        move |stage| {
            if stage == native::NativeStage::ConfigureJob {
                let _ = entered_tx.send(());
                let _ = release_rx.recv_timeout(Duration::from_secs(2));
                Some(0x5151)
            } else {
                None
            }
        },
        native::ValidationOverrides::default(),
        None,
    ) {
        Err(failure) => failure,
        Ok(session) => {
            drop(session);
            panic!("barrier-delivered setup failure should be preserved")
        }
    };
    let (entered, released) = helper.join().unwrap();

    assert!(entered && released, "failure delivery barrier completed");
    assert_eq!(failure.initiating.stage, native::NativeStage::ConfigureJob);
    assert_eq!(failure.failure_observed_qpc, Some(1_051));
    assert_eq!(failure.scheduled_stop_qpc, Some(1_030));
    assert_eq!(failure.cleanup.cleanup_deadline_qpc, Some(1_050));
    assert!(
        !failure.cleanup.continuation_safe,
        "late delivery cannot renew cleanup budget"
    );
}

#[test]
fn ambiguous_failure_observation_uses_original_setup_cleanup_ceiling_and_fails_closed() {
    use ownership::{CaseClock, QpcOrigin, QpcSource};
    use std::sync::Arc;
    use std::sync::atomic::{AtomicI64, Ordering};

    struct FakeQpc(AtomicI64);
    impl QpcSource for FakeQpc {
        fn counter(&self) -> Result<i64, u32> {
            Ok(self.0.load(Ordering::SeqCst))
        }
        fn frequency(&self) -> Result<i64, u32> {
            Ok(10)
        }
    }

    let source = Arc::new(FakeQpc(AtomicI64::new(1_000)));
    let failing_source = Arc::clone(&source);
    let failure = match native::NativeSession::prepare_with_shared_qpc_for_test(
        CaseClock::from_shared_qpc(
            QpcOrigin {
                counter: 1_000,
                frequency: 10,
            },
            source,
        )
        .unwrap(),
        move |stage| {
            if stage == native::NativeStage::ConfigureJob {
                failing_source.0.store(1_031, Ordering::SeqCst);
                Some(91)
            } else {
                None
            }
        },
        native::ValidationOverrides::default(),
        None,
    ) {
        Err(failure) => failure,
        Ok(session) => {
            drop(session);
            panic!("injected setup failure must be preserved");
        }
    };

    assert_eq!(failure.failure_observed_qpc, Some(1_031));
    assert_eq!(failure.scheduled_stop_qpc, Some(1_030));
    assert_eq!(failure.cleanup.cleanup_deadline_qpc, Some(1_050));
    assert!(!failure.cleanup.continuation_safe, "{:#?}", failure.cleanup);
}

#[test]
fn qpc_query_failure_keeps_observation_absent_and_uses_setup_cleanup_ceiling() {
    use ownership::{CaseClock, QpcOrigin, QpcSource};
    use std::sync::Arc;
    use std::sync::atomic::{AtomicBool, AtomicI64, Ordering};

    struct FailingQpc {
        counter: AtomicI64,
        fail_reads: AtomicBool,
    }
    impl QpcSource for FailingQpc {
        fn counter(&self) -> Result<i64, u32> {
            if self.fail_reads.load(Ordering::SeqCst) {
                Err(0xBEEF)
            } else {
                Ok(self.counter.load(Ordering::SeqCst))
            }
        }
        fn frequency(&self) -> Result<i64, u32> {
            Ok(10)
        }
    }

    let source = Arc::new(FailingQpc {
        counter: AtomicI64::new(1_000),
        fail_reads: AtomicBool::new(false),
    });
    let hook_source = Arc::clone(&source);
    let failure = match native::NativeSession::prepare_with_shared_qpc_for_test(
        CaseClock::from_shared_qpc(
            QpcOrigin {
                counter: 1_000,
                frequency: 10,
            },
            source,
        )
        .unwrap(),
        move |stage| {
            if stage == native::NativeStage::ConfigureJob {
                hook_source.counter.store(1_031, Ordering::SeqCst);
                hook_source.fail_reads.store(true, Ordering::SeqCst);
                Some(91)
            } else {
                None
            }
        },
        native::ValidationOverrides::default(),
        None,
    ) {
        Err(failure) => failure,
        Ok(session) => {
            drop(session);
            panic!("injected setup failure must be preserved");
        }
    };

    assert_eq!(failure.failure_observed_qpc, None);
    assert_eq!(failure.scheduled_stop_qpc, Some(1_030));
    assert_eq!(failure.cleanup.cleanup_deadline_qpc, Some(1_050));
    assert_eq!(failure.cleanup.clock_error, Some(0xBEEF));
    assert!(failure.cleanup.clock_invalid);
    assert!(!failure.cleanup.continuation_safe);
}

#[test]
fn shared_clock_attribute_list_and_post_create_checks_keep_the_same_origin() {
    use ownership::{CaseClock, QpcOrigin, QpcSource};
    use std::sync::Arc;
    use std::sync::atomic::{AtomicI64, Ordering};

    struct FakeQpc(AtomicI64);
    impl QpcSource for FakeQpc {
        fn counter(&self) -> Result<i64, u32> {
            Ok(self.0.load(Ordering::SeqCst))
        }
        fn frequency(&self) -> Result<i64, u32> {
            Ok(10)
        }
    }

    let origin = QpcOrigin {
        counter: 2_000,
        frequency: 10,
    };
    let attribute_clock = Arc::new(FakeQpc(AtomicI64::new(origin.counter)));
    let attribute_hook_clock = Arc::clone(&attribute_clock);
    let attribute_failure = match native::NativeSession::prepare_with_shared_qpc_for_test(
        CaseClock::from_shared_qpc(origin, attribute_clock).unwrap(),
        move |stage| {
            if stage == native::NativeStage::CreateAttributeList {
                attribute_hook_clock.0.store(2_032, Ordering::SeqCst);
            }
            None
        },
        native::ValidationOverrides::default(),
        None,
    ) {
        Err(failure) => failure,
        Ok(session) => {
            drop(session);
            panic!("attribute-list setup crossing the shared cutoff must fail")
        }
    };
    assert_eq!(
        attribute_failure.initiating.stage,
        native::NativeStage::CreateAttributeList
    );
    assert_eq!(attribute_failure.qpc_origin_for_test, Some(origin));
    assert_eq!(attribute_failure.scheduled_stop_qpc, Some(2_030));

    let post_create_clock = Arc::new(FakeQpc(AtomicI64::new(origin.counter)));
    let post_create_hook_clock = Arc::clone(&post_create_clock);
    let post_create_failure = match native::NativeSession::prepare_with_shared_qpc_for_test(
        CaseClock::from_shared_qpc(origin, post_create_clock).unwrap(),
        move |stage| {
            if stage == native::NativeStage::DuplicateRoot {
                post_create_hook_clock.0.store(2_032, Ordering::SeqCst);
            }
            None
        },
        native::ValidationOverrides::default(),
        None,
    ) {
        Err(failure) => failure,
        Ok(session) => {
            drop(session);
            panic!("post-create shared cutoff crossing must abort suspended root")
        }
    };
    assert_eq!(
        post_create_failure.initiating.stage,
        native::NativeStage::DuplicateRoot
    );
    assert!(post_create_failure.root_pid.is_some());
    assert_eq!(post_create_failure.qpc_origin_for_test, Some(origin));
    assert_eq!(post_create_failure.scheduled_stop_qpc, Some(2_030));
    assert!(post_create_failure.cleanup.root_wait_completed);
    assert!(post_create_failure.cleanup.root_wait_completed);
    assert!(post_create_failure.cleanup.all_handles_closed);
    assert!(post_create_failure.cleanup.watchdog_intervened);
    assert!(!post_create_failure.cleanup.continuation_safe);
}

#[derive(Debug)]
enum ResultCollection<T> {
    First(T),
    AfterTimeout(T),
    TimedOut,
    Disconnected,
}

fn collect_after_first_result<T>(
    receiver: &mpsc::Receiver<T>,
    first: Result<T, mpsc::RecvTimeoutError>,
    retry_timeout: Duration,
) -> ResultCollection<T> {
    match first {
        Ok(outcome) => ResultCollection::First(outcome),
        Err(mpsc::RecvTimeoutError::Timeout) => match receiver.recv_timeout(retry_timeout) {
            Ok(outcome) => ResultCollection::AfterTimeout(outcome),
            Err(mpsc::RecvTimeoutError::Timeout) => ResultCollection::TimedOut,
            Err(mpsc::RecvTimeoutError::Disconnected) => ResultCollection::Disconnected,
        },
        Err(mpsc::RecvTimeoutError::Disconnected) => ResultCollection::Disconnected,
    }
}
use windows_sys::Win32::Foundation::{
    CloseHandle, GetLastError, HANDLE, WAIT_OBJECT_0, WAIT_TIMEOUT,
};
use windows_sys::Win32::System::Threading::{
    OpenProcess, PROCESS_SYNCHRONIZE, PROCESS_TERMINATE, TerminateProcess, WaitForSingleObject,
};

struct SessionTestGuard(Option<native::NativeSession>);

impl Drop for SessionTestGuard {
    fn drop(&mut self) {
        if let Some(session) = self.0.take() {
            let _ = session.cleanup(Instant::now());
        }
    }
}

trait TestProcessApi: Send + Sync {
    fn open(&self, pid: u32) -> Result<HANDLE, u32>;
    fn wait(&self, handle: HANDLE, milliseconds: u32) -> u32;
    fn terminate(&self, handle: HANDLE, exit_code: u32) -> bool;
    fn close(&self, handle: HANDLE) -> bool;
}

struct WindowsTestProcessApi;

impl TestProcessApi for WindowsTestProcessApi {
    fn open(&self, pid: u32) -> Result<HANDLE, u32> {
        let process = unsafe { OpenProcess(PROCESS_TERMINATE | PROCESS_SYNCHRONIZE, 0, pid) };
        if process.is_null() {
            Err(unsafe { GetLastError() })
        } else {
            Ok(process)
        }
    }

    fn wait(&self, handle: HANDLE, milliseconds: u32) -> u32 {
        unsafe { WaitForSingleObject(handle, milliseconds) }
    }

    fn terminate(&self, handle: HANDLE, exit_code: u32) -> bool {
        unsafe { TerminateProcess(handle, exit_code) != 0 }
    }

    fn close(&self, handle: HANDLE) -> bool {
        unsafe { CloseHandle(handle) != 0 }
    }
}

struct TestRootReaper {
    handle: HANDLE,
    api: std::sync::Arc<dyn TestProcessApi>,
    wait_confirmed: bool,
    cleanup_attempted: bool,
}

impl TestRootReaper {
    fn open(pid: u32) -> Result<Self, u32> {
        Self::open_with_api(pid, std::sync::Arc::new(WindowsTestProcessApi))
    }

    fn open_with_api(pid: u32, api: std::sync::Arc<dyn TestProcessApi>) -> Result<Self, u32> {
        let handle = api.open(pid)?;
        Ok(Self {
            handle,
            api,
            wait_confirmed: false,
            cleanup_attempted: false,
        })
    }

    fn with_api(handle: HANDLE, api: std::sync::Arc<dyn TestProcessApi>) -> Self {
        Self {
            handle,
            api,
            wait_confirmed: false,
            cleanup_attempted: false,
        }
    }

    fn terminate_and_wait(&mut self) -> bool {
        if self.wait_confirmed {
            return true;
        }
        if self.cleanup_attempted {
            return false;
        }
        self.cleanup_attempted = true;
        let initial_wait = self.api.wait(self.handle, 0);
        if initial_wait == WAIT_OBJECT_0 {
            self.wait_confirmed = true;
            return true;
        }
        if initial_wait != WAIT_TIMEOUT {
            return false;
        }
        let _ = self.api.terminate(self.handle, 0xE1FF);
        self.wait_confirmed = self.api.wait(self.handle, 2_000) == WAIT_OBJECT_0;
        self.wait_confirmed
    }

    fn terminate_and_notify_reaped(&mut self, sender: &mpsc::Sender<()>) -> bool {
        if !self.terminate_and_wait() {
            return false;
        }
        sender.send(()).is_ok()
    }
}

fn send_root_observer_ack(ack_tx: &mpsc::Sender<bool>, acquired: bool, accept: bool) -> bool {
    ack_tx.send(acquired && accept).is_ok()
}

impl Drop for TestRootReaper {
    fn drop(&mut self) {
        if !self.handle.is_null() {
            if self.wait_confirmed || (!self.cleanup_attempted && self.terminate_and_wait()) {
                let _ = self.api.close(self.handle);
                self.handle = std::ptr::null_mut();
            } else {
                // Intentional process-lifetime retention: closing here would discard the last
                // in-process test custody handle without confirmed process exit. The external
                // guardian is responsible for custody that must survive this process.
            }
        }
    }
}

#[cfg(test)]
mod test_root_reaper_regressions {
    use super::*;
    use std::collections::VecDeque;
    use std::sync::{Arc, Mutex};
    use windows_sys::Win32::Foundation::WAIT_FAILED;

    #[derive(Default)]
    struct FakeProcessApi {
        waits: Mutex<VecDeque<u32>>,
        wait_calls: std::sync::atomic::AtomicUsize,
        close_calls: std::sync::atomic::AtomicUsize,
        terminate_calls: std::sync::atomic::AtomicUsize,
    }

    impl FakeProcessApi {
        fn with_waits(waits: impl IntoIterator<Item = u32>) -> Self {
            Self {
                waits: Mutex::new(waits.into_iter().collect()),
                ..Default::default()
            }
        }

        fn remaining_waits(&self) -> usize {
            self.waits.lock().unwrap().len()
        }
    }

    impl super::TestProcessApi for FakeProcessApi {
        fn open(&self, _pid: u32) -> Result<HANDLE, u32> {
            Ok(1 as HANDLE)
        }

        fn wait(&self, _handle: HANDLE, _milliseconds: u32) -> u32 {
            self.wait_calls
                .fetch_add(1, std::sync::atomic::Ordering::SeqCst);
            self.waits
                .lock()
                .unwrap()
                .pop_front()
                .unwrap_or(WAIT_FAILED)
        }

        fn terminate(&self, _handle: HANDLE, _exit_code: u32) -> bool {
            self.terminate_calls
                .fetch_add(1, std::sync::atomic::Ordering::SeqCst);
            true
        }

        fn close(&self, _handle: HANDLE) -> bool {
            self.close_calls
                .fetch_add(1, std::sync::atomic::Ordering::SeqCst);
            true
        }
    }

    #[test]
    fn unconfirmed_wait_keeps_last_reaper_handle_open() {
        let api = Arc::new(FakeProcessApi::with_waits([
            WAIT_TIMEOUT,
            WAIT_TIMEOUT,
            WAIT_TIMEOUT,
            WAIT_TIMEOUT,
        ]));
        let mut reaper = TestRootReaper::with_api(1 as HANDLE, api.clone());
        assert!(!reaper.terminate_and_wait());
        drop(reaper);

        assert_eq!(
            api.close_calls.load(std::sync::atomic::Ordering::SeqCst),
            0,
            "an unconfirmed process must retain the final test-reaper HANDLE"
        );
        assert!(
            api.terminate_calls
                .load(std::sync::atomic::Ordering::SeqCst)
                > 0
        );
        assert_eq!(
            api.wait_calls.load(std::sync::atomic::Ordering::SeqCst),
            2,
            "Drop must not restart the bounded wait or extend its cutoff"
        );
    }

    #[test]
    fn failed_wait_never_sends_reaped_notification() {
        let api = Arc::new(FakeProcessApi::with_waits([WAIT_FAILED]));
        let mut reaper = TestRootReaper::with_api(1 as HANDLE, api.clone());
        let (tx, rx) = mpsc::channel();

        assert!(!reaper.terminate_and_notify_reaped(&tx));
        assert_eq!(
            api.terminate_calls
                .load(std::sync::atomic::Ordering::SeqCst),
            0,
            "a failed initial wait is not reap evidence"
        );
        assert!(matches!(rx.try_recv(), Err(mpsc::TryRecvError::Empty)));
        assert_eq!(
            api.remaining_waits(),
            0,
            "all scripted wait outcomes consumed"
        );
    }

    #[test]
    fn result_arriving_before_reap_is_preserved_for_collection() {
        let (tx, rx) = mpsc::channel();
        tx.send(17).unwrap();
        let first = rx.recv_timeout(Duration::from_millis(10));

        assert!(matches!(
            collect_after_first_result(&rx, first, Duration::from_millis(10)),
            ResultCollection::First(17)
        ));
    }

    #[test]
    fn missing_cleanup_barrier_entry_preserves_early_failure_result() {
        let (entered_tx, entered_rx) = mpsc::channel::<()>();
        let (root_tx, root_rx) = mpsc::channel();
        let (result_tx, result_rx) = mpsc::channel();
        let setup = thread::spawn(move || {
            let result = native::NativeSession::prepare_with_root_observer(
                move |stage| {
                    let _ = &entered_tx;
                    (stage == native::NativeStage::CreateJob).then_some(0xBEEF)
                },
                move |pid| {
                    let _ = root_tx.send(pid);
                    true
                },
            );
            let outcome = match result {
                Err(failure) => (Some(failure.initiating.stage), failure.cleanup),
                Ok(session) => (None, session.cleanup(Instant::now())),
            };
            let _ = result_tx.send(outcome);
        });

        let pid_result = root_rx.recv_timeout(Duration::from_secs(5));
        let barrier_entry = entered_rx.recv_timeout(Duration::from_secs(5));
        let first_result = result_rx.recv_timeout(Duration::from_secs(5));
        let result_collection =
            collect_after_first_result(&result_rx, first_result, Duration::from_secs(5));
        let completion_deadline = Instant::now() + Duration::from_secs(2);
        while !setup.is_finished() && Instant::now() < completion_deadline {
            thread::sleep(Duration::from_millis(2));
        }
        let joined = if setup.is_finished() {
            setup.join().is_ok()
        } else {
            false
        };

        assert!(matches!(
            pid_result,
            Err(mpsc::RecvTimeoutError::Disconnected)
        ));
        assert!(matches!(
            barrier_entry,
            Err(mpsc::RecvTimeoutError::Disconnected)
        ));
        assert!(
            joined,
            "bounded native failure collection before assertions"
        );
        let (stage, cleanup) = match result_collection {
            ResultCollection::First(outcome) => outcome,
            other => panic!("early result must be preserved, got {other:?}"),
        };
        assert_eq!(stage, Some(native::NativeStage::CreateJob));
        assert!(!cleanup.root_wait_completed);
        assert!(cleanup.continuation_safe, "pre-root failure remains safe");
        assert!(cleanup.cleanup_deadline.is_some_and(|deadline| {
            cleanup
                .completed_at
                .is_some_and(|completed_at| completed_at <= deadline)
        }));
    }

    #[test]
    fn disconnected_ack_still_collects_cleanup_before_assertions() {
        use std::sync::atomic::{AtomicBool, Ordering};

        let (root_tx, root_rx) = mpsc::channel();
        let (ack_tx, ack_rx) = mpsc::channel::<bool>();
        let (entered_tx, entered_rx) = mpsc::channel::<()>();
        let saw_disconnect = Arc::new(AtomicBool::new(false));
        let setup_saw_disconnect = Arc::clone(&saw_disconnect);
        let (result_tx, result_rx) = mpsc::channel();
        let setup = thread::spawn(move || {
            let result = native::NativeSession::prepare_with_root_observer(
                move |_| {
                    let _ = &entered_tx;
                    None
                },
                move |pid| {
                    if !root_tx.send(pid).is_ok() {
                        return false;
                    }
                    match ack_rx.recv_timeout(Duration::from_secs(3)) {
                        Ok(ack) => ack,
                        Err(mpsc::RecvTimeoutError::Timeout) => false,
                        Err(mpsc::RecvTimeoutError::Disconnected) => {
                            setup_saw_disconnect.store(true, Ordering::SeqCst);
                            false
                        }
                    }
                },
            );
            let outcome = match result {
                Err(failure) => (Some(failure.initiating.stage), failure.cleanup),
                Ok(session) => (None, session.cleanup(Instant::now())),
            };
            let _ = result_tx.send(outcome);
        });

        let pid = root_rx.recv_timeout(Duration::from_secs(5)).ok();
        drop(ack_tx);
        let first_result = result_rx.recv_timeout(Duration::from_millis(10));
        let barrier_entry = entered_rx.recv_timeout(Duration::from_secs(5));
        let result_collection =
            collect_after_first_result(&result_rx, first_result, Duration::from_secs(5));
        let completion_deadline = Instant::now() + Duration::from_secs(2);
        while !setup.is_finished() && Instant::now() < completion_deadline {
            thread::sleep(Duration::from_millis(2));
        }
        let joined = if setup.is_finished() {
            setup.join().is_ok()
        } else {
            false
        };

        assert!(
            pid.is_some(),
            "root PID must be collected before assertions"
        );
        assert!(
            matches!(barrier_entry, Err(mpsc::RecvTimeoutError::Disconnected)),
            "observer rejection cleans up before the cleanup barrier is entered"
        );
        assert!(
            joined,
            "bounded result/cleanup collection before assertions"
        );
        assert!(
            saw_disconnect.load(Ordering::SeqCst),
            "ACK disconnect is distinct from timeout"
        );
        let (stage, cleanup) = match result_collection {
            ResultCollection::First(outcome) | ResultCollection::AfterTimeout(outcome) => outcome,
            other => panic!("native cleanup outcome must be collected, got {other:?}"),
        };
        assert_eq!(stage, Some(native::NativeStage::TestRootObserver));
        assert!(
            cleanup.root_wait_completed,
            "native cleanup evidence: {cleanup:?}"
        );
        assert!(!cleanup.continuation_safe, "rejected ACK remains unsafe");
        assert!(cleanup.cleanup_deadline.is_some_and(|deadline| {
            cleanup
                .completed_at
                .is_some_and(|completed_at| completed_at <= deadline)
        }));
    }

    #[test]
    fn failed_root_acquisition_is_rejected_without_waiting_for_ack() {
        let (root_tx, root_rx) = mpsc::channel();
        let (ack_tx, ack_rx) = mpsc::channel();
        let (result_tx, result_rx) = mpsc::channel();
        let setup = thread::spawn(move || {
            let result = native::NativeSession::prepare_with_root_observer(
                |_| None,
                move |pid| {
                    root_tx.send(pid).is_ok()
                        && ack_rx
                            .recv_timeout(Duration::from_secs(3))
                            .is_ok_and(|ack| ack)
                },
            );
            let outcome = match result {
                Err(failure) => (Some(failure.initiating.stage), failure.cleanup),
                Ok(session) => (None, session.cleanup(Instant::now())),
            };
            let _ = result_tx.send(outcome);
        });

        let pid = root_rx.recv_timeout(Duration::from_secs(5)).ok();
        let acquired = pid.and_then(|pid| {
            TestRootReaper::open_with_api(pid, Arc::new(FakeOpenProcessFailure)).ok()
        });
        let ack_sent = send_root_observer_ack(&ack_tx, acquired.is_some(), true);
        drop(ack_tx);
        let outcome = result_rx.recv_timeout(Duration::from_secs(10)).ok();
        let completion_deadline = Instant::now() + Duration::from_secs(2);
        while !setup.is_finished() && Instant::now() < completion_deadline {
            thread::sleep(Duration::from_millis(2));
        }
        let joined = if setup.is_finished() {
            setup.join().is_ok()
        } else {
            false
        };

        assert!(pid.is_some(), "root PID should be collected");
        assert!(
            acquired.is_none(),
            "fake OpenProcess must reject acquisition"
        );
        assert!(ack_sent, "negative ACK must be sent immediately");
        assert!(
            joined,
            "setup must finish before asserting cleanup evidence"
        );
        let (stage, cleanup) = outcome.expect("bounded result collection must complete");
        assert_eq!(stage, Some(native::NativeStage::TestRootObserver));
        assert!(
            cleanup.root_wait_completed,
            "native cleanup evidence: {cleanup:?}"
        );
        assert!(
            cleanup.all_handles_closed,
            "native cleanup evidence: {cleanup:?}"
        );
        assert!(
            !cleanup.continuation_safe,
            "rejected custody ACK remains unsafe"
        );
        assert!(cleanup.cleanup_deadline.is_some_and(|deadline| {
            cleanup
                .completed_at
                .is_some_and(|completed_at| completed_at <= deadline)
        }));
    }

    #[test]
    fn failed_independent_reap_releases_barrier_and_collects_native_cleanup() {
        let api = Arc::new(FakeProcessApi::with_waits([WAIT_FAILED]));
        let (root_tx, root_rx) = mpsc::channel();
        let (ack_tx, ack_rx) = mpsc::channel();
        let (entered_tx, entered_rx) = mpsc::channel();
        let (release_tx, release_rx) = mpsc::channel();
        let (reaped_tx, reaped_rx) = mpsc::channel();
        let saw_reaped = Arc::new(std::sync::atomic::AtomicBool::new(false));
        let setup_saw_reaped = Arc::clone(&saw_reaped);
        let (result_tx, result_rx) = mpsc::channel();
        let setup = thread::spawn(move || {
            let result = native::NativeSession::prepare_with_validation_overrides(
                move |stage| {
                    if stage == native::NativeStage::CleanupTerminateJob {
                        let _ = entered_tx.send(());
                        let _ = release_rx.recv_timeout(Duration::from_secs(3));
                        setup_saw_reaped.store(
                            reaped_rx.try_recv().is_ok(),
                            std::sync::atomic::Ordering::SeqCst,
                        );
                    }
                    (stage == native::NativeStage::CleanupQueryJob).then_some(0xCAFE)
                },
                native::ValidationOverrides {
                    is_process_in_job: Some(false),
                    ..Default::default()
                },
                Some(Box::new(move |pid| {
                    root_tx.send(pid).is_ok()
                        && ack_rx
                            .recv_timeout(Duration::from_secs(3))
                            .is_ok_and(|ack| ack)
                })),
            );
            let outcome = match result {
                Err(failure) => (Some(failure.initiating.stage), failure.cleanup),
                Ok(session) => (None, session.cleanup(Instant::now())),
            };
            let _ = result_tx.send(outcome);
        });

        let pid = root_rx.recv_timeout(Duration::from_secs(5)).ok();
        let reaper = pid.and_then(|pid| TestRootReaper::open_with_api(pid, api.clone()).ok());
        let acquisition_succeeded = reaper.is_some();
        let ack_sent = send_root_observer_ack(&ack_tx, acquisition_succeeded, true);
        let barrier_entered = entered_rx.recv_timeout(Duration::from_secs(5));
        let first_result = result_rx.recv_timeout(Duration::from_millis(10));
        let first_was_timeout = matches!(&first_result, Err(mpsc::RecvTimeoutError::Timeout));
        let mut reaper = reaper;
        let independently_reaped = reaper
            .as_mut()
            .is_some_and(|reaper| reaper.terminate_and_notify_reaped(&reaped_tx));
        let barrier_released = release_tx.send(()).is_ok();
        let (outcome, first_was_disconnected) = match first_result {
            Ok(outcome) => (Some(outcome), false),
            Err(mpsc::RecvTimeoutError::Timeout) => {
                (result_rx.recv_timeout(Duration::from_secs(5)).ok(), false)
            }
            Err(mpsc::RecvTimeoutError::Disconnected) => (None, true),
        };
        let completion_deadline = Instant::now() + Duration::from_secs(2);
        while !setup.is_finished() && Instant::now() < completion_deadline {
            thread::sleep(Duration::from_millis(2));
        }
        let joined = if setup.is_finished() {
            setup.join().is_ok()
        } else {
            false
        };

        assert!(
            pid.is_some(),
            "root PID must be collected before assertions"
        );
        assert!(
            acquisition_succeeded,
            "fake independent handle acquisition must succeed"
        );
        assert!(ack_sent, "positive ACK delivery must be collected");
        assert!(barrier_entered.is_ok(), "cleanup barrier must be reached");
        assert!(
            first_was_timeout,
            "native cleanup must remain blocked before failed reap"
        );
        assert!(
            !first_was_disconnected,
            "timeout and channel disconnection are distinct"
        );
        assert!(
            !independently_reaped,
            "WAIT_FAILED cannot confirm independent reap"
        );
        assert!(
            barrier_released,
            "failed reap must still release native cleanup"
        );
        assert!(
            joined,
            "never join setup while live; collect boundedly first"
        );
        assert!(!saw_reaped.load(std::sync::atomic::Ordering::SeqCst));
        let (stage, cleanup) = outcome.expect("native cleanup result collected after release");
        assert_eq!(stage, Some(native::NativeStage::VerifyMembership));
        assert!(cleanup.native_errors.contains(&0xCAFE));
        assert!(
            cleanup.root_wait_completed,
            "native cleanup evidence: {cleanup:?}"
        );
        assert!(
            !cleanup.continuation_safe,
            "independent reap must not clear unsafe native cleanup"
        );
        assert!(cleanup.cleanup_deadline.is_some_and(|deadline| {
            cleanup
                .completed_at
                .is_some_and(|completed_at| completed_at <= deadline)
        }));
        assert_eq!(
            api.remaining_waits(),
            0,
            "scripted WAIT_FAILED must be consumed"
        );
    }

    struct FakeOpenProcessFailure;

    impl super::TestProcessApi for FakeOpenProcessFailure {
        fn open(&self, _pid: u32) -> Result<HANDLE, u32> {
            Err(5)
        }

        fn wait(&self, _handle: HANDLE, _milliseconds: u32) -> u32 {
            WAIT_FAILED
        }

        fn terminate(&self, _handle: HANDLE, _exit_code: u32) -> bool {
            false
        }

        fn close(&self, _handle: HANDLE) -> bool {
            true
        }
    }
}

#[test]
fn prepared_actual_worker_is_suspended_and_exactly_root_only_in_job() {
    let session = native::NativeSession::prepare().expect("native session should prepare");
    let mut guard = SessionTestGuard(Some(session));
    let session = guard.0.as_ref().expect("guard owns session immediately");
    let observed = (
        session.is_suspended(),
        session.created_fixed_worker_binary(),
        session.job_process_ids().to_vec(),
        session.root_pid(),
        session.active_processes(),
    );

    let evidence = guard.0.take().unwrap().cleanup(Instant::now());

    assert!(observed.0);
    assert!(observed.1);
    assert_eq!(observed.2, [observed.3]);
    assert_eq!(observed.4, 1);
    assert!(evidence.continuation_safe, "cleanup evidence: {evidence:?}");
    assert!(evidence.root_wait_completed);
    assert_eq!(evidence.active_processes_after, Some(0));
    assert!(evidence.all_handles_closed);
}

#[test]
fn scripted_setup_failures_cleanup_each_acquired_prefix() {
    use native::NativeStage;

    let stages = [
        NativeStage::CreateJob,
        NativeStage::ConfigureJob,
        NativeStage::QueryJobPolicy,
        NativeStage::CreatePipes,
        NativeStage::SetPipeInheritance,
        NativeStage::CreateAttributeList,
        NativeStage::CreateProcess,
        NativeStage::DuplicateRoot,
        NativeStage::StartWatchdog,
        NativeStage::CloseChildPipeCopies,
        NativeStage::AssignRoot,
        NativeStage::VerifyMembership,
        NativeStage::QueryJobPids,
        NativeStage::QueryAccounting,
    ];

    for stage in stages {
        let failure = match native::NativeSession::prepare_with_hook(move |observed| {
            (observed == stage).then_some(0xDEAD)
        }) {
            Err(failure) => failure,
            Ok(session) => {
                drop(session);
                panic!("scripted stage failure must abort preparation: {stage:?}");
            }
        };
        assert_eq!(failure.initiating.stage, stage);
        assert_eq!(failure.initiating.raw_os_error, Some(0xDEAD));
        assert!(
            failure.cleanup.all_handles_closed,
            "{stage:?}: {:#?}",
            failure.cleanup
        );
        assert_eq!(
            failure.cleanup.continuation_safe,
            stage != NativeStage::StartWatchdog,
            "{stage:?}: {:#?}",
            failure.cleanup
        );
        if matches!(
            stage,
            NativeStage::CreateJob
                | NativeStage::ConfigureJob
                | NativeStage::QueryJobPolicy
                | NativeStage::CreatePipes
                | NativeStage::SetPipeInheritance
                | NativeStage::CreateAttributeList
        ) {
            assert!(!failure.cleanup.root_wait_completed);
            assert!(!failure.cleanup.root_termination_attempted);
        } else {
            assert!(failure.cleanup.root_wait_completed, "{stage:?}");
        }
    }
}

#[test]
fn queried_job_policy_mismatch_is_rejected_after_cleanup() {
    let result = native::NativeSession::prepare_with_validation_overrides(
        |_| None,
        native::ValidationOverrides {
            queried_job_limit_flags: Some(0),
            ..Default::default()
        },
        None,
    );
    let (stage, raw_os_error, root_pid, cleanup) = match result {
        Err(failure) => (
            Some(failure.initiating.stage),
            failure.initiating.raw_os_error,
            failure.root_pid,
            Some(failure.cleanup),
        ),
        Ok(session) => {
            let root_pid = Some(session.root_pid());
            (None, None, root_pid, Some(session.cleanup(Instant::now())))
        }
    };

    assert_eq!(stage, Some(native::NativeStage::QueryJobPolicy));
    assert_eq!(raw_os_error, None);
    assert_eq!(root_pid, None, "policy mismatch precedes root creation");
    let cleanup = cleanup.expect("setup outcome must be cleaned before assertions");
    assert!(cleanup.all_handles_closed, "cleanup evidence: {cleanup:?}");
    assert!(
        !cleanup.root_wait_completed,
        "policy mismatch precedes root creation"
    );
    assert!(!cleanup.root_termination_attempted);
    assert!(!cleanup.watchdog_fired);
    assert!(!cleanup.watchdog_intervened);
    assert!(!cleanup.watchdog_command_sent);
    assert!(cleanup.cleanup_deadline.is_some_and(|deadline| {
        cleanup
            .completed_at
            .is_some_and(|completed_at| completed_at <= deadline)
    }));
    assert!(cleanup.continuation_safe, "{cleanup:?}");
}

fn post_root_validation_outcome(
    overrides: native::ValidationOverrides,
    hook: impl FnMut(native::NativeStage) -> Option<u32> + Send + 'static,
) -> (
    Option<native::NativeStage>,
    Option<u32>,
    native::CleanupEvidence,
    bool,
) {
    let (root_tx, root_rx) = mpsc::channel();
    let (root_ack_tx, root_ack_rx) = mpsc::channel::<()>();
    let (result_tx, result_rx) = mpsc::channel();
    let setup = thread::spawn(move || {
        let result = native::NativeSession::prepare_with_validation_overrides(
            hook,
            overrides,
            Some(Box::new(move |pid| {
                root_tx.send(pid).is_ok()
                    && root_ack_rx.recv_timeout(Duration::from_secs(5)).is_ok()
            })),
        );
        let outcome = match result {
            Err(failure) => (
                Some(failure.initiating.stage),
                failure.initiating.raw_os_error,
                failure.cleanup,
            ),
            Ok(session) => (None, None, session.cleanup(Instant::now())),
        };
        let _ = result_tx.send(outcome);
    });

    let root_pid = root_rx.recv_timeout(Duration::from_secs(5)).ok();
    let mut root_reaper = root_pid.and_then(|pid| TestRootReaper::open(pid).ok());
    if root_reaper.is_some() {
        let _ = root_ack_tx.send(());
    } else {
        drop(root_ack_tx);
    }
    let mut outcome = result_rx.recv_timeout(Duration::from_secs(10)).ok();
    // On a result timeout, containment must precede any additional collection wait.
    let independently_reaped = root_reaper
        .as_mut()
        .is_some_and(TestRootReaper::terminate_and_wait);
    if outcome.is_none() {
        outcome = result_rx.recv_timeout(Duration::from_secs(2)).ok();
    }
    let completion_deadline = Instant::now() + Duration::from_secs(2);
    while !setup.is_finished() && Instant::now() < completion_deadline {
        thread::sleep(Duration::from_millis(2));
    }
    let setup_joined = if setup.is_finished() {
        setup.join().is_ok()
    } else {
        false
    };
    assert!(
        setup_joined,
        "setup thread must finish within bounded collection; no join performed while live"
    );
    let (stage, raw_os_error, cleanup) =
        outcome.expect("setup and its cleanup must complete before assertions");
    (stage, raw_os_error, cleanup, independently_reaped)
}

fn shared_post_root_validation_outcome(
    overrides: native::ValidationOverrides,
) -> (Option<native::NativeStage>, native::CleanupEvidence, bool) {
    use ownership::{CaseClock, QpcOrigin, QpcSource};
    use std::sync::Arc;

    struct StaticQpc;
    impl QpcSource for StaticQpc {
        fn counter(&self) -> Result<i64, u32> {
            Ok(10_010)
        }
        fn frequency(&self) -> Result<i64, u32> {
            Ok(10)
        }
    }

    let clock = CaseClock::from_shared_qpc(
        QpcOrigin {
            counter: 10_000,
            frequency: 10,
        },
        Arc::new(StaticQpc),
    )
    .unwrap();
    let (pid_tx, pid_rx) = mpsc::channel();
    let (ack_tx, ack_rx) = mpsc::channel();
    let (result_tx, result_rx) = mpsc::channel();
    let setup = thread::spawn(move || {
        let result = native::NativeSession::prepare_with_shared_qpc_for_test(
            clock,
            |_| None,
            overrides,
            Some(Box::new(move |pid| {
                pid_tx.send(pid).is_ok() && ack_rx.recv_timeout(Duration::from_secs(5)).is_ok()
            })),
        );
        let outcome = match result {
            Err(failure) => (Some(failure.initiating.stage), failure.cleanup),
            Ok(mut session) => (
                None,
                session.cleanup_timestamp_for_test(ownership::CaseTimestamp::SharedQpc(10_010)),
            ),
        };
        let _ = result_tx.send(outcome);
    });

    let root_pid = pid_rx.recv_timeout(Duration::from_secs(5)).ok();
    let mut reaper = root_pid.and_then(|pid| TestRootReaper::open(pid).ok());
    let acquired = reaper.is_some();
    if acquired {
        let _ = ack_tx.send(());
    } else {
        drop(ack_tx);
    }
    let outcome = result_rx.recv_timeout(Duration::from_secs(8)).ok();
    let independently_reaped = reaper
        .as_mut()
        .is_some_and(TestRootReaper::terminate_and_wait);
    assert!(
        acquired,
        "fixture custody handle must be acquired before ack"
    );
    assert!(independently_reaped, "fixture must independently reap root");
    let joined = if setup.is_finished() {
        Some(setup.join())
    } else {
        None
    };
    assert!(
        joined.is_none_or(|joined| joined.is_ok()),
        "finished shared-QPC setup must join successfully"
    );
    let (stage, cleanup) = outcome.expect("shared-QPC outcome must arrive");
    (stage, cleanup, independently_reaped)
}

#[test]
fn all_validation_overrides_reject_mismatches_with_shared_qpc_clock() {
    use ownership::{CaseClock, QpcOrigin, QpcSource};
    use std::sync::Arc;

    struct StaticQpc;
    impl QpcSource for StaticQpc {
        fn counter(&self) -> Result<i64, u32> {
            Ok(10_010)
        }
        fn frequency(&self) -> Result<i64, u32> {
            Ok(10)
        }
    }

    let policy = native::NativeSession::prepare_with_shared_qpc_for_test(
        CaseClock::from_shared_qpc(
            QpcOrigin {
                counter: 10_000,
                frequency: 10,
            },
            Arc::new(StaticQpc),
        )
        .unwrap(),
        |_| None,
        native::ValidationOverrides {
            queried_job_limit_flags: Some(0),
            ..Default::default()
        },
        None,
    );
    let policy_failure = match policy {
        Err(failure) => failure,
        Ok(session) => {
            drop(session);
            panic!("shared-QPC policy mismatch must fail");
        }
    };
    assert_eq!(
        policy_failure.initiating.stage,
        native::NativeStage::QueryJobPolicy
    );
    assert!(policy_failure.cleanup.all_handles_closed);
    assert!(policy_failure.cleanup.continuation_safe);

    let cases = [
        (
            native::ValidationOverrides {
                is_process_in_job: Some(false),
                ..Default::default()
            },
            native::NativeStage::VerifyMembership,
        ),
        (
            native::ValidationOverrides {
                job_process_ids: Some(Vec::new()),
                ..Default::default()
            },
            native::NativeStage::QueryJobPids,
        ),
        (
            native::ValidationOverrides {
                active_processes: Some(2),
                ..Default::default()
            },
            native::NativeStage::QueryAccounting,
        ),
    ];
    for (overrides, expected_stage) in cases {
        let (stage, cleanup, reaped) = shared_post_root_validation_outcome(overrides);
        assert_eq!(stage, Some(expected_stage));
        assert!(reaped);
        assert!(cleanup.root_wait_completed, "{cleanup:?}");
        assert!(cleanup.all_handles_closed, "{cleanup:?}");
        assert!(cleanup.job_empty, "{cleanup:?}");
        assert!(cleanup.continuation_safe, "{cleanup:?}");
    }
}

#[test]
fn false_process_in_job_result_is_rejected_after_independent_reaping() {
    let (stage, raw_os_error, cleanup, independently_reaped) = post_root_validation_outcome(
        native::ValidationOverrides {
            is_process_in_job: Some(false),
            ..Default::default()
        },
        |_| None,
    );

    assert_eq!(stage, Some(native::NativeStage::VerifyMembership));
    assert_eq!(raw_os_error, None);
    assert!(independently_reaped);
    assert_post_root_clean(&cleanup);
    assert!(cleanup.all_handles_closed, "cleanup evidence: {cleanup:?}");
    assert!(cleanup.job_empty, "cleanup evidence: {cleanup:?}");
}

#[test]
fn nonmatching_job_pid_list_is_rejected_after_independent_reaping() {
    let (stage, raw_os_error, cleanup, independently_reaped) = post_root_validation_outcome(
        native::ValidationOverrides {
            job_process_ids: Some(Vec::new()),
            ..Default::default()
        },
        |_| None,
    );

    assert_eq!(stage, Some(native::NativeStage::QueryJobPids));
    assert_eq!(raw_os_error, None);
    assert!(independently_reaped);
    assert_post_root_clean(&cleanup);
    assert!(cleanup.all_handles_closed, "cleanup evidence: {cleanup:?}");
    assert!(cleanup.job_empty, "cleanup evidence: {cleanup:?}");
}

#[test]
fn incorrect_active_process_count_is_rejected_after_independent_reaping() {
    let (stage, raw_os_error, cleanup, independently_reaped) = post_root_validation_outcome(
        native::ValidationOverrides {
            active_processes: Some(2),
            ..Default::default()
        },
        |_| None,
    );

    assert_eq!(stage, Some(native::NativeStage::QueryAccounting));
    assert_eq!(raw_os_error, None);
    assert!(independently_reaped);
    assert_post_root_clean(&cleanup);
    assert_eq!(cleanup.active_processes_after, Some(0));
    assert!(cleanup.all_handles_closed, "cleanup evidence: {cleanup:?}");
    assert!(cleanup.job_empty, "cleanup evidence: {cleanup:?}");
}

fn assert_post_root_clean(cleanup: &native::CleanupEvidence) {
    assert!(cleanup.root_termination_attempted, "{cleanup:?}");
    assert!(cleanup.root_termination_succeeded, "{cleanup:?}");
    assert!(cleanup.root_wait_completed, "{cleanup:?}");
    assert!(cleanup.job_empty, "{cleanup:?}");
    assert!(cleanup.watchdog_completed, "{cleanup:?}");
    assert!(cleanup.watchdog_thread_ended, "{cleanup:?}");
    assert!(cleanup.watchdog_join_succeeded, "{cleanup:?}");
    assert!(cleanup.watchdog_recovery_confirmed, "{cleanup:?}");
    assert!(cleanup.watchdog_command_sent, "{cleanup:?}");
    assert!(cleanup.root_confirmation_sent, "{cleanup:?}");
    assert!(!cleanup.watchdog_intervened, "{cleanup:?}");
    assert!(cleanup.native_errors.is_empty(), "{cleanup:?}");
    assert!(cleanup.close_errors.is_empty(), "{cleanup:?}");
    assert!(cleanup.watchdog_duplicate_closed, "{cleanup:?}");
    assert!(cleanup.all_handles_closed, "{cleanup:?}");
    assert!(cleanup.cleanup_deadline.is_some_and(|deadline| {
        cleanup
            .completed_at
            .is_some_and(|completed_at| completed_at <= deadline)
    }));
    assert!(cleanup.continuation_safe, "{cleanup:?}");
}

#[test]
fn post_root_mismatch_cleanup_query_error_is_not_hidden_by_independent_reap() {
    let (stage, raw_os_error, cleanup, independently_reaped) = post_root_validation_outcome(
        native::ValidationOverrides {
            is_process_in_job: Some(false),
            ..Default::default()
        },
        |stage| (stage == native::NativeStage::CleanupQueryJob).then_some(0xCAFE),
    );

    assert_eq!(stage, Some(native::NativeStage::VerifyMembership));
    assert_eq!(raw_os_error, None);
    assert!(independently_reaped);
    assert!(cleanup.native_errors.contains(&0xCAFE));
    assert!(!cleanup.continuation_safe, "{cleanup:?}");
}

#[test]
fn rejected_root_observer_ack_aborts_before_validation_override() {
    use std::sync::atomic::{AtomicBool, Ordering};

    let checked = std::sync::Arc::new(AtomicBool::new(false));
    let hook_checked = std::sync::Arc::clone(&checked);
    let (root_tx, root_rx) = mpsc::channel();
    let (ack_tx, ack_rx) = mpsc::channel::<bool>();
    let (result_tx, result_rx) = mpsc::channel();
    let setup = thread::spawn(move || {
        let result = native::NativeSession::prepare_with_validation_overrides(
            move |stage| {
                if stage == native::NativeStage::VerifyMembership {
                    hook_checked.store(true, Ordering::SeqCst);
                }
                None
            },
            native::ValidationOverrides {
                is_process_in_job: Some(false),
                ..Default::default()
            },
            Some(Box::new(move |pid| {
                root_tx.send(pid).is_ok()
                    && ack_rx
                        .recv_timeout(Duration::from_secs(5))
                        .is_ok_and(|ack| ack)
            })),
        );
        let outcome = match result {
            Err(failure) => (Some(failure.initiating.stage), failure.cleanup),
            Ok(session) => (None, session.cleanup(Instant::now())),
        };
        let _ = result_tx.send(outcome);
    });

    let pid = root_rx.recv_timeout(Duration::from_secs(5)).ok();
    let mut reaper = pid.and_then(|pid| TestRootReaper::open(pid).ok());
    let acquisition_succeeded = reaper.is_some();
    // A failed fixture acquisition is explicitly rejected; never release into validation.
    let _ = ack_tx.send(false);
    drop(ack_tx);
    let mut outcome = result_rx.recv_timeout(Duration::from_secs(10)).ok();
    let independently_reaped = reaper
        .as_mut()
        .is_some_and(TestRootReaper::terminate_and_wait);
    if outcome.is_none() {
        outcome = result_rx.recv_timeout(Duration::from_secs(2)).ok();
    }
    let completion_deadline = Instant::now() + Duration::from_secs(2);
    while !setup.is_finished() && Instant::now() < completion_deadline {
        thread::sleep(Duration::from_millis(2));
    }
    let setup_joined = if setup.is_finished() {
        setup.join().is_ok()
    } else {
        false
    };
    assert!(
        setup_joined,
        "setup completion remained unknown; cleanup safety is unknown"
    );
    assert!(
        acquisition_succeeded,
        "independent root reaper fixture must open"
    );
    assert!(
        independently_reaped,
        "independent root reaper must terminate and wait"
    );
    let (stage, cleanup) = outcome.expect("setup cleanup outcome must be collected boundedly");

    assert_eq!(stage, Some(native::NativeStage::TestRootObserver));
    assert!(
        !checked.load(Ordering::SeqCst),
        "semantic validation must not run"
    );
    assert!(cleanup.root_termination_attempted, "{cleanup:?}");
    assert!(cleanup.root_termination_succeeded, "{cleanup:?}");
    assert!(cleanup.root_wait_completed);
    // The observer runs immediately after process creation, before a watchdog is started.
    assert!(!cleanup.watchdog_completed, "{cleanup:?}");
    assert!(!cleanup.watchdog_duplicate_closed, "{cleanup:?}");
    assert!(!cleanup.watchdog_intervened, "{cleanup:?}");
    assert!(cleanup.native_errors.is_empty(), "{cleanup:?}");
    assert!(cleanup.close_errors.is_empty(), "{cleanup:?}");
    assert!(cleanup.all_handles_closed);
    assert!(
        cleanup.cleanup_deadline.is_some_and(|deadline| cleanup
            .completed_at
            .is_some_and(|completed_at| completed_at <= deadline)),
        "{cleanup:?}"
    );
    assert!(!cleanup.continuation_safe, "{cleanup:?}");
}

#[test]
fn timeout_guard_reaps_root_before_releasing_setup_barrier() {
    use std::sync::atomic::{AtomicBool, Ordering};

    let (root_tx, root_rx) = mpsc::channel();
    let (ack_tx, ack_rx) = mpsc::channel::<bool>();
    let (entered_tx, entered_rx) = mpsc::channel();
    let (release_tx, release_rx) = mpsc::channel::<()>();
    let (reaped_tx, reaped_rx) = mpsc::channel::<()>();
    let saw_reaped = std::sync::Arc::new(AtomicBool::new(false));
    let setup_saw_reaped = std::sync::Arc::clone(&saw_reaped);
    let (result_tx, result_rx) = mpsc::channel();
    let setup = thread::spawn(move || {
        let result = native::NativeSession::prepare_with_validation_overrides(
            move |stage| {
                if stage == native::NativeStage::CleanupTerminateJob {
                    let _ = entered_tx.send(());
                    let _ = release_rx.recv_timeout(Duration::from_secs(3));
                    setup_saw_reaped.store(reaped_rx.try_recv().is_ok(), Ordering::SeqCst);
                }
                None
            },
            native::ValidationOverrides {
                is_process_in_job: Some(false),
                ..Default::default()
            },
            Some(Box::new(move |pid| {
                root_tx.send(pid).is_ok()
                    && ack_rx
                        .recv_timeout(Duration::from_secs(3))
                        .is_ok_and(|ack| ack)
            })),
        );
        let outcome = match result {
            Err(failure) => (Some(failure.initiating.stage), failure.cleanup),
            Ok(session) => (None, session.cleanup(Instant::now())),
        };
        let _ = result_tx.send(outcome);
    });

    let pid = root_rx.recv_timeout(Duration::from_secs(5)).ok();
    let mut reaper = pid.and_then(|pid| TestRootReaper::open(pid).ok());
    let acquisition_succeeded = reaper.is_some();
    let ack_sent = send_root_observer_ack(&ack_tx, acquisition_succeeded, true);
    let entered = entered_rx.recv_timeout(Duration::from_secs(5)).is_ok();
    let first_result = result_rx.recv_timeout(Duration::from_millis(10));
    let result_timed_out_while_barrier_held =
        matches!(&first_result, Err(mpsc::RecvTimeoutError::Timeout));
    let reaped = reaper
        .as_mut()
        .is_some_and(|reaper| reaper.terminate_and_notify_reaped(&reaped_tx));
    let _ = release_tx.send(());
    let result_collection =
        collect_after_first_result(&result_rx, first_result, Duration::from_secs(5));
    let (outcome, result_disconnected) = match result_collection {
        ResultCollection::First(outcome) | ResultCollection::AfterTimeout(outcome) => {
            (Some(outcome), false)
        }
        ResultCollection::TimedOut => (None, false),
        ResultCollection::Disconnected => (None, true),
    };
    let completion_deadline = Instant::now() + Duration::from_secs(2);
    while !setup.is_finished() && Instant::now() < completion_deadline {
        thread::sleep(Duration::from_millis(2));
    }
    let joined = if setup.is_finished() {
        setup.join().is_ok()
    } else {
        false
    };

    assert!(pid.is_some(), "the root observer must report a PID");
    assert!(
        acquisition_succeeded,
        "independent root acquisition must succeed"
    );
    assert!(ack_sent, "the observer ACK channel must remain available");
    assert!(entered, "cleanup barrier must be reached");
    assert!(
        result_timed_out_while_barrier_held,
        "blocked cleanup must force the result timeout"
    );
    assert!(
        !result_disconnected,
        "result channel disconnection is distinct from timeout"
    );
    assert!(reaped, "only a signaled root wait may notify reap");
    assert!(
        joined,
        "setup completion remained unknown; cleanup safety is unknown"
    );
    assert!(saw_reaped.load(Ordering::SeqCst));
    let (stage, cleanup) = outcome.expect("setup result collected after reaping");
    assert_eq!(stage, Some(native::NativeStage::VerifyMembership));
    assert!(cleanup.root_wait_completed);
    assert!(cleanup.all_handles_closed);
}

#[test]
fn late_setup_cleanup_keeps_original_setup_cutoff_budget() {
    let mut delayed = false;
    let failure = match native::NativeSession::prepare_with_hook(move |stage| {
        if stage == native::NativeStage::CreateProcess && !delayed {
            delayed = true;
            thread::sleep(Duration::from_millis(3_150));
        }
        None
    }) {
        Err(failure) => failure,
        Ok(session) => {
            drop(session);
            panic!("late setup must fail");
        }
    };

    let expected_deadline = failure
        .case_origin_for_test
        .expect("local clock failures retain their Instant origin")
        + Duration::from_secs(5);
    let actual_deadline = failure.cleanup.cleanup_deadline.expect("cleanup deadline");
    let deadline_difference = if actual_deadline >= expected_deadline {
        actual_deadline.duration_since(expected_deadline)
    } else {
        expected_deadline.duration_since(actual_deadline)
    };
    assert!(
        deadline_difference <= Duration::from_millis(50),
        "cleanup must remain anchored at setup cutoff; expected {expected_deadline:?}, got {actual_deadline:?}"
    );
}

#[test]
fn watchdog_deadline_updates_only_shorten_and_expired_recovery_is_due() {
    let origin = Instant::now();
    let setup_cutoff = origin + Duration::from_secs(3);
    let mut deadlines =
        native::WatchdogDeadlines::new(setup_cutoff, origin + Duration::from_secs(5));

    let early_stop = origin + Duration::from_millis(100);
    let early_cleanup_deadline = origin + Duration::from_millis(2_100);
    let recovery_at = native::WatchdogDeadlines::recovery_at(early_stop, early_cleanup_deadline);
    deadlines.begin_cleanup(recovery_at, early_cleanup_deadline);
    assert_eq!(deadlines.setup_trigger, setup_cutoff);
    assert_eq!(deadlines.cleanup_deadline, early_cleanup_deadline);
    assert_eq!(recovery_at, origin + Duration::from_millis(1_100));
    assert_eq!(deadlines.recovery_at, recovery_at);
    assert_eq!(deadlines.trigger(), recovery_at);

    deadlines.begin_cleanup(
        origin + Duration::from_secs(2),
        origin + Duration::from_secs(4),
    );
    assert_eq!(deadlines.setup_trigger, setup_cutoff);
    assert_eq!(deadlines.cleanup_deadline, early_cleanup_deadline);
    assert_eq!(deadlines.recovery_at, recovery_at);
    assert!(deadlines.recovery_due(recovery_at));
}

#[test]
fn qpc_watchdog_deadlines_shorten_recovery_and_fail_closed_on_mixed_domains() {
    use ownership::CaseTimestamp::{Local, SharedQpc};

    let mut deadlines = native::WatchdogDeadlines::new(SharedQpc(1_030), SharedQpc(1_050));
    deadlines.begin_cleanup(SharedQpc(1_020), SharedQpc(1_040));
    assert_eq!(deadlines.trigger(), SharedQpc(1_020));
    assert!(!deadlines.recovery_due(SharedQpc(1_018)));
    assert!(deadlines.recovery_due(SharedQpc(1_022)));

    deadlines.begin_cleanup(SharedQpc(1_028), SharedQpc(1_045));
    assert_eq!(deadlines.trigger(), SharedQpc(1_020));
    assert_eq!(deadlines.cleanup_deadline, SharedQpc(1_040));

    deadlines.begin_cleanup(Local(Instant::now()), SharedQpc(1_035));
    assert!(deadlines.recovery_due(SharedQpc(1_018)));
}

#[test]
fn queued_cleanup_shortening_is_applied_before_due_recovery_commits() {
    let (parent_entered_tx, parent_entered_rx) = mpsc::channel();
    let (parent_release_tx, parent_release_rx) = mpsc::channel::<()>();
    let mut session = native::NativeSession::prepare_with_hook(move |stage| {
        if stage == native::NativeStage::CleanupTerminateJob {
            let _ = parent_entered_tx.send(());
            let _ = parent_release_rx.recv();
        }
        None
    })
    .expect("session setup should succeed before cleanup barriers");
    let root_pid = session.root_pid();
    let observer = session.watchdog_recovery_observer_for_test();
    let (watchdog_gate_entered, watchdog_gate_release) = session.watchdog_recovery_gate_for_test();
    let shorten = session.watchdog_shortener_for_test();
    let mut root_reaper = TestRootReaper::open(root_pid)
        .expect("independent root guard must exist before parent is blocked");
    let scheduled_stop = Instant::now();
    let expected_deadline = scheduled_stop + Duration::from_millis(1_600);
    let later_recovery = scheduled_stop + Duration::from_secs(1);
    let queued_recovery = expected_deadline - Duration::from_secs(1);
    let helper = thread::spawn(move || {
        let parent_entered = parent_entered_rx
            .recv_timeout(Duration::from_secs(2))
            .is_ok();
        let gate_entered = watchdog_gate_entered
            .recv_timeout(Duration::from_secs(2))
            .is_ok();
        let (timer_sender, timer_receiver) = mpsc::channel::<()>();
        let trigger_waited = later_recovery.saturating_duration_since(Instant::now());
        let _ = timer_receiver.recv_timeout(trigger_waited);
        drop(timer_sender);
        let shortening_sent = shorten(queued_recovery, expected_deadline);
        let _ = watchdog_gate_release.send(());
        let recovery = observer.recv_timeout(Duration::from_millis(800)).ok();
        let _ = parent_release_tx.send(());
        (parent_entered, gate_entered, shortening_sent, recovery)
    });

    let evidence = session.cleanup(scheduled_stop);
    let helper_result = helper.join();
    let independently_reaped = root_reaper.terminate_and_wait();
    let (parent_entered, gate_entered, shortening_sent, recovery) =
        helper_result.expect("barrier helper must complete within its channel bounds");

    assert!(parent_entered);
    assert!(gate_entered);
    assert!(shortening_sent);
    assert_eq!(
        recovery,
        Some((
            true,
            true,
            ownership::CaseTimestamp::Local(expected_deadline)
        ))
    );
    assert!(independently_reaped);
    assert_eq!(
        evidence.cleanup_deadline,
        Some(scheduled_stop + Duration::from_secs(2))
    );
    assert!(!evidence.continuation_safe);
}

#[test]
fn drain_observes_disconnect_and_recovers_live_root_immediately() {
    let (parent_entered_tx, parent_entered_rx) = mpsc::channel();
    let (parent_release_tx, parent_release_rx) = mpsc::channel::<()>();
    let mut session = native::NativeSession::prepare_with_hook(move |stage| {
        if stage == native::NativeStage::CleanupTerminateJob {
            let _ = parent_entered_tx.send(());
            let _ = parent_release_rx.recv_timeout(Duration::from_secs(3));
        }
        None
    })
    .expect("setup should succeed before disconnect regression");
    let root_pid = session.root_pid();
    let observer = session.watchdog_recovery_observer_for_test();
    let (gate_entered, gate_release) = session.watchdog_recovery_gate_for_test();
    let wake_watchdog = session.watchdog_shortener_for_test();
    let queue_cleanup = session.watchdog_shortener_for_test();
    let mut root_reaper = TestRootReaper::open(root_pid)
        .expect("independent reaper must be installed before disconnect");
    session.disconnect_watchdog_commands_for_test();

    let scheduled_stop = Instant::now();
    let cleanup_deadline = scheduled_stop + Duration::from_secs(2);
    let recovery_at = scheduled_stop + Duration::from_secs(1);
    let helper = thread::spawn(move || {
        let woke = wake_watchdog(recovery_at, cleanup_deadline);
        let gate_reached = gate_entered.recv_timeout(Duration::from_secs(1)).is_ok();
        let parent_entered = parent_entered_rx
            .recv_timeout(Duration::from_secs(1))
            .is_ok();
        let queued = queue_cleanup(recovery_at, cleanup_deadline);
        drop(wake_watchdog);
        drop(queue_cleanup);
        let _ = gate_release.send(());
        let recovery_deadline = Instant::now() + Duration::from_millis(250);
        let recovery = recv_until(&observer, recovery_deadline);
        let _ = parent_release_tx.send(());
        (woke, gate_reached, parent_entered, queued, recovery)
    });

    let evidence = session.cleanup(scheduled_stop);
    let helper_result = helper.join();
    let independently_reaped = root_reaper.terminate_and_wait();
    let (woke, gate_reached, parent_entered, queued, recovery) =
        helper_result.expect("bounded disconnect helper must finish");

    assert!(woke);
    assert!(
        gate_reached,
        "disconnect must be pending before drain resumes"
    );
    assert!(
        parent_entered,
        "parent termination must remain blocked during recovery"
    );
    assert!(
        queued,
        "shortening command must be queued before drain resumes"
    );
    assert!(recovery.is_some_and(|(intervened, confirmed, _)| intervened && confirmed));
    assert!(independently_reaped);
    assert!(evidence.watchdog_fired);
    assert!(evidence.watchdog_intervened);
    assert!(evidence.watchdog_duplicate_closed);
    assert!(!evidence.watchdog_command_sent);
    assert!(!evidence.continuation_safe);
}

#[test]
fn drained_root_confirmation_wait_error_survives_eventual_root_signal() {
    let (parent_entered_tx, parent_entered_rx) = mpsc::channel();
    let (parent_release_tx, parent_release_rx) = mpsc::channel::<()>();
    let mut session = native::NativeSession::prepare_with_hook(move |stage| {
        if stage == native::NativeStage::CleanupTerminateJob {
            let _ = parent_entered_tx.send(());
            let _ = parent_release_rx.recv_timeout(Duration::from_secs(3));
        }
        None
    })
    .expect("setup should succeed before queued confirmation regression");
    let root_pid = session.root_pid();
    let observer = session.watchdog_recovery_observer_for_test();
    let (gate_entered, gate_release) = session.watchdog_recovery_gate_for_test();
    let wake_watchdog = session.watchdog_shortener_for_test();
    let queue_cleanup = session.watchdog_shortener_for_test();
    let queue_confirmation = session.watchdog_confirmer_for_test();
    let mut root_reaper = TestRootReaper::open(root_pid)
        .expect("independent reaper must be installed before test commands");
    session.inject_watchdog_confirmation_wait_error_for_test();
    session.disconnect_watchdog_commands_for_test();

    let scheduled_stop = Instant::now();
    let cleanup_deadline = scheduled_stop + Duration::from_secs(2);
    let recovery_at = scheduled_stop + Duration::from_secs(1);
    let helper = thread::spawn(move || {
        let woke = wake_watchdog(recovery_at, cleanup_deadline);
        let gate_reached = gate_entered.recv_timeout(Duration::from_secs(1)).is_ok();
        let parent_entered = parent_entered_rx
            .recv_timeout(Duration::from_secs(1))
            .is_ok();
        let queued_cleanup = queue_cleanup(recovery_at, cleanup_deadline);
        let queued_confirmation = queue_confirmation();
        drop(wake_watchdog);
        drop(queue_cleanup);
        drop(queue_confirmation);
        let _ = gate_release.send(());
        let recovery_deadline = Instant::now() + Duration::from_millis(1_000);
        let recovery = recv_until(&observer, recovery_deadline);
        let _ = parent_release_tx.send(());
        (
            woke,
            gate_reached,
            parent_entered,
            queued_cleanup,
            queued_confirmation,
            recovery,
        )
    });

    let evidence = session.cleanup(scheduled_stop);
    let helper_result = helper.join();
    let independently_reaped = root_reaper.terminate_and_wait();
    let (woke, gate_reached, parent_entered, queued_cleanup, queued_confirmation, recovery) =
        helper_result.expect("bounded confirmation helper must finish");

    assert!(woke);
    assert!(
        gate_reached,
        "both commands must be queued before drain resumes"
    );
    assert!(
        parent_entered,
        "root must still be live when confirmation is drained"
    );
    assert!(queued_cleanup);
    assert!(queued_confirmation);
    assert!(recovery.is_some_and(|(intervened, confirmed, _)| intervened && confirmed));
    assert!(independently_reaped);
    assert!(evidence.root_wait_completed);
    assert!(evidence.native_errors.contains(&0xDEAD));
    assert!(evidence.watchdog_duplicate_closed);
    assert!(!evidence.continuation_safe);
}

#[test]
fn setup_cutoff_crossing_during_blocked_post_create_call_aborts_suspended_root() {
    let (entered_tx, entered_rx) = mpsc::channel();
    let (release_tx, release_rx) = mpsc::channel::<()>();
    let (root_tx, root_rx) = mpsc::channel();
    let (root_ack_tx, root_ack_rx) = mpsc::channel::<()>();
    let (finished_tx, finished_rx) = mpsc::channel();

    let worker = thread::spawn(move || {
        let result = native::NativeSession::prepare_with_root_observer(
            move |stage| {
                if stage == native::NativeStage::CreateProcess {
                    let _ = entered_tx.send(());
                    let _ = release_rx.recv_timeout(Duration::from_secs(5));
                }
                None
            },
            move |pid| {
                root_tx.send(pid).is_ok()
                    && root_ack_rx.recv_timeout(Duration::from_secs(5)).is_ok()
            },
        )
        .map(|session| session.cleanup(Instant::now()));
        let _ = finished_tx.send(result);
    });

    let root_pid = root_rx
        .recv_timeout(Duration::from_secs(5))
        .expect("root acquisition should be observed before setup continues");
    let mut root_reaper =
        TestRootReaper::open(root_pid).expect("independent reaper must open before cutoff cleanup");
    let _ = root_ack_tx.send(());
    entered_rx
        .recv_timeout(Duration::from_secs(5))
        .expect("post-create checkpoint should be reached");
    let remained_blocked_until_release = finished_rx.recv_timeout(Duration::from_secs(4)).is_err();
    let _ = release_tx.send(());
    let collected = finished_rx.recv_timeout(Duration::from_secs(5));
    let joined = worker.join();
    let independently_reaped = root_reaper.terminate_and_wait();
    assert!(joined.is_ok(), "setup thread should finish");
    let result = collected.expect("late setup must finish bounded cleanup");
    let failure = result.expect_err("late setup must not return a prepared session");

    assert!(remained_blocked_until_release);
    assert!(failure.cleanup.root_wait_completed);
    assert!(failure.cleanup.watchdog_fired);
    assert!(failure.cleanup.watchdog_duplicate_closed);
    assert!(failure.cleanup.all_handles_closed);
    assert!(!failure.cleanup.continuation_safe);
    assert!(independently_reaped, "independent root reaper must finish");
}

#[test]
fn watchdog_recovers_before_cleanup_deadline_while_parent_termination_is_blocked() {
    let (entered_tx, entered_rx) = mpsc::channel();
    let (release_tx, release_rx) = mpsc::channel::<()>();
    let mut session = native::NativeSession::prepare_with_hook(move |stage| {
        if stage == native::NativeStage::CleanupTerminateJob {
            let _ = entered_tx.send(());
            let _ = release_rx.recv();
        }
        None
    })
    .expect("session setup should succeed before cleanup barrier");
    let root_pid = session.root_pid();
    let observer = session.watchdog_recovery_observer_for_test();
    let mut root_reaper = TestRootReaper::open(root_pid)
        .expect("independent reaper must exist before cleanup is blocked");
    let helper = thread::spawn(move || {
        let entered = entered_rx.recv_timeout(Duration::from_secs(2)).is_ok();
        let deadline = Instant::now() + Duration::from_millis(1_500);
        let recovery = entered.then(|| recv_until(&observer, deadline)).flatten();
        let _ = release_tx.send(());
        (entered, recovery)
    });

    let evidence = session.cleanup(Instant::now());
    let helper_result = helper.join();
    let independently_reaped = root_reaper.terminate_and_wait();

    let (entered, recovery) = helper_result.expect("barrier helper must finish");
    assert!(
        entered,
        "parent must reach the blocked termination boundary"
    );
    assert!(independently_reaped, "root must be signaled and reaped");
    assert!(recovery.is_some_and(|(intervened, confirmed, _)| intervened && confirmed));
    assert!(evidence.root_wait_completed);
    assert!(!evidence.continuation_safe);
}

#[test]
fn watchdog_observes_parent_termination_before_recovery_and_does_not_intervene() {
    let (entered_tx, entered_rx) = mpsc::channel();
    let (release_tx, release_rx) = mpsc::channel::<()>();
    let mut session = native::NativeSession::prepare_with_hook(move |stage| {
        if stage == native::NativeStage::CleanupWaitRoot {
            let _ = entered_tx.send(());
            let _ = release_rx.recv();
        }
        None
    })
    .expect("session setup should succeed before wait barrier");
    let observer = session.watchdog_recovery_observer_for_test();
    let mut root_reaper = TestRootReaper::open(session.root_pid())
        .expect("independent root guard must exist before cleanup");
    let helper = thread::spawn(move || {
        let entered = entered_rx.recv_timeout(Duration::from_secs(2)).is_ok();
        let deadline = Instant::now() + Duration::from_millis(1_500);
        let recovery = entered.then(|| recv_until(&observer, deadline)).flatten();
        let _ = release_tx.send(());
        (entered, recovery)
    });

    let evidence = session.cleanup(Instant::now());
    let helper_result = helper.join();
    let independently_reaped = root_reaper.terminate_and_wait();
    let (entered, recovery) = helper_result.expect("barrier helper must finish");

    assert!(entered, "parent must reach root wait after termination");
    assert!(recovery.is_some_and(|(intervened, confirmed, _)| !intervened && confirmed));
    assert!(independently_reaped);
    assert!(evidence.watchdog_fired);
    assert!(!evidence.watchdog_intervened);
    assert!(evidence.watchdog_completed);
    assert!(evidence.watchdog_thread_ended);
    assert!(evidence.watchdog_join_succeeded);
    assert!(evidence.root_wait_completed);
    assert!(evidence.all_handles_closed);
    assert!(evidence.continuation_safe, "cleanup evidence: {evidence:?}");
}

#[test]
fn watchdog_confirmation_wait_error_remains_fail_closed_after_root_signals() {
    let session =
        native::NativeSession::prepare_with_hook(|_| None).expect("session setup should succeed");
    let mut root_reaper = TestRootReaper::open(session.root_pid())
        .expect("independent root cleanup guard must exist before fault injection");
    session.inject_watchdog_confirmation_wait_error_for_test();
    let evidence = session.cleanup(Instant::now());
    let independently_reaped = root_reaper.terminate_and_wait();

    assert!(independently_reaped);
    assert!(evidence.root_wait_completed);
    assert!(
        !evidence.continuation_safe,
        "wait error must not be erased by later signal confirmation"
    );
    assert!(evidence.native_errors.contains(&0xDEAD));
    assert!(evidence.watchdog_duplicate_closed);
    assert!(evidence.watchdog_join_succeeded);
}

#[test]
fn watchdog_thread_panic_after_result_preserves_close_evidence_but_fails_closed() {
    let session =
        native::NativeSession::prepare_with_hook(|_| None).expect("session setup should succeed");
    let mut root_reaper = TestRootReaper::open(session.root_pid())
        .expect("independent root cleanup guard must exist before panic injection");
    session.panic_watchdog_after_result_for_test();
    let evidence = session.cleanup(Instant::now());
    let independently_reaped = root_reaper.terminate_and_wait();

    assert!(independently_reaped);
    assert!(evidence.watchdog_thread_ended);
    assert!(!evidence.watchdog_join_succeeded);
    assert!(!evidence.watchdog_completed);
    assert!(evidence.watchdog_duplicate_closed);
    assert!(!evidence.continuation_safe);
}

#[test]
fn disconnected_watchdog_command_channel_recovers_live_root() {
    let (parent_entered_tx, parent_entered_rx) = mpsc::channel();
    let (parent_release_tx, parent_release_rx) = mpsc::channel::<()>();
    let mut session = native::NativeSession::prepare_with_hook(move |stage| {
        if stage == native::NativeStage::CleanupTerminateJob {
            let _ = parent_entered_tx.send(());
            let _ = parent_release_rx.recv();
        }
        None
    })
    .expect("session setup should succeed");
    let root_pid = session.root_pid();
    let mut root_reaper = TestRootReaper::open(root_pid)
        .expect("independent root containment must precede channel disconnect");
    let observer = session.watchdog_recovery_observer_for_test();
    session.disconnect_watchdog_commands_for_test();
    let helper = thread::spawn(move || {
        let parent_entered = parent_entered_rx
            .recv_timeout(Duration::from_secs(1))
            .is_ok();
        let deadline = Instant::now() + Duration::from_millis(1_500);
        let recovery = recv_until(&observer, deadline);
        let _ = parent_release_tx.send(());
        (parent_entered, recovery)
    });
    let evidence = session.cleanup(Instant::now());
    let helper_result = helper.join();
    let independently_reaped = root_reaper.terminate_and_wait();
    let (parent_entered, recovery) = helper_result.expect("disconnect helper must complete");

    assert!(independently_reaped);
    assert!(parent_entered);
    assert!(recovery.is_some_and(|(intervened, confirmed, _)| intervened && confirmed));
    assert!(evidence.watchdog_fired);
    assert!(evidence.watchdog_intervened);
    assert!(!evidence.continuation_safe);
    assert!(evidence.watchdog_completed);
    assert!(!evidence.watchdog_command_sent);
    assert!(!evidence.root_confirmation_sent);
    assert!(evidence.watchdog_duplicate_closed);
}

#[test]
fn terminate_job_failure_uses_kill_on_close_without_claiming_empty_job() {
    let session = native::NativeSession::prepare_with_hook(|stage| {
        (stage == native::NativeStage::CleanupTerminateJob).then_some(5)
    })
    .expect("session setup should succeed before scripted cleanup failure");

    let evidence = session.cleanup(Instant::now());

    assert!(evidence.job_termination_attempted);
    assert!(!evidence.job_termination_succeeded);
    assert!(evidence.root_wait_completed);
    assert_eq!(evidence.active_processes_after, None);
    assert!(!evidence.job_empty);
    assert!(!evidence.continuation_safe);
}

#[test]
fn uncertain_assignment_attempts_both_process_and_job_termination() {
    let (root_tx, root_rx) = mpsc::channel();
    let (root_ack_tx, root_ack_rx) = mpsc::channel::<()>();
    let setup = thread::spawn(move || {
        match native::NativeSession::prepare_with_root_observer(
            |stage| match stage {
                native::NativeStage::AssignRootBefore => Some(87),
                native::NativeStage::CleanupTerminateProcess => Some(5),
                _ => None,
            },
            move |pid| {
                root_tx.send(pid).is_ok()
                    && root_ack_rx.recv_timeout(Duration::from_secs(5)).is_ok()
            },
        ) {
            Err(failure) => Ok(failure),
            Ok(session) => {
                drop(session);
                Err(())
            }
        }
    });
    let root_pid = root_rx
        .recv_timeout(Duration::from_secs(5))
        .expect("root acquisition must be reported before assignment fault");
    let mut root_guard = TestRootReaper::open(root_pid)
        .expect("independent root cleanup guard should open before assignment fault");
    let _ = root_ack_tx.send(());
    let failure = setup
        .join()
        .expect("setup helper must finish")
        .expect("scripted assignment uncertainty must abort preparation");
    let independently_reaped = root_guard.terminate_and_wait();

    assert_eq!(failure.initiating.stage, native::NativeStage::AssignRoot);
    assert!(independently_reaped);
    assert!(failure.cleanup.root_termination_attempted);
    assert!(failure.cleanup.root_termination_succeeded);
    assert!(failure.cleanup.watchdog_intervened);
    assert!(failure.cleanup.native_errors.contains(&5));
    assert!(failure.cleanup.job_termination_attempted);
    assert!(failure.cleanup.job_termination_succeeded);
    assert!(failure.cleanup.root_wait_completed);
    assert!(!failure.cleanup.continuation_safe);
    assert!(failure.cleanup.all_handles_closed);
}

#[test]
fn scripted_root_wait_and_checked_close_failures_remain_unconfirmed() {
    let wait_session = native::NativeSession::prepare_with_hook(|stage| {
        (stage == native::NativeStage::CleanupWaitRoot).then_some(1460)
    })
    .expect("session setup should succeed before scripted wait failure");
    let wait_evidence = wait_session.cleanup(Instant::now());
    assert!(!wait_evidence.root_wait_completed);
    assert_eq!(wait_evidence.active_processes_after, Some(0));
    assert!(wait_evidence.native_errors.contains(&1460));
    assert!(!wait_evidence.continuation_safe);

    let query_session = native::NativeSession::prepare_with_hook(|stage| {
        (stage == native::NativeStage::CleanupQueryJob).then_some(1461)
    })
    .expect("session setup should succeed before scripted query failure");
    let query_evidence = query_session.cleanup(Instant::now());
    assert!(query_evidence.native_errors.contains(&1461));
    assert_eq!(query_evidence.active_processes_after, None);
    assert!(!query_evidence.continuation_safe);
}

#[test]
fn scripted_watchdog_completion_timeout_is_not_continuation_safe() {
    let session = native::NativeSession::prepare_with_hook(|stage| {
        (stage == native::NativeStage::CleanupWatchdogCompletion).then_some(1460)
    })
    .expect("session setup should succeed before watchdog timeout injection");

    let evidence = session.cleanup(Instant::now());

    assert!(!evidence.watchdog_completed);
    assert!(!evidence.watchdog_duplicate_closed);
    assert!(evidence.root_wait_completed);
    assert!(evidence.job_empty);
    assert!(!evidence.all_handles_closed);
    assert!(!evidence.continuation_safe);
    assert!(evidence.native_errors.contains(&1460));
}

#[test]
fn running_watchdog_duplicate_close_failure_is_aggregate_unconfirmed() {
    let session = native::NativeSession::prepare_with_hook(|stage| {
        (stage == native::NativeStage::WatchdogDuplicateClose).then_some(6)
    })
    .expect("session setup should succeed before watchdog close failure");

    let evidence = session.cleanup(Instant::now());
    let mut duplicate_guard = TestDuplicateCloseGuard(
        evidence
            .watchdog_duplicate_raw_for_test
            .expect("failed watchdog close must retain test cleanup handle"),
    );
    duplicate_guard.close_before_assertions();

    assert!(!evidence.watchdog_duplicate_closed);
    assert!(!evidence.all_handles_closed);
    assert!(!evidence.continuation_safe);
    assert!(evidence.close_errors.contains(&6));
    assert_eq!(evidence.watchdog_duplicate_close_backend_calls, 1);
}

#[test]
fn failed_owned_close_hides_handle_and_caches_evidence_without_drop_retry() {
    use std::sync::Arc;
    use std::sync::atomic::{AtomicUsize, Ordering};

    let calls = Arc::new(AtomicUsize::new(0));
    let backend_calls = Arc::clone(&calls);
    let fake = 1usize as HANDLE;
    let mut owned = ownership::OwnedHandle::from_raw_with_backend(fake, move |_| {
        backend_calls.fetch_add(1, Ordering::SeqCst);
        Err(6)
    });

    let first = owned.close_checked();
    let repeated = owned.close_checked();
    assert!(owned.raw().is_null());
    assert!(!owned.is_valid());
    drop(owned);

    assert_eq!(first, repeated);
    assert_eq!(first.raw_os_error, Some(6));
    assert_eq!(calls.load(Ordering::SeqCst), 1);
}

#[test]
fn attribute_list_is_deleted_when_deadline_crosses_after_successful_initialization() {
    use std::sync::Arc;
    use std::sync::atomic::{AtomicUsize, Ordering};

    let clock_calls = Arc::new(AtomicUsize::new(0));
    let observed = Arc::clone(&clock_calls);
    let deletes = Arc::new(AtomicUsize::new(0));
    let deadline = Instant::now() + Duration::from_secs(10);
    let result = native::AttributeList::new_for_test(
        &[],
        deadline,
        move || {
            if observed.fetch_add(1, Ordering::SeqCst) == 3 {
                deadline
            } else {
                deadline - Duration::from_secs(1)
            }
        },
        Arc::clone(&deletes),
    );

    assert!(
        result.is_err(),
        "injected deadline crossing should abort setup"
    );
    assert_eq!(clock_calls.load(Ordering::SeqCst), 4);
    assert_eq!(deletes.load(Ordering::SeqCst), 1);
}

#[test]
fn failed_emergency_job_close_prevents_later_accounting_query() {
    let session = native::NativeSession::prepare_with_hook(|stage| match stage {
        native::NativeStage::CleanupTerminateJob => Some(5),
        native::NativeStage::CleanupCloseJob => Some(6),
        _ => None,
    })
    .expect("session setup should succeed before injected cleanup failures");
    let root_pid = session.root_pid();
    let root_reaper = TestRootReaper::open(root_pid);

    let evidence = session.cleanup(Instant::now());
    let mut root_reaper = root_reaper.expect("root guard acquisition must be recorded");
    let mut job_guard = TestDuplicateCloseGuard(
        evidence
            .job_close_raw_for_test
            .expect("failed job close must retain test cleanup handle"),
    );
    job_guard.close_before_assertions();
    assert!(root_reaper.terminate_and_wait());

    assert_eq!(evidence.active_processes_after, None);
    assert!(!evidence.job_empty);
    assert!(!evidence.all_handles_closed);
    assert!(evidence.close_errors.contains(&6));
    assert_eq!(evidence.job_close_backend_calls, 1);
}

#[test]
fn watchdog_spawn_failure_retains_duplicate_close_evidence() {
    let failure = match native::NativeSession::prepare_with_hook(|stage| {
        (stage == native::NativeStage::StartWatchdog).then_some(8)
    }) {
        Err(failure) => failure,
        Ok(session) => {
            drop(session);
            panic!("watchdog spawn failure must abort setup");
        }
    };

    assert_eq!(failure.initiating.stage, native::NativeStage::StartWatchdog);
    assert_eq!(failure.initiating.raw_os_error, Some(8));
    assert!(failure.cleanup.watchdog_duplicate_closed);
    assert!(failure.cleanup.all_handles_closed);
    assert!(!failure.cleanup.continuation_safe);
    assert_eq!(failure.watchdog_duplicate_close_attempts, 1);
    assert!(failure.watchdog_spawn_failure_branch);
}

#[test]
fn failed_watchdog_duplicate_close_is_cached_and_not_reported_closed() {
    let failure = match native::NativeSession::prepare_with_hook(|stage| match stage {
        native::NativeStage::StartWatchdog => Some(8),
        native::NativeStage::WatchdogDuplicateClose => Some(6),
        _ => None,
    }) {
        Err(failure) => failure,
        Ok(session) => {
            drop(session);
            panic!("watchdog duplicate close failure must abort setup");
        }
    };

    let mut duplicate_guard = TestDuplicateCloseGuard(
        failure
            .watchdog_duplicate_raw_for_test
            .expect("failed close must expose a test cleanup owner"),
    );
    duplicate_guard.close_before_assertions();

    assert_eq!(failure.initiating.stage, native::NativeStage::StartWatchdog);
    assert_eq!(failure.initiating.raw_os_error, Some(8));
    assert_eq!(failure.watchdog_duplicate_close_attempts, 1);
    assert!(failure.watchdog_spawn_failure_branch);
    assert!(!failure.cleanup.watchdog_duplicate_closed);
    assert!(!failure.cleanup.all_handles_closed);
    assert!(!failure.cleanup.continuation_safe);
    assert!(failure.cleanup.close_errors.contains(&6));
}

struct TestDuplicateCloseGuard(usize);

impl TestDuplicateCloseGuard {
    fn close_before_assertions(&mut self) {
        let raw = std::mem::replace(&mut self.0, 0) as HANDLE;
        assert!(!raw.is_null());
        assert_ne!(
            unsafe { CloseHandle(raw) },
            0,
            "test-owned duplicate should close"
        );
    }
}

impl Drop for TestDuplicateCloseGuard {
    fn drop(&mut self) {
        let raw = std::mem::replace(&mut self.0, 0);
        if raw != 0 {
            let _ = unsafe { CloseHandle(raw as HANDLE) };
        }
    }
}
