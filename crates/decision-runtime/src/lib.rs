//! Experimental local decision inference. No plugin execution or application decision authority.
pub mod inference;
pub mod protocol;
pub mod service;

#[cfg(target_os = "linux")]
pub mod artifacts;
