const assert = require('node:assert/strict');
const fs = require('node:fs');
const fsp = fs.promises;
const http = require('node:http');
const os = require('node:os');
const path = require('node:path');
const { execFileSync } = require('node:child_process');
const { test, before, after } = require('node:test');

process.env.REDIS_URL = 'redis://127.0.0.1:1';

const {
  CertificateInputError,
  resolveCertificateBuffer,
  validateCertificateBuffer
} = require('../dist/emit');
const { app, invoiceSchema, legacySchema } = require('../dist/server');

let fixtureDirectory;
let p12Buffer;
const password = 'test-password';

async function makeP12(days = 2) {
  const directory = await fsp.mkdtemp(path.join(os.tmpdir(), 'sri-test-'));
  execFileSync('openssl', ['req', '-x509', '-newkey', 'rsa:2048', '-keyout', path.join(directory, 'key.pem'),
    '-out', path.join(directory, 'cert.pem'), '-sha256', '-nodes', '-subj', '/CN=SRI test', '-days', String(days)], { stdio: 'ignore' });
  execFileSync('openssl', ['pkcs12', '-export', '-out', path.join(directory, 'certificate.p12'),
    '-inkey', path.join(directory, 'key.pem'), '-in', path.join(directory, 'cert.pem'), '-passout', `pass:${password}`], { stdio: 'ignore' });
  return { directory, buffer: await fsp.readFile(path.join(directory, 'certificate.p12')) };
}

async function expectCertificateError(action, message) {
  await assert.rejects(action, (error) => {
    assert.equal(error instanceof CertificateInputError, true);
    assert.match(error.message, message);
    return true;
  });
}

function canonicalCertificate(p12_base64) {
  return {
    certificate: { p12_base64, password },
    env: 'test', version: '2.1.0', infoTributaria: {}, infoFactura: {}, detalles: []
  };
}

function legacyPayload(p12_base64) {
  return {
    idempotency_key: 'legacy-test-1', env: 'test', certificate: { p12_base64, password },
    company: { ruc: '1234567890123', estab: '001', ptoEmi: '001', secuencial: '000000001',
      razonSocial: 'Empresa', dirMatriz: 'Matriz', dirEstablecimiento: 'Establecimiento' },
    invoice: { issueDate: '2026-09-02', buyer: { idType: '05', id: '0102030405', name: 'Cliente' },
      totals: { subtotal_0: 10, total_discount: 0, total: 10, payments: [{ code: '01', amount: 10 }] },
      items: [{ code: 'A', description: 'Producto', qty: 1, unit_price: 10, taxes: [] }] }
  };
}

async function requestJson(server, body) {
  const address = server.address();
  return new Promise((resolve, reject) => {
    const request = http.request({ hostname: '127.0.0.1', port: address.port, path: '/api/v1/invoices/emit',
      method: 'POST', headers: { 'content-type': 'application/json' } }, (response) => {
      let data = '';
      response.setEncoding('utf8');
      response.on('data', (chunk) => { data += chunk; });
      response.on('end', () => resolve({ statusCode: response.statusCode, body: JSON.parse(data) }));
    });
    request.on('error', reject);
    request.end(JSON.stringify(body));
  });
}

before(async () => {
  fixtureDirectory = await makeP12();
  p12Buffer = fixtureDirectory.buffer;
  process.env.SRI_CERTIFICATE_ALLOWED_DIR = fixtureDirectory.directory;
});

after(async () => {
  await fsp.rm(fixtureDirectory.directory, { recursive: true, force: true });
});

test('acepta un certificado válido como Base64', async () => {
  const result = await resolveCertificateBuffer({ p12_base64: p12Buffer.toString('base64') });
  assert.deepEqual(result, p12Buffer);
  await validateCertificateBuffer(result, password);
});

test('elimina saltos de línea del Base64', async () => {
  const encoded = p12Buffer.toString('base64').match(/.{1,64}/g).join('\n');
  assert.deepEqual(await resolveCertificateBuffer({ p12_base64: encoded }), p12Buffer);
});

test('acepta un Data URI PKCS#12', async () => {
  const encoded = `data:application/x-pkcs12;base64,${p12Buffer.toString('base64')}`;
  assert.deepEqual(await resolveCertificateBuffer({ p12_base64: encoded }), p12Buffer);
});

test('rechaza Base64 inválido y Buffer vacío', async () => {
  await expectCertificateError(() => resolveCertificateBuffer({ p12_base64: '%%%no-base64%%%' }), /Base64.*válido/);
  await expectCertificateError(() => resolveCertificateBuffer({ p12_base64: ' \n\t' }), /vacío/);
});

test('rechaza contraseña incorrecta', async () => {
  await assert.rejects(() => validateCertificateBuffer(p12Buffer, 'wrong-password'), /contraseña.*incorrecta/i);
});

test('rechaza certificado vencido', async () => {
  const expired = await makeP12(0);
  try {
    await assert.rejects(() => validateCertificateBuffer(expired.buffer, password), /vencido/i);
  } finally {
    await fsp.rm(expired.directory, { recursive: true, force: true });
  }
});

test('mantiene compatibilidad temporal con p12_path dentro de la carpeta permitida', async () => {
  const result = await resolveCertificateBuffer({ p12_path: path.join(fixtureDirectory.directory, 'certificate.p12') });
  assert.deepEqual(result, p12Buffer);
});

test('no consulta fs.existsSync sobre el valor Base64', async () => {
  const original = fs.existsSync;
  const calls = [];
  fs.existsSync = (value) => { calls.push(value); return original(value); };
  try {
    await resolveCertificateBuffer({ p12_base64: p12Buffer.toString('base64') });
  } finally {
    fs.existsSync = original;
  }
  assert.deepEqual(calls, []);
});

test('invoiceSchema y legacySchema siguen aceptando sus contratos', () => {
  assert.equal(invoiceSchema.safeParse(canonicalCertificate(p12Buffer.toString('base64'))).success, true);
  assert.equal(legacySchema.safeParse(legacyPayload(p12Buffer.toString('base64'))).success, true);
});

test('el endpoint continúa aceptando legacy y devuelve 400 para certificado inválido', async () => {
  const server = http.createServer(app);
  await new Promise((resolve) => server.listen(0, resolve));
  try {
    const result = await requestJson(server, legacyPayload('%%%invalid%%%'));
    assert.equal(result.statusCode, 400);
    assert.match(result.body.messages[0], /Base64.*válido/);
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
});
