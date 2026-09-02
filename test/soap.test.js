const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');
const https = require('node:https');
const { test } = require('node:test');

const {
  SriSoapFaultError,
  SriTransportError,
  autorizacion,
  buildSoapEnvelope,
  endpointFromWsdl,
  isRecibida,
  postSoapWithRetry,
  recepcion
} = require('../dist/sri');

const wsdl = 'https://celcer.sri.gob.ec/comprobantes-electronicos-ws/RecepcionComprobantesOffline?wsdl';
const authWsdl = 'https://celcer.sri.gob.ec/comprobantes-electronicos-ws/AutorizacionComprobantesOffline?wsdl';
const accessKey = '2026090201123456789012311001000000001123456781' + '0';

function signedInvoice() {
  return `<factura><infoTributaria><ambiente>1</ambiente><tipoEmision>1</tipoEmision><razonSocial>Empresa</razonSocial><ruc>1234567890123</ruc><claveAcceso>${accessKey}</claveAcceso><codDoc>01</codDoc><estab>001</estab><ptoEmi>001</ptoEmi><secuencial>000000001</secuencial><dirMatriz>Matriz</dirMatriz></infoTributaria><infoFactura><fechaEmision>02/09/2026</fechaEmision><dirEstablecimiento>Establecimiento</dirEstablecimiento><obligadoContabilidad>SI</obligadoContabilidad><tipoIdentificacionComprador>05</tipoIdentificacionComprador><razonSocialComprador>Cliente</razonSocialComprador><identificacionComprador>0102030405</identificacionComprador><totalSinImpuestos>10.00</totalSinImpuestos><totalDescuento>0.00</totalDescuento><propina>0.00</propina><importeTotal>10.00</importeTotal><moneda>DOLAR</moneda><pagos><pago><formaPago>01</formaPago><total>10.00</total></pago></pagos></infoFactura><detalles><detalle><codigoPrincipal>A</codigoPrincipal><descripcion>Producto</descripcion><cantidad>1.00</cantidad><precioUnitario>10.00</precioUnitario><descuento>0.00</descuento><precioTotalSinImpuesto>10.00</precioTotalSinImpuesto><impuestos><impuesto><codigo>2</codigo><codigoPorcentaje>0</codigoPorcentaje><tarifa>0</tarifa><baseImponible>10.00</baseImponible><valor>0.00</valor></impuesto></impuestos></detalle></detalles><ds:Signature xmlns:ds="http://www.w3.org/2000/09/xmldsig#"/></factura>`;
}

function soapResponse(body, statusCode = 200) {
  const response = new EventEmitter();
  response.statusCode = statusCode;
  process.nextTick(() => {
    response.emit('data', Buffer.from(body));
    response.emit('end');
  });
  return response;
}

function mockHttps(responder) {
  const calls = [];
  const original = https.request;
  https.request = (url, options, callback) => {
    const request = new EventEmitter();
    request.setTimeout = (timeout, onTimeout) => { request.timeout = timeout; request.onTimeout = onTimeout; };
    request.destroy = (error) => process.nextTick(() => request.emit('error', error));
    request.end = (body) => {
      calls.push({ url, options, body: Buffer.from(body) });
      responder({ request, url, options, body: Buffer.from(body), callback, calls });
    };
    return request;
  };
  return { calls, restore: () => { https.request = original; } };
}

test('construye SOAP 1.1 y elimina ?wsdl del endpoint POST', () => {
  assert.equal(endpointFromWsdl(wsdl), 'https://celcer.sri.gob.ec/comprobantes-electronicos-ws/RecepcionComprobantesOffline');
  const envelope = buildSoapEnvelope('recepcion', '<signed>&value</signed>');
  assert.match(envelope, /schemas\.xmlsoap\.org\/soap\/envelope/);
  assert.match(envelope, /<ec:validarComprobante><xml>&lt;signed&gt;&amp;value&lt;\/signed&gt;<\/xml>/);
});

test('envía Content-Length, SOAPAction, HTTP 1.1, sin compresión ni keep-alive', async () => {
  const mock = mockHttps(({ callback, body }) => callback(soapResponse('<soap:Envelope xmlns:soap="http://schemas.xmlsoap.org/soap/envelope/"><soap:Body><ok/></soap:Body></soap:Envelope>')));
  try {
    const body = Buffer.from('soap-body');
    await postSoapWithRetry(wsdl, body.toString(), 'recepcion', accessKey, { maxAttempts: 1, timeoutMs: 1000 });
    const request = mock.calls[0];
    assert.equal(request.options.method, 'POST');
    assert.equal(request.options.family, 4);
    assert.equal(request.options.minVersion, 'TLSv1.2');
    assert.equal(request.options.rejectUnauthorized, true);
    assert.equal(request.options.agent.options.keepAlive, false);
    assert.equal(request.options.headers['Content-Type'], 'text/xml;charset=UTF-8');
    assert.equal(request.options.headers['Content-Length'], body.length);
    assert.equal(request.options.headers.SOAPAction, '""');
    assert.equal(request.options.headers['Accept-Encoding'], 'identity');
    assert.equal(request.options.headers.Connection, 'close');
    assert.equal('Expect' in request.options.headers, false);
  } finally {
    mock.restore();
  }
});

test('clasifica ECONNRESET y limita los reintentos a tres', async () => {
  const mock = mockHttps(({ request }) => process.nextTick(() => request.emit('error', { code: 'ECONNRESET' })));
  try {
    await assert.rejects(
      () => postSoapWithRetry(wsdl, '<soap/>', 'recepcion', accessKey, { maxAttempts: 3, backoffMs: 0, timeoutMs: 10 }),
      (error) => error instanceof SriTransportError && error.code === 'SRI_CONNECTION_RESET' && error.attempts === 3
    );
    assert.equal(mock.calls.length, 3);
  } finally {
    mock.restore();
  }
});

test('clasifica timeout y reintenta solo errores transitorios', async () => {
  const mock = mockHttps(({ request }) => process.nextTick(() => request.onTimeout()));
  try {
    await assert.rejects(
      () => postSoapWithRetry(wsdl, '<soap/>', 'recepcion', accessKey, { maxAttempts: 3, backoffMs: 0, timeoutMs: 10 }),
      (error) => error instanceof SriTransportError && error.code === 'SRI_TIMEOUT'
    );
    assert.equal(mock.calls.length, 3);
  } finally {
    mock.restore();
  }
});

test('parsea RECIBIDA sin reintentar', async () => {
  const response = '<soap:Envelope xmlns:soap="http://schemas.xmlsoap.org/soap/envelope/"><soap:Body><RespuestaRecepcionComprobante><estado>RECIBIDA</estado><comprobantes><comprobante/></comprobantes></RespuestaRecepcionComprobante></soap:Body></soap:Envelope>';
  const mock = mockHttps(({ callback }) => callback(soapResponse(response)));
  try {
    const result = await recepcion(wsdl, signedInvoice());
    assert.equal(isRecibida(result), true);
    assert.equal(mock.calls.length, 1);
  } finally {
    mock.restore();
  }
});

test('parsea rechazo tributario como respuesta válida sin reintentar', async () => {
  const response = '<soap:Envelope xmlns:soap="http://schemas.xmlsoap.org/soap/envelope/"><soap:Body><RespuestaRecepcionComprobante><estado>DEVUELTA</estado><comprobantes><comprobante><mensajes><mensaje><identificador>43</identificador><mensaje>Comprobante inválido</mensaje><informacionAdicional>Revise los datos</informacionAdicional></mensaje></mensajes></comprobante></comprobantes></RespuestaRecepcionComprobante></soap:Body></soap:Envelope>';
  const mock = mockHttps(({ callback }) => callback(soapResponse(response)));
  try {
    const result = await recepcion(wsdl, signedInvoice());
    assert.equal(isRecibida(result), false);
    assert.equal(mock.calls.length, 1);
    assert.equal(result.RespuestaRecepcionComprobante.comprobantes.comprobante.mensajes.mensaje[0].identificador, '43');
  } finally {
    mock.restore();
  }
});

test('parsea AUTORIZADO y SOAP Fault sin exponer el payload', async () => {
  const authorized = '<soap:Envelope xmlns:soap="http://schemas.xmlsoap.org/soap/envelope/"><soap:Body><RespuestaAutorizacionComprobante><numeroComprobantes>1</numeroComprobantes><autorizaciones><autorizacion><estado>AUTORIZADO</estado><numeroAutorizacion>AUTH-1</numeroAutorizacion><fechaAutorizacion>2026-09-02</fechaAutorizacion><comprobante><![CDATA[<factura/>]]></comprobante></autorizacion></autorizaciones></RespuestaAutorizacionComprobante></soap:Body></soap:Envelope>';
  const mock = mockHttps(({ callback }) => callback(soapResponse(authorized)));
  const logs = [];
  const originalInfo = console.info;
  console.info = (message) => logs.push(String(message));
  try {
    const result = await autorizacion(authWsdl, accessKey);
    assert.equal(result.RespuestaAutorizacionComprobante.autorizaciones.autorizacion.estado, 'AUTORIZADO');
    assert.equal(logs.some((line) => line.includes('<factura') || line.includes('password')), false);
  } finally {
    console.info = originalInfo;
    mock.restore();
  }

  const faultMock = mockHttps(({ callback }) => callback(soapResponse('<soap:Envelope xmlns:soap="http://schemas.xmlsoap.org/soap/envelope/"><soap:Body><soap:Fault><faultcode>soap:Server</faultcode><faultstring>Rejected by service</faultstring></soap:Fault></soap:Body></soap:Envelope>', 500)));
  try {
    await assert.rejects(() => autorizacion(authWsdl, accessKey), (error) => error instanceof SriSoapFaultError && error.code === 'SRI_SOAP_FAULT');
  } finally {
    faultMock.restore();
  }
});
