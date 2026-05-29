pub fn crate_ready() -> bool {
    true
}

#[cfg(test)]
mod tests {
    use super::crate_ready;

    #[test]
    fn crate_is_ready() {
        assert!(crate_ready());
    }
}
