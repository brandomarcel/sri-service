const test = require('node:test');
const assert = require('node:assert/strict');

const { getReceptionStatus, isRecibida } = require('../dist/sri');

test('distingue una recepción SOAP confirmada de una recepción inferida', () => {
  const directResponse = {
    RespuestaRecepcionComprobante: {
      estado: 'RECIBIDA'
    }
  };

  assert.equal(isRecibida(directResponse), true);
  assert.equal(getReceptionStatus(directResponse), 'RECIBIDA');

  const inferredResponse = {
    __receptionConfirmed: false,
    RespuestaRecepcionComprobante: {
      estado: 'RECIBIDA'
    }
  };

  assert.equal(isRecibida(inferredResponse), true);
  assert.equal(getReceptionStatus(inferredResponse), 'UNKNOWN');
});

test('identifica una recepción devuelta', () => {
  const response = {
    RespuestaRecepcionComprobante: {
      estado: 'DEVUELTA'
    }
  };

  assert.equal(getReceptionStatus(response), 'DEVUELTA');
});
