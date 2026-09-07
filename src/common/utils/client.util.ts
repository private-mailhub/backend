import type { Request } from 'express';

interface ClientInfo {
  ip: string;
  userAgent: string;
}

export function getClientInfo(request: Request): ClientInfo {
  return {
    ip: request.ip || request.socket.remoteAddress || '',
    userAgent: request.headers['user-agent'] || '',
  };
}
