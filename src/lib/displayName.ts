// Display names in chat. A peer's username is preferred; when it is missing or
// blank we fall back to the email prefix (the part before "@"). The result is
// never empty, so a chat card or conversation header can never render a
// nameless peer.
export function emailPrefix(email?: string | null): string {
  const value = (email ?? '').trim();
  if (!value) return '';
  const [prefix] = value.split('@');
  return (prefix ?? '').trim();
}

export function resolveDisplayName(
  username?: string | null,
  email?: string | null,
  fallback = 'Participant',
): string {
  const name = (username ?? '').trim();
  if (name) return name;

  const prefix = emailPrefix(email);
  if (prefix) return prefix;

  return fallback;
}
