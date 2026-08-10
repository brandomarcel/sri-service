import * as soap from 'soap';
import { isIP } from 'net';

type SriOperation = 'recepcion' | 'autorizacion';

/**
 * The SOAP endpoint must come from our configuration, not from soap:address in
 * the remote WSDL. node-soap otherwise initializes each port with that value.
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

async function createSriClient(wsdlUrl: string, operation: SriOperation) {
  const endpoint = endpointFromWsdl(wsdlUrl);

  console.info(`[SRI SOAP][${operation}] WSDL URL: ${wsdlUrl}`);
  const client = await soap.createClientAsync(wsdlUrl);

  // Do not trust the possibly stale/incorrect soap:address embedded in WSDL.
  client.setEndpoint(endpoint);
  console.info(`[SRI SOAP][${operation}] client endpoint: ${endpoint}`);

  return { client, endpoint };
}

export async function recepcion(wsdlUrl: string, xmlSigned: string) {
  const { client, endpoint } = await createSriClient(wsdlUrl, 'recepcion');
  const xmlB64 = Buffer.from(xmlSigned, 'utf8').toString('base64');
  console.info(`[SRI SOAP][recepcion] request URL: ${endpoint}`);
  const [resp] = await (client as any).validarComprobanteAsync({ xml: xmlB64 });
  return resp;
}

export async function autorizacion(wsdlUrl: string, accessKey: string) {
  const { client, endpoint } = await createSriClient(wsdlUrl, 'autorizacion');
  const fn =
    (client as any).autorizacionComprobantesAsync ??
    (client as any).autorizacionComprobanteAsync;
  if (typeof fn !== 'function') {
    throw new Error('El WSDL del SRI no expone una operación de autorización compatible.');
  }
  console.info(`[SRI SOAP][autorizacion] request URL: ${endpoint}`);
  const [resp] = await fn({ claveAccesoComprobante: accessKey });
  return resp;
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
  try { console.log('SRI raw:', JSON.stringify(resp)); } catch {}
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


if (!soap || typeof (soap as any).createClientAsync !== 'function') {
  throw new Error('SOAP no cargó correctamente. Revisa el import y que "soap" esté instalado.');
}
