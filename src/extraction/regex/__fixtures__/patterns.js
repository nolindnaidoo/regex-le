// Literal regexes
const digits = /\d+/g;
const word = /\w+/i;
const anchored = /^[a-z]+$/;
const escapedSlash = /foo\/bar/g;
const charClass = /[abc]/gim;

// Constructor forms
const ctor = new RegExp('\\d{3}-\\d{4}', 'g');
const ctorNoFlags = new RegExp('hello');
const bare = RegExp('world', 'i');

// Duplicate pattern on a different line — dedup drops this location
const digitsAgain = /\d+/g;

// Division that looks like a regex to the extractor
const ratio = a / b / c;

// URL with slashes
const url = 'https://example.com/path/to/resource';
