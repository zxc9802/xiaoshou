import cors from '@fastify/cors';
import type { FastifyInstance } from 'fastify';

const methods = ['GET', 'HEAD', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS'];

export async function registerCors(app: FastifyInstance, origin: string) {
  await app.register(cors, { origin, methods, credentials: true });
}
