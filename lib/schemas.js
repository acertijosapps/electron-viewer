// Esquemas zod de la API HTTP del visor, con los nombres de campo de la API (no los del MCP:
// el MCP recibe duration_ms y manda ms). Son estrictos: un campo que no existe es un error, para
// que `fromX` en lugar de `x1` diga eso y no llegue a CDP como "Invalid parameters".
// En GET todo llega como texto; los números y booleanos se convierten.

import { z } from 'zod';

const num = () => z.coerce.number();
const int = () => z.coerce.number().int();
const bool = () => z.union([z.boolean(), z.enum(['true', 'false']).transform((v) => v === 'true')], { error: 'must be true or false' });
const coord = () => num().min(0).max(1);
const ms = (min) => int().min(min).max(10000).optional();
const window = z.string().optional();
const app = z.string().optional();
const modifiers = z.union([z.array(z.enum(['alt', 'ctrl', 'meta', 'shift'])), int().min(0).max(15)], {
  error: 'must be a list of alt, ctrl, meta, shift (or a CDP bit mask)',
}).optional();

const object = (shape) => z.object(shape).strict();

export const API_SCHEMAS = {
  'GET /api/windows': object({}),
  'GET /api/project': object({}),
  'GET /api/screenshot': object({ window, max: int().min(1).optional() }),
  'GET /api/ax-tree': object({ window, interactiveOnly: bool().optional() }),
  'GET /api/logs': object({
    window,
    app,
    level: z.string().optional(),
    source: z.enum(['all', 'renderer', 'main', 'stdout']).optional(),
    limit: int().min(1).max(1000).optional(),
  }),
  'POST /api/launch': object({ project: z.string().optional() }),
  'POST /api/attach': object({ port: int().min(1).max(65535), inspectPort: int().min(1).max(65535).optional() }),
  'POST /api/click': object({
    window,
    x: coord(),
    y: coord(),
    button: z.enum(['left', 'right', 'middle']).optional(),
    count: int().min(1).max(3).optional(),
    modifiers,
  }),
  'POST /api/drag': object({ window, x1: coord(), y1: coord(), x2: coord(), y2: coord(), ms: ms(0), modifiers }),
  'POST /api/hover': object({ window, x: coord(), y: coord() }),
  'POST /api/tap': object({ window, x: coord(), y: coord() }),
  'POST /api/swipe': object({ window, x1: coord(), y1: coord(), x2: coord(), y2: coord(), ms: ms(50) }),
  'POST /api/long-press': object({ window, x: coord(), y: coord(), ms: ms(100) }),
  'POST /api/pinch': object({
    window,
    x: coord().optional(),
    y: coord().optional(),
    scale: num()
      .min(0.1)
      .max(10)
      .refine((v) => v !== 1, 'must not be 1'),
    ms: ms(100),
  }),
  'POST /api/scroll': object({ window, x: coord().optional(), y: coord().optional(), dx: num().optional(), dy: num().optional() }),
  'POST /api/text': object({ window, text: z.string().min(1).max(10000) }),
  'POST /api/key': object({ window, key: z.string().min(1), modifiers }),
  'POST /api/resize': object({
    window,
    width: int().min(0).max(8000),
    height: int().min(0).max(8000),
    emulate: bool().optional(),
  }),
  'POST /api/reload': object({ window, ignoreCache: bool().optional() }),
  'POST /api/evaluate': object({ window, expression: z.string().min(1) }),
  'POST /api/evaluate-main': object({ window, app, expression: z.string().min(1) }),
  'POST /api/devtools': object({ window }),
};

// Valida la entrada de una ruta y devuelve los datos ya convertidos, o lanza un error 400 que
// dice qué falta, qué sobra y qué valor está mal, p. ej.
// "POST /api/swipe: missing x1, y1; unknown fromX, fromY (fields: window, x1, …)".
export function validateApi(route, input) {
  const schema = API_SCHEMAS[route];
  if (!schema) return input;
  const result = schema.safeParse(input);
  if (result.success) return result.data;
  const missing = [];
  const unknown = [];
  const wrong = [];
  for (const issue of result.error.issues) {
    const field = issue.path.join('.');
    if (issue.code === 'unrecognized_keys') unknown.push(...issue.keys);
    else if (issue.path.length === 1 && input[issue.path[0]] === undefined) missing.push(field);
    else wrong.push(`${field} ${describe(issue)}`);
  }
  const parts = [];
  if (missing.length) parts.push(`missing ${missing.join(', ')}`);
  if (unknown.length) parts.push(`unknown ${unknown.join(', ')}`);
  if (wrong.length) parts.push(...wrong);
  const expected = Object.keys(schema.shape);
  const hint = expected.length ? ` (fields: ${expected.join(', ')})` : ' (no fields)';
  throw Object.assign(new Error(`${route}: ${parts.join('; ')}${hint}`), { status: 400 });
}

function describe(issue) {
  switch (issue.code) {
    case 'too_small':
      return issue.origin === 'string' ? 'must not be empty' : `must be ≥ ${issue.minimum}`;
    case 'too_big':
      return issue.origin === 'string' ? `must be at most ${issue.maximum} characters` : `must be ≤ ${issue.maximum}`;
    case 'invalid_value':
      return `must be one of ${issue.values.join(', ')}`;
    case 'invalid_union':
      return issue.message;
    case 'invalid_type':
      return `must be a ${issue.expected}`;
    default:
      return issue.message;
  }
}
