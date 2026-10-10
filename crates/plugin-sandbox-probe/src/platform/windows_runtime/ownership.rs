//! Small ownership and deadline primitives for the Windows diagnostic runtime.
//!
//! Deadlines bound supervisor decisions; synchronous native API latency is not
//! a hard real-time guarantee.

#[cfg(test)]
use std::sync::{Arc, atomic::AtomicUsize};
use std::time::{Duration, Instant};
use windows_sys::Win32::Foundation::{CloseHandle, GetLastError, HANDLE};

const SETUP_BUDGET: Duration = Duration::from_secs(3);
const HANDSHAKE_BUDGET: Duration = Duration::from_secs(13);
const OVERALL_BUDGET: Duration = Duration::from_secs(25);
const CLEANUP_BUDGET: Duration = Duration::from_secs(2);

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(super) struct CloseEvidence {
    pub attempted: bool,
    pub closed: bool,
    pub raw_os_error: Option<u32>,
}

/// Owns one HANDLE. An explicit close attempt is terminal: even when it fails,
/// Drop will not issue a second CloseHandle call against an uncertain value.
pub(super) struct OwnedHandle {
    raw: HANDLE,
    close_backend: Box<dyn FnMut(HANDLE) -> Result<(), u32> + Send>,
    close_attempted: bool,
    close_confirmed: bool,
    close_error: Option<u32>,
    #[cfg(test)]
    close_attempt_count: Arc<AtomicUsize>,
}

impl OwnedHandle {
    pub(super) fn from_raw(raw: HANDLE) -> Self {
        Self::with_backend(raw, Box::new(native_close))
    }

    fn with_backend(
        raw: HANDLE,
        close_backend: Box<dyn FnMut(HANDLE) -> Result<(), u32> + Send>,
    ) -> Self {
        Self {
            raw,
            close_backend,
            close_attempted: false,
            close_confirmed: false,
            close_error: None,
            #[cfg(test)]
            close_attempt_count: Arc::new(AtomicUsize::new(0)),
        }
    }

    #[cfg(test)]
    pub(super) fn from_raw_with_backend(
        raw: HANDLE,
        close_backend: impl FnMut(HANDLE) -> Result<(), u32> + Send + 'static,
    ) -> Self {
        Self::with_backend(raw, Box::new(close_backend))
    }

    pub(super) fn invalid() -> Self {
        Self::from_raw(std::ptr::null_mut())
    }

    pub(super) fn raw(&self) -> HANDLE {
        if self.close_attempted {
            std::ptr::null_mut()
        } else {
            self.raw
        }
    }

    pub(super) fn is_valid(&self) -> bool {
        !self.raw.is_null() && !self.close_attempted
    }

    /// Explicitly attempt closure once and return evidence from that attempt.
    /// A failed explicit attempt remains unconfirmed and is never retried.
    pub(super) fn close_checked(&mut self) -> CloseEvidence {
        if self.close_attempted {
            return CloseEvidence {
                attempted: true,
                closed: self.close_confirmed,
                raw_os_error: self.close_error,
            };
        }
        if self.raw.is_null() {
            return CloseEvidence {
                attempted: false,
                closed: false,
                raw_os_error: None,
            };
        }

        self.close_attempted = true;
        #[cfg(test)]
        {
            self.close_attempt_count
                .fetch_add(1, std::sync::atomic::Ordering::SeqCst);
        }
        match (self.close_backend)(self.raw) {
            Ok(()) => {
                self.raw = std::ptr::null_mut();
                self.close_confirmed = true;
            }
            Err(error) => self.close_error = Some(error),
        }
        CloseEvidence {
            attempted: true,
            closed: self.close_confirmed,
            raw_os_error: self.close_error,
        }
    }

    #[cfg(test)]
    pub(super) fn close_attempt_count(&self) -> usize {
        self.close_attempt_count
            .load(std::sync::atomic::Ordering::SeqCst)
    }

    #[cfg(test)]
    pub(super) fn close_attempt_counter(&self) -> Arc<AtomicUsize> {
        Arc::clone(&self.close_attempt_count)
    }
}

impl Drop for OwnedHandle {
    fn drop(&mut self) {
        if !self.raw.is_null() && !self.close_attempted {
            self.close_attempted = true;
            #[cfg(test)]
            {
                self.close_attempt_count
                    .fetch_add(1, std::sync::atomic::Ordering::SeqCst);
            }
            // Drop uses the same backend as checked close, but its return value
            // is not checked closure evidence.
            let _ = (self.close_backend)(self.raw);
            self.raw = std::ptr::null_mut();
        }
    }
}

fn native_close(raw: HANDLE) -> Result<(), u32> {
    if unsafe { CloseHandle(raw) } != 0 {
        Ok(())
    } else {
        // Capture immediately before returning to any caller/API.
        Err(unsafe { GetLastError() })
    }
}

#[cfg(test)]
use windows_sys::Win32::System::Performance::{QueryPerformanceCounter, QueryPerformanceFrequency};
#[cfg(test)]
use windows_sys::Win32::System::SystemInformation::OSVERSIONINFOEXW;

#[cfg(test)]
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(super) struct QpcOrigin {
    pub counter: i64,
    pub frequency: i64,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(super) enum ClockError {
    CounterQuery(u32),
    FrequencyQuery(u32),
    VersionQuery(i32),
    InvalidVersionInfoSize,
    MixedClockDomains,
    InvalidOrigin,
    InvalidFrequency,
    FrequencyMismatch,
    Overflow,
    AmbiguousOrdering,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(super) enum CaseTimestamp {
    Local(Instant),
    #[cfg(test)]
    SharedQpc(i64),
}

impl From<Instant> for CaseTimestamp {
    fn from(value: Instant) -> Self {
        Self::Local(value)
    }
}

impl PartialEq<Instant> for CaseTimestamp {
    fn eq(&self, other: &Instant) -> bool {
        matches!(self, Self::Local(value) if value == other)
    }
}

impl PartialEq<CaseTimestamp> for Instant {
    fn eq(&self, other: &CaseTimestamp) -> bool {
        other == self
    }
}

pub(super) fn compare_case_timestamps(
    left: CaseTimestamp,
    right: CaseTimestamp,
) -> Result<std::cmp::Ordering, ClockError> {
    match (left, right) {
        (CaseTimestamp::Local(left), CaseTimestamp::Local(right)) => Ok(left.cmp(&right)),
        #[cfg(test)]
        (CaseTimestamp::SharedQpc(left), CaseTimestamp::SharedQpc(right)) => {
            compare_cross_process_qpc(left, right)
        }
        #[cfg(test)]
        _ => Err(ClockError::MixedClockDomains),
    }
}

#[cfg(test)]
pub(super) trait QpcSource: Send + Sync {
    fn counter(&self) -> Result<i64, u32>;
    fn frequency(&self) -> Result<i64, u32>;
    fn after_wait(&self) {}
    fn after_receive(&self) {}
}

#[cfg(test)]
struct SystemQpcSource;

#[cfg(test)]
impl QpcSource for SystemQpcSource {
    fn counter(&self) -> Result<i64, u32> {
        let mut counter = 0;
        if unsafe { QueryPerformanceCounter(&mut counter) } != 0 {
            Ok(counter)
        } else {
            Err(unsafe { GetLastError() })
        }
    }

    fn frequency(&self) -> Result<i64, u32> {
        let mut frequency = 0;
        if unsafe { QueryPerformanceFrequency(&mut frequency) } != 0 {
            Ok(frequency)
        } else {
            Err(unsafe { GetLastError() })
        }
    }
}

#[cfg(test)]
impl QpcOrigin {
    pub(super) fn capture(source: &dyn QpcSource) -> Result<Self, ClockError> {
        let frequency = source.frequency().map_err(ClockError::FrequencyQuery)?;
        if frequency <= 0 {
            return Err(ClockError::InvalidFrequency);
        }
        let counter = source.counter().map_err(ClockError::CounterQuery)?;
        if counter < 0 {
            return Err(ClockError::InvalidOrigin);
        }
        Ok(Self { counter, frequency })
    }

    pub(super) fn capture_system() -> Result<Self, ClockError> {
        Self::capture(&SystemQpcSource)
    }

    pub(super) fn validate_frequency(self, frequency: i64) -> Result<(), ClockError> {
        if self.frequency <= 0 || frequency <= 0 {
            return Err(ClockError::InvalidFrequency);
        }
        if frequency != self.frequency {
            return Err(ClockError::FrequencyMismatch);
        }
        Ok(())
    }
}

#[cfg(test)]
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(super) struct QpcSchedule {
    origin: QpcOrigin,
    setup_cutoff: i64,
    handshake_cutoff: i64,
    overall_cutoff: i64,
}

#[cfg(test)]
impl QpcSchedule {
    pub(super) fn new(origin: QpcOrigin) -> Result<Self, ClockError> {
        if origin.frequency <= 0 {
            return Err(ClockError::InvalidFrequency);
        }
        Ok(Self {
            origin,
            setup_cutoff: Self::add_seconds(origin, origin.counter, 3)
                .ok_or(ClockError::Overflow)?,
            handshake_cutoff: Self::add_seconds(origin, origin.counter, 13)
                .ok_or(ClockError::Overflow)?,
            overall_cutoff: Self::add_seconds(origin, origin.counter, 25)
                .ok_or(ClockError::Overflow)?,
        })
    }

    pub(super) fn setup_cutoff(self) -> Option<i64> {
        Some(self.setup_cutoff)
    }

    pub(super) fn handshake_cutoff(self) -> Option<i64> {
        Some(self.handshake_cutoff)
    }

    pub(super) fn work_cutoff(self, observation_qpc: i64) -> Option<i64> {
        if compare_cross_process_qpc(observation_qpc, self.origin.counter).ok()?
            != std::cmp::Ordering::Greater
        {
            return None;
        }
        Self::add_seconds(self.origin, observation_qpc, 10)
    }

    pub(super) fn scheduled_setup_failure(self, failure_observed_qpc: i64) -> Option<i64> {
        if compare_cross_process_qpc(failure_observed_qpc, self.origin.counter).ok()?
            != std::cmp::Ordering::Greater
        {
            return None;
        }
        match compare_cross_process_qpc(failure_observed_qpc, self.setup_cutoff).ok()? {
            std::cmp::Ordering::Less => Some(failure_observed_qpc),
            std::cmp::Ordering::Equal | std::cmp::Ordering::Greater => Some(self.setup_cutoff),
        }
    }

    pub(super) fn overall_cutoff(self) -> Option<i64> {
        Some(self.overall_cutoff)
    }

    pub(super) fn cleanup_cutoff(self, scheduled_stop_qpc: i64) -> Option<i64> {
        if compare_cross_process_qpc(scheduled_stop_qpc, self.origin.counter).ok()?
            != std::cmp::Ordering::Greater
            || compare_cross_process_qpc(scheduled_stop_qpc, self.overall_cutoff).ok()?
                != std::cmp::Ordering::Less
        {
            return None;
        }
        Some(Self::add_seconds(self.origin, scheduled_stop_qpc, 2)?.min(self.overall_cutoff))
    }

    fn add_seconds(origin: QpcOrigin, counter: i64, seconds: i64) -> Option<i64> {
        let ticks = origin.frequency.checked_mul(seconds)?;
        counter.checked_add(ticks)
    }
}

#[cfg(test)]
pub(super) fn compare_cross_process_qpc(
    left: i64,
    right: i64,
) -> Result<std::cmp::Ordering, ClockError> {
    if left.abs_diff(right) <= 1 {
        return Err(ClockError::AmbiguousOrdering);
    }
    Ok(left.cmp(&right))
}

#[cfg(test)]
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(super) struct OsVersion {
    pub major: u32,
    pub minor: u32,
    pub build: u32,
    pub product_type: u8,
}

#[cfg(test)]
pub(super) fn supports_job_list_os_floor(version: OsVersion) -> bool {
    let build_floor = match version.product_type {
        1 => 10_240,
        2 | 3 => 14_393,
        _ => return false,
    };
    (version.major, version.minor, version.build) >= (10, 0, build_floor)
}

#[cfg(test)]
pub(super) fn query_os_version() -> Result<OsVersion, ClockError> {
    // This is observational evidence only; actual Job-list creation and
    // membership verification remain authoritative.
    #[link(name = "ntdll")]
    unsafe extern "system" {
        fn RtlGetVersion(version_information: *mut OSVERSIONINFOEXW) -> i32;
    }

    let expected_size = std::mem::size_of::<OSVERSIONINFOEXW>();
    let mut version_information: OSVERSIONINFOEXW = unsafe { std::mem::zeroed() };
    version_information.dwOSVersionInfoSize =
        u32::try_from(expected_size).map_err(|_| ClockError::InvalidVersionInfoSize)?;
    let status = unsafe { RtlGetVersion(&mut version_information) };
    if status != 0 {
        return Err(ClockError::VersionQuery(status));
    }
    if version_information.dwOSVersionInfoSize as usize != expected_size {
        return Err(ClockError::InvalidVersionInfoSize);
    }
    Ok(OsVersion {
        major: version_information.dwMajorVersion,
        minor: version_information.dwMinorVersion,
        build: version_information.dwBuildNumber,
        product_type: version_information.wProductType,
    })
}

/// One monotonic origin for a runtime attempt. Construct it before creating
/// the Job so all absolute cutoffs include setup work.
#[derive(Clone)]
pub(super) enum CaseClock {
    Local {
        origin: Instant,
    },
    #[cfg(test)]
    SharedQpc {
        origin: QpcOrigin,
        source: Arc<dyn QpcSource>,
    },
}

impl CaseClock {
    pub(super) fn new() -> Self {
        Self::from_origin(Instant::now())
    }

    pub(super) fn from_origin(origin: Instant) -> Self {
        Self::Local { origin }
    }

    pub(super) fn origin(&self) -> Instant {
        match self {
            Self::Local { origin } => *origin,
            #[cfg(test)]
            Self::SharedQpc { .. } => panic!("shared-QPC clocks have no local Instant origin"),
        }
    }

    #[cfg(test)]
    pub(super) fn from_shared_qpc(
        origin: QpcOrigin,
        source: Arc<dyn QpcSource>,
    ) -> Result<Self, ClockError> {
        if origin.counter < 0 {
            return Err(ClockError::InvalidOrigin);
        }
        let local_frequency = source.frequency().map_err(ClockError::FrequencyQuery)?;
        origin.validate_frequency(local_frequency)?;
        // Reject a shared clock before any native setup can begin unless every
        // absolute schedule cutoff is representable.
        QpcSchedule::new(origin)?;
        Ok(Self::SharedQpc { origin, source })
    }

    #[cfg(test)]
    pub(super) fn now(&self) -> Result<CaseTimestamp, ClockError> {
        self.now_timestamp()
    }

    #[cfg(test)]
    pub(super) fn after_wait_for_test(&self) {
        if let Self::SharedQpc { source, .. } = self {
            source.after_wait();
        }
    }

    #[cfg(test)]
    pub(super) fn after_receive_for_test(&self) {
        if let Self::SharedQpc { source, .. } = self {
            source.after_receive();
        }
    }

    #[cfg(test)]
    pub(super) fn shared_origin(&self) -> Option<QpcOrigin> {
        match self {
            Self::Local { .. } => None,
            Self::SharedQpc { origin, .. } => Some(*origin),
        }
    }

    pub(super) fn origin_timestamp(&self) -> CaseTimestamp {
        match self {
            Self::Local { origin } => CaseTimestamp::Local(*origin),
            #[cfg(test)]
            Self::SharedQpc { origin, .. } => CaseTimestamp::SharedQpc(origin.counter),
        }
    }

    pub(super) fn now_timestamp(&self) -> Result<CaseTimestamp, ClockError> {
        match self {
            Self::Local { .. } => Ok(CaseTimestamp::Local(Instant::now())),
            #[cfg(test)]
            Self::SharedQpc { source, .. } => {
                let counter = source.counter().map_err(ClockError::CounterQuery)?;
                if counter < 0 {
                    return Err(ClockError::InvalidOrigin);
                }
                Ok(CaseTimestamp::SharedQpc(counter))
            }
        }
    }

    pub(super) fn setup_cutoff(&self) -> Result<CaseTimestamp, ClockError> {
        self.cutoff_after(SETUP_BUDGET)
    }

    pub(super) fn handshake_cutoff(&self) -> Result<CaseTimestamp, ClockError> {
        self.cutoff_after(HANDSHAKE_BUDGET)
    }

    pub(super) fn overall_cutoff(&self) -> Result<CaseTimestamp, ClockError> {
        self.cutoff_after(OVERALL_BUDGET)
    }

    fn cutoff_after(&self, duration: Duration) -> Result<CaseTimestamp, ClockError> {
        match self {
            Self::Local { origin } => origin
                .checked_add(duration)
                .map(CaseTimestamp::Local)
                .ok_or(ClockError::Overflow),
            #[cfg(test)]
            Self::SharedQpc { origin, .. } => {
                let ticks = (origin.frequency as u128)
                    .checked_mul(duration.as_secs().into())
                    .and_then(|whole| {
                        let fractional = (origin.frequency as u128)
                            .checked_mul(u128::from(duration.subsec_nanos()))?
                            / 1_000_000_000;
                        whole.checked_add(fractional)
                    })
                    .ok_or(ClockError::Overflow)?;
                let ticks = i64::try_from(ticks).map_err(|_| ClockError::Overflow)?;
                origin
                    .counter
                    .checked_add(ticks)
                    .map(CaseTimestamp::SharedQpc)
                    .ok_or(ClockError::Overflow)
            }
        }
    }

    pub(super) fn is_due(&self, cutoff: CaseTimestamp) -> Result<bool, ClockError> {
        let now = self.now_timestamp()?;
        match compare_case_timestamps(now, cutoff)? {
            std::cmp::Ordering::Less => Ok(false),
            std::cmp::Ordering::Equal | std::cmp::Ordering::Greater => Ok(true),
        }
    }

    pub(super) fn remaining(&self, cutoff: CaseTimestamp) -> Result<Duration, ClockError> {
        let now = self.now_timestamp()?;
        match (now, cutoff) {
            (CaseTimestamp::Local(now), CaseTimestamp::Local(cutoff)) => {
                Ok(cutoff.saturating_duration_since(now))
            }
            #[cfg(test)]
            (CaseTimestamp::SharedQpc(now), CaseTimestamp::SharedQpc(cutoff)) => {
                match compare_cross_process_qpc(now, cutoff)? {
                    std::cmp::Ordering::Greater => Ok(Duration::ZERO),
                    std::cmp::Ordering::Equal => Err(ClockError::AmbiguousOrdering),
                    std::cmp::Ordering::Less => {
                        let origin = self.shared_origin().ok_or(ClockError::MixedClockDomains)?;
                        let ticks = cutoff.checked_sub(now).ok_or(ClockError::Overflow)? as u128;
                        let nanos = ticks
                            .checked_mul(1_000_000_000)
                            .ok_or(ClockError::Overflow)?
                            / origin.frequency as u128;
                        let seconds = nanos / 1_000_000_000;
                        let subsec_nanos = (nanos % 1_000_000_000) as u32;
                        Ok(Duration::new(
                            u64::try_from(seconds).map_err(|_| ClockError::Overflow)?,
                            subsec_nanos,
                        ))
                    }
                }
            }
            #[cfg(test)]
            _ => Err(ClockError::MixedClockDomains),
        }
    }

    pub(super) fn cleanup_cutoff(
        &self,
        scheduled_stop: CaseTimestamp,
    ) -> Result<CaseTimestamp, ClockError> {
        match (self, scheduled_stop) {
            (Self::Local { .. }, CaseTimestamp::Local(stop)) => self
                .cleanup_deadline(stop)
                .map(CaseTimestamp::Local)
                .ok_or(ClockError::Overflow),
            #[cfg(test)]
            (Self::SharedQpc { origin, .. }, CaseTimestamp::SharedQpc(stop)) => {
                let schedule = QpcSchedule::new(*origin)?;
                let cutoff = schedule
                    .cleanup_cutoff(stop)
                    .ok_or(ClockError::AmbiguousOrdering)?;
                Ok(CaseTimestamp::SharedQpc(cutoff))
            }
            #[cfg(test)]
            _ => Err(ClockError::MixedClockDomains),
        }
    }

    pub(super) fn after(
        &self,
        timestamp: CaseTimestamp,
        duration: Duration,
    ) -> Result<CaseTimestamp, ClockError> {
        match (self, timestamp) {
            (Self::Local { .. }, CaseTimestamp::Local(instant)) => instant
                .checked_add(duration)
                .map(CaseTimestamp::Local)
                .ok_or(ClockError::Overflow),
            #[cfg(test)]
            (Self::SharedQpc { origin, .. }, CaseTimestamp::SharedQpc(counter)) => {
                let whole = (origin.frequency as u128)
                    .checked_mul(duration.as_secs() as u128)
                    .ok_or(ClockError::Overflow)?;
                let fraction = (origin.frequency as u128)
                    .checked_mul(u128::from(duration.subsec_nanos()))
                    .ok_or(ClockError::Overflow)?
                    / 1_000_000_000;
                let ticks = i64::try_from(whole.checked_add(fraction).ok_or(ClockError::Overflow)?)
                    .map_err(|_| ClockError::Overflow)?;
                counter
                    .checked_add(ticks)
                    .map(CaseTimestamp::SharedQpc)
                    .ok_or(ClockError::Overflow)
            }
            #[cfg(test)]
            _ => Err(ClockError::MixedClockDomains),
        }
    }

    pub(super) fn before(
        &self,
        timestamp: CaseTimestamp,
        duration: Duration,
    ) -> Result<CaseTimestamp, ClockError> {
        match (self, timestamp) {
            (Self::Local { .. }, CaseTimestamp::Local(instant)) => instant
                .checked_sub(duration)
                .map(CaseTimestamp::Local)
                .ok_or(ClockError::Overflow),
            #[cfg(test)]
            (Self::SharedQpc { origin, .. }, CaseTimestamp::SharedQpc(counter)) => {
                let whole = (origin.frequency as u128)
                    .checked_mul(duration.as_secs() as u128)
                    .ok_or(ClockError::Overflow)?;
                let fraction = (origin.frequency as u128)
                    .checked_mul(u128::from(duration.subsec_nanos()))
                    .ok_or(ClockError::Overflow)?
                    / 1_000_000_000;
                let ticks = i64::try_from(whole.checked_add(fraction).ok_or(ClockError::Overflow)?)
                    .map_err(|_| ClockError::Overflow)?;
                counter
                    .checked_sub(ticks)
                    .map(CaseTimestamp::SharedQpc)
                    .ok_or(ClockError::Overflow)
            }
            #[cfg(test)]
            _ => Err(ClockError::MixedClockDomains),
        }
    }

    pub(super) fn scheduled_setup_failure(
        &self,
        observed: CaseTimestamp,
    ) -> Result<CaseTimestamp, ClockError> {
        match (self, observed) {
            (Self::Local { .. }, CaseTimestamp::Local(observed)) => {
                let cutoff = self.setup_cutoff()?;
                match cutoff {
                    CaseTimestamp::Local(cutoff) if observed >= cutoff => {
                        Ok(CaseTimestamp::Local(cutoff))
                    }
                    CaseTimestamp::Local(_) => Ok(CaseTimestamp::Local(observed)),
                    #[cfg(test)]
                    _ => Err(ClockError::MixedClockDomains),
                }
            }
            #[cfg(test)]
            (Self::SharedQpc { origin, .. }, CaseTimestamp::SharedQpc(observed)) => {
                QpcSchedule::new(*origin)?
                    .scheduled_setup_failure(observed)
                    .map(CaseTimestamp::SharedQpc)
                    .ok_or(ClockError::AmbiguousOrdering)
            }
            #[cfg(test)]
            _ => Err(ClockError::MixedClockDomains),
        }
    }

    pub(super) fn setup_deadline(&self) -> Option<Instant> {
        self.origin().checked_add(SETUP_BUDGET)
    }

    pub(super) fn handshake_deadline(&self) -> Option<Instant> {
        self.origin().checked_add(HANDSHAKE_BUDGET)
    }

    pub(super) fn overall_deadline(&self) -> Option<Instant> {
        self.origin().checked_add(OVERALL_BUDGET)
    }

    pub(super) fn offset_ms(&self, instant: Instant) -> Option<u64> {
        let elapsed = instant.checked_duration_since(self.origin())?;
        u64::try_from(elapsed.as_millis()).ok()
    }

    pub(super) fn now_offset_ms(&self) -> Option<u64> {
        self.offset_ms(Instant::now())
    }

    pub(super) fn setup_deadline_ms(&self) -> Option<u64> {
        self.offset_ms(self.setup_deadline()?)
    }

    pub(super) fn handshake_deadline_ms(&self) -> Option<u64> {
        self.offset_ms(self.handshake_deadline()?)
    }

    pub(super) fn overall_deadline_ms(&self) -> Option<u64> {
        self.offset_ms(self.overall_deadline()?)
    }

    /// Absolute cleanup cutoff: scheduled stop + 2 seconds, clipped by the
    /// overall case ceiling. Invalid/out-of-case offsets fail closed.
    pub(super) fn cleanup_deadline_ms(&self, scheduled_stop_ms: u64) -> Option<u64> {
        let overall_ms = self.overall_deadline_ms()?;
        if scheduled_stop_ms > overall_ms {
            return None;
        }
        Some(
            scheduled_stop_ms
                .checked_add(u64::try_from(CLEANUP_BUDGET.as_millis()).ok()?)?
                .min(overall_ms),
        )
    }

    pub(super) fn cleanup_deadline(&self, scheduled_stop: Instant) -> Option<Instant> {
        let overall_deadline = self.overall_deadline()?;
        if scheduled_stop < self.origin() || scheduled_stop > overall_deadline {
            return None;
        }
        Some(
            scheduled_stop
                .checked_add(CLEANUP_BUDGET)?
                .min(overall_deadline),
        )
    }
}
