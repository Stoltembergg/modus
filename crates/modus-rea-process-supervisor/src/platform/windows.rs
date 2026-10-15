use std::io;

/// Quote one argument using the Windows C runtime command-line escaping rules.
pub fn quote_windows_arg(value: &str) -> String {
    if !value.is_empty() && !value.chars().any(|c| c.is_whitespace() || c == '"') {
        return value.to_owned();
    }
    let mut out = String::from("\"");
    let mut slashes = 0;
    for ch in value.chars() {
        match ch {
            '\\' => slashes += 1,
            '"' => {
                out.push_str(&"\\".repeat(slashes * 2 + 1));
                out.push('"');
                slashes = 0;
            }
            _ => {
                out.push_str(&"\\".repeat(slashes));
                slashes = 0;
                out.push(ch);
            }
        }
    }
    out.push_str(&"\\".repeat(slashes * 2));
    out.push('"');
    out
}

/// `ResumeThread` returns `u32::MAX` when the API call fails.
pub fn resume_thread_result(previous_suspend_count: u32) -> io::Result<()> {
    if previous_suspend_count == u32::MAX {
        Err(io::Error::last_os_error())
    } else {
        Ok(())
    }
}

#[cfg(test)]
mod tests {
    #[test]
    fn resume_thread_api_failure_is_reported() {
        assert!(super::resume_thread_result(u32::MAX).is_err());
    }
}
