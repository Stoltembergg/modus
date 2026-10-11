//! Opaque admission tokens for future platform-confined workers.
//!
//! A dispatcher must not be constructible from host provenance alone. Platform
//! adapters must first verify the complete approved policy and then mint a
//! [`ConfinementPermit`]. No production adapter currently implements that
//! contract, so external worker execution remains unavailable.
//!
//! ```compile_fail
//! use modus_plugin_execution_protocol::{Dispatcher, HostProvenance, HostTrustLevel};
//! let provenance = HostProvenance::from_host_catalog(
//!     "plugin", "1.0.0", "0".repeat(64), "catalog", HostTrustLevel::Verified,
//!     "session", "workspace", "run", 1,
//! ).unwrap();
//! let _dispatcher = Dispatcher::new("0".repeat(64), provenance, Vec::<String>::new());
//! ```
