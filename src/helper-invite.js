// What a helper sees: the page an invite link opens (to download the collector
// themselves) and the email that sends them the link. Both say plainly what
// the program is, what it does on their computer and how to stop it.

import { siteName, emailHtml, escapeHtml as esc } from './mailer.js';

const DOWNLOADS = [
  { id: 'windows-x64', label: 'Windows' },
  { id: 'linux-x64', label: 'Linux (x64)' },
  { id: 'linux-arm64', label: 'Linux (ARM, e.g. Raspberry Pi)' },
  { id: 'zip', label: 'Mac / any computer with Node.js (zip)' },
];

const WHAT_IT_IS = (site) => [
  `${site} compares grocery prices across Australian supermarkets. Some supermarkets block servers, or block a connection that asks for too much, so the site shares the work of fetching prices between a few trusted computers.`,
  'This small program makes your computer one of them. It checks in with the site every few minutes and fetches what it’s asked for — a supermarket department, or a few pages of Coles — from your internet connection, at a gentle pace, and sends the prices back.',
  'It only visits supermarket websites and the site itself. It doesn’t read your files or anything else on your computer, and it uses very little data. Close it whenever you like; anything it was part-way through is handed to another computer.',
];

// `…` marks commands (shown as code on the page and in the email).
const SETUP = [
  'Windows: run the program and leave it running. Windows may say it’s from an unknown publisher (it isn’t code-signed): choose More info → Run anyway. To start it with the computer, run it once with `--autostart`.',
  'Linux or Raspberry Pi: extract it with `tar xzf grocery-collector-linux-*.tar.gz`, then run `./grocery-collector`. Add `--autostart` to start it when you log in.',
  'Mac (or anything with Node.js 20+): unzip it and run `sh start.sh` in a terminal.',
  'It keeps itself up to date. If you download it again, the copy you had stops working, so use the newest one.',
];
// Short commands stay on one line; long ones may wrap.
const codeHtml = (s) => esc(s).replace(/`([^`]+)`/g, (m, c) => `<code${c.length < 22 ? ' class="short"' : ''}>${c}</code>`);
const plain = (s) => s.replace(/`/g, '');

/** The invite page (or, with no helper, "this link has expired"). */
export function invitePage({ siteUrl, helper, inviteToken, until }) {
  const site = siteName();
  const page = (body) => `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="robots" content="noindex"><title>Help keep ${esc(site)} up to date</title>
<style>
  :root { --bg:#fbfaf5; --card:#fff; --text:#1d1b16; --muted:#6f685c; --border:#e6e0d3; --accent:#d6232c; }
  @media (prefers-color-scheme: dark) { :root { --bg:#151412; --card:#1f1d1a; --text:#f2efe8; --muted:#b2ab9e; --border:#36322c; --accent:#ffd23f; } }
  body { margin:0; background:var(--bg); color:var(--text); font:16px/1.55 system-ui,-apple-system,Segoe UI,Roboto,sans-serif; }
  main { max-width:620px; margin:0 auto; padding:24px 16px 48px; }
  .card { background:var(--card); border:1px solid var(--border); border-radius:14px; padding:20px; margin:16px 0; }
  h1 { font-size:1.5rem; margin:.2em 0 .4em; } h2 { font-size:1.1rem; margin:0 0 .5em; }
  .brand { display:flex; align-items:center; gap:8px; color:var(--muted); font-weight:600; }
  .brand img { width:28px; height:28px; border-radius:7px; }
  .downloads { display:flex; flex-wrap:wrap; gap:8px; }
  .downloads a { display:inline-block; padding:10px 14px; border-radius:10px; border:1px solid var(--border); color:var(--text); text-decoration:none; font-weight:600; }
  .downloads a:first-child { background:var(--accent); border-color:var(--accent); color:#fff; }
  @media (prefers-color-scheme: dark) { .downloads a:first-child { color:#1d1b16; } }
  .muted { color:var(--muted); font-size:.92em; } li { margin:.3em 0; } code { font-size:.92em; overflow-wrap:anywhere; }
  code.short { white-space:nowrap; }
</style></head><body><main>
<p class="brand"><img src="${esc(siteUrl)}/icon-192.png" alt="">${esc(site)}</p>
${body}
</main></body></html>`;
  if (!helper) {
    return page(`<h1>This link has expired</h1><div class="card"><p>Invite links work for a week, and stop when a new one is made. Ask whoever sent it for a new link.</p></div>`);
  }
  const [what, how, privacy] = WHAT_IT_IS(site);
  return page(`<h1>Help keep ${esc(site)}’s prices up to date</h1>
<p>Hi ${esc(helper.name)} — you’ve been invited to run the price collector.</p>
<div class="card"><h2>What it is</h2><p>${esc(what)}</p><p>${esc(how)}</p><p class="muted">${esc(privacy)}</p></div>
<div class="card"><h2>Download</h2>
  <div class="downloads">${DOWNLOADS.map((d) => `<a href="/collector/${esc(inviteToken)}/download/${d.id}" download>⬇ ${esc(d.label)}</a>`).join('')}</div>
  <p class="muted">Each download is already set up for ${esc(site)}. This link works until ${esc(new Date(until).toLocaleDateString('en-AU', { day: 'numeric', month: 'long' }))}.</p></div>
<div class="card"><h2>Setting it up</h2><ul>${SETUP.map((s) => `<li>${codeHtml(s)}</li>`).join('')}</ul></div>`);
}

/** "Preparing the program" while it's built the first time; the page tries again by itself. */
export function preparingPage() {
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<meta http-equiv="refresh" content="15"><title>Preparing your download</title>
<style>body{margin:0;padding:40px 16px;font:16px/1.5 system-ui,sans-serif;background:#fbfaf5;color:#1d1b16;text-align:center}
@media (prefers-color-scheme: dark){body{background:#151412;color:#f2efe8}}</style></head>
<body><h1>Preparing your download…</h1><p>This takes about a minute the first time. The download will start by itself.</p></body></html>`;
}

/** The email with an invite link. */
export function inviteEmail({ helper, link, until }) {
  const site = siteName();
  const [what, how, privacy] = WHAT_IT_IS(site);
  const date = new Date(until).toLocaleDateString('en-AU', { day: 'numeric', month: 'long' });
  const paragraphs = [`Hi ${helper.name},`, what, how, privacy, `Open the link below to download it for your computer. It's already set up for ${site}, and the link works until ${date}.`];
  return {
    subject: `Help keep ${site}’s prices up to date`,
    text: `${paragraphs.join('\n\n')}\n\n${link}\n\nSetting it up:\n${SETUP.map((s) => `- ${plain(s)}`).join('\n')}\n`,
    html: emailHtml({
      heading: `Help keep ${site}’s prices up to date`,
      paragraphs,
      button: { url: link, label: 'Download the collector' },
      extraHtml: `<p style="font-size:15px;margin:16px 0 6px"><strong>Setting it up</strong></p><ul style="font-size:14px;line-height:1.5;padding-left:20px;margin:0 0 12px">${SETUP.map((s) => `<li>${codeHtml(s)}</li>`).join('')}</ul>`,
      footer: 'You got this because someone who runs the site added you as a helper. If it wasn’t expected, ignore it.',
    }),
  };
}
