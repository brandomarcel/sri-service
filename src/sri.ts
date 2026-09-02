import * as https from 'https';
import { isIP } from 'net';
import { DOMParser } from '@xmldom/xmldom';

export type SriOperation = 'recepcion' | 'autorizacion';

/**
 * The SOAP endpoint comes from our configuration. The WSDL query is removed
 * before the POST so it is never used as the submission endpoint.
 */
export function endpointFromWsdl(wsdlUrl: string): string {
  const url = new URL(wsdlUrl);

  if (url.protocol !== 'https:') {
    throw new Error(`La URL WSDL del SRI debe usar HTTPS: ${wsdlUrl}`);
  }
  if (isIP(url.hostname)) {
    throw new Error(`La URL WSDL del SRI debe usar un dominio, no una IP: ${wsdlUrl}`);
  }

  url.search = '';
  url.hash = '';
  return url.toString().replace(/\/$/, '');
}

export type SriErrorCode =
  | 'SRI_CONNECTION_RESET'
  | 'SRI_TIMEOUT'
  | 'SRI_CONNECTION_REFUSED'
  | 'SRI_PIPE'
  | 'SRI_TLS_ERROR'
  | 'SRI_CONNECTION_ERROR'
  | 'SRI_SOAP_FAULT'
  | 'SRI_XML_INVALID'
  | 'SRI_REJECTED'
  | 'SRI_RECEIVED'
  | 'SRI_AUTHORIZED';

export class SriTransportError extends Error {
  readonly code: SriErrorCode;
  readonly attempts: number;
  readonly statusCode?: number;

  constructor(code: SriErrorCode, message: string, attempts = 1, statusCode?: number) {
    super(message);
    this.name = 'SriTransportError';
    this.code = code;
    this.attempts = attempts;
    this.statusCode = statusCode;
  }
}

export class SriSoapFaultError extends Error {
  readonly code = 'SRI_SOAP_FAULT' as const;
  readonly statusCode?: number;

  constructor(message: string, statusCode?: number) {
    super(message);
    this.name = 'SriSoapFaultError';
    this.statusCode = statusCode;
  }
}

export class SriXmlValidationError extends Error {
  readonly code = 'SRI_XML_INVALID' as const;
  readonly statusCode = 400;

  constructor(message: string) {
    super(message);
    this.name = 'SriXmlValidationError';
  }
}

export type SoapHttpResponse = {
  body: string;
  statusCode: number;
  attempts: number;
  durationMs: number;
};

export type SoapRequestOptions = {
  timeoutMs?: number;
  maxAttempts?: number;
  backoffMs?: number;
};

export type SriAuthorizationPollingOptions = {
  maxAttempts?: number;
  intervalMs?: number;
};

const sriAgent = new https.Agent({
  keepAlive: false,
  maxSockets: 10,
  minVersion: 'TLSv1.2',
  rejectUnauthorized: true
});

function environmentFromWsdl(wsdlUrl: string): 'test' | 'prod' {
  return new URL(wsdlUrl).hostname.startsWith('celcer.') ? 'test' : 'prod';
}

function maskAccessKey(accessKey?: string): string {
  if (!accessKey) return 'unknown';
  return accessKey.length > 14 ? `${accessKey.slice(0, 10)}...${accessKey.slice(-4)}` : 'invalid';
}

function transportCode(error: any): SriErrorCode {
  const code = String(error?.code || '').toUpperCase();
  if (code === 'ECONNRESET') return 'SRI_CONNECTION_RESET';
  if (code === 'ETIMEDOUT' || code === 'ESOCKETTIMEDOUT') return 'SRI_TIMEOUT';
  if (code === 'ECONNREFUSED') return 'SRI_CONNECTION_REFUSED';
  if (code === 'EPIPE') return 'SRI_PIPE';
  if (code.startsWith('ERR_SSL') || code === 'EPROTO' || code.includes('TLS') || code.includes('CERT')) {
    return 'SRI_TLS_ERROR';
  }
  return 'SRI_CONNECTION_ERROR';
}

function transportMessage(code: SriErrorCode): string {
  switch (code) {
    case 'SRI_CONNECTION_RESET': return 'El SRI cerró la conexión durante la solicitud SOAP.';
    case 'SRI_TIMEOUT': return 'El SRI no respondió dentro del tiempo establecido.';
    case 'SRI_CONNECTION_REFUSED': return 'No se pudo establecer conexión con el SRI.';
    case 'SRI_PIPE': return 'La conexión con el SRI se interrumpió durante la solicitud SOAP.';
    case 'SRI_TLS_ERROR': return 'No se pudo establecer una conexión TLS válida con el SRI.';
    default: return 'No se pudo completar la solicitud SOAP al SRI.';
  }
}

function logSoap(operation: SriOperation, wsdlUrl: string, accessKey: string | undefined, details: {
  attempt: number;
  durationMs: number;
  statusCode?: number;
  code?: string;
}) {
  const fields = [
    `environment=${environmentFromWsdl(wsdlUrl)}`,
    `endpoint=${endpointFromWsdl(wsdlUrl)}`,
    `method=${operation === 'recepcion' ? 'validarComprobante' : 'autorizacionComprobante'}`,
    `accessKey=${maskAccessKey(accessKey)}`,
    `attempt=${details.attempt}`,
    `durationMs=${details.durationMs}`
  ];
  if (details.statusCode !== undefined) fields.push(`statusHttp=${details.statusCode}`);
  if (details.code) fields.push(`code=${details.code}`);
  console.info(`[SRI SOAP] ${operation} ${details.code ? 'failed' : 'completed'} ${fields.join(' ')}`);
}

function redactDebugXml(xml: string): string {
  return xml
    .replace(/(<(?:[\w.-]+:)?X509Certificate\b[^>]*>)[\s\S]*?(<\/(?:[\w.-]+:)?X509Certificate>)/gi, '$1[REDACTED_CERTIFICATE]$2')
    .replace(/(<(?:[\w.-]+:)?(?:privateKey|PrivateKey|password|contraseña|p12_base64)\b[^>]*>)[\s\S]*?(<\/(?:[\w.-]+:)?(?:privateKey|PrivateKey|password|contraseña|p12_base64)>)/gi, '$1[REDACTED_SECRET]$2');
}

function escapeXml(value: string): string {
  return value.replace(/[<>&'\"]/g, (character) => ({
    '<': '&lt;', '>': '&gt;', '&': '&amp;', "'": '&apos;', '\"': '&quot;'
  }[character] as string));
}

function soapEnvelope(operation: SriOperation, value: string): string {
  const namespace = operation === 'recepcion'
    ? 'http://ec.gob.sri.ws.recepcion'
    : 'http://ec.gob.sri.ws.autorizacion';
  const action = operation === 'recepcion' ? 'validarComprobante' : 'autorizacionComprobante';
  const body = operation === 'recepcion'
    ? `<ec:${action}><xml>${escapeXml(value)}</xml></ec:${action}>`
    : `<ec:${action}><claveAccesoComprobante>${escapeXml(value)}</claveAccesoComprobante></ec:${action}>`;
  return `<?xml version="1.0" encoding="UTF-8"?>` +
    `<soapenv:Envelope xmlns:soapenv="http://schemas.xmlsoap.org/soap/envelope/" xmlns:ec="${namespace}">` +
    `<soapenv:Header/><soapenv:Body>${body}</soapenv:Body></soapenv:Envelope>`;
}

function postSoapOnce(endpoint: string, envelope: string, operation: SriOperation, accessKey: string | undefined, timeoutMs: number, attempt: number): Promise<SoapHttpResponse> {
  return new Promise((resolve, reject) => {
    const startedAt = Date.now();
    const body = Buffer.from(envelope, 'utf8');
    let settled = false;
    const fail = (error: any) => {
      if (settled) return;
      settled = true;
      const durationMs = Date.now() - startedAt;
      const code = transportCode(error);
      logSoap(operation, endpoint, accessKey, { attempt, durationMs, code });
      reject(new SriTransportError(code, transportMessage(code), attempt));
    };
    const request = https.request(endpoint, {
      method: 'POST',
      agent: sriAgent,
      family: 4,
      minVersion: 'TLSv1.2',
      rejectUnauthorized: true,
      headers: {
        'Content-Type': 'text/xml;charset=UTF-8',
        'Content-Length': body.length,
        'SOAPAction': '""',
        'Accept': 'text/xml',
        'Accept-Encoding': 'identity',
        'Connection': 'close'
      }
    }, (response) => {
      const chunks: Buffer[] = [];
      let size = 0;
      response.on('data', (chunk) => {
        const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
        size += buffer.length;
        if (size <= 10 * 1024 * 1024) chunks.push(buffer);
      });
      response.on('aborted', () => fail({ code: 'ECONNRESET' }));
      response.on('error', fail);
      response.on('end', () => {
        if (settled) return;
        settled = true;
        const durationMs = Date.now() - startedAt;
        const statusCode = response.statusCode || 0;
        logSoap(operation, endpoint, accessKey, { attempt, durationMs, statusCode });
        if (size > 10 * 1024 * 1024) {
          reject(new SriSoapFaultError('La respuesta SOAP del SRI excede el tamaño permitido.', statusCode));
          return;
        }
        const responseBody = Buffer.concat(chunks).toString('utf8');
        console.info(
          `[SRI SOAP] ${operation} response ` +
          `accessKey=${maskAccessKey(accessKey)} attempt=${attempt} ` +
          `statusHttp=${statusCode} durationMs=${durationMs}\n` +
          redactDebugXml(responseBody)
        );
        resolve({ body: responseBody, statusCode, attempts: 1, durationMs });
      });
    });

    request.setTimeout(timeoutMs, () => {
      const error = Object.assign(new Error('SRI request timeout'), { code: 'ETIMEDOUT' });
      request.destroy(error);
    });
    request.on('error', fail);
    request.end(body);
  });
}

function wait(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export async function postSoapWithRetry(wsdlUrl: string, envelope: string, operation: SriOperation, accessKey?: string, options: SoapRequestOptions = {}): Promise<SoapHttpResponse> {
  const endpoint = endpointFromWsdl(wsdlUrl);
  console.info(
    `[SRI SOAP] ${operation} request ` +
    `environment=${environmentFromWsdl(wsdlUrl)} ` +
    `wsdlUrl=${wsdlUrl} ` +
    `endpoint=${endpoint} ` +
    `method=${operation === 'recepcion' ? 'validarComprobante' : 'autorizacionComprobante'}`
  );
  const configuredTimeout = Number(process.env.SRI_TIMEOUT_MS || 90000);
  const timeoutMs = options.timeoutMs ?? (Number.isFinite(configuredTimeout) ? Math.min(Math.max(configuredTimeout, 60000), 120000) : 90000);
  const configuredAttempts = Number(options.maxAttempts ?? process.env.SRI_MAX_ATTEMPTS ?? 3);
  const maxAttempts = Number.isFinite(configuredAttempts) ? Math.min(Math.max(configuredAttempts, 1), 3) : 3;
  const configuredBackoff = Number(options.backoffMs ?? 250);
  const backoffMs = Number.isFinite(configuredBackoff) ? Math.max(configuredBackoff, 0) : 250;
  let lastError: SriTransportError | undefined;

  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    try {
      const response = await postSoapOnce(endpoint, envelope, operation, accessKey, timeoutMs, attempt);
      return { ...response, attempts: attempt };
    } catch (error) {
      if (!(error instanceof SriTransportError)) throw error;
      lastError = new SriTransportError(error.code, error.message, attempt);
      if (attempt >= maxAttempts) throw lastError;
      const waitMs = backoffMs * Math.pow(2, attempt - 1);
      console.info(
        `[SRI SOAP] ${operation} retry ` +
        `accessKey=${maskAccessKey(accessKey)} failedAttempt=${attempt} ` +
        `nextAttempt=${attempt + 1} waitMs=${waitMs} code=${error.code}`
      );
      await wait(waitMs);
    }
  }
  throw lastError || new SriTransportError('SRI_CONNECTION_ERROR', transportMessage('SRI_CONNECTION_ERROR'), maxAttempts);
}

function elementsByName(root: any, name: string): any[] {
  const nodes = [root, ...Array.from(root?.getElementsByTagName?.('*') || [])];
  return nodes.filter((node: any) => (node.localName || node.nodeName?.split(':').pop()) === name);
}

function firstElement(root: any, name: string): any | undefined {
  return elementsByName(root, name)[0];
}

function childText(root: any, name: string): string {
  const child = Array.from(root?.childNodes || []).find((node: any) =>
    node.nodeType === 1 && (node.localName || node.nodeName?.split(':').pop()) === name
  ) as any;
  return String(child?.textContent || '').trim();
}

export function validateSignedInvoiceXml(xml: string, expectedEnvironment?: 'test' | 'prod'): { accessKey: string; environment: 'test' | 'prod' } {
  const document = new DOMParser().parseFromString(xml, 'text/xml');
  if (firstElement(document, 'parsererror')) throw new SriXmlValidationError('El XML firmado no está bien formado.');
  const root = document.documentElement;
  if (!root || (root.localName || root.nodeName?.split(':').pop()) !== 'factura') {
    throw new SriXmlValidationError('El XML firmado no contiene una factura válida.');
  }
  if (!firstElement(document, 'Signature')) throw new SriXmlValidationError('El XML no contiene una firma digital.');

  const requiredTributaria = ['ambiente', 'tipoEmision', 'razonSocial', 'ruc', 'claveAcceso', 'codDoc', 'estab', 'ptoEmi', 'secuencial', 'dirMatriz'];
  const requiredFactura = ['fechaEmision', 'dirEstablecimiento', 'obligadoContabilidad', 'tipoIdentificacionComprador', 'razonSocialComprador', 'identificacionComprador', 'totalSinImpuestos', 'totalDescuento', 'propina', 'importeTotal', 'moneda'];
  const infoTributaria = firstElement(document, 'infoTributaria');
  const infoFactura = firstElement(document, 'infoFactura');
  if (!infoTributaria || requiredTributaria.some((field) => !childText(infoTributaria, field))) {
    throw new SriXmlValidationError('La información tributaria del XML está incompleta.');
  }
  if (!infoFactura || requiredFactura.some((field) => !childText(infoFactura, field))) {
    throw new SriXmlValidationError('La información de factura del XML está incompleta.');
  }

  const accessKey = childText(infoTributaria, 'claveAcceso');
  const ambiente = childText(infoTributaria, 'ambiente');
  const ruc = childText(infoTributaria, 'ruc');
  const estab = childText(infoTributaria, 'estab');
  const ptoEmi = childText(infoTributaria, 'ptoEmi');
  const secuencial = childText(infoTributaria, 'secuencial');
  if (!/^\d{49}$/.test(accessKey)) throw new SriXmlValidationError('La clave de acceso debe tener 49 dígitos.');
  if (!/^\d{13}$/.test(ruc)) throw new SriXmlValidationError('El RUC debe tener 13 dígitos.');
  if (!/^\d{3}$/.test(estab) || !/^\d{3}$/.test(ptoEmi) || !/^\d{9}$/.test(secuencial)) {
    throw new SriXmlValidationError('Establecimiento, punto de emisión o secuencial inválido.');
  }
  if (!['1', '2'].includes(ambiente)) throw new SriXmlValidationError('El ambiente del XML es inválido.');
  if (ruc !== accessKey.slice(10, 23)) throw new SriXmlValidationError('El RUC no coincide con la clave de acceso.');

  const environment = ambiente === '2' ? 'prod' : 'test';
  if (expectedEnvironment && environment !== expectedEnvironment) {
    throw new SriXmlValidationError('El ambiente del XML no coincide con el ambiente configurado.');
  }

  const details = elementsByName(document, 'detalle');
  if (!details.length) throw new SriXmlValidationError('La factura debe contener al menos un detalle.');
  for (const detail of details) {
    if (['codigoPrincipal', 'descripcion', 'cantidad', 'precioUnitario', 'descuento', 'precioTotalSinImpuesto'].some((field) => !childText(detail, field))) {
      throw new SriXmlValidationError('Un detalle de la factura está incompleto.');
    }
    const taxes = elementsByName(detail, 'impuesto');
    if (!taxes.length || taxes.some((tax) => ['codigo', 'codigoPorcentaje', 'tarifa', 'baseImponible', 'valor'].some((field) => !childText(tax, field)))) {
      throw new SriXmlValidationError('Un impuesto de la factura está incompleto.');
    }
  }
  const payments = elementsByName(infoFactura, 'pago');
  if (!payments.length || payments.some((payment) => !/^\d{2}$/.test(childText(payment, 'formaPago')) || !childText(payment, 'total'))) {
    throw new SriXmlValidationError('La factura debe contener formas de pago válidas.');
  }
  return { accessKey, environment };
}

export function buildSoapEnvelope(operation: SriOperation, value: string): string {
  return soapEnvelope(operation, value);
}

function parseSoapDocument(xml: string, statusCode: number): any {
  const document = new DOMParser().parseFromString(xml, 'text/xml');
  const parserError = firstElement(document, 'parsererror');
  if (parserError) throw new SriSoapFaultError('El SRI devolvió una respuesta SOAP mal formada.', statusCode);
  const fault = firstElement(document, 'Fault');
  if (fault) {
    const detail = childText(fault, 'faultstring') || childText(fault, 'Reason') || 'El SRI devolvió un SOAP Fault.';
    throw new SriSoapFaultError(`SOAP Fault del SRI: ${detail.slice(0, 300)}`, statusCode);
  }
  if (statusCode < 200 || statusCode >= 300) {
    throw new SriSoapFaultError(`El SRI respondió HTTP ${statusCode} sin un SOAP Fault válido.`, statusCode);
  }
  return document;
}

function parseRecepcionResponse(body: string, statusCode: number): any {
  const document = parseSoapDocument(body, statusCode);
  const root = firstElement(document, 'RespuestaRecepcionComprobante');
  const estado = childText(root || document, 'estado');
  if (!root || !estado) throw new SriSoapFaultError('La respuesta SOAP de recepción no contiene estado.', statusCode);

  const comprobante = firstElement(root, 'comprobante');
  const messageNodes = elementsByName(root, 'mensaje').filter((node) => childText(node, 'identificador'));
  const mensajes = messageNodes.map((node) => ({
    identificador: childText(node, 'identificador'),
    mensaje: childText(node, 'mensaje'),
    informacionAdicional: childText(node, 'informacionAdicional')
  }));
  return {
    RespuestaRecepcionComprobante: {
      estado,
      comprobantes: comprobante ? {
        comprobante: {
          mensajes: mensajes.length ? { mensaje: mensajes } : undefined
        }
      } : undefined
    }
  };
}

function parseAutorizacionResponse(body: string, statusCode: number): any {
  const document = parseSoapDocument(body, statusCode);
  const root = firstElement(document, 'RespuestaAutorizacionComprobante');
  if (!root) throw new SriSoapFaultError('La respuesta SOAP de autorización no tiene el nodo esperado.', statusCode);
  const authorization = firstElement(root, 'autorizacion');
  const messageNodes = authorization ? elementsByName(authorization, 'mensaje').filter((node) => childText(node, 'identificador')) : [];
  const mensajes = messageNodes.map((node) => ({
    identificador: childText(node, 'identificador'),
    mensaje: childText(node, 'mensaje'),
    informacionAdicional: childText(node, 'informacionAdicional')
  }));
  return {
    RespuestaAutorizacionComprobante: {
      numeroComprobantes: childText(root, 'numeroComprobantes'),
      autorizaciones: authorization ? {
        autorizacion: {
          estado: childText(authorization, 'estado'),
          numeroAutorizacion: childText(authorization, 'numeroAutorizacion'),
          fechaAutorizacion: childText(authorization, 'fechaAutorizacion'),
          comprobante: childText(authorization, 'comprobante'),
          mensajes: mensajes.length ? { mensaje: mensajes } : undefined
        }
      } : undefined
    }
  };
}

export async function recepcion(wsdlUrl: string, xmlSigned: string) {
  const accessKey = /<\s*claveAcceso\s*>\s*(\d{49})\s*<\s*\/\s*claveAcceso\s*>/i.exec(xmlSigned)?.[1];
  validateSignedInvoiceXml(xmlSigned, environmentFromWsdl(wsdlUrl));
  console.info(
    `[SRI SOAP] recepcion XML enviado ` +
    `environment=${environmentFromWsdl(wsdlUrl)} ` +
    `endpoint=${endpointFromWsdl(wsdlUrl)} accessKey=${accessKey || 'unknown'}\n` +
    redactDebugXml(xmlSigned)
  );
  const xmlB64 = Buffer.from(xmlSigned, 'utf8').toString('base64');
  const response = await postSoapWithRetry(wsdlUrl, soapEnvelope('recepcion', xmlB64), 'recepcion', accessKey);
  try {
    const parsed = parseRecepcionResponse(response.body, response.statusCode);
    const root = parsed?.RespuestaRecepcionComprobante;
    const messages = root?.comprobantes?.comprobante?.mensajes?.mensaje || [];
    console.info(
      `[SRI SOAP] recepcion estado=${root?.estado || 'DESCONOCIDO'} ` +
      `accessKey=${accessKey || 'unknown'} mensajes=${JSON.stringify(messages)}`
    );
    return parsed;
  } catch (error) {
    if (error instanceof SriSoapFaultError) {
      logSoap('recepcion', wsdlUrl, accessKey, { attempt: response.attempts, durationMs: response.durationMs, statusCode: response.statusCode, code: error.code });
    }
    throw error;
  }
}

export async function autorizacion(wsdlUrl: string, accessKey: string) {
  console.info(
    `[SRI SOAP] autorizacion consulta ` +
    `environment=${environmentFromWsdl(wsdlUrl)} ` +
    `endpoint=${endpointFromWsdl(wsdlUrl)} accessKey=${accessKey}`
  );
  const response = await postSoapWithRetry(wsdlUrl, soapEnvelope('autorizacion', accessKey), 'autorizacion', accessKey);
  try {
    const parsed = parseAutorizacionResponse(response.body, response.statusCode);
    const authorization = parsed?.RespuestaAutorizacionComprobante?.autorizaciones?.autorizacion;
    const first = Array.isArray(authorization) ? authorization[0] : authorization;
    console.info(
      `[SRI SOAP] autorizacion resultado ` +
      `environment=${environmentFromWsdl(wsdlUrl)} accessKey=${accessKey} ` +
      `attempts=${response.attempts} estado=${first?.estado || 'PENDIENTE'} ` +
      `numeroAutorizacion=${first?.numeroAutorizacion || 'none'} ` +
      `fechaAutorizacion=${first?.fechaAutorizacion || 'none'} ` +
      `mensaje=${first?.mensajes?.mensaje ? JSON.stringify(first.mensajes.mensaje) : 'none'}`
    );
    return parsed;
  } catch (error) {
    if (error instanceof SriSoapFaultError) {
      logSoap('autorizacion', wsdlUrl, accessKey, { attempt: response.attempts, durationMs: response.durationMs, statusCode: response.statusCode, code: error.code });
    }
    throw error;
  }
}

export async function autorizacionConPolling(
  wsdlUrl: string,
  accessKey: string,
  options: SriAuthorizationPollingOptions = {}
) {
  const maxAttempts = Math.min(Math.max(options.maxAttempts ?? 3, 1), 3);
  const intervalMs = Math.max(options.intervalMs ?? 5000, 0);
  let lastResponse: any;

  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    const startedAt = Date.now();
    lastResponse = await autorizacion(wsdlUrl, accessKey);
    const parsed = parseAutorizacion(lastResponse);
    console.info(
      `[SRI POLLING] accessKey=${accessKey} attempt=${attempt} ` +
      `estado=${parsed.estado} durationMs=${Date.now() - startedAt}`
    );

    if (parsed.estado === 'AUTORIZADO' || parsed.estado === 'NO AUTORIZADO' || attempt >= maxAttempts) {
      return lastResponse;
    }

    await wait(intervalMs);
  }

  return lastResponse;
}

export function isRecibida(resp: any): boolean {
  const estado =
    resp?.respuestaRecepcionComprobante?.estado ??
    resp?.RespuestaRecepcionComprobante?.estado ??
    resp?.RespuestaRecepcionComprobante?.comprobantes?.comprobante?.estado;
  return String(estado || '').toUpperCase().trim() === 'RECIBIDA';
}


// sri.ts
export type AutResult = {
  estado: 'AUTORIZADO' | 'NO AUTORIZADO' | 'PENDIENTE' | 'DESCONOCIDO';
  autorizado: boolean;
  number: string;
  date: string;
  xmlAut: string;
  errorMsg: string;
};

export function parseAutorizacion(resp: any): AutResult {
  const raiz = resp?.RespuestaAutorizacionComprobante ?? resp;

  const numeroComprobantes = (raiz?.numeroComprobantes ?? '').toString().trim();
  const autRoot = raiz?.autorizaciones?.autorizacion;

  // <-- caso típico de "pendiente / no encontrado aún"
  if (!autRoot || numeroComprobantes === '0') {
    return {
      estado: 'PENDIENTE',
      autorizado: false,
      number: '',
      date: '',
      xmlAut: '',
      errorMsg: 'Sin autorización disponible (pendiente o no encontrado).'
    };
  }

  const first = Array.isArray(autRoot) ? autRoot[0] : autRoot;
  let estado = (first?.estado ?? '').toString().trim().toUpperCase() || 'DESCONOCIDO';

  let autorizado = estado === 'AUTORIZADO';
  let number = first?.numeroAutorizacion ?? '';
  let date   = first?.fechaAutorizacion ?? '';
  let xmlAut = '';
  let errorMsg = '';

  if (first?.comprobante) {
    const c = String(first.comprobante);
    const m = /<!\[CDATA\[([\s\S]*?)\]\]>/.exec(c);
    xmlAut = (m ? m[1] : c).trim();
  }

  if (estado === 'NO AUTORIZADO') {
    const mensajes = first?.mensajes?.mensaje;
    if (Array.isArray(mensajes)) {
      errorMsg = mensajes
        .map(m => [m?.identificador, m?.mensaje, m?.informacionAdicional].filter(Boolean).join(': '))
        .join(' | ');
    } else if (mensajes) {
      errorMsg = [mensajes?.identificador, mensajes?.mensaje, mensajes?.informacionAdicional]
        .filter(Boolean).join(': ');
    } else {
      errorMsg = 'No autorizado sin mensaje específico';
    }
  }

  return { estado: estado as AutResult['estado'], autorizado, number, date, xmlAut, errorMsg };
}
