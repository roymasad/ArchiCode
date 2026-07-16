const directSecretKey = /^(?:apiKey|api_key|token|accessToken|refreshToken|password|secret|clientSecret|authorization|cookie|set-cookie)$/i;
const sensitiveContainerKey = /^(?:env|headers)$/i;

export function redactSensitiveText(text: string): { text: string; redacted: boolean } {
  let redacted = false;
  const next = text
    .replace(/("(?:apiKey|api_key|token|accessToken|refreshToken|password|secret|clientSecret|authorization|cookie)"\s*:\s*")([^"]*)(")/gi, (_match, prefix: string, _value: string, suffix: string) => {
      redacted = true;
      return `${prefix}[redacted]${suffix}`;
    })
    .replace(/^([A-Z0-9_]*(?:API_KEY|TOKEN|SECRET|PASSWORD|AUTHORIZATION|COOKIE)[A-Z0-9_]*=).+$/gim, (_match, prefix: string) => {
      redacted = true;
      return `${prefix}[redacted]`;
    })
    .replace(/\b(sk-[A-Za-z0-9_-]{12,}|anthropic-[A-Za-z0-9_-]{12,})\b/g, () => {
      redacted = true;
      return "[redacted-secret]";
    })
    .replace(/(https?:\/\/)([^\s/@:]+):([^\s/@]+)@/gi, (_match, protocol: string) => {
      redacted = true;
      return `${protocol}[redacted]@`;
    });
  return { text: next, redacted };
}

export function sanitizeExternalValue<T>(value: T): { value: T; redacted: boolean } {
  let redacted = false;

  const visit = (current: unknown, key = "", sensitiveContainer = ""): unknown => {
    if (current === null || current === undefined || typeof current === "number" || typeof current === "boolean") return current;
    if (typeof current === "string") {
      if (directSecretKey.test(key) || (sensitiveContainerKey.test(sensitiveContainer) && key === "value")) {
        redacted = true;
        return "[redacted]";
      }
      const sanitized = redactSensitiveText(current);
      redacted ||= sanitized.redacted;
      return sanitized.text;
    }
    const nextSensitiveContainer = sensitiveContainerKey.test(key) ? key : sensitiveContainer;
    if (Array.isArray(current)) return current.map((item) => visit(item, key, nextSensitiveContainer));
    if (typeof current === "object") {
      return Object.fromEntries(Object.entries(current as Record<string, unknown>).map(([childKey, childValue]) => [
        childKey,
        visit(childValue, childKey, nextSensitiveContainer)
      ]));
    }
    return current;
  };

  return { value: visit(value) as T, redacted };
}
