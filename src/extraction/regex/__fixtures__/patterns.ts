// Named groups and newer flags
const named = /(?<year>\d{4})-(?<month>\d{2})/u;
const sticky = /abc/y;
const dotAll = /a.b/s;

// Lookarounds
const lookahead = /foo(?=bar)/;
const lookbehind = /(?<=\$)\d+/;

// Constructor with template-adjacent quoting
const ctor = new RegExp('^[A-Z][a-z]+$');
const withFlags = new RegExp('a|b|c', 'gi');

// Escaped quote inside constructor string — extractor's [^'"]+ breaks here
const tricky = new RegExp('it\'s', 'g');
