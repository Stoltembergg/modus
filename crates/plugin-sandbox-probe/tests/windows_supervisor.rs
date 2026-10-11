#![cfg(windows)]

use plugin_sandbox_probe::platform::run_probe;

#[test]
fn windows_child_scenario_uses_suspended_job_supervision_and_reaps_in_two_seconds() {
    let report = run_probe().expect("Windows supervisor probe should produce a report");
    let json = serde_json::to_value(report).expect("report should serialize");
    assert_eq!(json["verdict"], "NO_GO");
    assert_eq!(json["process_tree_empty"], true);
    let child = json["scenarios"]
        .as_array()
        .expect("scenario list")
        .iter()
        .find(|scenario| scenario["scenario"] == "child_process_tree")
        .expect("child-process scenario");

    assert_eq!(child["status"], "passed");
    assert_eq!(child["challenge_observed"], true);
    assert_eq!(child["launch"]["created_suspended"], true);
    assert_eq!(child["launch"]["job_assigned_before_resume"], true);
    assert_eq!(child["launch"]["membership_verified"], true);
    assert_eq!(child["policy"]["effective_verified"], true);
    assert_eq!(child["effective_policy_verified"], true);
    assert_eq!(
        child["policy"]["configured"],
        "JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE (cleanup safeguard)"
    );
    assert_eq!(
        child["policy"]["queried"],
        "JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE"
    );
    assert_eq!(child["enforcement"], "verified");
    assert_eq!(
        child["mechanism"],
        "fresh Windows Job Object membership and TerminateJobObject"
    );
    assert_eq!(child["challenge"]["kind"], "host_owned_child_ready_frame");
    assert_eq!(child["challenge"]["observed"], true);
    assert!(
        child["challenge"]["detail"]
            .as_str()
            .is_some_and(|detail| !detail.is_empty())
    );
    assert_eq!(child["child"]["ready"], true);
    let child_pid = child["child"]["pid"].as_u64().expect("ready child PID");
    let root_pid = child["child"]["root_pid"].as_u64().expect("root PID");
    assert_ne!(child_pid, 0);
    assert_ne!(root_pid, 0);
    assert_ne!(child_pid, root_pid);
    assert_eq!(child["child"]["membership_verified"], true);
    assert_eq!(child["child"]["process_handle_retained"], true);
    assert_eq!(child["process_count"]["active_before"], 2);
    assert_eq!(child["termination"]["method"], "terminate_job_object");
    assert_eq!(child["termination"]["requested"], true);
    assert_eq!(
        child["termination"]["raw_os_error"],
        serde_json::Value::Null
    );
    let requested_exit_code = child["termination"]["requested_exit_code"]
        .as_u64()
        .expect("requested termination exit code");
    assert_eq!(child["exit"]["child_wait_completed"], true);
    assert_eq!(child["exit"]["worker_wait_completed"], true);
    assert_eq!(child["exit"]["tree_wait_completed"], true);
    assert_eq!(
        child["exit"]["child_exit_code"].as_u64(),
        Some(requested_exit_code)
    );
    assert_eq!(
        child["exit"]["worker_exit_code"].as_u64(),
        Some(requested_exit_code)
    );
    assert_eq!(child["worker_wait_completed"], true);
    assert_eq!(child["tree_wait_completed"], true);
    assert_eq!(child["process_count"]["active_after"], 0);
    assert_eq!(child["job_empty"], true);
    assert_eq!(child["reap"]["tree_wait_completed"], true);
    assert_eq!(child["reap"]["all_handles_closed"], true);
    assert_eq!(child["reap"]["job_handle_closed"], true);
    assert_eq!(child["reap"]["deadline_ms"], 2_000);
    let stop_to_reap_ms = child["stop_to_reap_ms"]
        .as_u64()
        .expect("stop-to-reap timing");
    let kill_to_reap_ms = child["kill_to_reap_ms"]
        .as_u64()
        .expect("kill-to-reap timing");
    assert!(stop_to_reap_ms <= 2_000);
    assert_eq!(stop_to_reap_ms, kill_to_reap_ms);
    assert_eq!(
        child["reap"]["stop_to_reap_ms"].as_u64(),
        Some(stop_to_reap_ms)
    );
    assert_eq!(
        child["reap"]["kill_to_reap_ms"].as_u64(),
        Some(kill_to_reap_ms)
    );
    assert!(
        child["independent_evidence"]
            .as_str()
            .is_some_and(|evidence| !evidence.is_empty())
    );
    assert_eq!(child["enforcement_attributed"], true);
}
