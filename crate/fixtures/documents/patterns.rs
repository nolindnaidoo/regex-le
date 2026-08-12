use regex::{Regex, RegexBuilder};

fn build() {
    // Raw string, no hashes
    let nested = Regex::new(r"(a+)+").unwrap();
    // Raw string with hashes, holding a quote
    let quoted = Regex::new(r#"say "([a-z]+)*""#).unwrap();
    // A quoted string escapes a level
    let escaped = RegexBuilder::new("\\d{4}").build().unwrap();
    // Fully qualified, and a name that only looks like one
    let qualified = regex::Regex::new(r"^\w+$").unwrap();
    let unrelated = MyRegex::new(r"ignored");
}
