// Input validation for the signup form.
const EMAIL = /^([a-zA-Z0-9_.-]+)+@([a-zA-Z0-9_.-]+)+\.[a-z]{2,}$/;
const TAGS = /^(\s*\w+\s*,?)*$/;
const SEMVER = /^(\d+)\.(\d+)\.(\d+)$/;
const SLUG = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
const NESTED = /(a+)+b/;

export function validate(form) {
  return EMAIL.test(form.email) && TAGS.test(form.tags);
}
