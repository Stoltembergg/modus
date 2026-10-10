use std::io;

fn main() {
    let args: Vec<String> = std::env::args().skip(1).collect();
    let result = match args.as_slice() {
        [mode] if mode == "--worker" => plugin_sandbox_probe::worker::run_worker_supervised(
            io::stdin().lock(),
            io::stdout().lock(),
        ),
        [mode] if mode == "--worker-child-challenge" => {
            let child = std::process::Command::new(std::env::current_exe().unwrap())
                .arg("--worker-hold")
                .arg("child_process_tree")
                .stdin(std::process::Stdio::null())
                .stdout(std::process::Stdio::inherit())
                .stderr(std::process::Stdio::null())
                .spawn();
            match child {
                Ok(_child) => loop {
                    std::hint::spin_loop();
                },
                Err(error) => Err(format!("fixed child challenge failed: {error}")),
            }
        }
        [mode, scenario] if mode == "--worker-hold" && scenario == "child_process_tree" => {
            plugin_sandbox_probe::worker::hold_child(
                plugin_sandbox_probe::report::ProbeScenario::ChildProcessTree,
            )
        }
        [mode, scenario] if mode == "--worker-hold" && scenario == "process_limit" => {
            plugin_sandbox_probe::worker::hold_child(
                plugin_sandbox_probe::report::ProbeScenario::ProcessLimit,
            )
        }
        [mode, scenario] if mode == "--worker-hold" && scenario == "hard_kill" => {
            plugin_sandbox_probe::worker::hold_child(
                plugin_sandbox_probe::report::ProbeScenario::HardKill,
            )
        }
        [mode, scenario] if mode == "--worker-hold" && scenario == "reap_deadline" => {
            plugin_sandbox_probe::worker::hold_child(
                plugin_sandbox_probe::report::ProbeScenario::ReapDeadline,
            )
        }
        [] => match plugin_sandbox_probe::platform::run_probe() {
            Ok(report) => match plugin_sandbox_probe::report::serialize_bounded(&report) {
                Ok(json) => {
                    println!("{json}");
                    Ok(())
                }
                Err(error) => Err(error),
            },
            Err(error) => Err(error),
        },
        [mode] if mode == "--probe" => match plugin_sandbox_probe::platform::run_probe() {
            Ok(report) => match plugin_sandbox_probe::report::serialize_bounded(&report) {
                Ok(json) => {
                    println!("{json}");
                    Ok(())
                }
                Err(error) => Err(error),
            },
            Err(error) => Err(error),
        },
        _ => Err("usage: plugin-sandbox-probe [--probe|--worker]".to_string()),
    };
    if let Err(error) = result {
        eprintln!("probe diagnostic error: {error}");
        std::process::exit(2);
    }
}
