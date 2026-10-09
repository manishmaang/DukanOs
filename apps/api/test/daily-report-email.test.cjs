const { test } = require('node:test');
const assert = require('node:assert/strict');
const {
  dailyConfig,
  deliveryError,
} = require('../dist/modules/daily-reports/email-adapter');
const { renderReport } = require('../dist/modules/daily-reports/report-email');
test('SMTP configuration is optional, bounded, provider-neutral and rejects header injection', () => {
  assert.equal(dailyConfig({}).smtp, null);
  assert.equal(dailyConfig({}).delay, 5);
  for (const env of [
    { DAILY_REPORT_DELAY_MINUTES: '-1' },
    { SMTP_HOST: 'mail.example.com', EMAIL_FROM_ADDRESS: 'invalid' },
    {
      SMTP_HOST: 'mail.example.com',
      EMAIL_FROM_ADDRESS: 'owner@example.com',
      SMTP_SECURE: 'yes',
    },
    {
      SMTP_HOST: 'mail.example.com',
      EMAIL_FROM_ADDRESS: 'owner@example.com',
      EMAIL_FROM_NAME: 'Name\r\nBcc: attacker@example.com',
    },
    {
      SMTP_HOST: 'mail.example.com',
      EMAIL_FROM_ADDRESS: 'owner@example.com',
      SMTP_USERNAME: 'user',
    },
  ])
    assert.throws(() => dailyConfig(env));
  assert.equal(
    dailyConfig({
      SMTP_HOST: 'smtp.example.com',
      EMAIL_FROM_ADDRESS: 'owner@example.com',
      SMTP_PORT: '465',
      SMTP_SECURE: 'true',
    }).smtp.secure,
    true,
  );
  assert.equal(
    deliveryError({ code: 'EAUTH', message: 'password secret' }),
    'SMTP_AUTH_FAILED',
  );
  assert.equal(deliveryError({ code: 'EENVELOPE' }), 'RECIPIENT_REJECTED');
  assert.equal(deliveryError({ code: 'ECONNECTION' }), 'SMTP_UNAVAILABLE');
});
test('version-specific email is structured, escaped, zero-safe and preserves paise', () => {
  const s = {
    schemaVersion: 1,
    businessDate: '2026-10-03',
    timezone: 'Asia/Kolkata',
    foodSold: '10000.50',
    cashReturned: '0.00',
    recordedExpenses: '0.00',
    expenseCategories: [],
    expenseEntries: [],
    bestSeller: null,
  };
  const a = renderReport(s, 1);
  assert.equal(a.subject, 'DukanOS Daily Report — 3 October 2026');
  assert.ok(a.text.includes('₹10000.50'));
  assert.ok(a.text.includes('No food sales recorded.'));
  assert.ok(a.text.includes('No expenses recorded.'));
  assert.ok(!a.html.includes('<script'));
  const b = renderReport(
    {
      ...s,
      bestSeller: {
        name: '<img onerror=evil>',
        quantity: '10',
        variants: [{ name: 'Half & Full', quantity: '10' }],
      },
    },
    2,
  );
  assert.ok(b.subject.endsWith('v2'));
  assert.ok(b.html.includes('&lt;img onerror=evil&gt;'));
  assert.ok(!b.html.includes('<img'));
  assert.ok(b.text.includes('REVISED DAILY REPORT'));
});

test('local SMTP 451 recipient failure retries; 550 recipient rejection is permanent', async () => {
  const net = require('node:net');
  const {
    EmailDeliveryAdapter,
  } = require('../dist/modules/daily-reports/email-adapter');
  let response = 451;
  const server = net.createServer((socket) => {
    socket.setEncoding('utf8');
    socket.write('220 local fixture\r\n');
    let pending = '';
    socket.on('data', (chunk) => {
      pending += chunk;
      let i;
      while ((i = pending.indexOf('\r\n')) >= 0) {
        const line = pending.slice(0, i);
        pending = pending.slice(i + 2);
        if (line.startsWith('EHLO')) socket.write('250 local fixture\r\n');
        else if (line.startsWith('RCPT TO'))
          socket.write(`${response} recipient fixture rejection\r\n`);
        else if (line === 'QUIT') socket.end('221 bye\r\n');
        else socket.write('250 ok\r\n');
      }
    });
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  try {
    const adapter = new EmailDeliveryAdapter();
    adapter.config = {
      delay: 5,
      smtp: {
        host: '127.0.0.1',
        port: server.address().port,
        secure: false,
        from: 'fixture@example.invalid',
        name: 'Fixture',
      },
    };
    for (const [smtpCode, expected] of [
      [451, 'SMTP_UNAVAILABLE'],
      [550, 'RECIPIENT_REJECTED'],
    ]) {
      response = smtpCode;
      await assert.rejects(
        adapter.send(
          'recipient@example.invalid',
          { subject: 'fixture', text: 'fixture', html: 'fixture' },
          'fixture',
        ),
        (e) => deliveryError(e) === expected && e.responseCode === smtpCode,
      );
    }
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
});
