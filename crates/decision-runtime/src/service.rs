use crate::{
    inference::Result,
    protocol::{self, Kind, ObservationInput},
};
use ort::session::RunOptions;
use serde_json::{json, Value};
use std::{
    collections::HashMap,
    io::{BufRead, Write},
    sync::{
        atomic::{AtomicBool, AtomicU8, Ordering},
        mpsc, Arc, Mutex,
    },
    thread,
    time::Duration,
};

struct Job {
    id: String,
    input: ObservationInput,
    run: RunOptions,
    reason: AtomicU8,
}
impl Job {
    fn stop(&self, reason: u8) {
        let _ = self
            .reason
            .compare_exchange(0, reason, Ordering::SeqCst, Ordering::SeqCst);
        let _ = self.run.terminate();
    }
}
fn emit<W: Write>(output: &Mutex<W>, generation: &str, mut value: Value) -> Result<()> {
    value["version"] = json!(protocol::VERSION);
    value["generation"] = json!(generation);
    let data = serde_json::to_vec(&value)?;
    if data.len() > protocol::MAX_RESPONSE_BYTES {
        return Err("response_frame".into());
    }
    let mut writer = output.lock().map_err(|_| "output_lock")?;
    writer.write_all(&data)?;
    writer.write_all(b"\n")?;
    writer.flush()?;
    Ok(())
}
/// One model owner. The reader can cancel an active ORT run while it is executing.
pub fn serve<R, W, F>(
    mut reader: R,
    writer: W,
    generation: &str,
    manifest_sha: &str,
    observe: F,
) -> Result<()>
where
    R: BufRead,
    W: Write + Send + 'static,
    F: FnMut(&ObservationInput, &RunOptions) -> Result<Value> + Send + 'static,
{
    let output = Arc::new(Mutex::new(writer));
    let pending = Arc::new(Mutex::new(HashMap::<String, Arc<Job>>::new()));
    let stopping = Arc::new(AtomicBool::new(false));
    let (sender, receiver) = mpsc::sync_channel::<Arc<Job>>(protocol::MAX_QUEUED);
    let out = output.clone();
    let jobs = pending.clone();
    let stop = stopping.clone();
    let gen = generation.to_owned();
    let worker = thread::spawn(move || -> Result<()> {
        let mut observe = observe;
        for job in receiver {
            if stop.load(Ordering::SeqCst) {
                job.stop(3);
            }
            if job.reason.load(Ordering::SeqCst) == 0 {
                emit(&out, &gen, json!({"type":"started","requestId":job.id}))?;
                let watched = job.clone();
                let (done, wait) = mpsc::channel();
                let watchdog = thread::spawn(move || {
                    if wait
                        .recv_timeout(Duration::from_secs(protocol::INFERENCE_TIMEOUT_SECS))
                        .is_err()
                    {
                        watched.stop(2);
                    }
                });
                let result = observe(&job.input, &job.run);
                let _ = done.send(());
                let _ = watchdog.join();
                let reason = job.reason.load(Ordering::SeqCst);
                let reply = match (reason, result) {
                    (0, Ok(mut value)) => {
                        value["type"] = json!("result");
                        value["requestId"] = json!(job.id);
                        value
                    }
                    (1 | 3, _) => json!({"type":"cancelled","requestId":job.id}),
                    (2, _) => json!({"type":"error","requestId":job.id,"code":"inference_timeout"}),
                    (_, Err(_)) => {
                        json!({"type":"error","requestId":job.id,"code":"observation_unavailable"})
                    }
                    _ => return Err("state".into()),
                };
                emit(&out, &gen, reply)?;
            } else {
                emit(&out, &gen, json!({"type":"cancelled","requestId":job.id}))?;
            }
            jobs.lock().map_err(|_| "pending_lock")?.remove(&job.id);
        }
        Ok(())
    });
    emit(
        &output,
        generation,
        json!({"type":"ready","manifestSha256":manifest_sha,"device":"cpu","intraOpThreads":2,"interOpThreads":1}),
    )?;
    let mut failure = None;
    loop {
        let request = match protocol::read_frame(&mut reader) {
            Ok(Some(frame)) => match protocol::parse_request(&frame, generation) {
                Ok(request) => request,
                Err(code) => {
                    failure = Some(code);
                    break;
                }
            },
            Ok(None) => break,
            Err(code) => {
                failure = Some(code);
                break;
            }
        };
        if request.kind == Kind::Shutdown {
            break;
        }
        let mut registry = pending.lock().map_err(|_| "pending_lock")?;
        if request.kind == Kind::Cancel {
            if let Some(job) = registry.get(&request.request_id) {
                job.stop(1);
            } else {
                emit(
                    &output,
                    generation,
                    json!({"type":"error","requestId":request.request_id,"code":"unknown_request"}),
                )?;
            }
            continue;
        }
        if registry.contains_key(&request.request_id) {
            failure = Some("duplicate_request");
            break;
        }
        if registry.len() >= protocol::MAX_QUEUED + 1 {
            emit(
                &output,
                generation,
                json!({"type":"error","requestId":request.request_id,"code":"queue_full"}),
            )?;
            continue;
        }
        let job = Arc::new(Job {
            id: request.request_id,
            input: request.input.ok_or("protocol_shape")?,
            run: RunOptions::new()?,
            reason: AtomicU8::new(0),
        });
        registry.insert(job.id.clone(), job.clone());
        if sender.try_send(job.clone()).is_err() {
            registry.remove(&job.id);
            emit(
                &output,
                generation,
                json!({"type":"error","requestId":job.id,"code":"queue_full"}),
            )?;
        }
    }
    stopping.store(true, Ordering::SeqCst);
    for job in pending.lock().map_err(|_| "pending_lock")?.values() {
        job.stop(3);
    }
    drop(sender);
    worker.join().map_err(|_| "worker_crash")??;
    if let Some(code) = failure {
        return Err(code.into());
    }
    emit(&output, generation, json!({"type":"stopped"}))
}
