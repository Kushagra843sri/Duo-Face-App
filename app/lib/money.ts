/**
 * Money from the server's own (Duo-Face) data is integer paise. Only this
 * function turns it into text; nothing in the app does float maths on it.
 */
export function formatPaise(paise: number): string {
  const negative = paise < 0;
  const abs = Math.abs(Math.trunc(paise));
  const rupees = Math.floor(abs / 100);
  const fraction = abs % 100;
  const digits = String(rupees);
  // Indian digit grouping: 12,34,567
  const grouped =
    digits.length > 3 ? digits.slice(0, -3).replace(/\B(?=(\d{2})+(?!\d))/g, ',') + ',' + digits.slice(-3) : digits;
  return `${negative ? '-' : ''}₹${grouped}${fraction === 0 ? '' : '.' + String(fraction).padStart(2, '0')}`;
}

/**
 * Turns what a person typed into integer paise, or null if it is not a valid
 * amount. Digits only, at most two decimals, no signs, no exponent: never a
 * float calculation on the way ("28.5" -> 2850, "0.1" -> 10).
 */
export function parseRupeesToPaise(text: string): number | null {
  const match = /^(\d{1,7})(?:\.(\d{1,2}))?$/.exec(text.trim());
  if (!match) return null;
  const rupees = Number(match[1]);
  const paise = Number((match[2] ?? '').padEnd(2, '0') || '0');
  return rupees * 100 + paise;
}

