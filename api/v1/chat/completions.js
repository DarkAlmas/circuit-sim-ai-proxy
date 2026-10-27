import { handleRequest } from '../../../lib/proxy.js';

export const maxDuration = 35;

export function POST(request) {
  return handleRequest(request);
}

export function OPTIONS(request) {
  return handleRequest(request);
}
