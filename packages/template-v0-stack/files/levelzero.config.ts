import { defineConfig } from '@levelzero/core';
import postgres from '@levelzero/plugin-postgres';
import prisma from '@levelzero/plugin-prisma';
import hono from '@levelzero/plugin-hono';
import typedClient from '@levelzero/plugin-typed-client';
import betterAuth from '@levelzero/plugin-better-auth';
import shadcn from '@levelzero/plugin-shadcn';
import next from '@levelzero/plugin-next';
import vitest from '@levelzero/plugin-vitest';
import playwright from '@levelzero/plugin-playwright';

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
