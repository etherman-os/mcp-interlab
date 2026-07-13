import { z } from 'zod';

import type { InteropCase, MatrixConfig } from './types.js';

const identifier = z
  .string()
  .min(1)
  .regex(/^[a-z0-9][a-z0-9._-]*$/i, 'must contain only letters, numbers, dot, underscore, or dash');

const httpUrl = z
  .string()
  .url()
  .refine(
    (value) => {
      try {
        return (
          !/[\s\u0000-\u001F\u007F]/.test(value) && ['http:', 'https:'].includes(new URL(value).protocol)
        );
      } catch {
        return false;
      }
    },
    { message: 'must use http:// or https://' }
  );

const targetSchema = z
  .object({
    url: httpUrl,
    command: z.string().min(1).optional(),
    args: z.array(z.string()).default([]),
    cwd: z.string().min(1).optional(),
    env: z.record(z.string(), z.string()).default({}),
    inheritEnv: z.array(z.string().min(1)).default([]),
    recordHttp: z.boolean().default(false),
    maxResponseBytes: z
      .number()
      .int()
      .positive()
      .max(64 * 1024 * 1024)
      .default(4 * 1024 * 1024),
    startupTimeoutMs: z.number().int().positive().default(10_000),
    requestTimeoutMs: z.number().int().positive().default(5_000),
    shutdownTimeoutMs: z.number().int().positive().default(2_000)
  })
  .strict();

const operationId = z.object({ id: identifier });

const operationSchema = z.discriminatedUnion('method', [
  operationId.extend({ method: z.literal('tools/list') }).strict(),
  operationId
    .extend({
      method: z.literal('tools/call'),
      params: z
        .object({
          name: z.string().min(1),
          arguments: z.record(z.string(), z.json()).default({})
        })
        .strict()
    })
    .strict(),
  operationId.extend({ method: z.literal('resources/list') }).strict(),
  operationId
    .extend({
      method: z.literal('resources/read'),
      params: z.object({ uri: z.string().min(1) }).strict()
    })
    .strict(),
  operationId.extend({ method: z.literal('prompts/list') }).strict(),
  operationId
    .extend({
      method: z.literal('prompts/get'),
      params: z
        .object({
          name: z.string().min(1),
          arguments: z.record(z.string(), z.string()).default({})
        })
        .strict()
    })
    .strict()
]);

export const interopCaseSchema: z.ZodType<InteropCase> = z
  .object({
    version: z.literal(1),
    id: identifier,
    title: z.string().min(1),
    description: z.string().min(1).optional(),
    expectation: z.enum(['spec', 'differential', 'regression']).default('differential'),
    tags: z.array(identifier).default([]),
    category: z
      .enum(['protocol', 'schema-acceptance', 'result-shape', 'error-semantics', 'lifecycle', 'timeout'])
      .optional(),
    sources: z
      .array(
        z
          .object({
            url: httpUrl,
            note: z.string().min(1).optional()
          })
          .strict()
      )
      .default([]),
    operations: z.array(operationSchema).min(1),
    compare: z
      .object({
        ignorePaths: z.array(z.string().startsWith('/')).default([]),
        unorderedPaths: z.array(z.string().startsWith('/')).default([])
      })
      .strict()
      .default({ ignorePaths: [], unorderedPaths: [] })
  })
  .strict()
  .superRefine((value, context) => {
    const seen = new Set<string>();
    for (const operation of value.operations) {
      if (seen.has(operation.id)) {
        context.addIssue({
          code: 'custom',
          path: ['operations'],
          message: `operation id '${operation.id}' is duplicated`
        });
      }
      seen.add(operation.id);
    }
  });

export const matrixSchema: z.ZodType<MatrixConfig> = z
  .object({
    version: z.literal(1),
    targets: z.record(identifier, targetSchema).refine((targets) => Object.keys(targets).length >= 2, {
      message: 'at least two targets are required'
    }),
    cases: z.array(z.union([z.string().min(1), interopCaseSchema])).min(1)
  })
  .strict();

export function formatValidationError(error: z.ZodError): string {
  return error.issues
    .map((issue) => `${issue.path.length > 0 ? issue.path.join('.') : '<root>'}: ${issue.message}`)
    .join('\n');
}
