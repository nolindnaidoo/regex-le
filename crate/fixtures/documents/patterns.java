import java.util.regex.Pattern;

class Validate {
	static final Pattern NESTED = Pattern.compile("(a+)+");
	static final Pattern ESCAPED = Pattern.compile("\\d{4}-\\d{2}");
	static final Pattern QUALIFIED = java.util.regex.Pattern.compile("^[A-Z][a-z]+$");
	static boolean check(String s) {
		return Pattern.matches("(a|ab)+", s);
	}
}
