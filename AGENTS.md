# AGENTS.md

Guía operativa para agentes de IA que trabajen en este repositorio. Este documento describe únicamente lo que se pudo verificar en el código actual. Cuando un dato no está implementado o no está almacenado en este repositorio se indica como **Pendiente de documentación**.

## 1. Descripción del proyecto

Este repositorio contiene una API Node.js/TypeScript para emitir comprobantes electrónicos del SRI de Ecuador. Su responsabilidad principal es recibir datos de un comprobante, generar o recibir su XML, firmarlo con un certificado digital P12/PFX, enviarlo a los servicios SOAP del SRI y consultar su autorización.

Los documentos soportados por la API son:

- Factura (`codDoc` `01`).
- Nota de crédito (`codDoc` `04`).
- Nota de débito (`codDoc` `05`).
- Guía de remisión (`codDoc` `06`).

El consumidor externo previsto incluye Frappe, pero Frappe no forma parte de este repositorio. Sus DocTypes, tablas, jobs y reglas de persistencia son **Pendiente de documentación** aquí.

No existe frontend en este repositorio. Tampoco existe una base de datos SQL, ORM o migraciones; la idempotencia y el estado temporal se manejan con Redis y, en desarrollo, pueden usar memoria del proceso.

## 2. Arquitectura del sistema

### Estructura

- `src/server.ts`: aplicación Express, rutas HTTP, validación Zod, normalización de respuestas y mapeo de errores.
- `src/emit.ts`: orquestación de emisión, idempotencia, certificados, generación/firma, persistencia temporal y polling de autorización.
- `src/sri.ts`: transporte SOAP, validación del XML firmado, recepción, autorización, reintentos y errores del SRI.
- `src/sri-config.ts`: selección de URLs de pruebas (`test`) o producción (`prod`) y valores por defecto.
- `src/types.ts`: tipos y contratos de entrada/salida de la API.
- `test/certificate.test.js`: pruebas de certificados, validaciones y compatibilidad de payloads.
- `test/soap.test.js`: pruebas del transporte SOAP, reintentos, respuestas de recepción/autorización y errores.
- `dist/`: salida compilada de TypeScript. Está ignorada por Git; la fuente mantenible es `src/`.
- `ecosystem.config.js` y `ecosystem_dev.config.js`: configuración de PM2 para los procesos de producción y desarrollo.
- `invoice.json`: payload de ejemplo; no debe considerarse contrato completo ni fuente de reglas fiscales.
- Dependencia local `open-factura-ec`: genera XML de facturas, notas y guías, y expone la firma XML. La dependencia está configurada como `file:../open-factura-ec-2025`.

### Flujo de datos

1. Express recibe el request.
2. Zod valida el payload y el certificado.
3. `emit.ts` obtiene o genera la clave de acceso, verifica idempotencia y adquiere un lock distribuido.
4. La librería local `open-factura-ec` genera el XML, salvo en el endpoint que recibe XML directamente.
5. El certificado P12/PFX firma el XML.
6. `sri.ts` valida el documento firmado y llama a `RecepcionComprobantesOffline`.
7. Si el SRI recibe el comprobante, se consulta `AutorizacionComprobantesOffline` de forma inmediata y mediante polling en segundo plano cuando corresponde.
8. `emit.ts` guarda el resultado temporal en Redis o memoria y devuelve el estado al consumidor.
9. Frappe puede consultar el estado mediante el endpoint de estado.

Rutas verificadas:

- `POST /api/v1/invoices/emit`
- `POST /api/v1/invoices/emit-xml`
- `POST /api/v1/credit-notes/emit`
- `POST /api/v1/debit-notes/emit`
- `POST /api/v1/remission-guides/emit`
- `GET /api/v1/invoices/:accessKey/status`
- `GET /api/v1/documents/:accessKey/status`
- `GET /api/v1/config`
- `GET /health`

## 3. Stack tecnológico

- Lenguaje: TypeScript, compilado a JavaScript CommonJS con objetivo ES2020.
- Runtime: Node.js.
- Framework HTTP: Express.
- Validación: Zod.
- SOAP/XML: `soap`, `@xmldom/xmldom`, `xml-core`, `xpath`.
- Firma y criptografía: `@peculiar/webcrypto`, OpenSSL del sistema y la librería local `open-factura-ec`.
- Colas/concurrencia: `p-queue` y polling en segundo plano.
- Persistencia temporal e idempotencia: Redis mediante `redis`; fallback en memoria para escenarios no productivos.
- Pruebas: Node test runner (`node --test`) y OpenSSL para certificados de prueba.
- Procesos: PM2.
- Servicios externos: SRI Ecuador mediante SOAP. Frappe es un consumidor externo.
- Base de datos relacional: no existe implementación en este repositorio; **Pendiente de documentación** si se requiere documentar la base de datos de Frappe.

Comandos definidos:

- `npm run build`: compila `src` en `dist`.
- `npm test`: compila y ejecuta las pruebas de `test/`.
- `npm run dev`: ejecuta `src/server.ts` con `ts-node-dev`.
- `npm start`: ejecuta `dist/server.js`.

## 4. Reglas generales para agentes IA

- No modificar código crítico de emisión sin entender el flujo completo desde generación hasta autorización.
- Mantener compatibilidad con los endpoints, nombres de campos, códigos de error y respuestas existentes.
- No regenerar ni reemplazar una clave de acceso durante una misma operación.
- Evitar cambios innecesarios en `src/sri.ts`, `src/emit.ts` y en los contratos de `src/types.ts`.
- Priorizar soluciones simples, tipadas, observables y mantenibles.
- Validar en el borde HTTP con Zod y mantener las validaciones fiscales críticas también en el backend.
- No asumir que un cambio en `src` está desplegado: el runtime PM2 usa `dist/server.js`, por lo que se debe compilar y reiniciar/recrear el proceso correspondiente.
- No editar `dist` como solución permanente. Si se inspecciona o modifica temporalmente para una operación de despliegue, la fuente de verdad sigue siendo `src`.
- No documentar como existente una tabla, endpoint, configuración o flujo que no esté comprobado en el repositorio.
- Antes de cambiar la dependencia local `open-factura-ec`, verificar su ruta, API y compatibilidad con todos los tipos de comprobante.

## 5. Arquitectura de facturación electrónica SRI

Flujo obligatorio:

```text
Generación factura
        ↓
Generación clave acceso
        ↓
Construcción XML
        ↓
Firma electrónica
        ↓
Envío RecepcionComprobantesOffline
        ↓
Consulta AutorizacionComprobantesOffline
        ↓
Actualización estado factura
```

Aunque el generador puede construir la clave durante la generación del XML, conceptualmente la clave se debe determinar una sola vez antes de continuar el proceso.

1. **Generación del comprobante**: el endpoint normaliza el payload y el generador local construye la estructura del documento. Facturas, notas de crédito, notas de débito y guías usan generadores distintos.
2. **Generación de clave de acceso**: la API/librería la genera a partir de los datos fiscales del comprobante y del código numérico. El SRI no la genera. Para idempotencia, el código numérico se deriva de forma determinista cuando el request no lo proporciona.
3. **Construcción XML**: se construye el XML del tipo de comprobante correspondiente. `sri.ts` valida raíz, `codDoc`, RUC, ambiente, establecimiento, punto de emisión, secuencial y estructura específica antes del envío.
4. **Firma electrónica**: se usa el certificado P12/PFX proporcionado en el request. El password nunca debe llegar a logs. Los archivos temporales se crean con permisos restrictivos y deben eliminarse.
5. **Recepción**: se invoca la operación SOAP `validarComprobante` de `RecepcionComprobantesOffline`. `RECIBIDA` significa que el SRI aceptó la recepción para continuar el proceso; no equivale todavía a autorización final.
6. **Autorización**: se invoca `autorizacionComprobante` de `AutorizacionComprobantesOffline`. La consulta puede devolver autorización, rechazo o ausencia temporal de autorización.
7. **Actualización de estado**: el resultado se guarda en Redis/memoria para consulta posterior. El polling en segundo plano actualiza el estado con autorización, rechazo o error.

URLs por ambiente configuradas por `src/sri-config.ts`:

- Pruebas: `celcer.sri.gob.ec`.
- Producción: `cel.sri.gob.ec`.

La ficha técnica exacta del SRI y su versión de julio de 2026 no están almacenadas en este repositorio. **Pendiente de documentación**; no asumir una versión normativa únicamente por el código.

## 6. Reglas críticas SRI

- La clave de acceso es generada por la aplicación/librería, no por el SRI.
- La clave debe permanecer idéntica durante generación, firma, recepción, autorización y consulta.
- No regenerar claves para una misma factura o comprobante.
- El `estab` y `ptoEmi` deben coincidir con la configuración fiscal del contribuyente y con el XML emitido.
- Nunca alterar un secuencial que ya fue utilizado.
- No enviar comprobantes duplicados. Usar la idempotencia existente y consultar autorización si existe incertidumbre de transporte.
- El código numérico debe ser estable para una misma operación y tener el formato requerido por el generador.
- No cambiar el ambiente (`test`/`prod`) entre recepción y autorización.
- Mantener el `accessKey` original al consultar estado; no calcular otra clave a partir de una respuesta parcial.
- Los tipos actualmente validados son `01`, `04`, `05` y `06`. Si se agrega otro documento, actualizar generador, validación, rutas, estados, logs y pruebas en conjunto.
- Una redirección HTTP del SRI no se debe seguir automáticamente. El transporte la convierte en estado pendiente/procesable para evitar duplicar el comprobante.

## 7. Manejo de errores SRI

Estados observados en el código:

- **`RECIBIDA`**: la recepción del SRI aceptó el comprobante. Se debe consultar autorización.
- **`DEVUELTA`**: la recepción rechazó el comprobante. Revisar los mensajes devueltos por el SRI, corregir la causa y no hacer reenvíos ciegos. En la emisión actual se trata como rechazo de recepción y puede exponerse como `ERROR`/`SRI_REJECTED`; la persistencia de un estado final `DEVUELTA` independiente está **Pendiente de documentación**.
- **`AUTORIZADO`**: autorización final exitosa. Conservar número, fecha y XML autorizado sin exponerlos en logs.
- **`NO AUTORIZADO`**: rechazo final de autorización. Conservar los mensajes y no reemitir automáticamente sin corregir la causa.
- **`PROCESSING`**: estado de la API mientras el comprobante está recibido, la autorización sigue pendiente o existe una condición transitoria que requiere consulta posterior.
- **`PENDIENTE`**: la consulta de autorización no encontró todavía una autorización. En el parser actual se usa, entre otros casos, cuando no existe el nodo `autorizacion`.

`numeroComprobantes: 0` junto con `autorizaciones: null` no demuestra por sí solo que el comprobante haya fallado. Puede significar:

- La autorización todavía no está disponible.
- El comprobante aún no llegó correctamente al SRI.
- Se consultó el ambiente equivocado.
- La clave de acceso consultada no coincide.
- La recepción fue devuelta.
- Hubo un problema de transporte, timeout, SOAP o parseo.

Para diagnosticarlo, revisar en orden los logs de generación, firma, recepción, respuesta de recepción, consulta de autorización y persistencia. No convertir automáticamente `PENDIENTE` en `NO AUTORIZADO`.

## 8. Sistema de logs obligatorio

Cada flujo SRI debe tener un identificador de trazabilidad único. En el código actual el campo compatible es `trace_id` en el request y `traceId` internamente; si no llega, se genera un UUID. El formato solicitado `TX-SRI-20261004-000020` es una convención válida para nuevos consumidores, pero no debe reemplazar silenciosamente el contrato actual.

Registrar como mínimo:

- Inicio del proceso.
- Tipo de documento y ambiente.
- Generación del XML, sin incluir el XML.
- Firma realizada, sin incluir certificado, password ni clave privada.
- Envío SOAP.
- Respuesta SOAP resumida.
- Consulta de autorización.
- Cambio de estado y resultado de persistencia.
- Reintento, timeout, redirect o error de transporte.

Las categorías esperadas son:

```text
[SRI][RECEPCION][REQUEST]
[SRI][RECEPCION][RESPONSE]
[SRI][AUTORIZACION][REQUEST]
[SRI][AUTORIZACION][RESPONSE]
```

El código actual usa logs estructurados con prefijos `[SRI SOAP]` y `[SRI PIPELINE]`, incluyendo timestamp, nivel, evento, `traceId`, tipo de documento, ambiente, clave enmascarada y hash de idempotencia. Los cambios deben extender esa trazabilidad sin romper los consumidores de logs.

Nunca registrar el XML completo, Base64 del certificado, password, clave privada, token sensible ni XML autorizado. Se pueden registrar hash, tamaños, tipo de documento, ambiente, clave enmascarada, código de error, fase y duración.

## 9. Seguridad

Nunca registrar ni devolver a logs:

- Claves privadas.
- Passwords de certificados.
- Tokens o secretos.
- Certificados P12/PFX completos.
- XML completo o su Base64.
- Claves de acceso completas cuando no sean necesarias para diagnóstico.

Se permite registrar:

- Hash del XML o del payload.
- Clave de acceso enmascarada.
- Tamaño del XML.
- Ambiente y tipo de documento.
- Estado de disponibilidad del certificado.
- Fecha de expiración del certificado.
- Código, fase y mensaje sanitizado del error.

El endpoint `/api/v1/config` solo debe mostrar estados de configuración, no valores sensibles. La recepción del certificado acepta Base64/Data URI o rutas controladas; las rutas deben estar dentro de los directorios permitidos. Los temporales P12 deben tener permisos `0600` y eliminarse al finalizar.

La respuesta HTTP existente puede contener XML firmado/autorizado en Base64 porque forma parte del contrato actual. No loguear esos campos ni cambiar su exposición sin una decisión explícita de compatibilidad y seguridad.

## 10. Base de datos

No existe una base de datos relacional en este repositorio. No hay tablas, modelos ORM, relaciones ni migraciones que se puedan documentar. Las tablas y DocTypes de Frappe son externos y quedan **Pendientes de documentación**.

La persistencia implementada aquí es temporal:

- Redis usa claves de respuesta de idempotencia con prefijo `idempotency:`.
- Redis usa locks distribuidos con prefijo `idempotency-lock:`.
- Las respuestas cacheadas tienen una expiración de 24 horas.
- El lock distribuido tiene una expiración aproximada de 180 segundos.
- Si Redis no está disponible, el proceso puede usar memoria en desarrollo; en producción la ausencia del estado distribuido debe producir `SRI_STATE_UNAVAILABLE`.

No agregar una base SQL ni cambiar el almacenamiento de estados sin documentar migración, consistencia, expiración, recuperación y compatibilidad con Frappe.

## 11. Variables de entorno

No copiar valores reales de `.env` a documentación, logs, commits ni respuestas.

| Variable | Propósito | Ejemplo seguro |
|---|---|---|
| `NODE_ENV` | Ambiente de ejecución, incluido el comportamiento estricto de estado en producción. | `test` o `production` |
| `PORT` | Puerto HTTP de Express. | `8090` |
| `REDIS_URL` | URL de Redis para idempotencia, locks y estados. | `redis://127.0.0.1:6379` |
| `SRI_CERTIFICADO_TEST_P12` | Estado/configuración visible para el ambiente de pruebas; no registrar su contenido. | `<secreto-no-documentar>` |
| `SRI_CERTIFICADO_TEST_PASSWORD` | Password del certificado de pruebas; nunca registrar. | `<secreto-no-documentar>` |
| `SRI_CERTIFICADO_PROD_P12` | Estado/configuración visible para producción; no registrar su contenido. | `<secreto-no-documentar>` |
| `SRI_CERTIFICADO_PROD_PASSWORD` | Password del certificado de producción; nunca registrar. | `<secreto-no-documentar>` |
| `SRI_RECEPCION_TEST` | URL SOAP de recepción en pruebas. | `<url-test>` |
| `SRI_AUTORIZACION_TEST` | URL SOAP de autorización en pruebas. | `<url-test>` |
| `SRI_RECEPCION_PROD` | URL SOAP de recepción en producción. | `<url-produccion>` |
| `SRI_AUTORIZACION_PROD` | URL SOAP de autorización en producción. | `<url-produccion>` |
| `SRI_CONNECTION_TIMEOUT_MS` | Timeout de conexión SOAP. | `8000` |
| `SRI_READ_TIMEOUT_MS` | Timeout de lectura SOAP. | `25000` |
| `SRI_MAX_ATTEMPTS` | Máximo de intentos para fallos transitorios. | `3` |
| `SRI_PROVEEDOR_RUC` | RUC opcional agregado como información adicional cuando aplica. | `<ruc-13-digitos>` |
| `SRI_CERTIFICATE_ALLOWED_DIR` / `SRI_CERTIFICATES_DIR` | Directorio permitido para certificados por ruta. | `/ruta/controlada` |
| `OPENSSL_BIN` | Ejecutable OpenSSL alternativo para validación/firma. | `openssl` |

Las últimas variables opcionales pueden no estar presentes en todos los `.env`; su uso se debe confirmar en el código antes de cambiarlo. No existe `.env.example` verificado; **Pendiente de documentación** crear uno seguro si el proyecto lo requiere.

## 12. Convenciones de código

- Mantener TypeScript estricto y tipos explícitos en contratos públicos.
- Usar `camelCase` para variables y funciones, `PascalCase` para tipos/clases y nombres de rutas coherentes con los endpoints existentes.
- Mantener los nombres fiscales y códigos SRI exactos: `01`, `04`, `05`, `06`, `RECIBIDA`, `DEVUELTA`, `AUTORIZADO`, `NO AUTORIZADO`, `PROCESSING` y `PENDIENTE`.
- Usar `async/await` y errores tipados; no ocultar excepciones de transporte o SOAP.
- Validar entradas con Zod antes de llegar a generación o firma.
- Mantener separados generación, firma, transporte, polling y persistencia; no mezclar llamadas HTTP con reglas de payload sin necesidad.
- Usar `trace_id`/`traceId` en toda nueva operación y propagarlo a logs y errores.
- Enmascarar claves y sanitizar mensajes antes de escribir logs.
- Preservar campos de respuesta y códigos de error existentes; cualquier cambio debe incluir compatibilidad o versión explícita.
- El XML se trata como contenido sensible: nunca agregar logs de depuración que impriman XML completo.
- Al añadir un tipo de comprobante, actualizar tipos, schema, generador, validación XML, endpoint, polling, estado, logs y pruebas.

## 13. Cómo realizar cambios

Antes de modificar el código:

1. Analizar el impacto en `server.ts`, `emit.ts`, `sri.ts`, `types.ts` y en la dependencia `open-factura-ec`.
2. Revisar el flujo completo: payload, clave, XML, firma, recepción, autorización, polling, estado y respuesta.
3. Crear una solución compatible con los endpoints y contratos existentes.
4. Agregar o actualizar pruebas unitarias y de transporte simulado.
5. Documentar cambios de configuración, estados, errores y variables de entorno.
6. Ejecutar `npm run build` y `npm test` en un entorno Node compatible.
7. Verificar el `dist` generado y reiniciar PM2 si se está probando el proceso compilado.
8. Revisar que no se hayan agregado secretos, XML completos, certificados o valores reales de `.env`.

Para cambios de emisión, comprobar específicamente:

- Idempotencia con el mismo request.
- Reintentos y recuperación ante timeout/`ECONNRESET`.
- No duplicación después de una respuesta incierta del SRI.
- Compatibilidad de recepción y autorización con el mismo `accessKey`.
- Persistencia del estado en Redis y comportamiento cuando Redis no está disponible.
- Compatibilidad de factura, nota de crédito, nota de débito y guía de remisión.

## 14. Pruebas

Pruebas automatizadas disponibles:

- Certificado P12: Base64, Data URI, password incorrecto, certificado inválido/expirado y rutas permitidas.
- Validación de payload canónico y compatibilidad con payload legado.
- Sobre SOAP, headers, TLS, familia IPv4, ausencia de compresión/keep-alive y stripping de `?wsdl`.
- Reintentos para timeout, `ECONNRESET` y HTTP `502/503/504`.
- Redirección HTTP no seguida automáticamente.
- Respuestas `RECIBIDA`, `DEVUELTA`, `AUTORIZADO`, fault SOAP y polling de autorización.
- Ausencia de secretos en errores/logs cubiertos por las pruebas existentes.

Comandos:

```bash
npm run build
npm test
```

No ejecutar pruebas contra producción ni usar certificados reales en tests. Para probar comunicación SRI se deben usar mocks o un ambiente autorizado de pruebas, con secretos fuera del repositorio.

Cobertura todavía pendiente de implementar o verificar:

- Prueba integral real de generación XML de factura, nota de débito y guía de remisión.
- Prueba integral de firma con certificado controlado.
- Prueba de extremo a extremo contra el SRI con credenciales de pruebas.
- Pruebas específicas de logs y correlación por `trace_id`.
- Pruebas de persistencia Redis, expiración, recuperación y concurrencia.
- Pruebas de integración con Frappe.
- Pruebas de una base de datos SQL, porque no existe en este repositorio.

Cuando el entorno no tenga Node/WSL compatible, separar claramente “código compilado y probado” de “prueba no ejecutada”. No declarar una integración SRI funcional solo por compilar: la autorización real requiere observar requests, respuestas, estados y logs del ambiente correspondiente.
