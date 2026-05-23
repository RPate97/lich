import { defineConfig } from '@lich/core';
import postgres from '@lich/plugin-postgres';
import prisma from '@lich/plugin-prisma';
import hono from '@lich/plugin-hono';
import typedClient from '@lich/plugin-typed-client';
import betterAuth from '@lich/plugin-better-auth';
import shadcn from '@lich/plugin-shadcn';
import next from '@lich/plugin-next';
import vitest from '@lich/plugin-vitest';
import playwright from '@lich/plugin-playwright';

export default defineConfig({
  name: '{{projectName}}',
  plugins: [
    postgres(),
    prisma(),
    hono(),
    typedClient(),
    betterAuth(),
    shadcn(),
    next(),
    vitest(),
    playwright(),
  ],
  envInjection: {
    DATABASE_URL: 'postgres.url',
    API_URL: 'hono.url',
    API_PORT: 'hono.port',
    WEB_URL: 'next.url',
    WEB_PORT: 'next.port',
  },
});
