import re

# Named groups PCRE-style: valid Python, and not valid JavaScript
NAMED = re.compile(r"(?P<year>\d{4})-(?P<month>\d{2})")

# The same spelling wrapped in the exponential shape — reported, and
# flagged, rather than dismissed as a syntax error
NESTED = re.compile(r"(?P<word>\w+)+@")

# Inline flags and an atomic group, neither of which JavaScript has
ATOMIC = re.compile(r"(?i)(?>[a-z]+)")

# A genuine syntax error stays a syntax error and is dropped
BROKEN = re.compile(r"a{2,1}")
