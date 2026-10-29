# apps/site

Static site for Modus (plain HTML/CSS + tiny ES modules, no build step, no dependencies).
Deployed on Vercel with **Root Directory = `apps/site`**; `vercel.json` sets `cleanUrls` and the
security headers (strict CSP: no inline scripts or styles).

| Path | File | Purpose |
|---|---|---|
| `/` | `index.html` | Landing page |
| `/billing/return` | `billing/return.html` | Stripe return page. `BILLING_RETURN_URL` of the Edge Functions points here; it forwards only a validated status / session id to the fixed `modus://billing/return` |
| `/pricing`, `/download`, `/privacy`, `/terms` | `*.html` | Site pages in English; pt-BR copies under `/pt-br/` (each page links to the other language). Privacy and Terms are drafts awaiting approval |
| `/auth/confirmed` | `auth/confirmed.html` | Email-confirmation landing (`MODUS_AUTH_EMAIL_REDIRECT_URL`) |

Tests: `npm run test:site` (Node's built-in test runner, `billing/forward.test.js`).

Not an npm workspace (no `package.json`), so the root workspace scripts ignore it.
