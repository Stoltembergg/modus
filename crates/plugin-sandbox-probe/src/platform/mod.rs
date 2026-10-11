#[cfg(target_os = "linux")]
mod linux;
#[cfg(target_os = "windows")]
mod windows;
#[cfg(target_os = "windows")]
mod windows_runtime;
#[cfg(target_os = "windows")]
mod windows_supervisor;

#[cfg(target_os = "linux")]
pub use linux::run_probe;
#[cfg(target_os = "windows")]
pub use windows::run_probe;

#[cfg(not(any(target_os = "windows", target_os = "linux")))]
pub fn run_probe() -> Result<crate::report::ProbeReport, String> {
    Err(format!(
        "unsupported probe host OS: {}",
        std::env::consts::OS
    ))
}
