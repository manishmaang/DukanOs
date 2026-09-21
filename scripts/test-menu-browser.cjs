const root = require('node:path').resolve(__dirname, '..');
const chromeBinary = process.env.CHROME_BINARY;
if (!chromeBinary)
  throw new Error(
    'Set CHROME_BINARY to a local Chromium or Chrome executable.',
  );
const requireProject = require('node:module').createRequire(
  root + '/package.json',
);
requireProject('reflect-metadata');
const { Client } = requireProject('pg');
const { Test } = requireProject('@nestjs/testing');
const express = requireProject('express');
const { spawn, spawnSync } = require('node:child_process');
const { randomUUID } = require('node:crypto');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const { AppModule } = require(root + '/apps/api/dist/app.module');
const { configureApp } = require(root + '/apps/api/dist/configure-app');
const { UsersService } = require(
  root + '/apps/api/dist/modules/users/users.service',
);
(async () => {
  const original = process.env.DATABASE_URL;
  const admin = new Client({ connectionString: original });
  await admin.connect();
  const schema = 'menu_browser_' + randomUUID().replaceAll('-', '');
  await admin.query(`CREATE SCHEMA "${schema}"`);
  const url = new URL(original);
  url.searchParams.set('options', `-csearch_path=${schema}`);
  process.env.DATABASE_URL = url.toString();
  let app, chrome, ws;
  const profile = fs.mkdtempSync('/tmp/dukanos-chrome-');
  process.env.DUKANOS_DATA_DIR = profile + '/media';
  try {
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
    const users = app.get(UsersService);
    const password = randomUUID() + '!';
    const owner = await users.create({
      username: 'owner',
      name: 'Owner',
      password,
      roles: ['OWNER'],
    });
    for (const role of ['MANAGER', 'CASHIER', 'KITCHEN'])
      await users.create(
        { username: role.toLowerCase(), name: role, password, roles: [role] },
        owner,
      );
    chrome = spawn(
      chromeBinary,
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
      let output = '';
      chrome.stderr.on('data', (d) => {
        output += d;
        const m = output.match(/DevTools listening on (ws:\/\/\S+)/);
        if (m) resolve(m[1]);
      });
      chrome.on('error', reject);
    });
    const target = (
      await (
        await fetch(
          endpoint
            .replace('ws:', 'http:')
            .replace(/\/devtools\/browser\/.*/, '/json'),
        )
      ).json()
    )[0];
    ws = new globalThis.WebSocket(target.webSocketDebuggerUrl);
    await new Promise((r) => ws.addEventListener('open', r, { once: true }));
    let sequence = 0;
    const pending = new Map();
    const failures = [];
    const external = [];
    const writes = [];
    const command = (method, params = {}) =>
      new Promise((resolve, reject) => {
        const id = ++sequence;
        pending.set(id, { resolve, reject });
        ws.send(JSON.stringify({ id, method, params }));
      });
    ws.addEventListener('message', (e) => {
      const m = JSON.parse(e.data);
      if (m.id) {
        const p = pending.get(m.id);
        pending.delete(m.id);
        if (m.error) p.reject(new Error(JSON.stringify(m.error)));
        else p.resolve(m.result);
      } else if (m.method === 'Fetch.requestPaused') {
        const req = m.params;
        if (
          req.request.url.includes('/api/menu/items') &&
          ['POST', 'PUT'].includes(req.request.method)
        )
          writes.push(req.request.method);
        const local =
          req.request.url.startsWith(origin) ||
          req.request.url.startsWith('data:') ||
          req.request.url.startsWith('blob:');
        if (!local) external.push(req.request.url);
        void command(
          local ? 'Fetch.continueRequest' : 'Fetch.failRequest',
          local
            ? { requestId: req.requestId }
            : { requestId: req.requestId, errorReason: 'InternetDisconnected' },
        );
      } else if (m.method === 'Runtime.exceptionThrown')
        failures.push(m.params.exceptionDetails.text);
    });
    await command('Runtime.enable');
    await command('Fetch.enable', { patterns: [{ urlPattern: '*' }] });
    await command('Page.navigate', { url: origin });
    const evaluate = async (expression) => {
      const result = await command('Runtime.evaluate', {
        expression,
        awaitPromise: true,
        returnByValue: true,
      });
      if (result.exceptionDetails)
        throw new Error(JSON.stringify(result.exceptionDetails));
      return result.result.value;
    };
    const wait = async (expression) => {
      for (let i = 0; i < 100; i++) {
        if (await evaluate(expression)) return;
        await new Promise((r) => setTimeout(r, 100));
      }
      throw new Error(
        'Browser condition timed out: ' +
          expression +
          ' PAGE: ' +
          (await evaluate('document.body.innerText')),
      );
    };
    const login = async (role) => {
      await wait(
        "!document.querySelector('nav') && !!document.querySelector('input[name=username]')",
      );
      await evaluate(
        `(()=>{for(const [name,value] of Object.entries(${JSON.stringify({ username: '', password })})){const input=document.querySelector('input[name='+name+']');input.value=name==='username'?${JSON.stringify(role.toLowerCase())}:value;}document.querySelector('form').requestSubmit();})()`,
      );
      await wait("!!document.querySelector('nav')");
    };
    const http = async (method, path, body) =>
      evaluate(
        `fetch('/api/menu${path}',{method:${JSON.stringify(method)},headers:{'Content-Type':'application/json','X-DukanOS-Request':'1'},body:${body === undefined ? 'undefined' : JSON.stringify(JSON.stringify(body))}}).then(async r=>({status:r.status,body:await r.json()}))`,
      );
    const click = async (text) =>
      evaluate(
        `(()=>{const b=[...document.querySelectorAll('button')].find(b=>b.textContent.trim()===${JSON.stringify(text)});if(!b)throw Error('Button not found');b.click();})()`,
      );
    const fill = async (selector, value) =>
      evaluate(
        `(()=>{const e=document.querySelector(${JSON.stringify(selector)});if(!e)throw Error('Input not found: '+${JSON.stringify(selector)});const p=e.tagName==='TEXTAREA'?HTMLTextAreaElement.prototype:e.tagName==='SELECT'?HTMLSelectElement.prototype:HTMLInputElement.prototype;Object.getOwnPropertyDescriptor(p,'value').set.call(e,${JSON.stringify(value)});e.dispatchEvent(new Event(e.tagName==='SELECT'?'change':'input',{bubbles:true}));})()`,
      );
    const save = async () => {
      await click(
        await evaluate(
          "document.querySelector('.dish-save button').textContent",
        ),
      );
      await wait(
        "document.querySelector('.dish-save')?.textContent.includes('All changes saved')",
      );
    };

    const sharp = requireProject('sharp');
    const photoPath = profile + '/test-photo.jpg';
    const secondPath = profile + '/replacement.png';
    await sharp({
      create: { width: 1500, height: 1000, channels: 3, background: '#bd8234' },
    })
      .jpeg()
      .toFile(photoPath);
    await sharp({
      create: { width: 700, height: 500, channels: 3, background: '#5c943b' },
    })
      .png()
      .toFile(secondPath);
    const attach = async (path) => {
      const { root: dom } = await command('DOM.getDocument');
      const { nodeId } = await command('DOM.querySelector', {
        nodeId: dom.nodeId,
        selector: 'input[type=file]',
      });
      await command('DOM.setFileInputFiles', { nodeId, files: [path] });
      await wait(
        "document.querySelector('.dish-photo-editor img')?.src.startsWith('blob:')",
      );
    };
    const openMenu = async (name) => {
      await evaluate("location.hash='/menu'");
      await wait("!!document.querySelector('.menu-sidebar')");
      await evaluate(
        `[...document.querySelectorAll('.dish-link')].find(b=>b.textContent.includes(${JSON.stringify(name)})).click()`,
      );
      await wait(
        `document.querySelector('[name=itemName]')?.value===${JSON.stringify(name)}`,
      );
    };
    const openPOS = async () => {
      await evaluate("location.hash='/pos'");
      await wait("!!document.querySelector('.pos-card')");
    };
    await command('Emulation.setDeviceMetricsOverride', {
      width: 1365,
      height: 1000,
      deviceScaleFactor: 1,
      mobile: false,
    });
    await login('OWNER');
    const chinese = (await http('POST', '/categories', { name: 'Chinese' }))
      .body;
    const soya = (await http('POST', '/categories', { name: 'Soya Chaap' }))
      .body;
    const dishBody = (name, categoryId) => ({
      name,
      categoryId,
      variants: [
        {
          name: 'Half',
          channels: [
            { channelCode: 'COUNTER', price: '200', available: true },
            { channelCode: 'SWIGGY', price: '350', available: true },
          ],
        },
        {
          name: 'Full',
          channels: [{ channelCode: 'COUNTER', price: '250', available: true }],
        },
      ],
    });
    await http('POST', '/items', dishBody('Manchurian', chinese.id));
    let gravy = (
      await http('POST', '/items', dishBody('Soya Chaap Gravy', soya.id))
    ).body;
    await http('PATCH', '/items/' + gravy.id, {
      version: gravy.version,
      active: false,
    });
    await openMenu('Soya Chaap Gravy');
    assert.match(
      await evaluate("document.querySelector('.counter-visibility').innerText"),
      /paused/,
    );
    await evaluate(
      "document.querySelector('.item-availability input').click()",
    );
    await attach(photoPath);
    await save();
    await wait(
      "document.querySelector('.dish-photo-editor img')?.src.includes('/api/menu/images/') && document.querySelector('.dish-photo-editor img').naturalWidth>0",
    );
    const firstPhoto = await evaluate(
      "document.querySelector('.dish-photo-editor img').src",
    );
    await openPOS();
    assert.equal(
      await evaluate("document.querySelectorAll('.pos-card').length"),
      2,
    );
    await click('Soya Chaap');
    assert.equal(
      await evaluate("document.querySelectorAll('.pos-card').length"),
      1,
    );
    assert.ok(
      await evaluate("document.querySelector('.pos-card img')?.naturalWidth>0"),
    );
    await evaluate("document.querySelector('.pos-card').click()");
    await wait("document.querySelector('dialog').open");
    const portions = await evaluate(
      "document.querySelector('dialog').innerText",
    );
    assert.match(portions, /200/);
    assert.match(portions, /250/);
    assert.doesNotMatch(portions, /350|Swiggy|Zomato/);
    await click('Close');
    await fill('.pos-search input', 'missing');
    assert.equal(
      await evaluate("document.querySelectorAll('.pos-card').length"),
      0,
    );
    await fill('.pos-search input', 'gravy');
    assert.equal(
      await evaluate("document.querySelectorAll('.pos-card').length"),
      1,
    );
    await fill('.pos-search input', '');
    await click('All dishes');
    // Refresh a POS which stays mounted: another manager save is noticed by the polling timer.
    const fresh = (
      await http('POST', '/items', dishBody('Fresh dish', chinese.id))
    ).body;
    for (let i = 0; i < 200; i++) {
      if (await evaluate("document.querySelectorAll('.pos-card').length===3"))
        break;
      await new Promise((r) => setTimeout(r, 100));
    }
    assert.equal(
      await evaluate("document.querySelectorAll('.pos-card').length"),
      3,
    );
    assert.equal(
      await evaluate(
        "document.querySelectorAll('.menu-photo-placeholder').length",
      ),
      2,
    );
    await openMenu('Soya Chaap Gravy');
    await attach(secondPath);
    await save();
    await openPOS();
    await wait("document.querySelector('.pos-card img')?.naturalWidth>0");
    assert.notEqual(
      await evaluate("document.querySelector('.pos-card img').src"),
      firstPhoto,
    );
    let shot = await command('Page.captureScreenshot', {
      format: 'png',
      captureBeyondViewport: true,
    });
    fs.writeFileSync(
      '/tmp/dukanos-visual-pos-desktop.png',
      Buffer.from(shot.data, 'base64'),
    );
    await command('Emulation.setDeviceMetricsOverride', {
      width: 900,
      height: 1100,
      deviceScaleFactor: 1,
      mobile: false,
    });
    assert.ok(
      await evaluate('document.documentElement.scrollWidth<=window.innerWidth'),
    );
    shot = await command('Page.captureScreenshot', {
      format: 'png',
      captureBeyondViewport: true,
    });
    fs.writeFileSync(
      '/tmp/dukanos-visual-pos-tablet.png',
      Buffer.from(shot.data, 'base64'),
    );
    await openMenu('Soya Chaap Gravy');
    await click('Remove photo');
    await save();
    await openPOS();
    assert.equal(
      await evaluate(
        "document.querySelectorAll('.menu-photo-placeholder').length",
      ),
      3,
    );
    await http('PATCH', '/items/' + fresh.id, {
      version: fresh.version,
      active: false,
    });
    await click('Refresh menu');
    await wait("document.querySelectorAll('.pos-card').length===2");
    await evaluate(
      "[...document.querySelectorAll('button')].find(b=>b.textContent==='Sign out').click()",
    );
    await login('CASHIER');
    await openPOS();
    assert.equal(
      await evaluate("document.querySelectorAll('.pos-card').length"),
      2,
    );
    assert.equal(
      (await http('POST', '/items', dishBody('Denied', chinese.id))).status,
      403,
    );
    // Independent browser context: separate cookie jar and no cross-context BroadcastChannel.
    const connect = async (address) => {
      const socket = new globalThis.WebSocket(address);
      await new Promise((r) =>
        socket.addEventListener('open', r, { once: true }),
      );
      let id = 0;
      const waiting = new Map();
      const send = (method, params = {}) =>
        new Promise((resolve, reject) => {
          const key = ++id;
          waiting.set(key, { resolve, reject });
          socket.send(JSON.stringify({ id: key, method, params }));
        });
      socket.addEventListener('message', (e) => {
        const m = JSON.parse(e.data);
        if (m.id) {
          const p = waiting.get(m.id);
          waiting.delete(m.id);
          if (m.error) p.reject(Error(JSON.stringify(m.error)));
          else p.resolve(m.result);
        } else if (m.method === 'Fetch.requestPaused') {
          const local = m.params.request.url.startsWith(origin);
          if (!local) external.push(m.params.request.url);
          void send(
            local ? 'Fetch.continueRequest' : 'Fetch.failRequest',
            local
              ? { requestId: m.params.requestId }
              : {
                  requestId: m.params.requestId,
                  errorReason: 'InternetDisconnected',
                },
          );
        }
      });
      return { socket, send };
    };
    const browser = await connect(endpoint);
    let second;
    let contextId;
    try {
      contextId = (await browser.send('Target.createBrowserContext'))
        .browserContextId;
      const id = (
        await browser.send('Target.createTarget', {
          url: 'about:blank',
          browserContextId: contextId,
        })
      ).targetId;
      second = await connect(
        endpoint.replace(/\/devtools\/browser\/.*/, '/devtools/page/' + id),
      );
      const send = second.send;
      const read = async (expression) => {
        const result = await send('Runtime.evaluate', {
          expression,
          awaitPromise: true,
          returnByValue: true,
        });
        if (result.exceptionDetails)
          throw Error('Second browser evaluation failed');
        return result.result.value;
      };
      const waitSecond = async (expression) => {
        for (let i = 0; i < 100; i++) {
          if (await read(expression)) return;
          await new Promise((r) => setTimeout(r, 100));
        }
        throw Error(
          'Second browser state did not propagate: ' +
            expression +
            ' PAGE: ' +
            (await read('document.body.innerText')),
        );
      };
      await send('Runtime.enable');
      await send('Fetch.enable', { patterns: [{ urlPattern: '*' }] });
      await send('Page.navigate', { url: origin });
      await waitSecond("!!document.querySelector('input[name=username]')");
      await read(
        `(()=>{for(const [name,value] of Object.entries(${JSON.stringify({ username: 'manager', password })})){document.querySelector('input[name='+name+']').value=value;}document.querySelector('form').requestSubmit();})()`,
      );
      await waitSecond("!!document.querySelector('nav')");
      await send('Page.navigate', { url: origin + '/#/pos' });
      await waitSecond("document.querySelectorAll('.pos-card').length===2");
      await send('Page.bringToFront');
      await evaluate(
        "[...document.querySelectorAll('.pos-card')].find(b=>b.textContent.includes('Manchurian')).click()",
      );
      await wait("document.querySelector('dialog').open");
      await click('Mark all sold out');
      await wait(
        "!document.querySelector('.pos-item-availability').disabled && document.querySelector('.pos-item-availability').textContent==='Make all available'",
      );
      await waitSecond(
        "[...document.querySelectorAll('.pos-card')].find(b=>b.textContent.includes('Manchurian')).textContent.includes('Sold out')",
      );
      assert.equal(
        await evaluate("document.querySelectorAll('.pos-card').length"),
        2,
      );
      await click('Make all available');
      await wait(
        "!document.querySelector('.pos-item-availability').disabled && document.querySelector('.pos-item-availability').textContent==='Mark all sold out'",
      );
      await evaluate(
        'document.querySelector(\'button[aria-label="Half: Mark sold out"]\').click()',
      );
      await wait(
        '!!document.querySelector(\'button[aria-label="Half: Make available"]\')',
      );
      assert.ok(
        await evaluate(
          '!!document.querySelector(\'button[aria-label="Full: Mark sold out"]\')',
        ),
      );
      await waitSecond(
        "[...document.querySelectorAll('.pos-card')].find(b=>b.textContent.includes('Manchurian')).textContent.includes('Some portions sold out')",
      );
      await evaluate(
        'document.querySelector(\'button[aria-label="Half: Make available"]\').click()',
      );
      await wait(
        '!!document.querySelector(\'button[aria-label="Half: Mark sold out"]\')',
      );
      assert.equal(
        (await http('GET', '?channel=SWIGGY')).body.categories
          .flatMap((c) => c.items)
          .find((i) => i.name === 'Manchurian').variants[0].price,
        '350.00',
      );
      await click('Close');
      console.log(
        'Browser PASS: cashier whole-dish/variant Counter toggles, sold-out restoration and independent manager browser propagation within polling window.',
      );
    } finally {
      second?.socket.close();
      if (contextId)
        await browser.send('Target.disposeBrowserContext', {
          browserContextId: contextId,
        });
      browser.socket.close();
    }
    assert.deepEqual(failures, []);
    assert.deepEqual(external, []);
    console.log(
      'Browser PASS: owner paused-item diagnostics/reactivation, upload/replace/remove, image rendering/placeholders, Counter-only portions, search/category filtering, fresh item while POS stays open, inactive filtering, Manchurian preserved, cashier configuration denial, desktop/tablet and zero external requests. Isolated fixtures; real menu unchanged.',
    );
  } finally {
    if (ws) ws.close();
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
