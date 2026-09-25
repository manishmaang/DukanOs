// Real Chromium + isolated PostgreSQL fixture. No changes to restaurant data.
require('reflect-metadata');
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
  const schema = 'responsive_browser_' + randomUUID().replaceAll('-', '');
  await admin.query(`CREATE SCHEMA "${schema}"`);
  const url = new URL(process.env.DATABASE_URL);
  url.searchParams.set('options', `-csearch_path=${schema}`);
  process.env.DATABASE_URL = url.toString();
  const profile = fs.mkdtempSync('/tmp/dukanos-responsive-');
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
      multi: ['CASHIER', 'DISPATCH'],
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
      assert.equal(r.status, 201);
      return r.json();
    }
    const category = await ownerCall('/menu/categories', {
      name: 'Kitchen dishes',
    });
    for (const [name, variants] of [
      ['Manchurian', ['Half', 'Full']],
      ['Soya Chaap Gravy', ['Half', 'Full']],
    ])
      await ownerCall('/menu/items', {
        categoryId: category.id,
        name,
        variants: variants.map((name) => ({
          name,
          channels: ['COUNTER', 'ZOMATO', 'SWIGGY'].map((channelCode) => ({
            channelCode,
            price: '100',
            available: true,
          })),
        })),
      });
    chrome = spawn(
      process.env.CHROME_BINARY,
      [
        '--no-sandbox',
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
          pending.set(id, { resolve, reject });
          socket.send(JSON.stringify({ id, method, params }));
        });
      socket.addEventListener('message', (e) => {
        const m = JSON.parse(e.data);
        if (m.id) {
          const p = pending.get(m.id);
          pending.delete(m.id);
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
      c.hold = false;
      c.fail = false;
      c.held = [];
      c.payloads = [];
      c.handlers.push((m) => {
        if (m.method === 'Runtime.exceptionThrown')
          failures.push(m.params.exceptionDetails.text);
        if (m.method !== 'Fetch.requestPaused') return;
        const r = m.params,
          local =
            r.request.url.startsWith(origin) ||
            r.request.url.startsWith('data:');
        if (!local) external.push(r.request.url);
        if (
          r.request.url.endsWith('/api/orders/counter') &&
          r.request.method === 'POST'
        )
          c.payloads.push(JSON.parse(r.request.postData));
        const kitchen = r.request.url.endsWith('/api/dispatch/orders');
        if (kitchen && c.hold) {
          c.held.push(r.requestId);
          return;
        }
        void c
          .send(
            !local || (kitchen && c.fail)
              ? 'Fetch.failRequest'
              : 'Fetch.continueRequest',
            !local || (kitchen && c.fail)
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
        if (label === 'menu-prices')
          await c.read(
            "document.querySelector('.dish-prices').scrollIntoView({block:'start'})",
          );
        else if (label === 'staff-reset')
          await c.read(
            "document.querySelector('details[data-reset=current]').scrollIntoView({block:'start'})",
          );
        else await c.read('window.scrollTo(0,0)');
        const shot = await c.send('Page.captureScreenshot', {
          format: 'png',
          captureBeyondViewport: false,
        });
        fs.writeFileSync(
          `/tmp/dukanos-responsive-${label}-${width}.png`,
          Buffer.from(shot.data, 'base64'),
        );
      }
    }
    for (const [width, height] of sizes) {
      await resize(width, height);
      for (const [route, selector] of [
        ['/', 'main h1'],
        ['/account/password', 'input[name=currentPassword]'],
        ['/pos', '.pos-card'],
        ['/menu', '.dish-link'],
        ['/kitchen', '.kds-columns'],
        ['/dispatch', '.dispatch'],
        ['/admin', 'input[name=username]'],
      ]) {
        await go(route, selector);
        await inspect(
          route.replaceAll('/', '-') || 'home',
          width,
          height,
          width === 390 || width === 1024,
        );
        if (route === '/pos') {
          await tap('.pos-card');
          await c.wait("!!document.querySelector('.pos-portions[open]')");
          await inspect(
            'portions',
            width,
            height,
            width === 390 || width === 1024,
          );
          await tap('.pos-close');
        }
        if (route === '/menu') {
          await tap('.dish-link');
          await c.wait("!!document.querySelector('.dish-editor')");
          await inspect(
            'dish-editor',
            width,
            height,
            width === 390 || width === 1024,
          );
        }
        if (route === '/kitchen') {
          await button('Availability');
          await c.wait("!!document.querySelector('.availability-dish')");
          await inspect(
            'availability',
            width,
            height,
            width === 390 || width === 1024,
          );
          await button('Close');
          await button('Production View');
          await inspect('production', width, height);
        }
      }
    }
    const imageFile = profile + '/fixture.png';
    await require('sharp')({
      create: { width: 40, height: 30, channels: 3, background: '#b8692b' },
    })
      .png()
      .toFile(imageFile);
    let token = 0;
    for (const [width, height] of [
      [390, 844],
      [768, 1024],
      [1024, 768],
      [1440, 900],
    ]) {
      await resize(width, height);
      // Log out and sign in using touch controls at each representative size.
      await button('Sign out');
      await c.wait("!!document.querySelector('input[name=username]')");
      await inspect('login', width, height, true);
      await c.fill('[name=username]', 'owner');
      await c.fill('[name=password]', password);
      await button('Sign in');
      await c.wait("!!document.querySelector('nav')");
      // Menu edit, labelled channel prices, independent availability, file picker and one save.
      await go('/menu', '.dish-link');
      await button('+ Add Category');
      await c.fill(
        '.category-editor input[name=name]',
        'Responsive category ' + width,
      );
      await button('Save category');
      await c.wait("!document.querySelector('.category-editor')");
      await c.fill('.menu-search input', 'Manchurian');
      await tap('.dish-link');
      await c.wait("!!document.querySelector('.dish-editor')");
      await button('+ Add variant');
      const portionCount = await c.read(
        "document.querySelectorAll('.dish-prices tbody tr').length",
      );
      await c.fill(
        `[aria-label="Portion ${portionCount} name"]`,
        'Extra ' + width,
      );
      await c.fill(`[aria-label="Extra ${width} Counter price"]`, '50');
      await tap(
        `label:has(input[aria-label="Extra ${width} available on Counter"])`,
      );
      await c.fill('[aria-label="Half Counter price"]', '101');
      await tap('label:has(input[aria-label="Half available on Swiggy"])');
      const doc = await c.send('DOM.getDocument');
      const fileNode = await c.send('DOM.querySelector', {
        nodeId: doc.root.nodeId,
        selector: 'input[type=file]',
      });
      await c.send('DOM.setFileInputFiles', {
        nodeId: fileNode.nodeId,
        files: [imageFile],
      });
      await c.wait(
        "document.querySelector('.dish-photo-editor img')?.src.startsWith('blob:')",
      );
      await inspect('menu-prices', width, height, true);
      await button('Save Changes');
      await c.wait(
        "document.querySelector('.menu-success')?.textContent.includes('saved')",
      );
      await button('Remove photo');
      await button('Save Changes');
      await c.wait("!document.querySelector('.dish-photo-editor img')");
      // POS category/search, two variants with distinct notes and a touch cart.
      await go('/pos', '.pos-card');
      await button('Kitchen dishes');
      await c.fill('.pos-search input', 'Manchurian');
      await tap('.pos-card');
      await c.wait("!!document.querySelector('.pos-portions[open]')");
      for (const [variant, note] of [
        ['Half', 'No onion'],
        ['Full', 'Extra spicy'],
      ]) {
        await tap(
          `.pos-portions button[aria-label="Increase ${variant} quantity"]`,
        );
        await tap(
          `.pos-portions button[aria-label="Add instruction for Manchurian / ${variant}"]`,
        );
        await c.fill(
          `textarea[aria-label="Instruction for Manchurian / ${variant}"]`,
          note,
        );
        if (width === 390 && variant === 'Half') {
          await resize(width, 420);
          await inspect('portion-keyboard', width, 420, true);
        }
        await button('Done');
        if (width === 390 && variant === 'Half') await resize(width, height);
      }
      await tap('.portion-add');
      await c.wait("!document.querySelector('.pos-portions')");
      if (width < 900) await tap('.mobile-order-trigger');
      await c.wait(
        "document.querySelector('.cart-line')?.getBoundingClientRect().width>0",
      );
      await tap('.cart-line button[aria-label="Increase Half quantity"]');
      await tap(
        '.cart-line button[aria-label="Edit instruction for Manchurian / Half"]',
      );
      await c.fill('.cart-line textarea', 'No onion, pack separately');
      if (width === 390) {
        await resize(width, 420);
        await inspect('cart-keyboard', width, 420, true);
      }
      await button('Done');
      if (width === 390) await resize(width, height);
      // Changing orientation preserves the same cart, instructions and confirmation identity.
      if (width === 390) {
        await resize(1024, 768);
        await c.wait(
          "document.querySelector('.cart-line')?.getBoundingClientRect().width>0",
        );
        await resize(width, height);
        await c.wait("!!document.querySelector('.cart-dialog:modal')");
      }
      await inspect('cart', width, height, true);
      assert.deepEqual(
        await c.read(
          "[...document.querySelectorAll('.cart-line .instruction-text')].map(e=>e.textContent)",
        ),
        ['Note: No onion, pack separately', 'Note: Extra spicy'],
      );
      await tap('.cart-remove');
      assert.equal(
        await c.read("document.querySelectorAll('.cart-line').length"),
        1,
      );
      await tap('.confirm-order');
      await c.wait(
        "!!document.querySelector('.payment-review .payment-choices')",
      );
      await button('Pay Later');
      token++;
      await c.wait(
        `document.querySelector('.order-token')?.textContent==='TOKEN #${token}'`,
      );
      await inspect('token', width, height, true);
      await button('New Order');
      // Kitchen actual transition, production, search and availability round-trip.
      await go('/kitchen', '.kds-card');
      await inspect('kitchen-orders', width, height, true);
      await button('Production View');
      await inspect('kitchen-production', width, height, true);
      await button('Order View');
      await button('Availability');
      await c.wait("!!document.querySelector('.availability-dish')");
      await c.fill('.kds-availability input', 'Manchurian');
      await tap('button[aria-label="Manchurian / Half: Mark sold out"]');
      await c.wait(
        '!!document.querySelector(\'button[aria-label="Manchurian / Half: Make available"]\')',
      );
      await tap('button[aria-label="Manchurian / Half: Make available"]');
      await c.wait(
        '!!document.querySelector(\'button[aria-label="Manchurian / Half: Mark sold out"]\')',
      );
      await button('Close');
      await button('Start Order');
      await c.wait("!!document.querySelector('.kds-preparing .kds-card')");
      await button('Mark Ready');
      await c.wait("!document.querySelector('.kds-card')");
      await go('/dispatch', '.dispatch-card');
      await inspect('dispatch-ready', width, height, true);
      await button('Handed Over');
      await c.wait(
        "document.querySelector('.dispatch')?.textContent.includes('No orders waiting')",
      );
      // Staff create, operational role union, access reason and reset password.
      await go('/admin', 'input[name=username]');
      await c.fill(
        'input[name=name]',
        'Long staff name for responsive audit ' + width,
      );
      await c.fill('input[name=username]', 'responsive' + width);
      await c.fill('input[name=password]', password);
      await c.read(
        "document.querySelector('.role-options label:nth-child(2)').dataset.touchTarget='role2'",
      );
      await tap('[data-touch-target="role2"]');
      await tap('.role-options label:nth-child(3)');
      await button('Create staff account');
      await c.wait(
        "document.body.textContent.includes('Staff account created.')",
      );
      await c.wait(
        `[...document.querySelectorAll('summary')].some(e=>e.textContent.includes('responsive${width}')&&!e.textContent.includes('Reset password'))`,
      );
      await c.read(
        `(()=>{document.querySelectorAll('details').forEach(e=>{if(e.querySelector('summary')?.textContent.includes('responsive${width}')&&!e.querySelector('summary').textContent.includes('Reset password'))e.dataset.staff='current';});})()`,
      );
      await tap('details[data-staff=current] summary');
      await c.fill(
        'details[data-staff=current] input:not([type=checkbox])',
        'Responsive access check',
      );
      await tap('details[data-staff=current] .role-options label:nth-child(2)');
      await tap('details[data-staff=current] .inline');
      await button('Save access');
      await c.wait(
        `document.querySelector('details[data-staff=current]')===null`,
      );
      await button('Refresh reset list');
      await c.wait(
        `[...document.querySelectorAll('summary')].some(e=>e.textContent.includes('responsive${width}')&&e.textContent.includes('Reset password'))`,
      );
      const editedStaff = (await c.http('/users')).body.find(
        (u) => u.username === 'responsive' + width,
      );
      assert.equal(editedStaff.active, false);
      assert.deepEqual([...editedStaff.roles].sort(), ['CASHIER', 'DISPATCH']);
      // Reset remains possible for inactive operational staff; activation is preserved.
      await c.read(
        `(()=>{document.querySelectorAll('details').forEach(e=>{if(e.querySelector('summary')?.textContent.includes('responsive${width}')&&e.querySelector('summary').textContent.includes('Reset password'))e.dataset.reset='current';});})()`,
      );
      await tap('details[data-reset=current] summary');
      await c.fill(
        'details[data-reset=current] [name=newPassword]',
        password + 'new',
      );
      await c.fill(
        'details[data-reset=current] [name=confirmation]',
        password + 'new',
      );
      await c.fill(
        'details[data-reset=current] [name=reason]',
        'Responsive reset check',
      );
      await inspect('staff-reset', width, height, true);
      await button('Reset password');
      await c.wait(
        "document.body.textContent.includes('Password reset. The staff member must sign in again.')",
      );
      // Self-service validation and narrow keyboard-height forms remain reachable.
      await go('/account/password', 'input[name=currentPassword]');
      await c.fill('[name=currentPassword]', password);
      await c.fill('[name=newPassword]', password);
      await c.fill('[name=confirmation]', password + 'mismatch');
      await resize(width, 420);
      await inspect('keyboard-height', width, 420, true);
      await button('Change password and sign out');
      await c.wait(
        "document.body.textContent.includes('New password and confirmation must match.')",
      );
      await resize(width, height);
    }
    const longName = 'SOYA CHAAP BUTTER MASALA SPECIAL ' + 'X'.repeat(80);
    const longVariant = 'Family portion ' + 'L'.repeat(60);
    const longNote = 'No onion <b>plain text</b> ' + 'instruction '.repeat(39);
    const longCategory = await ownerCall('/menu/categories', {
      name: 'Long category ' + 'C'.repeat(80),
    });
    const longDish = await ownerCall('/menu/items', {
      categoryId: longCategory.id,
      name: longName,
      variants: [
        {
          name: longVariant,
          channels: [
            { channelCode: 'COUNTER', price: '123.45', available: true },
          ],
        },
      ],
    });
    const template = await ownerCall('/orders/counter', {
      requestId: randomUUID(),
      serviceType: 'DINE_IN',
      lines: [
        {
          variantId: longDish.variants[0].id,
          quantity: 99,
          instruction: longNote,
        },
      ],
    });
    // Historical queued record for static LATE styling; valid aggregate is committed before transitions.
    await admin.query(`SET search_path TO "${schema}"`);
    const old = randomUUID();
    await admin.query('BEGIN');
    await admin.query(
      `INSERT INTO orders SELECT (jsonb_populate_record(NULL::orders,to_jsonb(o)||jsonb_build_object('id',$2::text,'request_id',$3::text,'status','QUEUED','business_date','2000-01-01','queued_at','2000-01-01T10:00:00Z','token_number',1))).* FROM orders o WHERE id=$1`,
      [template.id, old, randomUUID()],
    );
    await admin.query(
      `INSERT INTO order_items SELECT (jsonb_populate_record(NULL::order_items,to_jsonb(i)||jsonb_build_object('id',gen_random_uuid(),'order_id',$2::text))).* FROM order_items i WHERE order_id=$1`,
      [template.id, old],
    );
    await admin.query(
      "INSERT INTO order_status_history VALUES($1,$2,'DRAFT','QUEUED',$3,'2000-01-01T10:00:00Z','Responsive late fixture')",
      [randomUUID(), old, template.confirmedBy],
    );
    await admin.query('COMMIT');
    for (const [width, height] of sizes) {
      await resize(width, height);
      await go('/pos', '.pos-card');
      await c.fill('.pos-search input', 'SOYA CHAAP BUTTER');
      await tap('.pos-card');
      await c.wait("!!document.querySelector('.pos-portions')");
      await inspect('long-portions', width, height, true);
      await tap('.pos-close');
      await go('/menu', '.dish-link');
      await c.fill('.menu-search input', 'SOYA CHAAP BUTTER');
      await tap('.dish-link');
      await c.wait("!!document.querySelector('.dish-editor')");
      await inspect('long-editor', width, height, true);
      await go('/kitchen', '.kds-late');
      await inspect('long-late-order', width, height, true);
      assert.ok(
        await c.read(
          `document.querySelector('.kds-instruction').textContent===${JSON.stringify(longNote.trim())}`,
        ),
      );
      await button('Production View');
      await inspect('long-production', width, height, true);
      assert.doesNotMatch(
        await c.read(
          "document.querySelector('.kds-production-sections').innerText",
        ),
        /Token #/,
      );
      await button('Availability');
      await c.wait("!!document.querySelector('.availability-dish')");
      await c.fill('.kds-availability input', 'SOYA CHAAP BUTTER');
      await inspect('long-availability', width, height, true);
      await button('Close');
    }
    await resize(390, 844);
    await go('/kitchen', '.kds');
    await button('Order View');
    await button('Start Order');
    await c.wait("!!document.querySelector('.kds-preparing .kds-card')");
    await button('Mark Ready');
    await c.wait("!document.querySelector('.kds-preparing .kds-card')");
    await go('/dispatch', '.dispatch-card');
    await inspect('long-dispatch', 390, 844, true);
    await button('Handed Over');
    await c.wait(
      "document.querySelector('.dispatch')?.textContent.includes('No orders waiting')",
    );
    await c.read("location.hash='/unavailable-fixture'");
    await c.wait(
      "document.querySelector('main h1')?.textContent==='Workspace unavailable'",
    );
    await inspect('unavailable', 390, 844, true);
    // Successful self password change signs out, then normal login works on a phone.
    await resize(390, 844);
    await go('/account/password', 'input[name=currentPassword]');
    await c.fill('[name=currentPassword]', password);
    await c.fill('[name=newPassword]', password + 'changed');
    await c.fill('[name=confirmation]', password + 'changed');
    await button('Change password and sign out');
    await c.wait("!!document.querySelector('input[name=username]')");
    await c.fill('[name=username]', 'owner');
    await c.fill('[name=password]', password + 'changed');
    await button('Sign in');
    await c.wait("!!document.querySelector('nav')");
    fs.writeFileSync(
      '/tmp/dukanos-responsive-results.json',
      JSON.stringify(report, null, 2),
    );
    assert.deepEqual(external, []);
    assert.deepEqual(failures, []);
    console.log(
      'Responsive PASS: all eight requested sizes; touch login/navigation, Menu prices/availability/image save, multi-variant notes/cart/edit/confirm/token, orientation, Kitchen production/START/READY/availability, Dispatch, staff create/role/access/reset, password validation and constrained-height forms. No page overflow or undersized visible targets; local traffic only.',
    );
  } finally {
    for (const c of clients) c.socket.close();
    browser?.socket.close();
    if (chrome) {
      chrome.kill();
      await new Promise((r) => chrome.once('exit', r));
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
