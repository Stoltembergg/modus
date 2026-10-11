#![cfg(windows)]

#[path = "../src/platform/windows_runtime/ownership.rs"]
mod ownership;

use std::ptr::null;
use std::sync::atomic::{AtomicUsize, Ordering};
use std::time::{Duration, Instant};
use windows_sys::Win32::System::Threading::CreateEventW;

#[test]
fn checked_close_confirms_real_event_handle_closure() {
    let raw = unsafe { CreateEventW(null(), 0, 0, null()) };
    assert!(!raw.is_null());
    let mut owned = ownership::OwnedHandle::from_raw(raw);
    assert_eq!(owned.raw(), raw);
    let evidence = owned.close_checked();
    assert!(evidence.attempted);
    assert!(evidence.closed);
    assert_eq!(evidence.raw_os_error, None);
    assert!(!owned.is_valid());
}

#[test]
fn failed_checked_close_is_not_retried_by_drop() {
    let close_calls = std::sync::Arc::new(AtomicUsize::new(0));
    let calls = std::sync::Arc::clone(&close_calls);
    let synthetic_handle = 1usize as windows_sys::Win32::Foundation::HANDLE;
    let mut owned = ownership::OwnedHandle::from_raw_with_backend(synthetic_handle, move |_| {
        calls.fetch_add(1, Ordering::SeqCst);
        Err(6)
    });
    let first = owned.close_checked();
    let repeated = owned.close_checked();
    let observable_calls = owned.close_attempt_counter();
    drop(owned);
    assert_eq!(first, repeated);
    assert!(first.attempted);
    assert!(!first.closed);
    assert_eq!(first.raw_os_error, Some(6));
    assert_eq!(close_calls.load(Ordering::SeqCst), 1);
    assert_eq!(observable_calls.load(Ordering::SeqCst), 1);
}

#[test]
fn unattempted_drop_uses_backend_once_without_checked_close_evidence() {
    let close_calls = std::sync::Arc::new(AtomicUsize::new(0));
    let calls = std::sync::Arc::clone(&close_calls);
    let synthetic_handle = 1usize as windows_sys::Win32::Foundation::HANDLE;
    let owned = ownership::OwnedHandle::from_raw_with_backend(synthetic_handle, move |_| {
        calls.fetch_add(1, Ordering::SeqCst);
        Ok(())
    });
    let observable_calls = owned.close_attempt_counter();

    drop(owned);

    assert_eq!(close_calls.load(Ordering::SeqCst), 1);
    assert_eq!(observable_calls.load(Ordering::SeqCst), 1);
}

#[test]
fn invalid_and_already_closed_handles_do_not_claim_new_closure() {
    let mut invalid = ownership::OwnedHandle::invalid();
    let no_handle = invalid.close_checked();
    assert!(!no_handle.attempted);
    assert!(!no_handle.closed);

    let raw = unsafe { CreateEventW(null(), 0, 0, null()) };
    assert!(!raw.is_null());
    let mut owned = ownership::OwnedHandle::from_raw(raw);
    assert!(owned.close_checked().closed);
    let already_closed = owned.close_checked();
    assert!(already_closed.attempted);
    assert!(already_closed.closed);
    assert_eq!(owned.close_attempt_count(), 1);
}

#[test]
fn case_clock_has_exact_absolute_deadline_offsets() {
    let clock = ownership::CaseClock::new();
    assert_eq!(clock.setup_deadline_ms(), Some(3_000));
    assert_eq!(clock.handshake_deadline_ms(), Some(13_000));
    assert_eq!(clock.overall_deadline_ms(), Some(25_000));
}

#[test]
fn cleanup_deadline_is_two_seconds_after_stop_or_clipped_to_overall() {
    let clock = ownership::CaseClock::new();
    assert_eq!(clock.cleanup_deadline_ms(1_000), Some(3_000));
    assert_eq!(clock.cleanup_deadline_ms(24_000), Some(25_000));
}

#[test]
fn cleanup_deadline_preserves_fractional_scheduled_stop_precision() {
    let origin = Instant::now();
    let clock = ownership::CaseClock::from_origin(origin);
    let scheduled_stop = origin + Duration::from_secs(1) + Duration::from_micros(500);

    assert_eq!(
        clock.cleanup_deadline(scheduled_stop),
        Some(scheduled_stop + Duration::from_secs(2))
    );
}

#[test]
fn cleanup_deadline_rejects_scheduled_stop_before_origin() {
    let origin = Instant::now();
    let clock = ownership::CaseClock::from_origin(origin);
    let before_origin = origin - Duration::from_millis(1);

    assert_eq!(clock.cleanup_deadline(before_origin), None);
}

#[test]
fn cleanup_deadline_rejects_submillisecond_stop_after_overall_cutoff() {
    let origin = Instant::now();
    let clock = ownership::CaseClock::from_origin(origin);
    let late_stop = origin + Duration::from_millis(25_000) + Duration::from_nanos(1);

    assert_eq!(clock.offset_ms(late_stop), Some(25_000));
    assert_eq!(clock.cleanup_deadline(late_stop), None);
}

#[test]
fn case_clock_offsets_are_monotonic_and_origin_relative() {
    let origin = Instant::now();
    let clock = ownership::CaseClock::from_origin(origin);
    assert_eq!(clock.origin(), origin);
    assert_eq!(clock.offset_ms(origin), Some(0));
    let later = origin + Duration::from_millis(17);
    assert_eq!(clock.offset_ms(later), Some(17));
    assert_eq!(clock.offset_ms(origin - Duration::from_millis(1)), None);
    assert!(clock.now_offset_ms().is_some());
    let stop = origin + Duration::from_secs(24);
    assert_eq!(
        clock.offset_ms(clock.cleanup_deadline(stop).unwrap()),
        Some(25_000)
    );
}

#[test]
fn qpc_schedule_uses_one_absolute_origin_and_clips_cleanup() {
    let origin = ownership::QpcOrigin {
        counter: 1_000,
        frequency: 10_000_000,
    };
    let schedule = ownership::QpcSchedule::new(origin).unwrap();

    assert_eq!(schedule.setup_cutoff(), Some(30_001_000));
    assert_eq!(schedule.handshake_cutoff(), Some(130_001_000));
    assert_eq!(schedule.work_cutoff(20_001_000), Some(120_001_000));
    assert_eq!(schedule.work_cutoff(999), None);
    assert_eq!(schedule.overall_cutoff(), Some(250_001_000));
    assert_eq!(schedule.cleanup_cutoff(240_001_000), Some(250_001_000));
    assert_eq!(schedule.cleanup_cutoff(220_001_000), Some(240_001_000));
    assert_eq!(schedule.cleanup_cutoff(1_000), None);
    assert_eq!(schedule.cleanup_cutoff(250_001_000), None);
}

#[test]
fn setup_failure_stop_uses_observation_until_setup_cutoff() {
    let schedule = ownership::QpcSchedule::new(ownership::QpcOrigin {
        counter: 1_000,
        frequency: 10,
    })
    .unwrap();
    let setup_cutoff = schedule.setup_cutoff().unwrap();

    assert_eq!(schedule.scheduled_setup_failure(999), None);
    assert_eq!(schedule.scheduled_setup_failure(1_000), None);
    assert_eq!(schedule.scheduled_setup_failure(1_001), None);
    assert_eq!(schedule.scheduled_setup_failure(1_002), Some(1_002));
    assert_eq!(
        schedule.scheduled_setup_failure(setup_cutoff - 2),
        Some(setup_cutoff - 2)
    );
    assert_eq!(schedule.scheduled_setup_failure(setup_cutoff - 1), None);
    assert_eq!(schedule.scheduled_setup_failure(setup_cutoff), None);
    assert_eq!(schedule.scheduled_setup_failure(setup_cutoff + 1), None);
    assert_eq!(
        schedule.scheduled_setup_failure(setup_cutoff + 2),
        Some(setup_cutoff)
    );
}

#[test]
fn qpc_schedule_rejects_invalid_or_mismatched_frequency() {
    use ownership::ClockError;

    assert_eq!(
        ownership::QpcSchedule::new(ownership::QpcOrigin {
            counter: 0,
            frequency: 0,
        }),
        Err(ClockError::InvalidFrequency)
    );
    assert_eq!(
        ownership::QpcOrigin {
            counter: 0,
            frequency: 10,
        }
        .validate_frequency(11),
        Err(ClockError::FrequencyMismatch)
    );
    assert_eq!(
        ownership::QpcOrigin {
            counter: 0,
            frequency: 10,
        }
        .validate_frequency(10),
        Ok(())
    );
}

#[test]
fn qpc_origin_capture_validates_frequency_and_preserves_source_errors() {
    use ownership::{ClockError, QpcOrigin, QpcSource};

    struct FakeQpc {
        counter: Result<i64, u32>,
        frequency: Result<i64, u32>,
    }

    impl QpcSource for FakeQpc {
        fn counter(&self) -> Result<i64, u32> {
            self.counter
        }

        fn frequency(&self) -> Result<i64, u32> {
            self.frequency
        }
    }

    assert_eq!(
        QpcOrigin::capture(&FakeQpc {
            counter: Ok(777),
            frequency: Ok(10_000_000),
        }),
        Ok(QpcOrigin {
            counter: 777,
            frequency: 10_000_000,
        })
    );
    assert_eq!(
        QpcOrigin::capture(&FakeQpc {
            counter: Ok(777),
            frequency: Ok(0),
        }),
        Err(ClockError::InvalidFrequency)
    );
    assert_eq!(
        QpcOrigin::capture(&FakeQpc {
            counter: Err(55),
            frequency: Ok(10),
        }),
        Err(ClockError::CounterQuery(55))
    );
    assert_eq!(
        QpcOrigin::capture(&FakeQpc {
            counter: Ok(777),
            frequency: Err(44),
        }),
        Err(ClockError::FrequencyQuery(44))
    );
}

#[test]
fn rtl_get_version_returns_initialized_os_version_evidence() {
    let version = ownership::query_os_version().expect("RtlGetVersion should report OS evidence");

    assert!(version.major > 0);
    assert!((1..=3).contains(&version.product_type));
}

#[test]
fn qpc_schedule_rejects_tick_arithmetic_overflow() {
    use ownership::ClockError;

    assert_eq!(
        ownership::QpcSchedule::new(ownership::QpcOrigin {
            counter: i64::MAX - 1,
            frequency: 1,
        }),
        Err(ClockError::Overflow)
    );
    assert_eq!(
        ownership::QpcSchedule::new(ownership::QpcOrigin {
            counter: 0,
            frequency: i64::MAX,
        }),
        Err(ClockError::Overflow)
    );
}

#[test]
fn cross_process_qpc_order_rejects_one_tick_ambiguity() {
    use ownership::ClockError;
    use std::cmp::Ordering;

    assert_eq!(
        ownership::compare_cross_process_qpc(100, 101),
        Err(ClockError::AmbiguousOrdering)
    );
    assert_eq!(
        ownership::compare_cross_process_qpc(101, 100),
        Err(ClockError::AmbiguousOrdering)
    );
    assert_eq!(
        ownership::compare_cross_process_qpc(100, 102),
        Ok(Ordering::Less)
    );
    assert_eq!(
        ownership::compare_cross_process_qpc(102, 100),
        Ok(Ordering::Greater)
    );
    assert_eq!(
        ownership::compare_cross_process_qpc(100, 100),
        Err(ClockError::AmbiguousOrdering)
    );
}

#[test]
fn timestamp_ordering_rejects_mixed_clock_domains_and_ambiguous_qpc() {
    use ownership::{CaseTimestamp, ClockError};
    use std::cmp::Ordering;

    let local = Instant::now();
    assert_eq!(
        ownership::compare_case_timestamps(
            CaseTimestamp::Local(local),
            CaseTimestamp::Local(local + Duration::from_millis(1)),
        ),
        Ok(Ordering::Less)
    );
    assert_eq!(
        ownership::compare_case_timestamps(
            CaseTimestamp::Local(local),
            CaseTimestamp::SharedQpc(100),
        ),
        Err(ClockError::MixedClockDomains)
    );
    assert_eq!(
        ownership::compare_case_timestamps(
            CaseTimestamp::SharedQpc(100),
            CaseTimestamp::Local(local),
        ),
        Err(ClockError::MixedClockDomains)
    );
    assert_eq!(
        ownership::compare_case_timestamps(
            CaseTimestamp::SharedQpc(100),
            CaseTimestamp::SharedQpc(101),
        ),
        Err(ClockError::AmbiguousOrdering)
    );
}

#[test]
fn job_list_os_floor_requires_supported_windows_product_and_build() {
    let version = |major, minor, build, product_type| ownership::OsVersion {
        major,
        minor,
        build,
        product_type,
    };

    assert!(ownership::supports_job_list_os_floor(version(
        10, 0, 10_240, 1
    )));
    assert!(ownership::supports_job_list_os_floor(version(
        10, 0, 22_000, 1
    )));
    assert!(!ownership::supports_job_list_os_floor(version(
        10, 0, 10_239, 1
    )));
    assert!(ownership::supports_job_list_os_floor(version(
        10, 0, 14_393, 2
    )));
    assert!(ownership::supports_job_list_os_floor(version(
        10, 0, 20_000, 3
    )));
    assert!(!ownership::supports_job_list_os_floor(version(
        10, 0, 14_392, 3
    )));
    assert!(!ownership::supports_job_list_os_floor(version(
        10, 0, 30_000, 0
    )));
    assert!(ownership::supports_job_list_os_floor(version(10, 1, 0, 1)));
    assert!(ownership::supports_job_list_os_floor(version(11, 0, 0, 1)));
    assert!(ownership::supports_job_list_os_floor(version(11, 0, 0, 3)));
    assert!(!ownership::supports_job_list_os_floor(version(
        6, 3, 9_600, 1
    )));
}

#[test]
fn shared_case_clocks_validate_local_qpf_and_keep_independent_readers() {
    use ownership::{CaseClock, CaseTimestamp, ClockError, QpcOrigin, QpcSource};
    use std::sync::Arc;
    use std::sync::atomic::{AtomicI64, Ordering as AtomicOrdering};

    struct FakeQpc {
        counter: AtomicI64,
        frequency: i64,
    }

    impl QpcSource for FakeQpc {
        fn counter(&self) -> Result<i64, u32> {
            Ok(self.counter.load(AtomicOrdering::SeqCst))
        }

        fn frequency(&self) -> Result<i64, u32> {
            Ok(self.frequency)
        }
    }

    let origin = QpcOrigin {
        counter: 10_000,
        frequency: 1_000,
    };
    let first_source = Arc::new(FakeQpc {
        counter: AtomicI64::new(10_010),
        frequency: 1_000,
    });
    let second_source = Arc::new(FakeQpc {
        counter: AtomicI64::new(10_020),
        frequency: 1_000,
    });
    let first = CaseClock::from_shared_qpc(origin, first_source.clone()).unwrap();
    let second = CaseClock::from_shared_qpc(origin, second_source.clone()).unwrap();

    assert_eq!(first.now(), Ok(CaseTimestamp::SharedQpc(10_010)));
    first_source.counter.store(10_030, AtomicOrdering::SeqCst);
    assert_eq!(first.now(), Ok(CaseTimestamp::SharedQpc(10_030)));
    assert_eq!(second.now(), Ok(CaseTimestamp::SharedQpc(10_020)));

    let mismatched = FakeQpc {
        counter: AtomicI64::new(10_000),
        frequency: 999,
    };
    assert_eq!(
        CaseClock::from_shared_qpc(origin, Arc::new(mismatched)).err(),
        Some(ClockError::FrequencyMismatch)
    );

    let invalid_origin = QpcOrigin {
        counter: -1,
        frequency: 1_000,
    };
    assert_eq!(
        CaseClock::from_shared_qpc(invalid_origin, first_source.clone()).err(),
        Some(ClockError::InvalidOrigin)
    );
    let setup_cutoff = first.setup_cutoff().unwrap();
    assert_eq!(
        first.remaining(setup_cutoff).unwrap(),
        Duration::from_millis(2_970)
    );
    assert_eq!(
        first.remaining(ownership::CaseTimestamp::Local(Instant::now())),
        Err(ClockError::MixedClockDomains)
    );
    assert_eq!(
        first.remaining(CaseTimestamp::SharedQpc(10_031)),
        Err(ClockError::AmbiguousOrdering)
    );
    assert_eq!(
        first.cleanup_cutoff(ownership::CaseTimestamp::SharedQpc(14_000)),
        Ok(ownership::CaseTimestamp::SharedQpc(16_000))
    );
    assert_eq!(
        first.cleanup_cutoff(CaseTimestamp::SharedQpc(34_000)),
        Ok(CaseTimestamp::SharedQpc(35_000)),
        "cleanup must clip +2s at the origin's +25s absolute cutoff"
    );

    struct FailedRead;
    impl QpcSource for FailedRead {
        fn counter(&self) -> Result<i64, u32> {
            Err(77)
        }
        fn frequency(&self) -> Result<i64, u32> {
            Ok(1_000)
        }
    }
    let failed_read = CaseClock::from_shared_qpc(origin, Arc::new(FailedRead)).unwrap();
    assert_eq!(failed_read.now(), Err(ClockError::CounterQuery(77)));

    struct FailedFrequency;
    impl QpcSource for FailedFrequency {
        fn counter(&self) -> Result<i64, u32> {
            Ok(10_000)
        }
        fn frequency(&self) -> Result<i64, u32> {
            Err(88)
        }
    }
    assert_eq!(
        CaseClock::from_shared_qpc(origin, Arc::new(FailedFrequency)).err(),
        Some(ClockError::FrequencyQuery(88))
    );

    struct InvalidFrequency;
    impl QpcSource for InvalidFrequency {
        fn counter(&self) -> Result<i64, u32> {
            Ok(10_000)
        }
        fn frequency(&self) -> Result<i64, u32> {
            Ok(0)
        }
    }
    assert_eq!(
        CaseClock::from_shared_qpc(origin, Arc::new(InvalidFrequency)).err(),
        Some(ClockError::InvalidFrequency)
    );

    struct NegativeCounter;
    impl QpcSource for NegativeCounter {
        fn counter(&self) -> Result<i64, u32> {
            Ok(-1)
        }
        fn frequency(&self) -> Result<i64, u32> {
            Ok(1_000)
        }
    }
    let negative_counter = CaseClock::from_shared_qpc(origin, Arc::new(NegativeCounter)).unwrap();
    assert_eq!(negative_counter.now(), Err(ClockError::InvalidOrigin));
}

#[test]
fn cleanup_cutoff_rejects_both_mixed_clock_domains() {
    use ownership::{CaseClock, CaseTimestamp, ClockError, QpcOrigin, QpcSource};
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

    let qpc_clock = CaseClock::from_shared_qpc(
        QpcOrigin {
            counter: 1_000,
            frequency: 10,
        },
        Arc::new(FakeQpc),
    )
    .unwrap();
    assert_eq!(
        qpc_clock.cleanup_cutoff(CaseTimestamp::Local(Instant::now())),
        Err(ClockError::MixedClockDomains)
    );

    let local_clock = CaseClock::from_origin(Instant::now());
    assert_eq!(
        local_clock.cleanup_cutoff(CaseTimestamp::SharedQpc(1_100)),
        Err(ClockError::MixedClockDomains)
    );
}
