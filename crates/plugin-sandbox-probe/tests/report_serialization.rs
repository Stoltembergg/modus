use plugin_sandbox_probe::report::{
    CheckOutcome, ProbeReport, QuotaState, Verdict, serialize_bounded,
};

#[test]
fn serializes_v1_report_with_invariant_fields_and_bound() {
    let report = ProbeReport::not_tested("linux", "x86_64");
    let json = serialize_bounded(&report).unwrap();
    assert!(json.len() <= plugin_sandbox_probe::report::MAX_REPORT_BYTES);
    let value: serde_json::Value = serde_json::from_str(&json).unwrap();
    assert_eq!(value["schema_version"], 2);
    assert_eq!(value["scenarios"].as_array().unwrap().len(), 8);
    assert_eq!(value["verdict"], "NO_GO");
    assert_eq!(value["audit_findings_closed"], false);
    assert_eq!(value["plugin_bytes_received"], false);
    assert_eq!(value["checks"]["protected_path_read"], "not_run");
    assert_eq!(value["checks"]["environment"], "not_run");
    assert_eq!(value["quotas"]["memory"], "not_tested");
    assert_eq!(value["quotas"]["cpu_rate"], "not_tested");
    assert_eq!(value["quotas"]["processes"], "not_tested");
    assert_eq!(value["process_tree_empty"], false);
    assert_eq!(value["termination_evidence"], "not tested");

    let mut invalid = report;
    invalid.verdict = Verdict::NoGo;
    invalid.checks.protected_path_read = CheckOutcome::Error;
    invalid.quotas.memory = QuotaState::Unavailable;
    invalid.evidence.push("diagnostic only".into());
    assert!(serialize_bounded(&invalid).is_ok());
}

#[test]
fn serialization_rejects_oversized_evidence() {
    let mut report = ProbeReport::not_tested("linux", "x86_64");
    report
        .evidence
        .push("x".repeat(plugin_sandbox_probe::report::MAX_REPORT_BYTES));
    assert!(serialize_bounded(&report).is_err());
}

fn apparent_pass_report(scenario: &str) -> serde_json::Value {
    let mut report = serde_json::to_value(ProbeReport::not_tested("windows", "x86_64")).unwrap();
    let result = report["scenarios"]
        .as_array_mut()
        .unwrap()
        .iter_mut()
        .find(|result| result["scenario"] == scenario)
        .unwrap();
    result["status"] = "passed".into();
    result["mechanism"] = "verified mechanism".into();
    result["effective_policy_verified"] = true.into();
    result["enforcement"] = "verified".into();
    result["challenge_observed"] = true.into();
    result["challenge"] = serde_json::json!({"kind":"fixed", "observed":true, "detail":null});
    result["independent_evidence"] = "parent observation".into();
    result["enforcement_attributed"] = true.into();
    result["worker_terminated"] = true.into();
    result["job_empty"] = true.into();
    result["worker_wait_completed"] = true.into();
    result["tree_wait_completed"] = true.into();
    result["stop_to_reap_ms"] = 1.into();
    result["kill_to_reap_ms"] = 1.into();
    result["launch"] = serde_json::json!({"created_suspended":true,"job_assigned_before_resume":true,"membership_verified":true});
    result["policy"] =
        serde_json::json!({"configured":"policy","queried":"policy","effective_verified":true});
    result["termination"] = serde_json::json!({"method":"terminate_job_object","requested":true,"raw_os_error":null,"requested_exit_code":7});
    result["exit"] = serde_json::json!({"worker_exit_code":7,"worker_wait_completed":true,"tree_wait_completed":true,"child_exit_code":null,"child_wait_completed":false});
    result["duration_ms"] = if scenario == "wall_clock_timeout" {
        10_305
    } else {
        305
    }
    .into();
    result["process_count"] = serde_json::json!({"active_before":1,"active_after":0});
    result["stop_to_reap_ms"] = 5.into();
    result["kill_to_reap_ms"] = 4.into();
    result["reap"] = serde_json::json!({"stop_to_reap_ms":5,"kill_to_reap_ms":4,"deadline_ms":2000,"tree_wait_completed":true,"all_handles_closed":true,"job_handle_closed":true});
    result["rss_enforced"] = true.into();
    result["timing"] = if scenario == "wall_clock_timeout" {
        serde_json::json!({"overall_deadline_ms":25000,"setup_deadline_ms":3000,"handshake_deadline_ms":13000,
            "work_deadline_ms":10300,"cleanup_deadline_ms":12300,
            "resume_ms":100,"ready_ms":200,"observation_ms":300,"scheduled_stop_ms":10300,
            "termination_call_ms":10301,"worker_wait_ms":10302,"tree_wait_ms":10303,
            "empty_job_ms":10304,"all_handles_closed_ms":10305})
    } else {
        serde_json::json!({"overall_deadline_ms":25000,"setup_deadline_ms":3000,"handshake_deadline_ms":13000,
            "work_deadline_ms":null,"cleanup_deadline_ms":2300,
            "resume_ms":100,"ready_ms":200,"observation_ms":300,"scheduled_stop_ms":300,
            "termination_call_ms":301,"worker_wait_ms":302,"tree_wait_ms":303,
            "empty_job_ms":304,"all_handles_closed_ms":305})
    };
    report
}

#[test]
fn new_scenario_passes_require_typed_timing_and_cleanup_evidence() {
    let mut apparent = apparent_pass_report("memory_bomb");
    apparent["scenarios"]
        .as_array_mut()
        .unwrap()
        .iter_mut()
        .find(|result| result["scenario"] == "memory_bomb")
        .unwrap()["timing"] = serde_json::Value::Null;
    let report: ProbeReport = serde_json::from_value(apparent).unwrap();
    assert!(
        report.validate().is_err(),
        "legacy-shaped pass without timing must fail closed"
    );
}

#[test]
fn complete_windows_cpu_pass_is_prohibited_without_approved_calibration_contract() {
    let report: ProbeReport = serde_json::from_value(apparent_pass_report("cpu_loop")).unwrap();
    assert_eq!(report.os, "windows");
    assert!(
        report.validate().is_err(),
        "complete-looking Windows CPU evidence cannot pass this tranche"
    );
}

#[test]
fn new_pass_timing_and_reap_summaries_are_consistent_with_final_closure() {
    for (path, value) in [
        ("timing.scheduled_stop_ms", serde_json::json!(299)),
        ("duration_ms", serde_json::json!(304)),
        ("duration_ms", serde_json::json!(25_001)),
        ("stop_to_reap_ms", serde_json::json!(4)),
        ("kill_to_reap_ms", serde_json::json!(3)),
        ("reap.stop_to_reap_ms", serde_json::json!(4)),
        ("reap.kill_to_reap_ms", serde_json::json!(3)),
    ] {
        let mut invalid = apparent_pass_report("memory_bomb");
        let result = invalid["scenarios"]
            .as_array_mut()
            .unwrap()
            .iter_mut()
            .find(|result| result["scenario"] == "memory_bomb")
            .unwrap();
        let keys = path.split('.').collect::<Vec<_>>();
        let mut cursor = &mut *result;
        for key in &keys[..keys.len() - 1] {
            cursor = &mut cursor[*key];
        }
        cursor[keys[keys.len() - 1]] = value;
        if path == "timing.scheduled_stop_ms" {
            result["timing"]["cleanup_deadline_ms"] = 2_299.into();
            result["stop_to_reap_ms"] = 6.into();
            result["reap"]["stop_to_reap_ms"] = 6.into();
        }
        let report: ProbeReport = serde_json::from_value(invalid).unwrap();
        assert!(report.validate().is_err(), "inconsistent {path} must fail");
    }
}

#[test]
fn telemetry_cannot_substitute_for_hard_handle_enforcement() {
    let mut apparent = apparent_pass_report("handle_limit");
    let result = apparent["scenarios"]
        .as_array_mut()
        .unwrap()
        .iter_mut()
        .find(|result| result["scenario"] == "handle_limit")
        .unwrap();
    result["resource_telemetry"] =
        serde_json::json!({"observed_handle_count":100,"opened_handles":100});
    let report: ProbeReport = serde_json::from_value(apparent).unwrap();
    assert!(
        report.validate().is_err(),
        "handle telemetry is not a hard quota"
    );
}

#[test]
fn process_limit_requires_correlated_pretermination_attribution() {
    let apparent = apparent_pass_report("process_limit");
    let report: ProbeReport = serde_json::from_value(apparent).unwrap();
    assert!(
        report.validate().is_err(),
        "generic spawn success or failure evidence cannot pass process limit"
    );
}

#[test]
fn complete_process_limit_attribution_is_representable_without_weak_substitutes() {
    let mut apparent = apparent_pass_report("process_limit");
    let result = apparent["scenarios"]
        .as_array_mut()
        .unwrap()
        .iter_mut()
        .find(|result| result["scenario"] == "process_limit")
        .unwrap();
    result["timing"] = serde_json::json!({
        "overall_deadline_ms":25000,"setup_deadline_ms":3000,"handshake_deadline_ms":13000,
        "work_deadline_ms":null,"cleanup_deadline_ms":2300,
        "resume_ms":100,"ready_ms":200,"observation_ms":300,"scheduled_stop_ms":300,
        "termination_call_ms":301,"worker_wait_ms":302,"tree_wait_ms":303,
        "empty_job_ms":304,"all_handles_closed_ms":305
    });
    result["process_limit"] = serde_json::json!({
        "configured_active_process_limit":1,"queried_active_process_limit":1,
        "fresh_job":true,
        "completion_port_associated":true,"completion_key_matches":true,
        "active_process_limit_event_observed":true,"null_overlapped_confirmed":true,
        "spawn_attempt_count":1,"spawn_attempted":true,"spawn_succeeded":false,
        "reported_spawn_os_error":5,"total_terminated_before_attempt":0,
        "total_terminated_after_attempt_before_termination":1,
        "active_before_attempt":1,"active_after_attempt_before_termination":1,
        "stable_root_only_membership":true,"active_member_samples":[1,1],
        "pre_execution_denial_semantics_proven_applicable":true,"ancestor_job_policy_resolved":true
    });
    let mut no_error_code = apparent.clone();
    no_error_code["scenarios"]
        .as_array_mut()
        .unwrap()
        .iter_mut()
        .find(|result| result["scenario"] == "process_limit")
        .unwrap()["process_limit"]["reported_spawn_os_error"] = serde_json::Value::Null;
    let report: ProbeReport = serde_json::from_value(no_error_code).unwrap();
    assert!(
        report.validate().is_ok(),
        "missing raw spawn error code must not reject complete attribution"
    );
    let report: ProbeReport = serde_json::from_value(apparent).unwrap();
    assert!(report.validate().is_ok());
}

#[test]
fn typed_deadline_cutoffs_and_error_categories_are_fail_closed() {
    let mut too_late = apparent_pass_report("memory_bomb");
    let result = too_late["scenarios"]
        .as_array_mut()
        .unwrap()
        .iter_mut()
        .find(|result| result["scenario"] == "memory_bomb")
        .unwrap();
    result["timing"] = serde_json::json!({
        "overall_deadline_ms":25000,"setup_deadline_ms":3000,"handshake_deadline_ms":13000,
        "work_deadline_ms":null,"cleanup_deadline_ms":5200,
        "resume_ms":3001,"ready_ms":3100,"observation_ms":3200,"scheduled_stop_ms":3200,
        "termination_call_ms":3201,"worker_wait_ms":3202,"tree_wait_ms":3203,
        "empty_job_ms":3204,"all_handles_closed_ms":3205
    });
    let report: ProbeReport = serde_json::from_value(too_late.clone()).unwrap();
    assert!(
        report.validate().is_err(),
        "resume after setup cutoff must fail"
    );

    for (field, value) in [
        ("ready_ms", 13_001),
        ("observation_ms", 13_001),
        ("worker_wait_ms", 2_301),
        ("all_handles_closed_ms", 25_001),
    ] {
        let mut out_of_budget = apparent_pass_report("memory_bomb");
        let result = out_of_budget["scenarios"]
            .as_array_mut()
            .unwrap()
            .iter_mut()
            .find(|result| result["scenario"] == "memory_bomb")
            .unwrap();
        result["timing"] = serde_json::json!({
            "overall_deadline_ms":25000,"setup_deadline_ms":3000,"handshake_deadline_ms":13000,
            "work_deadline_ms":null,"cleanup_deadline_ms":2300,
            "resume_ms":100,"ready_ms":200,"observation_ms":300,"scheduled_stop_ms":300,
            "termination_call_ms":301,"worker_wait_ms":302,"tree_wait_ms":303,
            "empty_job_ms":304,"all_handles_closed_ms":305
        });
        result["timing"][field] = value.into();
        let report: ProbeReport = serde_json::from_value(out_of_budget).unwrap();
        assert!(
            report.validate().is_err(),
            "{field} outside its cutoff must fail"
        );
    }

    let mut good_timing = too_late;
    let result = good_timing["scenarios"]
        .as_array_mut()
        .unwrap()
        .iter_mut()
        .find(|result| result["scenario"] == "memory_bomb")
        .unwrap();
    result["timing"] = serde_json::json!({
        "overall_deadline_ms":25000,"setup_deadline_ms":3000,"handshake_deadline_ms":13000,
        "work_deadline_ms":null,"cleanup_deadline_ms":2300,
        "resume_ms":100,"ready_ms":200,"observation_ms":300,"scheduled_stop_ms":300,
        "termination_call_ms":301,"worker_wait_ms":302,"tree_wait_ms":303,
        "empty_job_ms":304,"all_handles_closed_ms":305
    });
    result["initiating_operation_error"] =
        serde_json::json!({"stage":"resume_thread","reported_os_error":5});
    result["cleanup_errors"] = serde_json::json!([{"stage":"close_handle","reported_os_error":6}]);
    let encoded = serde_json::to_string(&good_timing).unwrap();
    assert!(encoded.contains("initiating_operation_error"));
    assert!(encoded.contains("cleanup_errors"));
    let report: ProbeReport = serde_json::from_value(good_timing).unwrap();
    assert!(
        report.validate().is_err(),
        "cleanup failure or initiating failure prevents pass"
    );
}

#[test]
fn wall_clock_stop_must_be_the_matched_observation_deadline() {
    let mut apparent = apparent_pass_report("wall_clock_timeout");
    let result = apparent["scenarios"]
        .as_array_mut()
        .unwrap()
        .iter_mut()
        .find(|result| result["scenario"] == "wall_clock_timeout")
        .unwrap();
    result["timing"] = serde_json::json!({
        "overall_deadline_ms":25000,"setup_deadline_ms":3000,"handshake_deadline_ms":13000,
        "work_deadline_ms":10300,"cleanup_deadline_ms":12300,
        "resume_ms":100,"ready_ms":200,"observation_ms":300,"scheduled_stop_ms":10300,
        "termination_call_ms":10301,"worker_wait_ms":10302,"tree_wait_ms":10303,
        "empty_job_ms":10304,"all_handles_closed_ms":10305
    });
    let report: ProbeReport = serde_json::from_value(apparent.clone()).unwrap();
    assert!(
        report.validate().is_ok(),
        "scheduled deadline from matched observation should validate"
    );
    apparent["scenarios"]
        .as_array_mut()
        .unwrap()
        .iter_mut()
        .find(|result| result["scenario"] == "wall_clock_timeout")
        .unwrap()["timing"]["scheduled_stop_ms"] = 10301.into();
    let report: ProbeReport = serde_json::from_value(apparent).unwrap();
    assert!(
        report.validate().is_err(),
        "late watchdog time must not replace scheduled stop"
    );
}

fn tree_pass_report(scenario: &str) -> serde_json::Value {
    let mut report = apparent_pass_report(scenario);
    let result = report["scenarios"]
        .as_array_mut()
        .unwrap()
        .iter_mut()
        .find(|result| result["scenario"] == scenario)
        .unwrap();
    result["process_count"] = serde_json::json!({"active_before":2,"active_after":0});
    result["exit"] = serde_json::json!({
        "worker_exit_code":7,"worker_wait_completed":true,"tree_wait_completed":true,
        "child_exit_code":7,"child_wait_completed":true
    });
    result["child"] = serde_json::json!({
        "ready":true,"pid":1235,"root_pid":1234,"membership_verified":true,
        "process_handle_retained":true
    });
    result["timing"] = serde_json::json!({
        "overall_deadline_ms":25000,"setup_deadline_ms":3000,"handshake_deadline_ms":13000,
        "work_deadline_ms":null,"cleanup_deadline_ms":2300,
        "resume_ms":100,"ready_ms":200,"observation_ms":300,"scheduled_stop_ms":300,
        "termination_call_ms":301,"worker_wait_ms":302,"tree_wait_ms":303,
        "child_ready_ms":300,"empty_job_ms":304,"all_handles_closed_ms":305
    });
    result["reap"]["stop_to_reap_ms"] = 5.into();
    result["reap"]["kill_to_reap_ms"] = 4.into();
    report
}

#[test]
fn hard_kill_and_reap_deadline_require_strict_two_process_tree_cleanup() {
    for scenario in ["hard_kill", "reap_deadline"] {
        let valid = tree_pass_report(scenario);
        let report: ProbeReport = serde_json::from_value(valid.clone()).unwrap();
        assert!(
            report.validate().is_ok(),
            "complete {scenario} tree evidence should validate"
        );

        for ready_time in [None, Some(299), Some(13_001), Some(301)] {
            let mut invalid = valid.clone();
            let result = invalid["scenarios"]
                .as_array_mut()
                .unwrap()
                .iter_mut()
                .find(|result| result["scenario"] == scenario)
                .unwrap();
            result["timing"]["child_ready_ms"] =
                ready_time.map_or(serde_json::Value::Null, serde_json::Value::from);
            let report: ProbeReport = serde_json::from_value(invalid).unwrap();
            assert!(
                report.validate().is_err(),
                "{scenario} child-ready timestamp {ready_time:?} must fail"
            );
        }

        let mut missing_timing = valid.clone();
        missing_timing["scenarios"]
            .as_array_mut()
            .unwrap()
            .iter_mut()
            .find(|result| result["scenario"] == scenario)
            .unwrap()["timing"] = serde_json::Value::Null;
        let report: ProbeReport = serde_json::from_value(missing_timing).unwrap();
        assert!(
            report.validate().is_err(),
            "{scenario} without timing must fail"
        );

        for field in ["stop_to_reap_ms", "kill_to_reap_ms"] {
            let mut mismatch = valid.clone();
            let result = mismatch["scenarios"]
                .as_array_mut()
                .unwrap()
                .iter_mut()
                .find(|result| result["scenario"] == scenario)
                .unwrap();
            result[field] = 2.into();
            let report: ProbeReport = serde_json::from_value(mismatch).unwrap();
            assert!(
                report.validate().is_err(),
                "{scenario} top-level {field} must match nested reap evidence"
            );
        }

        for (path, value) in [
            ("child.ready", serde_json::json!(false)),
            ("child.pid", serde_json::json!(1234)),
            ("child.membership_verified", serde_json::json!(false)),
            ("child.process_handle_retained", serde_json::json!(false)),
            ("exit.child_wait_completed", serde_json::json!(false)),
            ("exit.child_exit_code", serde_json::json!(8)),
            ("process_count.active_before", serde_json::json!(1)),
        ] {
            let mut invalid = valid.clone();
            let result = invalid["scenarios"]
                .as_array_mut()
                .unwrap()
                .iter_mut()
                .find(|result| result["scenario"] == scenario)
                .unwrap();
            let mut cursor = &mut *result;
            let keys = path.split('.').collect::<Vec<_>>();
            for key in &keys[..keys.len() - 1] {
                cursor = &mut cursor[*key];
            }
            cursor[keys[keys.len() - 1]] = value;
            let report: ProbeReport = serde_json::from_value(invalid).unwrap();
            assert!(report.validate().is_err(), "{scenario} must reject {path}");
        }
    }
}

#[test]
fn new_passes_require_exact_serialized_deadline_cutoffs() {
    let mut missing = apparent_pass_report("memory_bomb");
    let result = missing["scenarios"]
        .as_array_mut()
        .unwrap()
        .iter_mut()
        .find(|result| result["scenario"] == "memory_bomb")
        .unwrap();
    result["timing"] = serde_json::json!({
        "resume_ms":100,"ready_ms":200,"observation_ms":300,"scheduled_stop_ms":300,
        "termination_call_ms":301,"worker_wait_ms":302,"tree_wait_ms":303,
        "empty_job_ms":304,"all_handles_closed_ms":305
    });
    let report: ProbeReport = serde_json::from_value(missing.clone()).unwrap();
    assert!(
        report.validate().is_err(),
        "missing cutoff fields must fail"
    );
    let result = missing["scenarios"]
        .as_array_mut()
        .unwrap()
        .iter_mut()
        .find(|result| result["scenario"] == "memory_bomb")
        .unwrap();
    result["timing"]["overall_deadline_ms"] = 24_999.into();
    result["timing"]["setup_deadline_ms"] = 3_000.into();
    result["timing"]["handshake_deadline_ms"] = 13_000.into();
    result["timing"]["cleanup_deadline_ms"] = 2_300.into();
    let report: ProbeReport = serde_json::from_value(missing).unwrap();
    assert!(
        report.validate().is_err(),
        "non-approved overall cutoff must fail"
    );
}

#[test]
fn process_limit_requires_pretermination_total_termination_accounting() {
    let mut no_increase = apparent_pass_report("process_limit");
    let result = no_increase["scenarios"]
        .as_array_mut()
        .unwrap()
        .iter_mut()
        .find(|result| result["scenario"] == "process_limit")
        .unwrap();
    result["timing"] = serde_json::json!({
        "overall_deadline_ms":25000,"setup_deadline_ms":3000,"handshake_deadline_ms":13000,
        "work_deadline_ms":null,"cleanup_deadline_ms":2300,
        "resume_ms":100,"ready_ms":200,"observation_ms":300,"scheduled_stop_ms":300,
        "termination_call_ms":301,"worker_wait_ms":302,"tree_wait_ms":303,
        "empty_job_ms":304,"all_handles_closed_ms":305
    });
    result["process_limit"] = serde_json::json!({
        "configured_active_process_limit":1,"queried_active_process_limit":1,"fresh_job":true,
        "completion_port_associated":true,"completion_key_matches":true,
        "active_process_limit_event_observed":true,"null_overlapped_confirmed":true,
        "spawn_attempt_count":1,"spawn_attempted":true,"spawn_succeeded":false,
        "reported_spawn_os_error":5,"total_terminated_before_attempt":0,
        "total_terminated_after_attempt_before_termination":0,
        "active_before_attempt":1,"active_after_attempt_before_termination":1,
        "stable_root_only_membership":true,"active_member_samples":[1,1],
        "pre_execution_denial_semantics_proven_applicable":true,"ancestor_job_policy_resolved":true
    });
    let report: ProbeReport = serde_json::from_value(no_increase.clone()).unwrap();
    assert!(
        report.validate().is_err(),
        "no increase in terminated-process accounting must fail"
    );

    no_increase["scenarios"]
        .as_array_mut()
        .unwrap()
        .iter_mut()
        .find(|result| result["scenario"] == "process_limit")
        .unwrap()["process_limit"]["total_terminated_after_attempt_before_termination"] = 1.into();
    let report: ProbeReport = serde_json::from_value(no_increase.clone()).unwrap();
    assert!(
        report.validate().is_ok(),
        "complete accounting and correlation evidence should validate"
    );

    let mut only_error = apparent_pass_report("process_limit");
    let result = only_error["scenarios"]
        .as_array_mut()
        .unwrap()
        .iter_mut()
        .find(|result| result["scenario"] == "process_limit")
        .unwrap();
    result["process_limit"] = serde_json::json!({"reported_spawn_os_error":5});
    let report: ProbeReport = serde_json::from_value(only_error).unwrap();
    assert!(
        report.validate().is_err(),
        "a reported spawn error alone is not quota attribution"
    );
    assert_eq!(
        no_increase["scenarios"]
            .as_array()
            .unwrap()
            .iter()
            .find(|result| result["scenario"] == "process_limit")
            .unwrap()["process_limit"]["reported_spawn_os_error"],
        5
    );
}

#[test]
fn scenario_report_requires_exactly_eight_unique_scenarios_and_validates_pass_evidence() {
    use plugin_sandbox_probe::report::{
        CaseTiming, ChallengeEvidence, ChildEvidence, EnforcementState, ExitEvidence,
        LaunchEvidence, PolicyEvidence, ProbeScenario, ProcessCountEvidence, ReapEvidence,
        ScenarioResult, ScenarioStatus, TerminationEvidence,
    };

    let base = ProbeReport::not_tested("windows", "x86_64");
    let mut missing = base.clone();
    missing.scenarios.clear();
    assert!(
        missing.validate().is_err(),
        "missing scenario results must fail"
    );

    let all_not_tested = ProbeScenario::ALL
        .into_iter()
        .map(ScenarioResult::not_tested)
        .collect::<Vec<_>>();
    let mut complete = base.clone();
    complete.scenarios = all_not_tested;
    complete.scenarios[0] = ScenarioResult::not_tested(ProbeScenario::MemoryBomb);
    complete.scenarios[1] = ScenarioResult::not_tested(ProbeScenario::CpuLoop);
    assert!(complete.validate().is_ok());

    let mut duplicate = complete.clone();
    duplicate.scenarios[1].scenario = duplicate.scenarios[0].scenario;
    assert!(
        duplicate.validate().is_err(),
        "duplicate scenario must fail"
    );

    let mut false_pass = ScenarioResult::not_tested(ProbeScenario::MemoryBomb);
    false_pass.status = ScenarioStatus::Passed;
    false_pass.mechanism = Some("verified diagnostic mechanism".into());
    false_pass.effective_policy_verified = true;
    false_pass.enforcement = EnforcementState::Verified;
    false_pass.challenge_observed = true;
    false_pass.independent_evidence = Some("parent accounting".into());
    false_pass.enforcement_attributed = true;
    false_pass.worker_terminated = true;
    false_pass.job_empty = true;
    false_pass.worker_wait_completed = true;
    false_pass.tree_wait_completed = true;
    false_pass.stop_to_reap_ms = Some(5);
    false_pass.kill_to_reap_ms = Some(4);
    false_pass.rss_enforced = true;
    false_pass.launch = Some(LaunchEvidence {
        created_suspended: true,
        job_assigned_before_resume: true,
        membership_verified: true,
    });
    false_pass.policy = Some(PolicyEvidence {
        configured: Some("job policy".into()),
        queried: Some("job policy".into()),
        effective_verified: true,
    });
    false_pass.challenge = Some(ChallengeEvidence {
        kind: "fixed challenge".into(),
        observed: true,
        detail: None,
    });
    false_pass.termination = Some(TerminationEvidence {
        method: "terminate_job_object".into(),
        requested: true,
        raw_os_error: None,
        requested_exit_code: Some(1),
    });
    false_pass.exit = Some(ExitEvidence {
        worker_exit_code: Some(1),
        worker_wait_completed: true,
        tree_wait_completed: true,
        child_exit_code: None,
        child_wait_completed: false,
    });
    false_pass.duration_ms = Some(35);
    false_pass.process_count = Some(ProcessCountEvidence {
        active_before: Some(1),
        active_after: Some(0),
    });
    false_pass.reap = Some(ReapEvidence {
        stop_to_reap_ms: Some(5),
        kill_to_reap_ms: Some(4),
        deadline_ms: 2_000,
        tree_wait_completed: true,
        all_handles_closed: true,
        job_handle_closed: true,
    });
    false_pass.timing = Some(CaseTiming {
        overall_deadline_ms: Some(25_000),
        setup_deadline_ms: Some(3_000),
        handshake_deadline_ms: Some(13_000),
        work_deadline_ms: None,
        cleanup_deadline_ms: Some(2_030),
        child_ready_ms: None,
        resume_ms: Some(10),
        ready_ms: Some(20),
        observation_ms: Some(30),
        scheduled_stop_ms: Some(30),
        termination_call_ms: Some(31),
        worker_wait_ms: Some(32),
        tree_wait_ms: Some(33),
        empty_job_ms: Some(34),
        all_handles_closed_ms: Some(35),
    });
    let mut invalid = complete.clone();
    let mut missing_enforcement = false_pass.clone();
    missing_enforcement.enforcement = EnforcementState::Configured;
    invalid.scenarios[0] = missing_enforcement;
    assert!(
        invalid.validate().is_err(),
        "unverified enforcement must not pass"
    );
    let mut missing_challenge = false_pass.clone();
    missing_challenge.challenge_observed = false;
    invalid.scenarios[0] = missing_challenge;
    assert!(
        invalid.validate().is_err(),
        "unobserved challenge must not pass"
    );
    let mut missing_reap = false_pass.clone();
    missing_reap.kill_to_reap_ms = None;
    invalid.scenarios[0] = missing_reap;
    assert!(
        invalid.validate().is_err(),
        "missing reap timing must not pass"
    );
    let mut missing_stop_reap = false_pass.clone();
    missing_stop_reap.stop_to_reap_ms = None;
    invalid.scenarios[0] = missing_stop_reap;
    assert!(
        invalid.validate().is_err(),
        "missing stop-to-reap timing must not pass"
    );
    let mut missing_launch = false_pass.clone();
    missing_launch.launch = None;
    invalid.scenarios[0] = missing_launch;
    assert!(
        invalid.validate().is_err(),
        "a pass must prove suspended launch and Job membership"
    );
    invalid.scenarios[0] = false_pass.clone();
    assert!(
        invalid.validate().is_ok(),
        "valid synthetic memory pass rejected: {:?}",
        invalid.validate()
    );

    let mut child_tree_without_child_evidence = invalid.clone();
    child_tree_without_child_evidence.scenarios[0].scenario = ProbeScenario::ChildProcessTree;
    child_tree_without_child_evidence.scenarios[1] =
        ScenarioResult::not_tested(ProbeScenario::MemoryBomb);
    child_tree_without_child_evidence.scenarios[3].scenario = ProbeScenario::CpuLoop;
    assert!(
        child_tree_without_child_evidence.validate().is_err(),
        "child-tree pass without identified child readiness, membership, exit, and cleanup evidence must fail"
    );

    let mut valid_child = false_pass.clone();
    valid_child.scenario = ProbeScenario::ChildProcessTree;
    valid_child.required_policy = "25% of one logical core hard Job CPU rate".into();
    valid_child.rss_enforced = false;
    valid_child.stop_to_reap_ms = Some(1);
    valid_child.kill_to_reap_ms = Some(1);
    valid_child.duration_ms = Some(1);
    valid_child.reap.as_mut().unwrap().stop_to_reap_ms = Some(1);
    valid_child.reap.as_mut().unwrap().kill_to_reap_ms = Some(1);
    valid_child
        .termination
        .as_mut()
        .unwrap()
        .requested_exit_code = Some(0xE001);
    valid_child.exit.as_mut().unwrap().worker_exit_code = Some(0xE001);
    valid_child.exit.as_mut().unwrap().child_exit_code = Some(0xE001);
    valid_child.exit.as_mut().unwrap().child_wait_completed = true;
    valid_child.process_count.as_mut().unwrap().active_before = Some(2);
    valid_child.child = Some(ChildEvidence {
        ready: true,
        pid: Some(1234),
        root_pid: Some(1233),
        membership_verified: true,
        process_handle_retained: true,
    });
    valid_child.reap.as_mut().unwrap().all_handles_closed = true;
    valid_child.reap.as_mut().unwrap().job_handle_closed = true;
    let mut valid_child_report = complete.clone();
    valid_child_report.scenarios[0] = valid_child.clone();
    valid_child_report.scenarios[1] = ScenarioResult::not_tested(ProbeScenario::MemoryBomb);
    valid_child_report.scenarios[3] = ScenarioResult::not_tested(ProbeScenario::CpuLoop);
    assert!(valid_child_report.validate().is_ok());

    let mut bad_child = valid_child_report.clone();
    bad_child.scenarios[0].child.as_mut().unwrap().ready = false;
    assert!(
        bad_child.validate().is_err(),
        "child readiness is mandatory"
    );
    let mut bad_child = valid_child_report.clone();
    bad_child.scenarios[0].child.as_mut().unwrap().root_pid = Some(1234);
    assert!(
        bad_child.validate().is_err(),
        "child PID must differ from root PID"
    );
    let mut bad_child = valid_child_report.clone();
    bad_child.scenarios[0].child.as_mut().unwrap().root_pid = None;
    assert!(
        bad_child.validate().is_err(),
        "root PID is required for child identity"
    );
    let mut bad_child = valid_child_report.clone();
    bad_child.scenarios[0]
        .child
        .as_mut()
        .unwrap()
        .membership_verified = false;
    assert!(
        bad_child.validate().is_err(),
        "child Job membership is mandatory"
    );
    let mut bad_child = valid_child_report.clone();
    bad_child.scenarios[0]
        .process_count
        .as_mut()
        .unwrap()
        .active_before = Some(1);
    assert!(
        bad_child.validate().is_err(),
        "root and child must be active before termination"
    );
    let mut bad_child = valid_child_report.clone();
    bad_child.scenarios[0]
        .process_count
        .as_mut()
        .unwrap()
        .active_before = Some(3);
    assert!(
        bad_child.validate().is_err(),
        "child-tree identity requires exactly root and child in the Job"
    );
    let mut bad_child = valid_child_report.clone();
    bad_child.scenarios[0]
        .exit
        .as_mut()
        .unwrap()
        .child_wait_completed = false;
    assert!(
        bad_child.validate().is_err(),
        "child process wait is mandatory"
    );
    let mut bad_child = valid_child_report.clone();
    bad_child.scenarios[0]
        .exit
        .as_mut()
        .unwrap()
        .child_exit_code = Some(1);
    assert!(
        bad_child.validate().is_err(),
        "both exit codes must match requested termination"
    );
    let mut bad_child = valid_child_report.clone();
    bad_child.scenarios[0]
        .reap
        .as_mut()
        .unwrap()
        .all_handles_closed = false;
    assert!(
        bad_child.validate().is_err(),
        "all handle closes must be confirmed"
    );
    let mut bad_child = valid_child_report.clone();
    bad_child.scenarios[0]
        .reap
        .as_mut()
        .unwrap()
        .job_handle_closed = false;
    assert!(
        bad_child.validate().is_err(),
        "Job handle close must be confirmed"
    );
    let mut bad_child = valid_child_report.clone();
    bad_child.scenarios[0].reap.as_mut().unwrap().deadline_ms = 2_001;
    assert!(
        bad_child.validate().is_err(),
        "reap deadline must not exceed two seconds"
    );
    let mut bad_child = valid_child_report.clone();
    bad_child.scenarios[0]
        .reap
        .as_mut()
        .unwrap()
        .kill_to_reap_ms = Some(2);
    assert!(
        bad_child.validate().is_err(),
        "top-level and nested timings must agree"
    );
    let mut bad_child = valid_child_report.clone();
    bad_child.scenarios[0]
        .termination
        .as_mut()
        .unwrap()
        .raw_os_error = Some(5);
    assert!(
        bad_child.validate().is_err(),
        "successful requested termination cannot report OS error"
    );
    let mut bad_child = valid_child_report.clone();
    bad_child.scenarios[0].termination.as_mut().unwrap().method = "kill_on_close".into();
    assert!(
        bad_child.validate().is_err(),
        "child-tree pass must attribute termination to TerminateJobObject"
    );
    let mut bad_child = valid_child_report.clone();
    bad_child.scenarios[0]
        .termination
        .as_mut()
        .unwrap()
        .requested_exit_code = Some(7);
    assert!(
        bad_child.validate().is_err(),
        "root and child exits must match requested code"
    );
    let mut bad_child = valid_child_report.clone();
    bad_child.scenarios[0].mechanism = Some("  ".into());
    assert!(
        bad_child.validate().is_err(),
        "mechanism evidence cannot be empty"
    );
    let mut bad_child = valid_child_report.clone();
    bad_child.scenarios[0].independent_evidence = Some(String::new());
    assert!(
        bad_child.validate().is_err(),
        "independent evidence cannot be empty"
    );
    let mut bad_child = valid_child_report.clone();
    bad_child.scenarios[0]
        .process_count
        .as_mut()
        .unwrap()
        .active_after = Some(1);
    assert!(
        bad_child.validate().is_err(),
        "Job must be empty after cleanup"
    );
    let mut bad_child = valid_child_report.clone();
    bad_child.scenarios[0]
        .exit
        .as_mut()
        .unwrap()
        .worker_wait_completed = false;
    assert!(
        bad_child.validate().is_err(),
        "root process wait is mandatory"
    );

    let mut memory_pass = invalid.clone();
    memory_pass.scenarios[0] = ScenarioResult::not_tested(ProbeScenario::CpuLoop);
    memory_pass.scenarios[1] = ScenarioResult::not_tested(ProbeScenario::MemoryBomb);
    let mut memory = false_pass.clone();
    memory.rss_enforced = false;
    memory_pass.scenarios[1] = memory;
    assert!(
        memory_pass.validate().is_err(),
        "Job commit alone is not RSS enforcement"
    );
}
