// Real Chromium + isolated PostgreSQL fixture. No changes to restaurant data.
require('reflect-metadata');
process.env.ORDER_TAX_RATE = '0';
const { Client } = require('pg');
const { Test } = require('@nestjs/testing');
const express = require('express');
const { spawn, spawnSync } = require('node:child_process');
const { randomUUID } = require('node:crypto');
const fs = require('node:fs');
const assert = require('node:assert/strict');
const { AppModule } = require('../apps/api/dist/app.module');
const { configureApp } = require('../apps/api/dist/configure-app');
const {
  UsersService,
} = require('../apps/api/dist/modules/users/users.service');
const root = require('node:path').resolve(__dirname, '..');
(async () => {
  const admin = new Client({ connectionString: process.env.DATABASE_URL });
  await admin.connect();
  const schema = 'daily_browser_' + randomUUID().replaceAll('-', '');
  await admin.query(`CREATE SCHEMA "${schema}"`);
  const url = new URL(process.env.DATABASE_URL);
  url.searchParams.set('options', `-csearch_path=${schema}`);
  process.env.DATABASE_URL = url.toString();
  const profile = fs.mkdtempSync('/tmp/dukanos-daily-');
  process.env.DUKANOS_DATA_DIR = profile + '/media';
  let app, chrome, browser;
  const clients = [];
  const external = [],
    failures = [];
  try {
    assert.ok(
      process.env.CHROME_BINARY,
      'Set CHROME_BINARY to a local Chromium executable',
    );
    const migrated = spawnSync(process.execPath, ['scripts/migrate.mjs'], {
      cwd: root,
      env: process.env,
      encoding: 'utf8',
    });
    assert.equal(migrated.status, 0, migrated.stderr);
    const module = await Test.createTestingModule({
      imports: [AppModule],
    }).compile();
    app = module.createNestApplication();
    configureApp(app);
    app.use(express.static(root + '/apps/web/dist'));
    await app.listen(0, '127.0.0.1');
    const origin = await app.getUrl();
    const users = app.get(UsersService),
      password = randomUUID() + '!';
    const owner = await users.create({
      username: 'owner',
      name: 'Owner',
      password,
      roles: ['OWNER'],
    });
    for (const [username, roles] of Object.entries({
      cashier: ['CASHIER'],
      cook: ['KITCHEN'],
      multi: ['CASHIER', 'KITCHEN', 'DISPATCH'],
      manager: ['MANAGER'],
      dispatcher: ['DISPATCH'],
    }))
      await users.create({ username, name: username, password, roles }, owner);
    const login = await fetch(origin + '/api/auth/login', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-DukanOS-Request': '1' },
      body: JSON.stringify({ username: 'owner', password }),
    });
    const cookie = login.headers.get('set-cookie').split(';')[0];
    async function ownerCall(path, body) {
      const r = await fetch(origin + '/api' + path, {
        method: 'POST',
        headers: {
          Cookie: cookie,
          'Content-Type': 'application/json',
          'X-DukanOS-Request': '1',
        },
        body: JSON.stringify(body),
      });
      const result = await r.json();
      assert.equal(r.status, 201, path + ': ' + JSON.stringify(result));
      return result;
    }
    chrome = spawn(
      process.env.CHROME_BINARY,
      [
        '--no-sandbox',
        '--headless=new',
        '--remote-debugging-port=0',
        '--user-data-dir=' + profile,
        '--disable-background-networking',
        'about:blank',
      ],
      { stdio: ['ignore', 'ignore', 'pipe'] },
    );
    const endpoint = await new Promise((resolve, reject) => {
      let out = '';
      chrome.stderr.on('data', (d) => {
        out += d;
        const m = out.match(/DevTools listening on (ws:\/\/\S+)/);
        if (m) resolve(m[1]);
      });
      chrome.on('error', reject);
    });
    async function connect(address) {
      const socket = new globalThis.WebSocket(address);
      await new Promise((r) =>
        socket.addEventListener('open', r, { once: true }),
      );
      let sequence = 0;
      const pending = new Map();
      const handlers = [];
      const send = (method, params = {}) =>
        new Promise((resolve, reject) => {
          const id = ++sequence;
          const timer = setTimeout(() => {
            pending.delete(id);
            reject(Error('CDP timeout: ' + method));
          }, 30000);
          pending.set(id, {
            resolve: (value) => {
              clearTimeout(timer);
              resolve(value);
            },
            reject: (error) => {
              clearTimeout(timer);
              reject(error);
            },
          });
          socket.send(JSON.stringify({ id, method, params }));
        });
      socket.addEventListener('message', (e) => {
        const m = JSON.parse(e.data);
        if (m.id) {
          const p = pending.get(m.id);
          pending.delete(m.id);
          if (!p) return;
          if (m.error) p.reject(Error(JSON.stringify(m.error)));
          else p.resolve(m.result);
        } else for (const h of handlers) h(m);
      });
      return { socket, send, handlers };
    }
    browser = await connect(endpoint);
    async function device(username) {
      const ctx = (await browser.send('Target.createBrowserContext'))
        .browserContextId;
      const target = (
        await browser.send('Target.createTarget', {
          url: 'about:blank',
          browserContextId: ctx,
        })
      ).targetId;
      const c = await connect(
        endpoint.replace(/\/devtools\/browser\/.*/, '/devtools/page/' + target),
      );
      clients.push(c);
      c.fail = false;
      c.handlers.push((m) => {
        if (m.method === 'Runtime.exceptionThrown')
          failures.push(m.params.exceptionDetails.text);
        if (m.method !== 'Fetch.requestPaused') return;
        const r = m.params,
          local =
            r.request.url.startsWith(origin) ||
            r.request.url.startsWith('data:');
        if (!local) external.push(r.request.url);
        const reportRequest = /\/api\/(dashboard|reports\/)/.test(
          r.request.url,
        );
        void c
          .send(
            !local || (reportRequest && c.fail)
              ? 'Fetch.failRequest'
              : 'Fetch.continueRequest',
            !local || (reportRequest && c.fail)
              ? { requestId: r.requestId, errorReason: 'InternetDisconnected' }
              : { requestId: r.requestId },
          )
          .catch((e) => {
            if (!e.message.includes('Invalid InterceptionId'))
              failures.push(e.message);
          });
      });
      c.read = async (expression) => {
        const r = await c.send('Runtime.evaluate', {
          expression,
          awaitPromise: true,
          returnByValue: true,
        });
        if (r.exceptionDetails) throw Error(JSON.stringify(r.exceptionDetails));
        return r.result.value;
      };
      c.wait = async (expression) => {
        for (let i = 0; i < 150; i++) {
          if (await c.read(expression)) return;
          await new Promise((r) => setTimeout(r, 100));
        }
        throw Error(
          'Timed out: ' +
            expression +
            ' PAGE: ' +
            (await c.read('document.body.innerText')),
        );
      };
      c.click = async (text) => {
        await c.read(
          `(()=>{const b=[...document.querySelectorAll('button')].find(b=>b.textContent.trim()===${JSON.stringify(text)});if(!b)throw Error('Missing button');b.click();})()`,
        );
      };
      c.fill = async (selector, value) =>
        c.read(
          `(()=>{const e=document.querySelector(${JSON.stringify(selector)});const p=e.tagName==='TEXTAREA'?HTMLTextAreaElement.prototype:HTMLInputElement.prototype;Object.getOwnPropertyDescriptor(p,'value').set.call(e,${JSON.stringify(value)});e.dispatchEvent(new Event('input',{bubbles:true}));})()`,
        );
      c.http = async (path, method = 'GET') =>
        c.read(
          `fetch('/api'+${JSON.stringify(path)},{method:${JSON.stringify(method)},headers:{'X-DukanOS-Request':'1'}}).then(async r=>({status:r.status,body:await r.json()}))`,
        );
      await c.send('Runtime.enable');
      await c.send('Fetch.enable', { patterns: [{ urlPattern: '*' }] });
      await c.send('Emulation.setFocusEmulationEnabled', { enabled: true });
      await c.send('Emulation.setDeviceMetricsOverride', {
        width: 1440,
        height: 1000,
        deviceScaleFactor: 1,
        mobile: false,
      });
      await c.send('Page.navigate', { url: origin });
      await c.wait("!!document.querySelector('input[name=username]')");
      await c.read(
        `(()=>{document.querySelector('[name=username]').value=${JSON.stringify(username)};document.querySelector('[name=password]').value=${JSON.stringify(password)};document.querySelector('form').requestSubmit();})()`,
      );
      await c.wait("!!document.querySelector('nav')");
      return c;
    }
    const c = await device('owner');
    const sizes = [
      [360, 800],
      [390, 844],
      [430, 932],
      [768, 1024],
      [1024, 768],
      [1280, 800],
      [1440, 900],
      [1600, 900],
    ];
    await c.send('Emulation.setTouchEmulationEnabled', {
      enabled: true,
      maxTouchPoints: 5,
    });
    await c.send('Emulation.setEmulatedMedia', {
      features: [{ name: 'prefers-reduced-motion', value: 'reduce' }],
    });
    async function resize(width, height) {
      await c.send('Emulation.setDeviceMetricsOverride', {
        width,
        height,
        deviceScaleFactor: 1,
        mobile: true,
      });
      await c.read(
        'new Promise(resolve=>{setTimeout(resolve,150);requestAnimationFrame(()=>requestAnimationFrame(resolve))})',
      );
      await c.wait(
        "Math.abs(parseFloat(getComputedStyle(document.documentElement).getPropertyValue('--usable-height')) - (visualViewport?.height ?? innerHeight)) < 1",
      );
    }
    async function tap(selector) {
      await c.read(
        `document.querySelector(${JSON.stringify(selector)})?.scrollIntoView({block:'center',inline:'nearest'})`,
      );
      await c.read(
        'new Promise(resolve=>{setTimeout(resolve,150);requestAnimationFrame(()=>requestAnimationFrame(resolve))})',
      );
      const point = await c.read(
        `(()=>{const e=document.querySelector(${JSON.stringify(selector)});if(!e)throw Error('Missing touch target: '+${JSON.stringify(selector)});e.scrollIntoView({block:'center',inline:'nearest'});const r=e.getBoundingClientRect();const x=r.x+r.width/2,y=r.y+r.height/2;const top=document.elementFromPoint(x,y);if(!top||!(e===top||e.contains(top)))throw Error('Obscured touch target: '+${JSON.stringify(selector)}+' text='+e.textContent+' top='+top?.outerHTML.slice(0,180)+' bounds='+JSON.stringify({x,y,w:innerWidth,h:innerHeight}));if(r.width<43||r.height<43)throw Error('Small touch target: '+${JSON.stringify(selector)});return {x,y};})()`,
      );
      await c.send('Input.dispatchTouchEvent', {
        type: 'touchStart',
        touchPoints: [point],
      });
      await c.send('Input.dispatchTouchEvent', {
        type: 'touchEnd',
        touchPoints: [],
      });
    }
    async function button(text) {
      await c.wait(
        `!![...document.querySelectorAll('button')].find(b=>b.textContent.trim()===${JSON.stringify(text)}&&!b.disabled)`,
      );
      await c.read(
        `(()=>{document.querySelectorAll('[data-touch-target]').forEach(e=>e.removeAttribute('data-touch-target'));const e=[...document.querySelectorAll('button')].find(e=>e.textContent.trim()===${JSON.stringify(text)}&&e.getClientRects().length&&!e.closest('details:not([open])'));if(!e)throw Error('Missing button '+${JSON.stringify(text)});e.dataset.touchTarget='1';})()`,
      );
      await tap('[data-touch-target]');
    }
    async function go(route, selector) {
      const narrow = await c.read('innerWidth<900');
      if (narrow) {
        // Native OS select choice: dispatch the same change event after selecting an available option.
        await c.read(
          `(()=>{const e=document.querySelector('select[aria-label="Workspace"]');e.value=${JSON.stringify(route)};e.dispatchEvent(new Event('change',{bubbles:true}));})()`,
        );
      } else await tap(`nav[aria-label="Workspaces"] a[href="#${route}"]`);
      await c.wait(`!!document.querySelector(${JSON.stringify(selector)})`);
      if (route === '/dashboard' || route === '/reports')
        await c.wait(
          `document.querySelector('.reports-workspace h1')?.textContent === ${JSON.stringify(route === '/dashboard' ? 'Dashboard' : 'Reports')}`,
        );
    }
    const report = [];
    async function inspect(label, width, height, screenshot = false) {
      const result = await c.read(
        `(()=>{const modal=document.querySelector('dialog:modal');const root=modal||document;const visible=e=>e.getClientRects().length&&getComputedStyle(e).visibility!=='hidden';return {pageWidth:document.documentElement.scrollWidth,viewport:innerWidth,smallTargets:[...root.querySelectorAll('button,summary,input,select,nav[aria-label="Workspaces"] a')].filter(visible).filter(e=>!e.disabled).filter(e=>{const r=(e.type==='checkbox'?e.closest('label'):e).getBoundingClientRect();return r.height<43||r.width<43}).map(e=>e.getAttribute('aria-label')||e.textContent.trim().slice(0,40)||e.name),overflow:modal?modal.scrollWidth>modal.clientWidth+1:false,modalBounds:modal?(()=>{const r=modal.getBoundingClientRect();return r.top>=-1&&r.bottom<=innerHeight+1&&r.left>=-1&&r.right<=innerWidth+1})():true}})()`,
      );
      assert.ok(
        result.pageWidth <= result.viewport + 1,
        `${label} ${width}: page overflow ${result.pageWidth}`,
      );
      assert.deepEqual(
        result.smallTargets,
        [],
        `${label} ${width}: small targets`,
      );
      assert.equal(
        result.overflow,
        false,
        `${label} ${width}: dialog overflow`,
      );
      assert.ok(
        result.modalBounds,
        `${label} ${width}: dialog outside viewport`,
      );
      console.log(`Checked ${label} ${width}x${height}`);
      report.push({ label, width, height, ...result });
      if (screenshot) {
        if (label === 'mixed-explanation' || label === 'money-boundary')
          await c.read(
            "document.querySelector('.owner-money').scrollIntoView({block:'start'})",
          );
        else if (label === 'sales-trend')
          await c.read(
            "document.querySelector('.report-trend').closest('section').scrollIntoView({block:'start'})",
          );
        else if (label === 'items')
          await c.read(
            "document.querySelector('.report-items').scrollIntoView({block:'start'})",
          );
        else await c.read('window.scrollTo(0,0)');
        const shot = await c.send('Page.captureScreenshot', {
          format: 'png',
          captureBeyondViewport: false,
        });
        fs.writeFileSync(
          `/tmp/dukanos-daily-${label}-${width}.png`,
          Buffer.from(shot.data, 'base64'),
        );
      }
    }

    const config = (await c.http('/expense-categories')).body;
    const date = new Date(
      Date.parse(config.currentBusinessDate + 'T00:00:00Z') - 86400000,
    )
      .toISOString()
      .slice(0, 10);
    await ownerCall('/expenses', {
      requestId: randomUUID(),
      amount: '1250.50',
      categoryId: config.categories[0].id,
      paymentMethod: 'CASH',
      businessDate: date,
      vendor: 'Local supplier with a very long readable name',
      note: 'Fresh bread <plain text> & supplies',
    });
    const {
      RestaurantClock,
    } = require('../apps/api/dist/database/restaurant-clock');
    const clock = app.get(RestaurantClock),
      realRead = clock.read.bind(clock);
    clock.read = async () => ({
      business_date: date,
      queued_at: new Date(date + 'T12:00:00+05:30'),
    });
    const category = await ownerCall('/menu/categories', {
      name: 'Report browser dishes',
    });
    const dish = await ownerCall('/menu/items', {
      name: 'Soya Chaap Butter Masala with a Long Historical Dish Name',
      categoryId: category.id,
      variants: ['Half', 'Full'].map((name) => ({
        name,
        channels: [
          { channelCode: 'COUNTER', price: '100.50', available: true },
        ],
      })),
    });
    await ownerCall('/orders/counter', {
      requestId: randomUUID(),
      serviceType: 'DINE_IN',
      lines: dish.variants.map((v, i) => ({
        variantId: v.id,
        quantity: i + 1,
      })),
    });
    clock.read = realRead;
    const {
      EmailDeliveryAdapter,
    } = require('../apps/api/dist/modules/daily-reports/email-adapter');
    const {
      DailyWorkerService,
    } = require('../apps/api/dist/modules/daily-reports/daily-worker.service');
    const adapter = app.get(EmailDeliveryAdapter),
      worker = app.get(DailyWorkerService);
    adapter.config.smtp = {
      host: '127.0.0.1',
      port: 1,
      secure: false,
      from: 'test@example.com',
      name: 'Test',
    };
    adapter.send = async () => '<browser-fixture@local>';
    for (const [width, height] of [
      [390, 844],
      [768, 1024],
      [1024, 768],
      [1440, 900],
    ]) {
      await resize(width, height);
      await go('/dashboard', '.reports-workspace');
      await go('/reports', '.reports-workspace');
      await button('Daily Reports');
      await c.wait(
        "!!document.querySelector('.daily-reports input[type=date]')",
      );
      await button('Settings');
      await c.wait("!!document.querySelector('.daily-reports textarea')");
      await c.fill(
        '.daily-reports textarea',
        'owner@example.com\npartner@example.com',
      );
      await button('Save settings');
      await c.wait("document.body.textContent.includes('Settings saved.')");
      await c.read(
        "(()=>{const e=document.querySelector('.daily-reports select');e.value='owner@example.com';e.dispatchEvent(new Event('change',{bubbles:true}));})()",
      );
      await button('Send Test Email');
      await c.wait("document.body.textContent.includes('PENDING')");
      while (await worker.deliverOne()) {
        /* Drain every recipient job before the next action. */
      }
      await button('Refresh');
      await c.wait("document.body.textContent.includes('SENT')");
      await inspect('settings', width, height, true);
      await button('History');
      await c.fill('.daily-reports input[type=date]', date);
      await button('Generate report');
      await c.wait("document.body.textContent.includes('Version 1')");
      assert.ok((await c.read('document.body.textContent')).includes('1250.5'));
      await inspect('snapshot', width, height, true);
      await c.fill(
        '.daily-reports textarea',
        'Missing historical expense review ' + width,
      );
      await button('Regenerate Report');
      await c.wait(
        `document.body.textContent.includes('Reason: Missing historical expense review ${width}')`,
      );
      await button('Send Email');
      await c.wait("document.body.textContent.includes('PENDING')");
      while (await worker.deliverOne()) {
        /* Drain every recipient job before the next action. */
      }
      await button('Refresh');
      await c.wait(
        "!![...document.querySelectorAll('button')].find(b=>b.textContent==='Resend Email')",
      );
      await tap('.daily-check');
      await button('Resend Email');
      await c.wait("document.body.textContent.includes('PENDING')");
      while (await worker.deliverOne()) {
        /* Drain every recipient job before the next action. */
      }
      while (await worker.deliverOne()) {
        /* Drain every recipient job before the next action. */
      }
      while (await worker.deliverOne()) {
        /* Drain every recipient job before the next action. */
      }
      await button('Refresh');
      await inspect('revised-delivery', width, height, true);
      await button('History');
      await inspect('history', width, height, true);
      console.log(`Daily Reports touch workflow PASS ${width}x${height}`);
    }
    for (const [width, height] of [...sizes, [390, 420]]) {
      await resize(width, height);
      await button('History');
      await inspect('history-boundary', width, height, true);
      await button('Open report');
      await c.wait("!!document.querySelector('.daily-reports textarea')");
      await inspect('detail-boundary', width, height, true);
      await button('Settings');
      await c.wait("!!document.querySelector('.daily-reports select')");
      await inspect('settings-boundary', width, height, true);
    }
    for (const name of ['cashier', 'manager', 'cook', 'dispatcher']) {
      const other = await device(name);
      assert.equal(
        (await other.http('/daily-reports')).status,
        name === 'manager' ? 200 : 403,
      );
    }
    const {
      renderReport,
    } = require('../apps/api/dist/modules/daily-reports/report-email');
    const history = (await c.http('/daily-reports')).body.reports;
    const snapshot = (await c.http('/daily-reports/' + history[0].id)).body;
    assert.equal(snapshot.snapshot.bestSeller.quantity, '3');
    const html = renderReport(snapshot.snapshot, snapshot.version).html;
    const tree = await c.send('Page.getFrameTree');
    await c.send('Page.setDocumentContent', {
      frameId: tree.frameTree.frame.id,
      html,
    });
    for (const [width, height] of [
      [390, 844],
      [768, 1024],
      [1440, 900],
    ]) {
      await c.send('Emulation.setDeviceMetricsOverride', {
        width,
        height,
        deviceScaleFactor: 1,
        mobile: true,
      });
      await c.read('new Promise(r=>setTimeout(r,150))');
      await inspect('email-template', width, height, true);
    }
    assert.deepEqual(external, []);
    assert.deepEqual(failures, []);
    fs.writeFileSync(
      '/tmp/dukanos-daily-results.json',
      JSON.stringify(report, null, 2),
    );
    console.log(
      'Daily Reports browser PASS: generation, stored detail, regeneration, settings, test/send/resend, all device classes and boundaries; local traffic only.',
    );
  } finally {
    for (const c of clients) c.socket.close();
    browser?.socket.close();
    if (chrome) {
      if (chrome.exitCode === null && chrome.signalCode === null) {
        chrome.kill();
        await new Promise((r) => chrome.once('exit', r));
      }
    }
    if (app) await app.close();
    await admin.query(`DROP SCHEMA "${schema}" CASCADE`);
    await admin.end();
    fs.rmSync(profile, { recursive: true, force: true });
  }
})().catch((e) => {
  console.error(e.message);
  process.exitCode = 1;
});
