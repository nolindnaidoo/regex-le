import re

# The textbook catastrophic-backtracking shape, in a raw string
NESTED = re.compile(r"(a+)+")

# A quoted string escapes a level, exactly as the JS constructor does
ESCAPED = re.compile("\\d{3}-\\d{4}")

# Single-quoted raw, and a triple-quoted body
SINGLE = re.match(r'^[a-z]+$', name)
TRIPLE = re.search("""(a|ab)+""", text)

# A path is not a pattern: Python has no /…/ literal
PREFIX = "/usr/local/bin"
