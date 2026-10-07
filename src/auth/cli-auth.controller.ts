import { Body, Controller, HttpCode, HttpStatus, Post, Req } from '@nestjs/common';
import type { Request } from 'express';
import { isIP } from 'node:net';
import { CliDeviceAuthService } from './cli-device-auth.service';
import {
  CliUserCodeDto,
  DecideCliDeviceAuthorizationDto,
  PollCliDeviceTokenDto,
  StartCliDeviceAuthorizationDto,
} from './dto/cli-device.dto';
import { CurrentUser, type CurrentUserPayload } from '../common/decorators/current-user.decorator';
import { Public } from '../common/decorators/public.decorator';

@Controller('auth/cli')
export class CliAuthController {
  constructor(private readonly cliDeviceAuthService: CliDeviceAuthService) {}

  @Public()
  @Post('device')
  async startDeviceAuthorization(
    @Body() dto: StartCliDeviceAuthorizationDto,
    @Req() request: Request,
  ) {
    return this.cliDeviceAuthService.startDeviceAuthorization(dto, this.getClientIp(request));
  }

  @Public()
  @Post('device/token')
  @HttpCode(HttpStatus.OK)
  async pollDeviceToken(@Body() dto: PollCliDeviceTokenDto, @Req() request: Request) {
    return this.cliDeviceAuthService.pollDeviceToken(
      dto.deviceCode,
      dto.pollSecret,
      this.getClientIp(request),
    );
  }

  @Post('device/authorization')
  @HttpCode(HttpStatus.OK)
  async getAuthorization(@Body() dto: CliUserCodeDto, @Req() request: Request) {
    return this.cliDeviceAuthService.getAuthorization(dto.userCode, this.getClientIp(request));
  }

  @Post('device/decision')
  @HttpCode(HttpStatus.OK)
  async decideAuthorization(
    @CurrentUser() user: CurrentUserPayload,
    @Body() dto: DecideCliDeviceAuthorizationDto,
    @Req() request: Request,
  ): Promise<{ status: 'approved' | 'denied' }> {
    return this.cliDeviceAuthService.decideAuthorization(
      user.userId,
      dto.userCode,
      dto.approve,
      this.getClientIp(request),
    );
  }

  private getClientIp(request: Request): string {
    const remoteAddress = request.socket.remoteAddress;
    if (this.isLocalProxy(remoteAddress)) {
      const realIp = request.get('x-real-ip');
      if (this.isValidIp(realIp)) {
        return realIp;
      }
    }
    if (remoteAddress) {
      return remoteAddress;
    }
    return 'unknown';
  }

  private isLocalProxy(remoteAddress: string | undefined): boolean {
    if (remoteAddress === '127.0.0.1') {
      return true;
    }
    if (remoteAddress === '::1') {
      return true;
    }
    return remoteAddress === '::ffff:127.0.0.1';
  }

  private isValidIp(value: string | undefined): value is string {
    if (!value) {
      return false;
    }
    return isIP(value) !== 0;
  }
}
