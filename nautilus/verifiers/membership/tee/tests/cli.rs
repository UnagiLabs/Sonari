use std::process::Command;

fn membership_tee() -> Command {
    Command::new(env!("CARGO_BIN_EXE_membership-tee"))
}

#[test]
fn top_level_help_exits_successfully() {
    let output = membership_tee()
        .arg("--help")
        .output()
        .expect("failed to run membership-tee --help");

    assert!(
        output.status.success(),
        "expected --help to succeed, stderr: {}",
        String::from_utf8_lossy(&output.stderr)
    );
}

#[test]
fn fixture_help_exits_successfully() {
    let output = membership_tee()
        .args(["fixture", "--help"])
        .output()
        .expect("failed to run membership-tee fixture --help");

    assert!(
        output.status.success(),
        "expected fixture --help to succeed, stderr: {}",
        String::from_utf8_lossy(&output.stderr)
    );
}

#[test]
fn production_help_exits_successfully() {
    let output = membership_tee()
        .args(["production", "--help"])
        .output()
        .expect("failed to run membership-tee production --help");

    assert!(
        output.status.success(),
        "expected production --help to succeed, stderr: {}",
        String::from_utf8_lossy(&output.stderr)
    );
}

#[test]
fn fixture_command_fails_until_implemented() {
    let output = membership_tee()
        .arg("fixture")
        .output()
        .expect("failed to run membership-tee fixture");

    assert!(
        !output.status.success(),
        "expected fixture command to fail until implemented"
    );
    assert!(
        String::from_utf8_lossy(&output.stderr).contains("not implemented yet"),
        "expected not implemented error, stderr: {}",
        String::from_utf8_lossy(&output.stderr)
    );
}

#[test]
fn production_command_fails_until_implemented() {
    let output = membership_tee()
        .arg("production")
        .output()
        .expect("failed to run membership-tee production");

    assert!(
        !output.status.success(),
        "expected production command to fail until implemented"
    );
    assert!(
        String::from_utf8_lossy(&output.stderr).contains("not implemented yet"),
        "expected not implemented error, stderr: {}",
        String::from_utf8_lossy(&output.stderr)
    );
}
