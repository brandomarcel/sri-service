export type Payment = { code: string; amount: number };

export type Tax = {
  type_code: string;  // Cambiado de 'type' a 'type_code'
  rate: number;
  // Campos adicionales que tu función parece esperar
  rate_code?: string;
  base?: number;
  amount?: number;
}
export type Item = {
  code: string;
  description: string;
  qty: number;
  unit_price: number;
  discount?: number;
  taxes?: Tax[];  // Cambiado para usar el tipo Tax corregido
  // Campos adicionales que tu función parece usar
  total_without_taxes?: number;
};
export interface EmitInvoiceInput {
  idempotency_key: string;
  env: 'test'|'prod';
  numeric_code?: string;
  company: {
    id?: string;
    ruc: string;
    estab: string;
    ptoEmi: string;
    secuencial: string;
    razonSocial: string;
    nombreComercial?: string;
    dirMatriz: string;
    dirEstablecimiento: string;
    contribuyenteRimpe?: string;
    obligadoContabilidad?: 'SI'|'NO';  // Campo añadido
  };
  certificate: ({ p12_base64: string } | { p12_path: string }) & { password: string };
  invoice: {
    issueDate: string;
    buyer: {
      idType: string;
      id: string;
      name: string;
      email?: string;
      address?: string;  // Campo añadido
    };
    totals: {
      // Campos flexibles para diferentes tasas de impuestos
      [key: string]: number | Payment[];
      subtotal_0: number;
      total_discount: number;
      total: number;
      payments: Payment[];
    };
    items: Item[];
    additional?: { name: string; value: string }[];  // Cambiado de Record<string, string>
  };
}

export interface EmitInvoiceOutput {
  status: 'AUTHORIZED' | 'PROCESSING' | 'NOT_AUTHORIZED' | 'ERROR' | 'DEVUELTA';
  accessKey?: string;
  authorization?: { number: string; date: string };
  xml_signed_base64?: string;
  xml_authorized_base64?: string;
  messages?: string[];
  payload_hash?: string;
  
}

export interface IdempotencyRecord {
  response: EmitInvoiceOutput;
  timestamp: number;
  ttl?: number;
}
