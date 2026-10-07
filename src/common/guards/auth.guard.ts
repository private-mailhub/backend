import {
  CanActivate,
  ExecutionContext,
  ForbiddenException,
  Injectable,
  UnauthorizedException,
  Logger,
} from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { TokenService } from '../../auth/jwt/token.service';
import { ApiKeyService, type ApiKeyScope } from '../../auth/api-key.service';
import { API_KEY_SCOPE_KEY } from '../decorators/api-key-access.decorator';
import { IS_PUBLIC_KEY } from '../decorators/public.decorator';
import type { Request } from 'express';

type AuthenticatedRequest = Request & {
  apiKey?: {
    keyId: number;
    scopes: ApiKeyScope[];
  };
};

type ApiKeyRouteRequest = {
  method: string;
  path?: string;
  originalUrl?: string;
  url?: string;
};

@Injectable()
export class AuthGuard implements CanActivate {
  private readonly logger = new Logger(AuthGuard.name);

  constructor(
    private readonly reflector: Reflector,
    private readonly tokenService: TokenService,
    private readonly apiKeyService: ApiKeyService,
  ) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    // Check if route is public
    const isPublic = this.reflector.getAllAndOverride<boolean>(IS_PUBLIC_KEY, [
      context.getHandler(),
      context.getClass(),
    ]);

    if (isPublic) {
      return true;
    }

    const request = context.switchToHttp().getRequest<AuthenticatedRequest>();
    const accessToken = this.extractTokenFromHeader(request);

    if (!accessToken) {
      throw new UnauthorizedException('Access token is required');
    }

    if (this.isApiKey(accessToken)) {
      return await this.authenticateApiKey(context, request, accessToken);
    }

    try {
      // Validate access token (checks expiration and signature)
      const payload = this.tokenService.parsePayloadFromToken(accessToken);

      // Set user in request
      request.user = {
        userId: payload.userId,
        username: payload.username,
      };

      return true;
    } catch (error) {
      if (error?.name === 'TokenExpiredError') {
        throw new UnauthorizedException('EXPIRED TOKEN');
      }

      this.logger.warn(
        `Authentication failed for ${request.method} ${request.path}: ${error?.message}`,
      );
      throw new UnauthorizedException('Invalid access token');
    }
  }

  private async authenticateApiKey(
    context: ExecutionContext,
    request: AuthenticatedRequest,
    apiKey: string,
  ): Promise<boolean> {
    const requiredScope = this.reflector.getAllAndOverride<ApiKeyScope | undefined>(
      API_KEY_SCOPE_KEY,
      [context.getHandler(), context.getClass()],
    );
    const route = this.getRouteRequest(request);
    const isAllowedRoute = this.isAllowedApiKeyRoute(route, requiredScope);
    if (!requiredScope) {
      throw new ForbiddenException('API key is not allowed for this endpoint');
    }
    if (!isAllowedRoute) {
      throw new ForbiddenException('API key is not allowed for this endpoint');
    }

    const principal = await this.apiKeyService.validate(apiKey);
    const hasScope = principal.scopes.includes(requiredScope);
    if (!hasScope) {
      throw new ForbiddenException('API key does not include the required scope');
    }

    request.user = {
      userId: principal.userId,
      username: principal.username,
    };
    request.apiKey = {
      keyId: principal.keyId,
      scopes: principal.scopes,
    };
    return true;
  }

  private isAllowedApiKeyRoute(route: ApiKeyRouteRequest, scope: ApiKeyScope | undefined): boolean {
    const path = this.getPath(route);
    if (scope === 'relay:read') {
      return this.isRelayReadRoute(route.method, path);
    }
    if (scope === 'relay:write') {
      return this.isRelayWriteRoute(route.method, path);
    }
    if (scope === 'keys:read') {
      return this.isApiKeyListRoute(route.method, path);
    }
    if (scope === 'keys:revoke') {
      return this.isApiKeyRevokeRoute(route.method, path);
    }
    return false;
  }

  private getRouteRequest(request: AuthenticatedRequest): ApiKeyRouteRequest {
    return {
      method: request.method,
      path: request.path,
      originalUrl: request.originalUrl,
      url: request.url,
    };
  }

  private isRelayReadRoute(method: string, path: string): boolean {
    return method === 'GET' && path === '/api/relay-emails';
  }

  private isRelayWriteRoute(method: string, path: string): boolean {
    if (method === 'POST') {
      return path === '/api/relay-emails/create';
    }
    if (method !== 'PATCH') {
      return false;
    }
    return /^\/api\/relay-emails\/\d+\/(active|description)$/.test(path);
  }

  private isApiKeyListRoute(method: string, path: string): boolean {
    return method === 'GET' && path === '/api/api-keys';
  }

  private isApiKeyRevokeRoute(method: string, path: string): boolean {
    if (method !== 'DELETE') {
      return false;
    }
    const isCurrentKeyRoute = path === '/api/api-keys/current';
    const isKeyIdRoute = /^\/api\/api-keys\/\d+$/.test(path);
    return isCurrentKeyRoute || isKeyIdRoute;
  }

  private getPath(request: ApiKeyRouteRequest): string {
    if (request.path) {
      return request.path;
    }
    let rawUrl = '';
    if (request.originalUrl) {
      rawUrl = request.originalUrl;
    } else if (request.url) {
      rawUrl = request.url;
    }
    return rawUrl.split('?')[0];
  }

  private isApiKey(token: string): boolean {
    return token.startsWith('mhk_');
  }

  private extractTokenFromHeader(request: Request): string | undefined {
    const [type, token] = request.headers.authorization?.split(' ') ?? [];
    return type === 'Bearer' ? token : undefined;
  }
}
