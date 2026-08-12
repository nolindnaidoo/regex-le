using System.Text.RegularExpressions;

class Validate {
	// Verbatim string: the source as written
	static readonly Regex Nested = new Regex(@"(a+)+");
	// Quoted string: escapes a level
	static readonly Regex Escaped = new Regex("\\d{4}");
	// The static form takes the subject first and the pattern second
	static bool Check(string s) => Regex.IsMatch(s, @"(a|ab)+");
	static string Strip(string s) => Regex.Replace(s, "\\s+", "");
}
