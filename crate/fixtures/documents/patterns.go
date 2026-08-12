package main

import "regexp"

var (
	// A backquoted string is the source verbatim
	nested = regexp.MustCompile(`(a+)+`)
	// A quoted string escapes a level
	escaped = regexp.Compile("\\d{2}:\\d{2}")
	// Inline flags: valid RE2, and not JavaScript
	inline = regexp.MustCompile(`(?i)^[a-z]+$`)
)
