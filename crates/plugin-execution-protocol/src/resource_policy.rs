//! Shared limits approved in the plugin-isolation design.
//!
//! These values are requirements for platform adapters, not evidence that any
//! adapter enforces them. External execution must remain unavailable until a
//! host-side supervisor applies and verifies every required limit.

use crate::{MAX_IPC_FRAME_BYTES, MAX_PENDING_REQUESTS, MAX_RESULT_BYTES};

const KIB: u64 = 1024;
const MIB: u64 = 1024 * KIB;

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub struct ResourcePolicy {
    pub max_artifact_bytes: u64,
    pub max_ipc_frame_bytes: u64,
    pub max_result_bytes: u64,
    pub max_stdout_bytes_per_invocation: u64,
    pub max_stderr_bytes_per_invocation: u64,
    pub max_wasm_memory_bytes: u64,
    pub max_helper_rss_bytes: u64,
    pub max_total_helper_rss_bytes: u64,
    pub wasmtime_fuel_per_invocation: u64,
    pub wasmtime_fuel_per_plugin_minute: u64,
    pub cpu_basis_points_of_one_core: u16,
    pub handshake_timeout_ms: u64,
    pub startup_timeout_ms: u64,
    pub execution_timeout_ms: u64,
    pub lifecycle_timeout_ms: u64,
    pub broker_timeout_ms: u64,
    pub cooperative_cancel_grace_ms: u64,
    pub forced_termination_reap_deadline_ms: u64,
    pub max_hostcalls_per_invocation: u32,
    pub max_hostcalls_per_plugin_second: u32,
    pub max_pending_requests: u32,
    pub max_helpers_per_plugin: u32,
    pub max_helpers_per_application: u32,
    pub max_guest_child_processes: u32,
    pub max_kernel_handles_or_file_descriptors: u32,
}

/// Frozen policy ceilings from `2026-10-07-plugin-execution-isolation-design.md`.
/// A value here is a requirement only; it does not assert enforcement.
pub const APPROVED_RESOURCE_POLICY: ResourcePolicy = ResourcePolicy {
    max_artifact_bytes: 32 * MIB,
    max_ipc_frame_bytes: MAX_IPC_FRAME_BYTES as u64,
    max_result_bytes: MAX_RESULT_BYTES as u64,
    max_stdout_bytes_per_invocation: 64 * KIB,
    max_stderr_bytes_per_invocation: 64 * KIB,
    max_wasm_memory_bytes: 128 * MIB,
    max_helper_rss_bytes: 256 * MIB,
    max_total_helper_rss_bytes: 1024 * MIB,
    wasmtime_fuel_per_invocation: 50_000_000,
    wasmtime_fuel_per_plugin_minute: 200_000_000,
    cpu_basis_points_of_one_core: 2_500,
    handshake_timeout_ms: 2_000,
    startup_timeout_ms: 5_000,
    execution_timeout_ms: 10_000,
    lifecycle_timeout_ms: 10_000,
    broker_timeout_ms: 5_000,
    cooperative_cancel_grace_ms: 100,
    forced_termination_reap_deadline_ms: 2_000,
    max_hostcalls_per_invocation: 64,
    max_hostcalls_per_plugin_second: 256,
    max_pending_requests: MAX_PENDING_REQUESTS as u32,
    max_helpers_per_plugin: 1,
    max_helpers_per_application: 8,
    max_guest_child_processes: 0,
    max_kernel_handles_or_file_descriptors: 64,
};

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn policy_matches_the_approved_fixed_resource_ceilings() {
        let policy = APPROVED_RESOURCE_POLICY;
        assert_eq!(policy.max_artifact_bytes, 32 * MIB);
        assert_eq!(policy.max_ipc_frame_bytes, 256 * KIB);
        assert_eq!(policy.max_result_bytes, 64 * KIB);
        assert_eq!(policy.max_stdout_bytes_per_invocation, 64 * KIB);
        assert_eq!(policy.max_stderr_bytes_per_invocation, 64 * KIB);
        assert_eq!(policy.max_wasm_memory_bytes, 128 * MIB);
        assert_eq!(policy.max_helper_rss_bytes, 256 * MIB);
        assert_eq!(policy.max_total_helper_rss_bytes, 1024 * MIB);
        assert_eq!(policy.wasmtime_fuel_per_invocation, 50_000_000);
        assert_eq!(policy.wasmtime_fuel_per_plugin_minute, 200_000_000);
        assert_eq!(policy.cpu_basis_points_of_one_core, 2_500);
        assert_eq!(policy.handshake_timeout_ms, 2_000);
        assert_eq!(policy.startup_timeout_ms, 5_000);
        assert_eq!(policy.execution_timeout_ms, 10_000);
        assert_eq!(policy.lifecycle_timeout_ms, 10_000);
        assert_eq!(policy.broker_timeout_ms, 5_000);
        assert_eq!(policy.cooperative_cancel_grace_ms, 100);
        assert_eq!(policy.forced_termination_reap_deadline_ms, 2_000);
        assert_eq!(policy.max_hostcalls_per_invocation, 64);
        assert_eq!(policy.max_hostcalls_per_plugin_second, 256);
        assert_eq!(policy.max_pending_requests, 16);
        assert_eq!(policy.max_helpers_per_plugin, 1);
        assert_eq!(policy.max_helpers_per_application, 8);
        assert_eq!(policy.max_guest_child_processes, 0);
        assert_eq!(policy.max_kernel_handles_or_file_descriptors, 64);
    }

    #[test]
    fn policy_ipc_ceilings_cannot_drift_from_the_protocol_codec() {
        assert_eq!(
            APPROVED_RESOURCE_POLICY.max_ipc_frame_bytes,
            MAX_IPC_FRAME_BYTES as u64,
        );
        assert_eq!(
            APPROVED_RESOURCE_POLICY.max_result_bytes,
            MAX_RESULT_BYTES as u64,
        );
        assert_eq!(
            APPROVED_RESOURCE_POLICY.max_pending_requests,
            MAX_PENDING_REQUESTS as u32,
        );
    }
}
