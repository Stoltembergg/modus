use modus_decision_runtime::{inference::Engine, service};
use std::{io, path::Path};
fn run() -> Result<(), &'static str> {
    if !cfg!(all(target_os = "linux", target_arch = "x86_64")) {
        return Err("platform_unvalidated");
    }
    let args: Vec<String> = std::env::args().collect();
    if args.len() != 7
        || args[1] != "--manifest"
        || args[3] != "--manifest-sha256"
        || args[5] != "--generation"
    {
        return Err("arguments");
    }
    if args[6].is_empty()
        || args[6].len() > 128
        || !args[6]
            .bytes()
            .all(|b| b.is_ascii_alphanumeric() || b"-_".contains(&b))
    {
        return Err("generation");
    }
    let mut engine = Engine::load(Path::new(&args[2]), &args[4]).map_err(|_| "artifact_load")?;
    service::serve(
        io::stdin().lock(),
        io::stdout(),
        &args[6],
        &args[4],
        move |input, options| engine.observe(input, options),
    )
    .map_err(|_| "runtime_protocol")
}
fn main() {
    if let Err(code) = run() {
        eprintln!("decision_runtime:{code}");
        std::process::exit(1);
    }
}
