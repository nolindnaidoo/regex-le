mod cli;
mod detect;
mod mcp;
mod scan;
mod walk;

// The fuzzer sits beside `detect/` rather than inside it: it needs a
// clock and a generator, which the rules for that directory rule out,
// and it is not part of the layer the coverage floor measures.
#[cfg(test)]
mod fuzz;
#[cfg(test)]
mod testing;

fn main() -> std::process::ExitCode {
    cli::run()
}
