use std::io::{self, Read, Write};

use modus_plugin_execution_supervisor::{
    MAX_SUPERVISOR_REQUEST_BYTES, WorkerInvocationResponse, encode_supervisor_response,
    handle_unavailable_linux_request,
};

fn main() {
    let mut input = Vec::new();
    if io::stdin()
        .take((MAX_SUPERVISOR_REQUEST_BYTES + 1) as u64)
        .read_to_end(&mut input)
        .is_err()
        || input.len() > MAX_SUPERVISOR_REQUEST_BYTES
    {
        respond(WorkerInvocationResponse::Denied {
            request_id: "invalid-request".into(),
            reason: "Supervisor request exceeded its bounded input size.".into(),
        });
        return;
    }

    match handle_unavailable_linux_request(&input) {
        Ok(response) => respond(response),
        Err(error) => respond(WorkerInvocationResponse::Denied {
            request_id: "invalid-request".into(),
            reason: format!("Supervisor rejected request: {error}"),
        }),
    }
}

fn respond(response: WorkerInvocationResponse) {
    match encode_supervisor_response(&response) {
        Ok(bytes) => {
            let mut stdout = io::stdout().lock();
            let _ = stdout.write_all(&bytes);
            let _ = stdout.write_all(b"\n");
            let _ = stdout.flush();
        }
        Err(_) => std::process::exit(2),
    }
}
