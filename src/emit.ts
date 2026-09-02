import { EmitInvoiceOutput } from './types';
import { recepcion, autorizacion, autorizacionConPolling, isRecibida, parseAutorizacion, SriTransportError, SriSoapFaultError, SriXmlValidationError } from './sri';
import * as dotenv from 'dotenv';
import { generateInvoiceXML, generateCreditNoteXML, signXML, InvoiceVersion, Invoice } from 'open-factura-ec';
import { createHash } from 'crypto';
import { createClient } from 'redis';
import * as fs from 'fs';
import * as http from 'http';
import * as https from 'https';
import { spawn } from 'child_process';
import * as os from 'os';
import * as path from 'path';
import { getSriUrls } from './sri-config';

dotenv.config();

const REDIS_URL = process.env.REDIS_URL || 'redis://localhost:6379';
const DEFAULT_VERSION: InvoiceVersion = "2.1.0";


function numeric8FromKey(key: string): string {
  // Derivar 8 dígitos decimales estables desde el hash
  const hex = createHash('md5').update(key).digest('hex');   // 32 hex
  const asInt = parseInt(hex.slice(0, 8), 16);               // 32 bits
  return (asInt % 100000000).toString().padStart(8, '0');    // 8 dígitos 0-9
}

const redisClient = createClient({
  url: REDIS_URL,
  socket: { reconnectStrategy: (retries) => Math.min(retries * 50, 2000) }
});
redisClient.on('error', (err) => console.error('Redis Client Error:', err));
let redisConnected = false;
(async () => {
  try { await redisClient.connect(); redisConnected = true; console.log('Conectado a Redis'); }
  catch (e) { console.error('Redis no disponible, usando memoria:', e); }
})();
type CachedResponse = EmitInvoiceOutput & { payload_hash?: string };
const memoryStore = new Map<string, { response: CachedResponse, timestamp: number }>();
const cacheCleanupTimer = setInterval(() => {
  const now = Date.now();
  for (const [k,v] of memoryStore.entries()) if (now - v.timestamp > 24*60*60*1000) memoryStore.delete(k);
}, 60*60*1000);
cacheCleanupTimer.unref();

function stableStringify(obj: any): string {
  const all = new Set<string>(); JSON.stringify(obj, (k,v)=> (all.add(k), v));
  return JSON.stringify(obj, Array.from(all).sort());
}
function payloadHash(payload: any): string {
  const c = { ...payload }; delete c.idempotency_key;
  return createHash('sha256').update(stableStringify(c)).digest('hex');
}
async function getCachedResponse(key: string): Promise<CachedResponse | null> {
  try {
    if (redisConnected) { const raw = await redisClient.get(`idempotency:${key}`); return raw ? JSON.parse(raw) : null; }
    const m = memoryStore.get(key); return m ? m.response : null;
  } catch { return null; }
}
async function setCachedResponse(key: string, response: CachedResponse, ttlSec = 24*60*60) {
  try {
    if (redisConnected) await redisClient.setEx(`idempotency:${key}`, ttlSec, JSON.stringify(response));
    else memoryStore.set(key, { response, timestamp: Date.now() });
  } catch (e) { console.error('Cache set error:', e); }
}

async function fetchAsBase64(url: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const lib = url.startsWith('https') ? https : http;
    lib.get(url, (res) => {
      if (res.statusCode && res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
        return fetchAsBase64(res.headers.location).then(resolve).catch(reject);
      }
      if (res.statusCode !== 200) return reject(new Error(`HTTP ${res.statusCode}`));
      const chunks: Buffer[] = [];
      res.on('data', (c) => chunks.push(Buffer.isBuffer(c) ? c : Buffer.from(c)));
      res.on('end', () => resolve(Buffer.concat(chunks).toString('base64')));
    }).on('error', reject);
  });
}
async function readCertificateFile(filePath: string) {
  return fs.promises.readFile(filePath);
}

export class CertificateInputError extends Error {
  readonly statusCode = 400;

  constructor(message: string) {
    super(message);
    this.name = 'CertificateInputError';
  }
}

function publicErrorMessage(error: unknown, fallback: string): string {
  const message = error instanceof Error ? error.message : '';
  // Nunca devolver rutas temporales, detalles PKCS#12 ni mensajes que puedan
  // incluir material sensible de la librería de firma.
  if (/p12|pkcs|certificate|certificado|private key|password|contraseña|sri-p12-|\/tmp\//i.test(message)) {
    return fallback;
  }
  return message || fallback;
}

function sriErrorResponse(error: unknown, accessKey?: string, payloadHash?: string): EmitInvoiceOutput {
  const code = error instanceof SriTransportError || error instanceof SriSoapFaultError || error instanceof SriXmlValidationError
    ? error.code
    : 'SRI_CONNECTION_ERROR';
  const attempts = error instanceof SriTransportError ? error.attempts : undefined;
  return {
    ok: false,
    status: 'ERROR',
    code,
    attempts,
    accessKey,
    messages: [error instanceof SriTransportError || error instanceof SriSoapFaultError || error instanceof SriXmlValidationError
      ? error.message
      : publicErrorMessage(error, 'No se pudo completar la solicitud al SRI.')],
    payload_hash: payloadHash
  };
}

function normalizeCachedResponse(cached: CachedResponse): CachedResponse {
  if (cached.status === 'ERROR' || cached.status === 'NOT_AUTHORIZED') {
    return { ...cached, ok: false, code: cached.code || 'SRI_REJECTED' };
  }
  return cached;
}

type CertificateInput = {
  p12_base64?: string;
  p12_url?: string;
  p12_path?: string;
  urlFirma?: string;
};

function certificateAllowedDirectories(): string[] {
  const configured = process.env.SRI_CERTIFICATE_ALLOWED_DIR || process.env.SRI_CERTIFICATES_DIR;
  return configured
    ? configured.split(path.delimiter).filter(Boolean).map((dir) => path.resolve(dir))
    : [];
}

function isPathInside(childPath: string, parentPath: string): boolean {
  const relative = path.relative(parentPath, childPath);
  return relative === '' || (relative !== '..' && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative));
}

async function readControlledCertificateFile(filePath: string): Promise<Buffer> {
  if (!(filePath.startsWith('/') || filePath.startsWith('./'))) {
    throw new CertificateInputError('La ruta heredada del certificado no tiene un formato permitido.');
  }

  const allowedDirectories = certificateAllowedDirectories();
  if (!allowedDirectories.length) {
    throw new CertificateInputError('La carpeta permitida para certificados no está configurada.');
  }

  try {
    const resolvedPath = path.resolve(process.cwd(), filePath);
    const realPath = await fs.promises.realpath(resolvedPath);
    const realAllowedDirectories = await Promise.all(
      allowedDirectories.map(async (directory) => {
        try { return await fs.promises.realpath(directory); } catch { return null; }
      })
    );

    if (!realAllowedDirectories.some((directory) => directory && isPathInside(realPath, directory))) {
      throw new CertificateInputError('La ruta del certificado está fuera de la carpeta permitida.');
    }

    const stat = await fs.promises.stat(realPath);
    if (!stat.isFile()) throw new CertificateInputError('El certificado indicado no es un archivo.');
    return await readCertificateFile(realPath);
  } catch (error) {
    if (error instanceof CertificateInputError) throw error;
    throw new CertificateInputError('No se encontró el archivo del certificado.');
  }
}

function extractBase64Payload(value: string): string {
  const trimmed = value.trim();
  const dataUri = /^data:[^,]*;base64,(.*)$/is.exec(trimmed);
  return (dataUri ? dataUri[1] : trimmed).replace(/\s+/g, '');
}

function isValidBase64(value: string): boolean {
  if (!value || value.length % 4 === 1 || !/^[A-Za-z0-9+/]*={0,2}$/.test(value)) return false;
  const paddingIndex = value.indexOf('=');
  if (paddingIndex !== -1 && paddingIndex < value.length - 2) return false;
  const unpadded = value.replace(/=+$/, '');
  const decoded = Buffer.from(value, 'base64');
  if (!decoded.length) return false;
  return decoded.toString('base64').replace(/=+$/, '') === unpadded;
}

function decodeCertificateBase64(value: string): Buffer {
  const cleanBase64 = extractBase64Payload(value);
  if (!cleanBase64) throw new CertificateInputError('El Base64 del certificado está vacío.');
  if (!isValidBase64(cleanBase64)) throw new CertificateInputError('El Base64 del certificado no es válido.');

  const p12Buffer = Buffer.from(cleanBase64, 'base64');
  if (!p12Buffer.length) throw new CertificateInputError('El Buffer del certificado está vacío.');
  return p12Buffer;
}

async function readCertificateFromInput(input: CertificateInput): Promise<Buffer> {
  // Base64 real siempre tiene prioridad sobre las rutas heredadas.
  if (input.p12_base64 !== undefined) {
    const cleanBase64 = extractBase64Payload(input.p12_base64);
    const trimmed = input.p12_base64.trim();
    const isDataUri = /^data:/i.test(trimmed);
    if (isDataUri || isValidBase64(cleanBase64) || !(trimmed.startsWith('/') || trimmed.startsWith('./'))) {
      return decodeCertificateBase64(input.p12_base64);
    }
    return readControlledCertificateFile(trimmed);
  }

  const url = input.p12_url || input.urlFirma;
  if (url) return decodeCertificateBase64(await fetchAsBase64(url));
  if (input.p12_path !== undefined) {
    const trimmedPath = input.p12_path.trim();
    if (!trimmedPath) throw new CertificateInputError('No se proporcionó certificado (p12_base64 o p12_path).');
    return readControlledCertificateFile(trimmedPath);
  }
  throw new CertificateInputError('No se proporcionó certificado (p12_base64 o p12_path).');
}

// Exportadas para pruebas de integración y para mantener una única ruta de
// validación en cualquier consumidor interno del servicio.
export const resolveCertificateBuffer = readCertificateFromInput;

type OpenSslResult = { code: number | null; stdout: string; stderr: string };

function runOpenSsl(args: string[], input: string | Buffer): Promise<OpenSslResult> {
  return new Promise((resolve, reject) => {
    const child = spawn('openssl', args, { stdio: ['pipe', 'pipe', 'pipe'] });
    const stdout: Buffer[] = [];
    const stderr: Buffer[] = [];
    child.stdout.on('data', (chunk) => stdout.push(Buffer.from(chunk)));
    child.stderr.on('data', (chunk) => stderr.push(Buffer.from(chunk)));
    child.on('error', reject);
    child.on('close', (code) => resolve({
      code,
      stdout: Buffer.concat(stdout).toString('utf8'),
      stderr: Buffer.concat(stderr).toString('utf8')
    }));
    child.stdin.end(input);
  });
}

async function validateP12File(filePath: string, password: string): Promise<void> {
  let result: OpenSslResult;
  try {
    result = await runOpenSsl(['pkcs12', '-in', filePath, '-passin', 'stdin', '-nodes'], password);
  } catch {
    throw new CertificateInputError('No se pudo validar el certificado P12.');
  }

  // OpenSSL 3 requiere -legacy para algunos P12 antiguos.
  if (result.code !== 0 && /unsupported|legacy|inner_evp_generic_fetch/i.test(result.stderr)) {
    try {
      result = await runOpenSsl(['pkcs12', '-legacy', '-in', filePath, '-passin', 'stdin', '-nodes'], password);
    } catch {
      throw new CertificateInputError('No se pudo validar el certificado P12.');
    }
  }

  if (result.code !== 0) {
    if (/mac verify|invalid password|bad decrypt|pkcs12 cipherfinal/i.test(result.stderr)) {
      throw new CertificateInputError('La contraseña del certificado es incorrecta.');
    }
    throw new CertificateInputError('El archivo no es un certificado P12 válido.');
  }

  const certificate = /-----BEGIN CERTIFICATE-----[\s\S]+?-----END CERTIFICATE-----/.exec(result.stdout)?.[0];
  if (!certificate) throw new CertificateInputError('El P12 no contiene un certificado digital.');
  if (!/-----BEGIN (?:PRIVATE KEY|RSA PRIVATE KEY|EC PRIVATE KEY)-----/.test(result.stdout)) {
    throw new CertificateInputError('El P12 no contiene una clave privada.');
  }

  const dates = await runOpenSsl(['x509', '-noout', '-startdate', '-enddate'], certificate);
  if (dates.code !== 0) throw new CertificateInputError('No se pudo leer la vigencia del certificado.');
  const notBefore = /^notBefore=(.+)$/im.exec(dates.stdout)?.[1];
  const notAfter = /^notAfter=(.+)$/im.exec(dates.stdout)?.[1];
  const start = notBefore ? Date.parse(notBefore) : NaN;
  const end = notAfter ? Date.parse(notAfter) : NaN;
  const now = Date.now();
  if (!Number.isFinite(start) || !Number.isFinite(end)) {
    throw new CertificateInputError('No se pudo leer la vigencia del certificado.');
  }
  if (now < start) throw new CertificateInputError('El certificado todavía no está vigente.');
  if (now > end) throw new CertificateInputError('El certificado está vencido.');
}

async function withTemporaryCertificate<T>(p12Buffer: Buffer, password: string, callback: (filePath: string) => Promise<T>): Promise<T> {
  const tempDirectory = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'sri-p12-'));
  const tempPath = path.join(tempDirectory, 'certificate.p12');
  try {
    await fs.promises.writeFile(tempPath, p12Buffer, { mode: 0o600 });
    await fs.promises.chmod(tempPath, 0o600);
    await validateP12File(tempPath, password);
    return await callback(tempPath);
  } finally {
    await fs.promises.rm(tempPath, { force: true }).catch(() => undefined);
    await fs.promises.rm(tempDirectory, { recursive: true, force: true }).catch(() => undefined);
  }
}

export async function validateCertificateBuffer(p12Buffer: Buffer, password: string): Promise<void> {
  if (!p12Buffer.length) throw new CertificateInputError('El Buffer del certificado está vacío.');
  if (!password) throw new CertificateInputError('Falta la contraseña del certificado.');
  await withTemporaryCertificate(p12Buffer, password, async () => undefined);
}

// open-factura-ec todavía emite objetos de clave privada por console.log durante
// la firma. Se serializa esta sección para impedir que ese debug filtre secretos.
let signingTail = Promise.resolve();
async function signXmlWithCertificate(xml: string, input: CertificateInput, password: string): Promise<string> {
  const p12Buffer = await readCertificateFromInput(input);
  if (!p12Buffer.length) throw new CertificateInputError('El Buffer del certificado está vacío.');
  if (!password) throw new CertificateInputError('Falta la contraseña del certificado.');

  let release!: () => void;
  const previous = signingTail;
  signingTail = new Promise<void>((resolve) => { release = resolve; });
  await previous;
  const originalLog = console.log;
  console.log = (...args: any[]) => {
    if (typeof args[0] === 'string' && /DEBUG (?:typeof )?privateKeyObj/i.test(args[0])) return;
    originalLog(...args);
  };
  try {
    return await withTemporaryCertificate(p12Buffer, password, (tempPath) => signXML(xml, tempPath, password));
  } finally {
    console.log = originalLog;
    release();
  }
}

function parseRecepcionMensajes(resp: any): string[] {
  try {
    const raiz = resp?.respuestaRecepcionComprobante ?? resp?.RespuestaRecepcionComprobante ?? resp;
    const comp = raiz?.comprobantes?.comprobante;
    const first = Array.isArray(comp) ? comp[0] : comp;
    const mensajes = first?.mensajes?.mensaje;
    const list = Array.isArray(mensajes) ? mensajes : mensajes ? [mensajes] : [];
    const textos = list.map((m: any) =>
      [m?.identificador, m?.mensaje, m?.informacionAdicional].filter(Boolean).join(': ')
    );
    const estado = String(raiz?.estado || '').toUpperCase();
    if (estado && !['RECIBIDA', ''].includes(estado)) textos.unshift(`Estado recepción: ${estado}`);
    return textos.length ? textos : ['Recepción SRI devuelta sin mensajes.'];
  } catch {
    return ['No se pudieron parsear los mensajes de recepción.'];
  }
}

function extractFromXml(xml: string) {
  const key = /<\s*claveAcceso\s*>\s*(\d{49})\s*<\s*\/\s*claveAcceso\s*>/i.exec(xml)?.[1] ?? null;
  const amb = /<\s*ambiente\s*>\s*([12])\s*<\s*\/\s*ambiente\s*>/i.exec(xml)?.[1] ?? null;
  return { accessKey: key, ambiente: amb ? (amb === '2' ? 'prod' : 'test') : null };
}

// ======================= FACTURA (JSON) =======================

const invoicesInFlight = new Map<string, { payloadHash: string; promise: Promise<EmitInvoiceOutput> }>();

function invoiceIdempotencyKey(payload: any): string {
  return payload?.idempotency_key || `${payload?.infoTributaria?.ruc}-${payload?.infoTributaria?.estab}-${payload?.infoTributaria?.ptoEmi}-${payload?.infoTributaria?.secuencial}-${payload?.infoFactura?.fechaEmision}`;
}

export async function emitirFactura(payload: any): Promise<EmitInvoiceOutput> {
  const idempotencyKey = invoiceIdempotencyKey(payload);
  const requestHash = payloadHash(payload);
  const inFlight = invoicesInFlight.get(idempotencyKey);
  if (inFlight) {
    if (inFlight.payloadHash !== requestHash) {
      throw new CertificateInputError('La idempotency_key ya está asociada a otro comprobante.');
    }
    return inFlight.promise;
  }

  const operation = emitirFacturaInternal(payload);
  invoicesInFlight.set(idempotencyKey, { payloadHash: requestHash, promise: operation });
  try {
    return await operation;
  } finally {
    if (invoicesInFlight.get(idempotencyKey)?.promise === operation) invoicesInFlight.delete(idempotencyKey);
  }
}

const authorizationJobs = new Map<string, Promise<CachedResponse>>();

function queueAuthorizationPolling(params: {
  idempotencyKey: string;
  authorizationUrl: string;
  accessKey: string;
  signedXml: string;
  payloadHash: string;
  environment: string;
}): Promise<CachedResponse> {
  const existingJob = authorizationJobs.get(params.idempotencyKey);
  if (existingJob) return existingJob;

  const job = (async () => {
    try {
      const auth = await autorizacionConPolling(params.authorizationUrl, params.accessKey, {
        maxAttempts: 3,
        intervalMs: 5000
      });
      const parsed = parseAutorizacion(auth);

      if (parsed.estado === 'PENDIENTE' || parsed.estado === 'DESCONOCIDO') {
        const out: CachedResponse = {
          ok: true,
          status: 'PROCESSING',
          code: 'SRI_RECEIVED',
          accessKey: params.accessKey,
          xml_signed_base64: Buffer.from(params.signedXml).toString('base64'),
          messages: [parsed.errorMsg || 'Esperando autorización del SRI.'],
          payload_hash: params.payloadHash
        };
        console.info(
          `[SRI ASYNC] autorización pendiente ` +
          `environment=${params.environment} accessKey=${params.accessKey} ` +
          `status=PROCESSING message=${out.messages?.join(' | ') || 'none'}`
        );
        await setCachedResponse(params.idempotencyKey, out, 24 * 60 * 60);
        return out;
      }

      if (parsed.estado === 'NO AUTORIZADO') {
        const out: CachedResponse = {
          ok: false,
          status: 'NOT_AUTHORIZED',
          code: 'SRI_REJECTED',
          accessKey: params.accessKey,
          xml_signed_base64: Buffer.from(params.signedXml).toString('base64'),
          messages: [parsed.errorMsg || 'El comprobante no fue autorizado.'],
          payload_hash: params.payloadHash
        };
        await setCachedResponse(params.idempotencyKey, out, 24 * 60 * 60);
        return out;
      }

      const out: CachedResponse = {
        ok: true,
        status: 'AUTHORIZED',
        code: 'SRI_AUTHORIZED',
        accessKey: params.accessKey,
        authorization: { number: parsed.number, date: parsed.date },
        xml_signed_base64: Buffer.from(params.signedXml).toString('base64'),
        xml_authorized_base64: parsed.xmlAut ? Buffer.from(parsed.xmlAut).toString('base64') : undefined,
        messages: [],
        payload_hash: params.payloadHash
      };
      await setCachedResponse(params.idempotencyKey, out, 24 * 60 * 60);
      return out;
    } catch (error) {
      const out = sriErrorResponse(error, params.accessKey, params.payloadHash);
      await setCachedResponse(params.idempotencyKey, out, 24 * 60 * 60);
      console.error(
        `[SRI ASYNC] autorización fallida ` +
        `environment=${params.environment} accessKey=${params.accessKey} ` +
        `code=${out.code || 'SRI_CONNECTION_ERROR'}`
      );
      return out as CachedResponse;
    }
  })().finally(() => {
    authorizationJobs.delete(params.idempotencyKey);
  });

  authorizationJobs.set(params.idempotencyKey, job);
  return job;
}

async function emitirFacturaInternal(payload: any): Promise<EmitInvoiceOutput> {
  const idempotencyKey = payload.idempotency_key || `${payload?.infoTributaria?.ruc}-${payload?.infoTributaria?.estab}-${payload?.infoTributaria?.ptoEmi}-${payload?.infoTributaria?.secuencial}-${payload?.infoFactura?.fechaEmision}`;
  const reqHash = payloadHash(payload);

  const env = payload.env || 'test';
  const { recepcion: recepcionUrl, autorizacion: autorizacionUrl } = getSriUrls(env);

  const cached = await getCachedResponse(idempotencyKey);
  if (cached) {
    if (cached.payload_hash === reqHash) return normalizeCachedResponse(cached);
    throw new CertificateInputError('La idempotency_key ya está asociada a otro comprobante.');
  }

  const { version = DEFAULT_VERSION, infoTributaria, infoFactura, detalles, infoAdicional, certificate } = payload;
  if (!infoTributaria || !infoFactura || !detalles || !certificate) {
    throw new CertificateInputError('Datos incompletos en el payload.');
  }
  if (!certificate.password) throw new CertificateInputError('Falta la contraseña del certificado.');

const numericCode =
  typeof payload.numeric_code === 'string' && /^\d{8}$/.test(payload.numeric_code)
    ? payload.numeric_code
    : numeric8FromKey(idempotencyKey);

  const sriInvoice: Invoice = { version: version as InvoiceVersion, infoTributaria, infoFactura, detalles, infoAdicional };
  let accessKey: string | undefined;

  try {
    const { xml, accessKey: generatedAccessKey } = generateInvoiceXML(sriInvoice, numericCode);
    accessKey = generatedAccessKey;
    const signedXml = await signXmlWithCertificate(xml, {
      p12_base64: certificate.p12_base64,
      p12_url: certificate.p12_url,
      p12_path: certificate.p12_path
    }, certificate.password);

    const rec = await recepcion(recepcionUrl, signedXml);
    if (!isRecibida(rec)) {
      const msgs = parseRecepcionMensajes(rec);
      const out: CachedResponse = {
        ok: false,
        status: 'ERROR',
        code: 'SRI_REJECTED',
        accessKey,
        xml_signed_base64: Buffer.from(signedXml).toString('base64'),
        messages: msgs,
        payload_hash: reqHash
      };
      await setCachedResponse(idempotencyKey, out, 24 * 60 * 60);
      return out;
    }
	
	

    const processing: CachedResponse = {
      ok: true,
      status: 'PROCESSING',
      code: 'SRI_RECEIVED',
      accessKey,
      xml_signed_base64: Buffer.from(signedXml).toString('base64'),
      messages: ['El comprobante fue recibido. La autorización se está consultando en segundo plano.'],
      payload_hash: reqHash
    };
    console.info(
      `[SRI SOAP] estado PROCESSING guardado ` +
      `environment=${env} endpoint=${autorizacionUrl} accessKey=${accessKey} ` +
      `message=${processing.messages?.join(' | ') || 'none'}`
    );
    await setCachedResponse(idempotencyKey, processing, 24 * 60 * 60);
    const authorizationJob = queueAuthorizationPolling({
      idempotencyKey,
      authorizationUrl: autorizacionUrl,
      accessKey: accessKey!,
      signedXml,
      payloadHash: reqHash,
      environment: env
    });

    // Dar una ventana corta para que Frappe reciba AUTORIZADO si el SRI ya
    // terminó el procesamiento; el polling continúa fuera de la petición.
    const completed = await Promise.race([
      authorizationJob,
      new Promise<CachedResponse | null>((resolve) => setTimeout(() => resolve(null), 7000))
    ]);
    if (completed && completed.status !== 'PROCESSING') return completed;
    return processing;

  } catch (error) {
    if (error instanceof CertificateInputError || error instanceof SriXmlValidationError) throw error;
    const out = sriErrorResponse(error, accessKey, reqHash);
    if (error instanceof SriTransportError || error instanceof SriSoapFaultError) {
      // La misma idempotency_key no vuelve a enviar un comprobante cuyo
      // resultado de transporte/SOAP ya fue determinado.
      await setCachedResponse(idempotencyKey, out, 24 * 60 * 60);
    }
    return out;
  }
}

// ======================= FACTURA (XML crudo) =======================

export async function emitirFacturaDesdeXML(payload: {
  xml: string;
  env?: 'test' | 'prod';
  idempotency_key?: string;
  certificate?: { p12_base64?: string; p12_url?: string; p12_path?: string; password: string };
  urlFirma?: string; // compat
  clave?: string;    // compat
}): Promise<EmitInvoiceOutput> {
  const xml = (payload.xml || '').trim();
  if (!xml) return { status: 'ERROR', messages: ['Falta el campo xml'] };

  const { accessKey, ambiente } = extractFromXml(xml);
  if (!accessKey) return { status: 'ERROR', messages: ['No se encontró <claveAcceso> en el XML.'] };

  const idempotencyKey = payload.idempotency_key || accessKey;
  const reqHash = createHash('sha256').update(xml).digest('hex');

  const env:any = payload.env || ambiente || 'test';
  const { recepcion: recepcionUrl, autorizacion: autorizacionUrl } = getSriUrls(env);

  const cached = await getCachedResponse(idempotencyKey);
  if (cached && cached.payload_hash === reqHash) return cached;

  const password = payload.certificate?.password || payload.clave;
  if (!password) throw new CertificateInputError('Falta la contraseña del certificado (password/clave).');

  try {
    const signedXml = await signXmlWithCertificate(xml, {
      p12_base64: payload.certificate?.p12_base64,
      p12_url: payload.certificate?.p12_url,
      p12_path: payload.certificate?.p12_path,
      urlFirma: payload.urlFirma
    }, password);

    const rec = await recepcion(recepcionUrl, signedXml);
    if (!isRecibida(rec)) {
      const msgs = parseRecepcionMensajes(rec);
      // ⛔ NO cachear transitorio
      return {
        status: 'ERROR',
        accessKey,
        xml_signed_base64: Buffer.from(signedXml).toString('base64'),
        messages: msgs,
        payload_hash: reqHash
      };
    }

    const auth = await autorizacion(autorizacionUrl, accessKey);
    const parsed = parseAutorizacion(auth);

    if (parsed.estado === 'PENDIENTE' || parsed.estado === 'DESCONOCIDO') {
      // ⛔ NO cachear transitorio
      return {
        status: 'PROCESSING',
        accessKey,
        xml_signed_base64: Buffer.from(signedXml).toString('base64'),
        messages: [parsed.errorMsg || 'Esperando autorización del SRI.'],
        payload_hash: reqHash
      };
    }
    if (parsed.estado === 'NO AUTORIZADO') {
      const out: CachedResponse = {
        status: 'NOT_AUTHORIZED',
        accessKey,
        xml_signed_base64: Buffer.from(signedXml).toString('base64'),
        messages: [parsed.errorMsg || 'El comprobante no fue autorizado.'],
        payload_hash: reqHash
      };
      await setCachedResponse(idempotencyKey, out, 24 * 60 * 60);
      return out;
    }

    const ok: CachedResponse = {
      status: 'AUTHORIZED',
      accessKey,
      authorization: { number: parsed.number, date: parsed.date },
      xml_signed_base64: Buffer.from(signedXml).toString('base64'),
      xml_authorized_base64: parsed.xmlAut ? Buffer.from(parsed.xmlAut).toString('base64') : undefined,
      messages: [],
      payload_hash: reqHash
    };
    await setCachedResponse(idempotencyKey, ok, 24 * 60 * 60);
    return ok;

  } catch (err) {
    if (err instanceof CertificateInputError) throw err;
    return { status: 'ERROR', messages: [publicErrorMessage(err, 'No se pudo firmar o emitir el XML.')] };
  }
}

// ======================= NOTA DE CRÉDITO (JSON) =======================

export async function emitirNotaCredito(payload: any): Promise<EmitInvoiceOutput> {
  const idempotencyKey = payload.idempotency_key
    || `${payload?.infoTributaria?.ruc}-${payload?.infoTributaria?.estab}-${payload?.infoTributaria?.ptoEmi}-${payload?.infoTributaria?.secuencial}-${payload?.infoNotaCredito?.fechaEmision}`;

  const reqHash = payloadHash(payload);
  const env = payload.env || 'test';
  const { recepcion: recepcionUrl, autorizacion: autorizacionUrl } = getSriUrls(env);

  const cached = await getCachedResponse(idempotencyKey);
  if (cached && cached.payload_hash === reqHash) return cached;

  const { infoTributaria, infoNotaCredito, detalles, infoAdicional, certificate } = payload;
  if (!infoTributaria || !infoNotaCredito || !detalles || !certificate) {
    throw new CertificateInputError('Datos incompletos para nota de crédito.');
  }
  if (!certificate.password) throw new CertificateInputError('Falta la contraseña del certificado.');

  try {
const numericCode =
  typeof payload.numeric_code === 'string' && /^\d{8}$/.test(payload.numeric_code)
    ? payload.numeric_code
    : numeric8FromKey(idempotencyKey);


    const { xml, accessKey } = generateCreditNoteXML(
      { version: (payload.version || '1.1.0'), infoTributaria, infoNotaCredito, detalles, infoAdicional } as any,
      numericCode
    );

    const signedXml = await signXmlWithCertificate(xml, {
      p12_base64: certificate.p12_base64,
      p12_url: certificate.p12_url,
      p12_path: certificate.p12_path
    }, certificate.password);

    const rec = await recepcion(recepcionUrl, signedXml);
    if (!isRecibida(rec)) {
      const msgs = parseRecepcionMensajes(rec);
      // ⛔ NO cachear transitorio
      return {
        status: 'ERROR',
        accessKey,
        xml_signed_base64: Buffer.from(signedXml).toString('base64'),
        messages: msgs,
        payload_hash: reqHash
      };
    }

    const auth = await autorizacion(autorizacionUrl, accessKey);
    const parsed = parseAutorizacion(auth);

    if (parsed.estado === 'PENDIENTE' || parsed.estado === 'DESCONOCIDO') {
      // ⛔ NO cachear transitorio
      return {
        status: 'PROCESSING',
        accessKey,
        xml_signed_base64: Buffer.from(signedXml).toString('base64'),
        messages: [parsed.errorMsg || 'Esperando autorización del SRI.'],
        payload_hash: reqHash
      };
    }
    if (parsed.estado === 'NO AUTORIZADO') {
      const out: CachedResponse = {
        status: 'NOT_AUTHORIZED',
        accessKey,
        xml_signed_base64: Buffer.from(signedXml).toString('base64'),
        messages: [parsed.errorMsg || 'La nota de crédito no fue autorizada.'],
        payload_hash: reqHash
      };
      await setCachedResponse(idempotencyKey, out, 24 * 60 * 60);
      return out;
    }

    const ok: CachedResponse = {
      status: 'AUTHORIZED',
      accessKey,
      authorization: { number: parsed.number, date: parsed.date },
      xml_signed_base64: Buffer.from(signedXml).toString('base64'),
      xml_authorized_base64: parsed.xmlAut ? Buffer.from(parsed.xmlAut).toString('base64') : undefined,
      messages: [],
      payload_hash: reqHash
    };
    await setCachedResponse(idempotencyKey, ok, 24 * 60 * 60);
    return ok;

  } catch (err) {
    if (err instanceof CertificateInputError) throw err;
    return { status: 'ERROR', messages: [publicErrorMessage(err, 'No se pudo firmar o emitir la nota de crédito.')] };
  }
}

// Utils de estado del servicio
export async function healthCheck(): Promise<{ status: string; redis: string; timestamp: string }> {
  return { status: 'OK', redis: redisConnected ? 'CONNECTED' : 'DISCONNECTED', timestamp: new Date().toISOString() };
}
export async function clearIdempotencyCache(): Promise<void> {
  if (redisConnected) {
    const keys = await redisClient.keys('idempotency:*');
    if (keys.length) await redisClient.del(keys);
  } else memoryStore.clear();
}
process.on('SIGINT', async () => { if (redisConnected) await redisClient.quit(); process.exit(0); });
process.on('SIGTERM', async () => { if (redisConnected) await redisClient.quit(); process.exit(0); });
