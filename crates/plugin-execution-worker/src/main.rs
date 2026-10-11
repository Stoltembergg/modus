use std::io;

use modus_plugin_execution_worker::{
    BOOTSTRAP_CHALLENGE_ENV, bootstrap_error_to_io, run_bootstrap,
};

fn main() {
    let result = std::env::var(BOOTSTRAP_CHALLENGE_ENV)
        .map_err(|_| io::Error::new(io::ErrorKind::InvalidInput, "missing bootstrap challenge"))
        .and_then(|challenge| {
            run_bootstrap(io::stdin().lock(), io::stdout().lock(), &challenge)
                .map_err(bootstrap_error_to_io)
        });
    if result.is_err() {
        std::process::exit(2);
    }
}
