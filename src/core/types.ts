// Minimal structural types for the slice of OpenAPI 3.0/3.1 we actually
// inspect. We intentionally do NOT model the full spec — only what the
// diff rules need. Anything else is passed through as `unknown`.

export interface OpenAPISpec {
  openapi?: string;
  info?: { title?: string; version?: string };
  paths?: Record<string, PathItem>;
  components?: {
    schemas?: Record<string, SchemaObject>;
    securitySchemes?: Record<string, unknown>;
  };
  security?: SecurityRequirement[];
  [key: string]: unknown;
}

export type SecurityRequirement = Record<string, string[]>;

export interface PathItem {
  [method: string]: Operation | unknown;
}

export interface Operation {
  operationId?: string;
  summary?: string;
  description?: string;
  parameters?: ParameterObject[];
  requestBody?: {
    required?: boolean;
    content?: Record<string, { schema?: SchemaObject }>;
  };
  responses?: Record<string, ResponseObject>;
  security?: SecurityRequirement[];
  [key: string]: unknown;
}

export interface ParameterObject {
  name: string;
  in: 'query' | 'path' | 'header' | 'cookie';
  required?: boolean;
  schema?: SchemaObject;
  example?: unknown;
  description?: string;
}

export interface ResponseObject {
  description?: string;
  content?: Record<string, { schema?: SchemaObject }>;
  headers?: Record<string, unknown>;
}

export interface SchemaObject {
  type?: string;
  properties?: Record<string, SchemaObject>;
  required?: string[];
  enum?: unknown[];
  items?: SchemaObject;
  example?: unknown;
  default?: unknown;
  $ref?: string;
  [key: string]: unknown;
}

export type Severity = 'breaking' | 'warning' | 'info';
export type Category = 'endpoint' | 'request' | 'response' | 'security';

export interface Finding {
  severity: Severity;
  category: Category;
  operation: string; // e.g. "GET /users"
  message: string;
  location: string;
  suggestion: string;
}

export const HTTP_METHODS = [
  'get',
  'put',
  'post',
  'delete',
  'options',
  'head',
  'patch',
  'trace',
] as const;

export type HttpMethod = (typeof HTTP_METHODS)[number];
