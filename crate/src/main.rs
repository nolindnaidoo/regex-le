mod cli;
mod detect;
mod mcp;
mod scan;
mod walk;

#[cfg(test)]
mod testing;

fn main() -> std::process::ExitCode {
    cli::run()
}
