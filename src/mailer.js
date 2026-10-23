// Sending email (password resets, verification, alerts).
// Configure SMTP_URL (any provider: Resend, Postmark, SES, Mailgun, Gmail…).
// Without it, emails are written to the server log and the admin page's
// outbox instead, so a self-hosted site still works.

import nodemailer from 'nodemailer';
import { getDb, nowIso } from './db.js';

const FROM = () => process.env.MAIL_FROM || 'Grocery Price Compare <no-reply@localhost>';
let transport = null;

export function mailConfigured() {
  return !!process.env.SMTP_URL;
}

/** Base URL for links in emails: SITE_URL, else the address the request came in on. */
export function siteUrl(req) {
  const base = process.env.SITE_URL || (req ? `${req.protocol}://${req.get('host')}` : 'http://localhost:3000');
  return base.replace(/\/$/, '');
}

export const siteName = () => process.env.SITE_NAME || 'Grocery Price Compare';

// Tests read sent mail from here instead of a mail server.
export const capturedMail = [];

/**
 * @param {{to:string, subject:string, text:string, html?:string, kind:string, headers?:object}} msg
 */
export async function sendMail(msg) {
  const d = getDb();
  const log = d.prepare('INSERT INTO email_log (to_email, subject, kind, sent_at, error, body) VALUES (?, ?, ?, ?, ?, ?)');
  if (process.env.MAIL_CAPTURE === 'true') {
    capturedMail.push(msg);
    return { captured: true };
  }
  if (!mailConfigured()) {
    console.log(`[mail] (no SMTP_URL set) to ${msg.to}: ${msg.subject}\n${msg.text}\n`);
    log.run(msg.to, msg.subject, msg.kind, nowIso(), null, msg.text);
    return { outbox: true };
  }
  try {
    transport ||= nodemailer.createTransport(process.env.SMTP_URL);
    await transport.sendMail({ from: FROM(), to: msg.to, subject: msg.subject, text: msg.text, html: msg.html, headers: msg.headers });
    log.run(msg.to, msg.subject, msg.kind, nowIso(), null, null);
    return { sent: true };
  } catch (e) {
    log.run(msg.to, msg.subject, msg.kind, nowIso(), e.message, null);
    throw e;
  }
}

const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);

/** A plain, readable HTML email: heading, paragraphs, optional button, footer note. */
export function emailHtml({ heading, paragraphs = [], button, footer, extraHtml = '' }) {
  return `<!doctype html><html><body style="margin:0;padding:24px;background:#f6f6f4;font-family:system-ui,-apple-system,Segoe UI,Roboto,sans-serif;color:#0b0b0b">
  <div style="max-width:560px;margin:0 auto;background:#fff;border:1px solid #e2e1dc;border-radius:12px;padding:24px">
    <p style="margin:0 0 4px;color:#7a7974;font-size:13px">${esc(siteName())}</p>
    <h1 style="font-size:20px;margin:0 0 12px">${esc(heading)}</h1>
    ${paragraphs.map((p) => `<p style="font-size:15px;line-height:1.5;margin:0 0 12px">${esc(p)}</p>`).join('')}
    ${extraHtml}
    ${button ? `<p style="margin:20px 0"><a href="${esc(button.url)}" style="background:#2a78d6;color:#fff;text-decoration:none;padding:10px 16px;border-radius:8px;font-weight:600;display:inline-block">${esc(button.label)}</a></p>
    <p style="font-size:12px;color:#7a7974;word-break:break-all">Or open: ${esc(button.url)}</p>` : ''}
    ${footer ? `<p style="font-size:12px;color:#7a7974;margin-top:20px">${footer}</p>` : ''}
  </div></body></html>`;
}

export { esc as escapeHtml };
