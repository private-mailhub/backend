import {
  Controller,
  Delete,
  ForbiddenException,
  Get,
  HttpCode,
  HttpStatus,
  Param,
  Req,
} from '@nestjs/common';
import type { Request } from 'express';
import { ApiKeyService } from './api-key.service';
import { ApiKeyAccess } from '../common/decorators/api-key-access.decorator';
import { CurrentUser, type CurrentUserPayload } from '../common/decorators/current-user.decorator';

type ApiKeyRequest = Request & {
  apiKey?: {
    keyId: number;
  };
};

@Controller('api-keys')
export class ApiKeysController {
  constructor(private readonly apiKeyService: ApiKeyService) {}

  @Get()
  @ApiKeyAccess('keys:read')
  @HttpCode(HttpStatus.OK)
  async list(@CurrentUser() user: CurrentUserPayload) {
    return this.apiKeyService.list(user.userId);
  }

  @Delete('current')
  @ApiKeyAccess('keys:revoke')
  @HttpCode(HttpStatus.OK)
  async revokeCurrent(
    @CurrentUser() user: CurrentUserPayload,
    @Req() request: ApiKeyRequest,
  ): Promise<{ message: string }> {
    const keyId = request.apiKey?.keyId;
    if (keyId === undefined) {
      throw new ForbiddenException('Current API key revocation requires API key authentication');
    }
    await this.apiKeyService.revokeCurrent(user.userId, keyId);
    return { message: 'API key revoked' };
  }

  @Delete(':keyId')
  @ApiKeyAccess('keys:revoke')
  @HttpCode(HttpStatus.OK)
  async revoke(
    @CurrentUser() user: CurrentUserPayload,
    @Param('keyId') keyId: string,
  ): Promise<{ message: string }> {
    await this.apiKeyService.revoke(user.userId, keyId);
    return { message: 'API key revoked' };
  }
}
