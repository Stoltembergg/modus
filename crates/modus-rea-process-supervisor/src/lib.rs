pub const NPX_ARGS: [&str; 3] = ["-y", "rea-agents@6.5.0", "mcp"];

#[cfg(windows)]
pub mod platform {
    pub mod windows;
}
