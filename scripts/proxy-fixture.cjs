/* global exports */
// Disposable local HTTPS proxy; never installs configuration or system services.
const fs = require('node:fs/promises');
const net = require('node:net');
const https = require('node:https');
const { spawn, execFileSync } = require('node:child_process');
async function freePort() {
  const s = net.createServer();
  await new Promise((r) => s.listen(0, '127.0.0.1', r));
  const port = s.address().port;
  await new Promise((r) => s.close(r));
  return port;
}
exports.proxyFixture = async function (apiPort) {
  const root = await fs.mkdtemp('/tmp/dukanos-proxy-');
  const port = await freePort(),
    httpPort = await freePort();
  execFileSync(
    'openssl',
    [
      'req',
      '-x509',
      '-newkey',
      'rsa:2048',
      '-nodes',
      '-keyout',
      root + '/key.pem',
      '-out',
      root + '/cert.pem',
      '-days',
      '1',
      '-subj',
      '/CN=localhost',
    ],
    { stdio: 'ignore' },
  );
  let template = await fs.readFile('deploy/nginx.conf.example', 'utf8');
  template = template
    .replaceAll('__HOSTNAME__', 'localhost')
    .replaceAll('__TLS_CERT_PATH__', root + '/cert.pem')
    .replaceAll('__TLS_KEY_PATH__', root + '/key.pem')
    .replace('listen 80;', `listen 127.0.0.1:${httpPort};`)
    .replace('listen 443 ssl;', `listen 127.0.0.1:${port} ssl;`)
    .replaceAll('127.0.0.1:3000', `127.0.0.1:${apiPort}`)
    .replaceAll('/var/log/nginx/dukanos-error.log', root + '/errors.log');
  const config = `error_log stderr crit; pid ${root}/nginx.pid; events {} http { access_log off; fastcgi_temp_path ${root}/fastcgi; uwsgi_temp_path ${root}/uwsgi; scgi_temp_path ${root}/scgi; client_body_temp_path ${root}/body; proxy_temp_path ${root}/proxy; ${template} }`;
  await fs.writeFile(root + '/nginx.conf', config);
  const binary = process.env.NGINX_BINARY || '/usr/sbin/nginx';
  execFileSync(binary, ['-t', '-p', root + '/', '-c', root + '/nginx.conf'], {
    stdio: 'ignore',
  });
  const child = spawn(
    binary,
    ['-p', root + '/', '-c', root + '/nginx.conf', '-g', 'daemon off;'],
    { stdio: 'ignore' },
  );
  const call = (path, { method = 'GET', body, headers = {} } = {}) =>
    new Promise((resolve, reject) => {
      const serialized = body === undefined ? undefined : JSON.stringify(body);
      const req = https.request(
        {
          hostname: '127.0.0.1',
          port,
          path,
          method,
          rejectUnauthorized: false,
          headers: {
            host: 'localhost',
            ...(serialized
              ? {
                  'Content-Type': 'application/json',
                  'Content-Length': Buffer.byteLength(serialized),
                }
              : {}),
            ...headers,
          },
        },
        (res) => {
          let text = '';
          res.on('data', (c) => (text += c));
          res.on('end', () =>
            resolve({ status: res.statusCode, headers: res.headers, text }),
          );
        },
      );
      req.on('error', reject);
      req.setTimeout(5000, () => req.destroy(new Error('Fixture timeout')));
      req.end(serialized);
    });
  let up = false;
  for (let i = 0; i < 50; i++) {
    try {
      await call('/api/health');
      up = true;
      break;
    } catch {
      await new Promise((r) => setTimeout(r, 100));
    }
  }
  if (!up) {
    child.kill();
    await fs.rm(root, { recursive: true, force: true });
    throw new Error('Proxy fixture failed');
  }
  return {
    call,
    close: async () => {
      const end = new Promise((r) => child.once('exit', r));
      child.kill('SIGTERM');
      await end;
      await fs.rm(root, { recursive: true, force: true });
    },
  };
};
