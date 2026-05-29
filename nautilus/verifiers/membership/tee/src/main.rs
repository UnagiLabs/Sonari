use std::process::ExitCode;

use clap::{Parser, Subcommand};

#[derive(Debug, Parser)]
#[command(name = "membership-tee")]
#[command(about = "Membership TEE verifier CLI")]
struct Cli {
    #[command(subcommand)]
    command: Command,
}

#[derive(Debug, Subcommand)]
enum Command {
    Fixture,
    Production,
}

fn main() -> ExitCode {
    let cli = Cli::parse();

    match cli.command {
        Command::Fixture => unsupported("fixture"),
        Command::Production => unsupported("production"),
    }
}

fn unsupported(command: &str) -> ExitCode {
    eprintln!("membership-tee {command} is not implemented yet");
    ExitCode::from(1)
}
