use std::io::{self, BufReader, BufWriter};

use modus_plugin_execution_supervisor::serve_supervisor;

fn main() {
    let stdin = io::stdin();
    let stdout = io::stdout();
    if serve_supervisor(BufReader::new(stdin.lock()), BufWriter::new(stdout.lock())).is_err() {
        std::process::exit(2);
    }
}
