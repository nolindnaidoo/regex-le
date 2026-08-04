// Input validation patterns used across the signup flow.
const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/i;
const SLUG = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
const SEMVER = /^(\d+)\.(\d+)\.(\d+)(?:-([0-9a-z.-]+))?$/i;
const HEX_COLOR = /^#(?:[0-9a-f]{3}|[0-9a-f]{6})$/i;
const ISO_DATE = /^\d{4}-\d{2}-\d{2}(?:T\d{2}:\d{2}:\d{2}Z)?$/;

// Pulled from a legacy parser — kept here while it is being replaced.
const NESTED = /^(a+)+$/;
const ALTERNATION = /^(x|x)*y$/;

const PHONE = new RegExp('^\\+?[0-9]{7,15}$');
const TAG = new RegExp('<([a-z][a-z0-9]*)\\b[^>]*>', 'gi');

module.exports = { EMAIL, SLUG, SEMVER, HEX_COLOR, ISO_DATE, PHONE, TAG };
