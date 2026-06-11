// js/auth/free-email-domains.js
// ---------------------------------------------------------------------------
// Denylist of PUBLIC / CONSUMER / disposable email providers.
//
// Strategy: we can't list every corporate domain (there are millions), so we
// do the inverse — block known free-mail and throwaway providers, and treat
// everything else as a business address. This is the same approach used by
// SaaS "work email required" sign-up flows.
//
// To extend: add lowercase domains below. For exhaustive coverage you can
// swap this for an open dataset (e.g. github.com/disposable-email-domains),
// but this curated list covers the overwhelming majority of real sign-ups.
// ---------------------------------------------------------------------------

export const FREE_EMAIL_DOMAINS = new Set([
  // --- Google ---
  'gmail.com', 'googlemail.com',
  // --- Microsoft ---
  'outlook.com', 'hotmail.com', 'live.com', 'msn.com', 'hotmail.co.uk',
  'outlook.co.uk', 'live.co.uk', 'hotmail.fr', 'live.fr', 'outlook.fr',
  'hotmail.de', 'live.de', 'outlook.de', 'hotmail.it', 'windowslive.com',
  // --- Yahoo / AOL / Verizon ---
  'yahoo.com', 'ymail.com', 'rocketmail.com', 'yahoo.co.uk', 'yahoo.co.in',
  'yahoo.fr', 'yahoo.de', 'yahoo.com.br', 'yahoo.ca', 'yahoo.com.au',
  'yahoo.es', 'yahoo.it', 'aol.com', 'aim.com', 'verizon.net',
  // --- Apple ---
  'icloud.com', 'me.com', 'mac.com',
  // --- Privacy-focused ---
  'proton.me', 'protonmail.com', 'pm.me', 'tutanota.com', 'tuta.io',
  'tutamail.com', 'hushmail.com', 'mailfence.com', 'fastmail.com',
  // --- Other Western free providers ---
  'gmx.com', 'gmx.net', 'gmx.de', 'gmx.at', 'gmx.ch', 'web.de',
  'mail.com', 'email.com', 'usa.com', 'europe.com', 'inbox.com',
  'zoho.com', 'zohomail.com', 'yandex.com', 'yandex.ru', 'ya.ru',
  'mail.ru', 'bk.ru', 'list.ru', 'inbox.ru', 'rambler.ru',
  // --- China ---
  'qq.com', 'foxmail.com', '163.com', '126.com', 'yeah.net',
  'sina.com', 'sina.cn', 'sohu.com', 'aliyun.com', '139.com',
  '189.cn', 'tom.com', '21cn.com', 'wo.cn',
  // --- Korea / Japan / SE Asia ---
  'naver.com', 'daum.net', 'hanmail.net', 'nate.com', 'kakao.com',
  'docomo.ne.jp', 'ezweb.ne.jp', 'softbank.ne.jp', 'yahoo.co.jp',
  // --- Disposable / temporary (block sign-up abuse) ---
  'mailinator.com', '10minutemail.com', 'guerrillamail.com', 'guerrillamail.info',
  'sharklasers.com', 'trashmail.com', 'getnada.com', 'temp-mail.org',
  'tempmail.com', 'throwawaymail.com', 'yopmail.com', 'maildrop.cc',
  'dispostable.com', 'fakeinbox.com', 'mailnesia.com', 'mintemail.com',
  'mohmal.com', 'spambox.us', 'emailondeck.com', 'moakt.com',
]);

// Returns the lowercase domain part of an email, or '' if malformed.
export function emailDomainOf(email) {
  const at = (email || '').lastIndexOf('@');
  if (at < 0) return '';
  return email.slice(at + 1).trim().toLowerCase();
}

// True if the email looks like a business address (i.e. NOT a known free/
// disposable provider). Empty / malformed emails are rejected.
export function isBusinessEmail(email) {
  const d = emailDomainOf(email);
  return d.length > 0 && d.includes('.') && !FREE_EMAIL_DOMAINS.has(d);
}
