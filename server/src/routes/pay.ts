import { Router } from 'express';
import helmet from 'helmet';

/**
 * NOTE: the Cashfree SDK script has no Subresource Integrity hash on purpose. Cashfree serves it from one
 * unversioned URL and requires loading it from there, so a pinned hash would break checkout whenever they
 * update it. The CSP below restricts scripts to this server and sdk.cashfree.com instead.
 *
 * The page the app opens (in the in-app browser) so the customer can pay. It
 * works the same in Expo Go, native builds and on web: no native Cashfree SDK.
 * The payment session id travels in the URL (as in Cashfree's own hosted
 * flow), so these pages are never cached and never send a Referer.
 */
const SESSION_PATTERN = /^[A-Za-z0-9_\-=.]{10,512}$/;

const checkoutScript = `(function () {
  var s = document.currentScript;
  var msg = document.getElementById('msg');
  function fail(text) { msg.textContent = text; }
  if (typeof Cashfree !== 'function') { fail('Could not load the payment page. Check your connection and try again.'); return; }
  try {
    var cf = Cashfree({ mode: s.getAttribute('data-mode') });
    cf.checkout({ paymentSessionId: s.getAttribute('data-session'), redirectTarget: '_self' }).then(function (r) {
      if (r && r.error) fail(r.error.message || 'Payment could not start.');
    });
  } catch (e) { fail('Payment could not start.'); }
})();`;

const PAGE_STYLE =
  'body{font-family:system-ui,sans-serif;margin:0;display:flex;min-height:100vh;align-items:center;justify-content:center;background:#fff7ed;color:#1c1917}main{max-width:22rem;padding:2rem;text-align:center}h1{font-size:1.25rem}p{color:#57534e}';

const page = (title: string, body: string, scripts = '') =>
  `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${title}</title><style>${PAGE_STYLE}</style></head><body><main>${body}</main>${scripts}</body></html>`;

export function createPayRouter(mode: 'sandbox' | 'production') {
  const router = Router();

  router.use((_req, res, next) => {
    res.setHeader('Cache-Control', 'no-store');
    res.setHeader('Referrer-Policy', 'no-referrer');
    next();
  });
  router.use(
    helmet.contentSecurityPolicy({
      useDefaults: false,
      directives: {
        defaultSrc: ["'none'"],
        scriptSrc: ["'self'", 'https://sdk.cashfree.com'],
        connectSrc: ["'self'", 'https://*.cashfree.com'],
        frameSrc: ['https://*.cashfree.com'],
        styleSrc: ["'unsafe-inline'"],
        formAction: ["'self'", 'https://*.cashfree.com'],
        baseUri: ["'none'"],
      },
    })
  );

  router.get('/checkout.js', (_req, res) => {
    res.type('application/javascript').send(checkoutScript);
  });

  router.get('/checkout', (req, res) => {
    const session = typeof req.query.session === 'string' ? req.query.session : '';
    if (!SESSION_PATTERN.test(session)) {
      res.status(400).type('html').send(page('Payment', '<h1>This payment link is not valid.</h1><p>Go back to the app and try again.</p>'));
      return;
    }
    // `session` passed the strict character allow-list above, so it is safe inside an attribute.
    res
      .type('html')
      .send(
        page(
          'Pay for your order',
          '<h1>Opening secure payment…</h1><p id="msg">Please wait.</p>',
          `<script src="https://sdk.cashfree.com/js/v3/cashfree.js"></script><script src="/pay/checkout.js" data-mode="${mode}" data-session="${session}"></script>`
        )
      );
  });

  router.get('/return', (_req, res) => {
    res.type('html').send(page('Payment', '<h1>Thank you</h1><p>You can close this window and go back to the app. Your order updates automatically once the payment is confirmed.</p>'));
  });

  return router;
}
