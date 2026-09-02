// 1) ENV
import * as dotenv from 'dotenv';
dotenv.config();

// Polyfills para Node (sin cambios)
import { DOMParser, XMLSerializer } from '@xmldom/xmldom';
import * as xpath from 'xpath';
import { webcrypto } from 'crypto';
import { setNodeDependencies } from 'xml-core';
setNodeDependencies({
  DOMParser,
  XMLSerializer,
  xpath,
  atob: (d: string) => Buffer.from(d, 'base64').toString('binary'),
  btoa: (d: string) => Buffer.from(d, 'binary').toString('base64'),
  crypto: webcrypto as any,
});

// 3) Resto de imports
import express from 'express';
import { z } from 'zod';
import { emitirFactura, emitirFacturaDesdeXML, emitirNotaCredito } from './emit';
import { autorizacion, parseAutorizacion,recepcion } from './sri';
import { getSriUrls } from './sri-config';

const app = express();
app.use(express.json({ limit: '10mb' }));

const certificateSchema = z.object({
  // p12_base64 es el contrato actual; p12_path queda solo para compatibilidad.
  p12_base64: z.string().optional(),
  p12_path: z.string().optional(),
  password: z.string().optional()
}).passthrough().superRefine((certificate, context) => {
  if (!certificate.p12_base64 && !certificate.p12_path) {
    context.addIssue({ code: z.ZodIssueCode.custom, path: ['p12_base64'], message: 'Falta p12_base64 o p12_path.' });
  }
  if (!certificate.password) {
    context.addIssue({ code: z.ZodIssueCode.custom, path: ['password'], message: 'Falta la contraseña del certificado.' });
  }
});

// --- Schema Zod para FACTURA (JSON canónico) ---
export const invoiceSchema = z.object({
  idempotency_key: z.string().min(6).optional(),
  env: z.enum(['test','prod']).optional(),
  numeric_code: z.string().regex(/^\d{8}$/).optional(),

  version: z.string().optional().default('2.1.0'),
  certificate: certificateSchema,

  infoTributaria: z.any(),
  infoFactura: z.any(),
  detalles: z.any(),
  infoAdicional: z.any().optional()
});

// --- Schema para el formato legacy ---
export const legacySchema = z.object({
  idempotency_key: z.string().min(6),
  env: z.enum(['test','prod']),
  numeric_code: z.string().regex(/^\d{8}$/).optional(),
  company: z.object({
    id: z.string().optional(),
    ruc: z.string().regex(/^\d{13}$/),
    estab: z.string().regex(/^\d{3}$/),
    ptoEmi: z.string().regex(/^\d{3}$/),
    secuencial: z.string().regex(/^\d{9}$/),
    razonSocial: z.string().min(1),
    nombreComercial: z.string().optional(),
    dirMatriz: z.string().min(1),
    dirEstablecimiento: z.string().min(1),
    contribuyenteRimpe: z.string().optional(),
    obligadoContabilidad: z.string().optional(),
  }),
  certificate: certificateSchema,
  invoice: z.object({
    issueDate: z.string(),
    buyer: z.object({
      idType: z.string(),
      id: z.string(),
      name: z.string(),
      address: z.string().optional(),
      email: z.string().email().optional()
    }),
    totals: z.object({
      subtotal_0: z.number(),
      total_discount: z.number(),
      total: z.number(),
      payments: z.array(z.object({ code: z.string(), amount: z.number() })).min(1)
    }).passthrough(),
    items: z.array(z.object({
      code: z.string(),
      description: z.string(),
      qty: z.number().positive(),
      unit_price: z.number().nonnegative(),
      discount: z.number().optional(),
      taxes: z.array(z.object({
        type_code: z.string(),
        rate: z.number()
      })).optional()
    })).min(1),
    additional: z.array(z.object({
      name: z.string(),
      value: z.string()
    })).optional()
  })
});

// --- Transformador legacy → nuevo ---
function transformLegacyToNewFormat(legacyData: z.infer<typeof legacySchema>) {
  const { company, certificate, invoice, env, idempotency_key, numeric_code } = legacyData;
  const [year, month, day] = invoice.issueDate.split('-');
  const fechaEmision = `${day}/${month}/${year}`;

  const detalles = invoice.items.map(item => ({
    codigoPrincipal: item.code,
    descripcion: item.description,
    cantidad: item.qty,
    precioUnitario: item.unit_price,
    descuento: item.discount || 0,
    precioTotalSinImpuesto: item.qty * item.unit_price - (item.discount || 0),
    impuestos: (item.taxes || []).map(tax => ({
      codigo: tax.type_code,
      codigoPorcentaje: tax.type_code === '2' ? '2' : '0',
      tarifa: tax.rate,
      baseImponible: item.qty * item.unit_price - (item.discount || 0),
      valor: (item.qty * item.unit_price - (item.discount || 0)) * (tax.rate / 100)
    }))
  }));

  const totalSinImpuestos = invoice.totals.subtotal_0;
  const totalDescuento = invoice.totals.total_discount;

  const totalConImpuestos: any[] = [];
  for (const [key, value] of Object.entries(invoice.totals)) {
    if (key.startsWith('subtotal_') && key !== 'subtotal_0') {
      const rate = parseInt(key.split('_')[1]);
      totalConImpuestos.push({
        codigo: '2',
        codigoPorcentaje: rate === 12 ? '2' : rate === 15 ? '4' : '0',
        baseImponible: value as number,
        valor: (value as number) * (rate / 100),
        tarifa: rate
      });
    }
  }

  const pagos = (invoice.totals.payments as any[]).map(p => ({
    formaPago: p.code,
    total: p.amount,
    plazo: '0',
    unidadTiempo: 'dias'
  }));

  return {
    idempotency_key,
    env,
    numeric_code,
    version: '2.1.0',
    certificate,
    infoTributaria: {
      ambiente: env === 'prod' ? '2' : '1',
      tipoEmision: '1',
      razonSocial: company.razonSocial,
      nombreComercial: company.nombreComercial || company.razonSocial,
      ruc: company.ruc,
      codDoc: '01',
      estab: company.estab,
      ptoEmi: company.ptoEmi,
      secuencial: company.secuencial,
      dirMatriz: company.dirMatriz,
      contribuyenteRimpe: company.contribuyenteRimpe,
      obligadoContabilidad: company.obligadoContabilidad
    },
    infoFactura: {
      fechaEmision,
      dirEstablecimiento: company.dirEstablecimiento,
      obligadoContabilidad: company.obligadoContabilidad || 'SI',
      tipoIdentificacionComprador: invoice.buyer.idType,
      razonSocialComprador: invoice.buyer.name,
      identificacionComprador: invoice.buyer.id,
      direccionComprador: invoice.buyer.address,
      totalSinImpuestos,
      totalDescuento,
      totalConImpuestos,
      propina: 0,
      importeTotal: invoice.totals.total,
      moneda: 'DOLAR',
      pagos
    },
    detalles,
    infoAdicional: invoice.additional ? { campos: invoice.additional } : undefined
  };
}

// --- Schema Zod para NOTA DE CRÉDITO (JSON canónico) ---
const creditNoteSchema = z.object({
  idempotency_key: z.string().min(6).optional(),
  env: z.enum(['test','prod']).optional(),
  numeric_code: z.string().regex(/^\d{8}$/).optional(),
  version: z.string().optional().default('1.1.0'),
  certificate: z.object({
    p12_base64: z.string().optional(),
    password: z.string()
  }).passthrough(),
  infoTributaria: z.any(),
  infoNotaCredito: z.any(),
  detalles: z.any(),
  infoAdicional: z.any().optional()
});

// --- Config SRI local (para /status y /config) ---
function getSriConfig(env: 'test' | 'prod') {
  const config = {
    test: {
      recepcion: process.env.SRI_RECEPCION_TEST,
      autorizacion: process.env.SRI_AUTORIZACION_TEST,
      certificado: {
        p12_base64: process.env.SRI_CERTIFICADO_TEST_P12,
        password: process.env.SRI_CERTIFICADO_TEST_PASSWORD
      }
    },
    prod: {
      recepcion: process.env.SRI_RECEPCION_PROD,
      autorizacion: process.env.SRI_AUTORIZACION_PROD,
      certificado: {
        p12_base64: process.env.SRI_CERTIFICADO_PROD_P12,
        password: process.env.SRI_CERTIFICADO_PROD_PASSWORD
      }
    }
  };
  if (env === 'test') {
    if (!config.test.recepcion || !config.test.autorizacion) {
      console.warn('Configuración TEST incompleta: SRI_RECEPCION_TEST / SRI_AUTORIZACION_TEST');
    }
  } else {
    if (!config.prod.recepcion || !config.prod.autorizacion) {
      console.warn('Configuración PROD incompleta: SRI_RECEPCION_PROD / SRI_AUTORIZACION_PROD');
    }
  }
  return config[env];
}

// ---------- Endpoints ----------

// Emitir FACTURA (JSON canónico)
app.post('/api/v1/invoices/emit', async (req, res) => {
  try {
    if (!req.body?.certificate) {
      return res.status(400).json({ ok: false, status: 'ERROR', code: 'VALIDATION_ERROR', messages: ['Falta el campo certificate.'] });
    }
    const newFormatParse = invoiceSchema.safeParse(req.body);
    if (newFormatParse.success) {
      const out = await emitirFactura(newFormatParse.data);
      return res.json(out);
    }

    const legacyFormatParse = legacySchema.safeParse(req.body);
    if (legacyFormatParse.success) {
      const transformedData = transformLegacyToNewFormat(legacyFormatParse.data);
      const out = await emitirFactura(transformedData);
      return res.json(out);
    }

    const errors = [
      ...(newFormatParse.error?.errors ?? []),
      ...(legacyFormatParse.error?.errors ?? []),
    ];
    return res.status(400).json({
      ok: false,
      status: 'ERROR',
      code: 'VALIDATION_ERROR',
      message: 'Formato de datos inválido',
      messages: errors.map((error) => error.message),
      issues: errors
    });
  } catch (e: any) {
    if (e?.statusCode === 400) {
      return res.status(400).json({ ok: false, status: 'ERROR', code: 'VALIDATION_ERROR', messages: [e.message] });
    }
    console.error('Error al emitir factura.');
    return res.status(500).json({ ok: false, status: 'ERROR', code: 'INTERNAL_ERROR', message: 'Internal Error' });
  }
});

// Emitir FACTURA desde XML crudo
app.post('/api/v1/invoices/emit-xml', async (req, res) => {
  try {
    const out = await emitirFacturaDesdeXML({
      xml: req.body?.xml,
      env: req.body?.env,
      idempotency_key: req.body?.idempotency_key,
      certificate: req.body?.certificate,
      urlFirma: req.body?.urlFirma,
      clave: req.body?.clave
    });
    return res.json(out);
  } catch (e: any) {
    if (e?.statusCode === 400) {
      return res.status(400).json({ ok: false, status: 'ERROR', code: 'VALIDATION_ERROR', messages: [e.message] });
    }
    console.error('Error en /emit-xml.');
    return res.status(500).json({ ok: false, status: 'ERROR', code: 'INTERNAL_ERROR', message: 'Internal Error' });
  }
});

// Emitir NOTA DE CRÉDITO (JSON canónico)
app.post('/api/v1/credit-notes/emit', async (req, res) => {
  try {
  
  
    const parsed = creditNoteSchema.safeParse(req.body);
    if (!parsed.success) {
      return res.status(400).json({ ok: false, status: 'ERROR', code: 'VALIDATION_ERROR', message: 'Formato de datos inválido', issues: parsed.error.errors });
    }
    const out = await emitirNotaCredito(parsed.data);
    return res.json(out);
  } catch (e: any) {
    if (e?.statusCode === 400) {
      return res.status(400).json({ ok: false, status: 'ERROR', code: 'VALIDATION_ERROR', messages: [e.message] });
    }
    console.error('Error al emitir nota de crédito.');
    return res.status(500).json({ ok: false, status: 'ERROR', code: 'INTERNAL_ERROR', message: 'Internal Error' });
  }
});

// Endpoint de status (sirve para cualquier clave)
app.get('/api/v1/invoices/:accessKey/status', async (req, res) => {
  try {
    const { accessKey } = req.params;
    const { env } = req.query as { env: 'test' | 'prod' };

    if (!/^\d{49}$/.test(accessKey)) {
      return res.status(400).json({ status: 'ERROR', messages: ['Clave de acceso inválida. Debe tener 49 dígitos.'] });
    }

    // Helper para consultar un ambiente específico
    const checkEnv = async (amb: 'test' | 'prod') => {
      const urls = getSriUrls(amb);
      if (!urls.autorizacion) {
        return {
          status: 'ERROR' as const,
          messages: [`URL de autorización no configurada para ambiente: ${amb}`],
          environment: amb,
        };
      }
      console.info(
        `[SRI STATUS] consulta autorización environment=${amb} ` +
        `endpoint=${urls.autorizacion} accessKey=${accessKey}`
      );
      const authResponse = await autorizacion(urls.autorizacion, accessKey);
      const parsed = parseAutorizacion(authResponse);

      if (parsed.estado === 'AUTORIZADO') {
        return {
          status: 'AUTHORIZED' as const,
          accessKey,
          environment: amb,
          authorization: { number: parsed.number, date: parsed.date },
          xml_authorized_base64: parsed.xmlAut ? Buffer.from(parsed.xmlAut).toString('base64') : undefined,
        };
      }
      if (parsed.estado === 'PENDIENTE' || parsed.estado === 'DESCONOCIDO') {
        return {
          status: 'PROCESSING' as const,
          accessKey,
          environment: amb,
          messages: [parsed.errorMsg || 'El comprobante todavía no tiene autorización (pendiente).'],
        };
      }
      if (parsed.estado === 'NO AUTORIZADO') {
        return {
          status: 'NOT_AUTHORIZED' as const,
          accessKey,
          environment: amb,
          messages: [parsed.errorMsg || 'El comprobante no fue autorizado.'],
        };
      }

      return {
        status: 'UNKNOWN' as const,
        accessKey,
        environment: amb,
        messages: ['Estado de autorización desconocido.'],
      };
    };

    // Si el cliente especifica ambiente, consulta solo ese.
    if (env === 'prod' || env === 'test') {
      const out = await checkEnv(env);
      if (out.status === 'ERROR') {
        return res.status(500).json(out);
      }
      return res.json(out);
    }

    // Si NO especifica ambiente, intenta PROD y luego TEST,
    // y elige el "mejor" resultado.
    const [prodResult, testResult] = await Promise.allSettled([checkEnv('prod'), checkEnv('test')]);

    // Normaliza resultados
    const results = [prodResult, testResult]
      .filter(r => r.status === 'fulfilled')
      .map(r => (r as PromiseFulfilledResult<any>).value);

    if (!results.length) {
      // Ambos fallaron en nivel de red/config
      return res.status(500).json({ status: 'ERROR', messages: ['No se pudo consultar SRI en ninguno de los ambientes.'] });
    }

    // Prioridad: AUTHORIZED > PROCESSING > NOT_AUTHORIZED > UNKNOWN
    const pickByPriority = (arr: any[]) =>
      arr.find(r => r.status === 'AUTHORIZED') ||
      arr.find(r => r.status === 'PROCESSING') ||
      arr.find(r => r.status === 'NOT_AUTHORIZED') ||
      arr[0];

    const chosen = pickByPriority(results);
    return res.json(chosen);

  } catch (e: any) {
    console.error('Error al consultar estado:', e);
    return res.status(500).json({ status: 'ERROR', messages: [e?.message || 'Internal Error'] });
  }
});

// Endpoint para ver la configuración actual
app.get('/api/v1/config', (req, res) => {
  const testConfig = getSriConfig('test');
  const prodConfig = getSriConfig('prod');
  res.json({
    test: {
      recepcion: testConfig.recepcion ? 'Configurada' : 'No configurada',
      autorizacion: testConfig.autorizacion ? 'Configurada' : 'No configurada',
      certificado: testConfig.certificado.p12_base64 ? 'Configurado' : 'No configurado'
    },
    prod: {
      recepcion: prodConfig.recepcion ? 'Configurada' : 'No configurada',
      autorizacion: prodConfig.autorizacion ? 'Configurada' : 'No configurada',
      certificado: prodConfig.certificado.p12_base64 ? 'Configurado' : 'No configurado'
    }
  });
});

// Health check endpoint
app.get('/health', (req, res) => {
  res.json({
    status: 'OK',
    timestamp: new Date().toISOString(),
    service: 'SRI API'
  });
});

export { app };

if (require.main === module) {
  const port = Number(process.env.PORT || 8090);
  app.listen(port, () => console.log(`🚀 Servicio SRI escuchando en el puerto :${port}`));
}
