import { Injectable } from '@nestjs/common';
import { isEmail } from 'class-validator';
import nodemailer from 'nodemailer';
export function dailyConfig(env: NodeJS.ProcessEnv = process.env) {
  const delay = Number(env.DAILY_REPORT_DELAY_MINUTES || '5');
  if (!Number.isInteger(delay) || delay < 0 || delay > 1440)
    throw new Error('Invalid DAILY_REPORT_DELAY_MINUTES');
  const host = env.SMTP_HOST?.trim();
  if (!host) return { delay, smtp: null };
  const port = Number(env.SMTP_PORT || '587');
  const secure = env.SMTP_SECURE || 'false';
  const from = env.EMAIL_FROM_ADDRESS?.trim() ?? '';
  const name = env.EMAIL_FROM_NAME || 'DukanOS';
  if (
    !Number.isInteger(port) ||
    port < 1 ||
    port > 65535 ||
    !['true', 'false'].includes(secure) ||
    !isEmail(from) ||
    /[\r\n]/.test(host + from + name) ||
    name.length > 100 ||
    Boolean(env.SMTP_USERNAME) !== Boolean(env.SMTP_PASSWORD)
  )
    throw new Error('Invalid SMTP configuration');
  return {
    delay,
    smtp: {
      host,
      port,
      secure: secure === 'true',
      from,
      name,
      user: env.SMTP_USERNAME,
      password: env.SMTP_PASSWORD,
    },
  };
}
export interface DeliveryMessage {
  subject: string;
  text: string;
  html: string;
}
@Injectable()
export class EmailDeliveryAdapter {
  readonly config = dailyConfig();
  get configured() {
    return this.config.smtp !== null;
  }
  async send(recipient: string, message: DeliveryMessage, id: string) {
    const s = this.config.smtp;
    if (!s)
      throw Object.assign(new Error('Email not configured'), {
        code: 'NOT_CONFIGURED',
      });
    const local = ['127.0.0.1', 'localhost', '::1'].includes(s.host);
    const transport = nodemailer.createTransport({
      host: s.host,
      port: s.port,
      secure: s.secure,
      requireTLS: !s.secure && !local,
      auth: s.user ? { user: s.user, pass: s.password! } : undefined,
      connectionTimeout: 10000,
      greetingTimeout: 10000,
      socketTimeout: 20000,
      dnsTimeout: 10000,
      logger: false,
      debug: false,
      disableFileAccess: true,
      disableUrlAccess: true,
    });
    try {
      const result = await transport.sendMail({
        ...message,
        from: { name: s.name, address: s.from },
        to: { address: recipient, name: '' },
        messageId: `<${id}@dukanos.local>`,
      });
      if (!result.accepted.length)
        throw Object.assign(new Error('Recipient rejected'), {
          code: 'EENVELOPE',
        });
      return result.messageId;
    } finally {
      transport.close();
    }
  }
}
export function deliveryError(error: unknown) {
  const code = (error as { code?: string })?.code;
  if (code === 'EAUTH') return 'SMTP_AUTH_FAILED';
  if (code === 'EENVELOPE') return 'RECIPIENT_REJECTED';
  if (code === 'NOT_CONFIGURED') return 'NOT_CONFIGURED';
  return 'SMTP_UNAVAILABLE';
}
