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
  const schema = 'expenses_browser_' + randomUUID().replaceAll('-', '');
  await admin.query(`CREATE SCHEMA "${schema}"`);
  const url = new URL(process.env.DATABASE_URL);
  url.searchParams.set('options', `-csearch_path=${schema}`);
  process.env.DATABASE_URL = url.toString();
  const profile = fs.mkdtempSync('/tmp/dukanos-expenses-');
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
    const category = await ownerCall('/menu/categories', {
      name: 'Kitchen dishes',
    });
    const menu = {};
    for (const [name, price] of [
      ['Meal', '500'],
      ['Snack', '300'],
      ['Pasta', '170'],
      ['Noodles', '120'],
    ]) {
      menu[name] = await ownerCall('/menu/items', {
        categoryId: category.id,
        name:
          name === 'Meal'
            ? 'Meal with Soya Chaap Butter Masala and Extra Long Restaurant Special Name'
            : name,
        variants: [
          {
            name: 'Full',
            channels: [{ channelCode: 'COUNTER', price, available: true }],
          },
        ],
      });
    }
    const create = (name, extra = {}) =>
      ownerCall('/orders/counter', {
        requestId: randomUUID(),
        ...(extra.billId ? {} : { serviceType: 'DINE_IN' }),
        ...extra,
        lines: [{ variantId: menu[name].variants[0].id, quantity: 1 }],
      });
    const pay = (o, amount, method) =>
      ownerCall(`/bills/${o.billId}/payments`, {
        requestId: randomUUID(),
        amount,
        method,
      });
    async function replace(o, name) {
      const body = {
        requestId: randomUUID(),
        expectedRevision: 0,
        kind: 'CHANGE',
        reason: 'CUSTOMER_CHANGE',
        lines: [
          {
            id: o.items[0].id,
            variantId: menu[name].variants[0].id,
            quantity: 1,
            instruction: '',
          },
        ],
      };
      const quote = await ownerCall(`/orders/${o.id}/amendments/quote`, body);
      await ownerCall(`/orders/${o.id}/amendments`, {
        ...body,
        quoteHash: quote.quoteHash,
      });
    }
    const a = await create('Meal');
    const b = await create('Snack', { serviceType: 'TAKEAWAY' });
    await pay(a, '500', 'CASH');
    await pay(b, '200', 'UPI');
    const amended = await create('Pasta');
    await pay(amended, '170', 'UPI');
    await replace(amended, 'Noodles');
    await ownerCall(`/bills/${amended.billId}/refunds`, {
      requestId: randomUUID(),
      amount: '50',
    });
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
          `/tmp/dukanos-expenses-${label}-${width}.png`,
          Buffer.from(shot.data, 'base64'),
        );
      }
    }

    const select = async (selector, value) =>
      c.read(
        `(()=>{const e=document.querySelector(${JSON.stringify(selector)});e.value=${JSON.stringify(value)};e.dispatchEvent(new Event('change',{bubbles:true}));})()`,
      );

    async function metric(key, value) {
      await c.wait(
        `document.querySelector('[data-metric="${key}"]')?.textContent===${JSON.stringify(value)}`,
      );
    }
    const loaded = () =>
      c.wait(
        "!!document.querySelector('.report-period') && !document.querySelector('.reports-workspace [role=status]')",
      );
    const expenseConfig = (await c.http('/expense-categories')).body;
    const vegetables = expenseConfig.categories.find(
      (x) => x.name === 'Vegetables / Raw Material',
    ).id;
    const bread = expenseConfig.categories.find(
      (x) => x.name === 'Bread / Bakery',
    ).id;
    const today = expenseConfig.currentBusinessDate;
    const yesterday = new Date(Date.parse(today + 'T00:00:00Z') - 86400000)
      .toISOString()
      .slice(0, 10);
    let total = 0n;
    const currency = (n) =>
      '₹' +
      (n / 100n).toString() +
      (n % 100n ? '.' + (n % 100n).toString().padStart(2, '0') : '');
    const expenseLoaded = () =>
      c.wait(
        "!!document.querySelector('.expense-period') && !!document.querySelector('[data-expense-total]')",
      );
    const expenseTotal = () =>
      c.wait(
        `document.querySelector('[data-expense-total]')?.textContent===${JSON.stringify(currency(total))}`,
      );
    async function entry(value, cat, method = 'Cash', date) {
      await button('Add Expense');
      await c.wait(
        '!!document.querySelector(\'[aria-label="Expense amount"]\')',
      );
      await c.fill('[aria-label="Expense amount"]', value);
      await select('[aria-label="Expense category"]', cat);
      await button(method);
      if (date) await c.fill('[aria-label="Expense business date"]', date);
      await c.fill(
        '[aria-label="Expense vendor"]',
        'Fresh Market ' + 'long vendor name '.repeat(4),
      );
      await c.fill(
        '[aria-label="Expense note"]',
        'Morning purchase <plain text>',
      );
    }
    for (const [width, height] of [
      [390, 844],
      [768, 1024],
      [1024, 768],
      [1440, 900],
    ]) {
      await resize(width, height);
      await go('/expenses', '.expenses-workspace');
      await expenseLoaded();
      await entry('1250', vegetables);
      await inspect('entry', width, height, true);
      // Native file input is filled through CDP with a local generated image.
      const sharp = require('sharp');
      const receiptFile = profile + '/receipt.png';
      await sharp({
        create: {
          width: 1200,
          height: 1800,
          channels: 3,
          background: '#fafafa',
        },
      })
        .png()
        .toFile(receiptFile);
      const document = (await c.send('DOM.getDocument')).root.nodeId;
      const input = (
        await c.send('DOM.querySelector', {
          nodeId: document,
          selector: 'input[type=file]',
        })
      ).nodeId;
      await c.send('DOM.setFileInputFiles', {
        nodeId: input,
        files: [receiptFile],
      });
      await c.wait("!!document.querySelector('.expense-receipt-preview img')");
      await button('Save Expense');
      await c.wait("!!document.querySelector('.expense-detail')");
      assert.ok(
        await c.read(
          "document.querySelector('.expense-detail').textContent.includes('₹1250') && !!document.querySelector('.expense-receipt-link')",
        ),
      );
      total += 125000n;
      await inspect('receipt-detail', width, height, true);
      await button('Back to expenses');
      await expenseLoaded();
      await expenseTotal();
      await entry('600', bread, 'UPI');
      // Double submission uses the synchronous in-flight guard and server idempotency.
      await c.read(
        "document.querySelector('.expense-entry').requestSubmit();document.querySelector('.expense-entry').requestSubmit()",
      );
      await c.wait("!!document.querySelector('.expense-detail')");
      total += 60000n;
      await button('Back to expenses');
      await expenseLoaded();
      await expenseTotal();
      await button('Manage categories');
      await c.fill(
        '[aria-label="Expense category name"]',
        'Staff Tea ' + width,
      );
      await button('Save category');
      await c.wait(
        `document.querySelector('.expense-category-list').textContent.includes('Staff Tea ${width}')`,
      );
      const tea = (await c.http('/expense-categories')).body.categories.find(
        (x) => x.name === 'Staff Tea ' + width,
      );
      await button('Back to expenses');
      await expenseLoaded();
      await entry('150', tea.id);
      await button('Save Expense');
      await c.wait("!!document.querySelector('.expense-detail')");
      total += 15000n;
      await tap('.expense-void summary');
      await select('[aria-label="Expense void reason"]', 'WRONG_AMOUNT');
      await c.fill(
        '[aria-label="Expense void note"]',
        'Correct value entered separately',
      );
      await button('Confirm void');
      await c.wait("!!document.querySelector('.expense-void-audit')");
      total -= 15000n;
      await inspect('void-audit', width, height, true);
      await button('Back to expenses');
      await expenseLoaded();
      await expenseTotal();
      await button('Manage categories');
      await button('Edit Staff Tea ' + width);
      await c.fill(
        '[aria-label="Expense category name"]',
        'Tea renamed ' + width,
      );
      await tap('.expense-checkbox');
      await button('Save category');
      await c.wait(
        `document.querySelector('.expense-category-list').textContent.includes('Tea renamed ${width} · Inactive')`,
      );
      await button('Back to expenses');
      await expenseLoaded();
      await entry('25.50', bread, 'Cash', yesterday);
      assert.ok(
        await c.read("!!document.querySelector('.expense-historical')"),
      );
      await button('Save Expense');
      await c.wait("!!document.querySelector('.expense-detail')");
      assert.ok(
        await c.read(
          `document.querySelector('.expense-detail').textContent.includes(${JSON.stringify(yesterday)})`,
        ),
      );
      await button('Back to expenses');
      await expenseLoaded();
      await expenseTotal();
      await select('[aria-label="Expense period"]', 'YESTERDAY');
      await c.wait(
        `document.querySelector('.expense-period').textContent.startsWith(${JSON.stringify(yesterday)})`,
      );
      await select('[aria-label="Expense period"]', 'LAST_7_DAYS');
      await expenseLoaded();
      await select('[aria-label="Expense period"]', 'THIS_MONTH');
      await expenseLoaded();
      await select('[aria-label="Expense period"]', 'CUSTOM');
      await c.fill('[aria-label="Expense from"]', today);
      await c.fill('[aria-label="Expense to"]', today);
      await button('Apply expense dates');
      await expenseTotal();
      await c.fill('[aria-label="Search expenses"]', 'no matching expense');
      await c.wait(
        "document.body.textContent.includes('No entries match these filters.')",
      );
      await c.fill('[aria-label="Search expenses"]', '');
      await expenseTotal();
      await go('/dashboard', '.reports-workspace');
      await loaded();
      await metric('sales', '₹920');
      await metric('net', '₹820');
      await metric('expenses', currency(total));
      await go('/reports', '.report-tabs');
      await loaded();
      await button('Expenses');
      await c.wait("!!document.querySelector('.expense-trend')");
      await expenseTotal();
      await inspect('expense-report', width, height, true);
      console.log(
        `Expenses workflow PASS ${width}x${height}: receipt, Cash/UPI, double submit, category rename/deactivate, void audit, dates, search, Dashboard independence and report.`,
      );
    }
    for (const [width, height] of [...sizes, [390, 420]]) {
      await resize(width, height);
      await go('/expenses', '.expenses-workspace');
      await expenseLoaded();
      await inspect('list-boundary', width, height, true);
      await entry('1.50', vegetables);
      await inspect('entry-boundary', width, height, true);
      await button('Back to expenses');
      await button('Manage categories');
      await inspect('categories-boundary', width, height);
      await button('Back to expenses');
      await go('/reports', '.report-tabs');
      await loaded();
      await button('Expenses');
      await c.wait("!!document.querySelector('.expense-trend')");
      await inspect('report-boundary', width, height);
    }
    for (const name of ['cashier', 'manager', 'cook', 'dispatcher']) {
      const other = await device(name);
      const allowed = ['cashier', 'manager'].includes(name);
      assert.equal((await other.http('/expenses')).status, allowed ? 200 : 403);
      assert.equal(
        (await other.http('/reports/expenses')).status,
        name === 'manager' ? 200 : 403,
      );
      await other.read("location.hash='/expenses'");
      if (allowed) {
        await other.wait("!!document.querySelector('.expenses-workspace')");
        await other.wait("!!document.querySelector('.expense-period')");
        assert.equal(
          await other.read(
            "[...document.querySelectorAll('button')].some(b=>b.textContent==='Manage categories')",
          ),
          name === 'manager',
        );
      } else
        await other.wait(
          "document.body.textContent.includes('Workspace unavailable')",
        );
    }
    assert.deepEqual(external, []);
    assert.deepEqual(failures, []);
    fs.writeFileSync(
      '/tmp/dukanos-expenses-results.json',
      JSON.stringify(report, null, 2),
    );
    console.log(
      'Expenses browser PASS: four touch workflows, all eight sizes and constrained height, local receipts, category/void permissions, exact Reports and unchanged customer money, external traffic blocked.',
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
