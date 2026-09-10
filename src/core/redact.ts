const SENSITIVE_QUERY_PARAMETER = /(?:api[-_]?key|access[-_]?token|auth(?:orization)?|password|secret|token)/i;

/** Removes credentials and common token-like query values before reports are written. */
export function redactUrl(value: string): string {
  if (!value) return value;
  try {
    const url = new URL(value);
    url.username = '';
    url.password = '';
    for (const [name] of url.searchParams) {
      if (SENSITIVE_QUERY_PARAMETER.test(name)) url.searchParams.set(name, 'REDACTED');
    }
    return url.toString();
  } catch {
    return value;
  }
}

/** Replaces known secret values in unexpected network error messages. */
export function redactText(value: string, secretValues: string[] = []): string {
  let redacted = value;
  for (const secret of secretValues) {
    if (secret.length >= 4) redacted = redacted.split(secret).join('[REDACTED]');
  }
  return redacted;
}
