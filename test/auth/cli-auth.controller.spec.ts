import type { Request } from 'express';
import { CliAuthController } from '../../src/auth/cli-auth.controller';

describe('CliAuthController', () => {
  let controller: CliAuthController;
  let cliDeviceAuthService: {
    startDeviceAuthorization: jest.Mock;
    getAuthorization: jest.Mock;
    decideAuthorization: jest.Mock;
    pollDeviceToken: jest.Mock;
  };

  beforeEach(() => {
    cliDeviceAuthService = {
      startDeviceAuthorization: jest.fn().mockResolvedValue({}),
      getAuthorization: jest.fn().mockResolvedValue({}),
      decideAuthorization: jest.fn().mockResolvedValue({ status: 'approved' }),
      pollDeviceToken: jest.fn().mockResolvedValue({}),
    };
    controller = new CliAuthController(cliDeviceAuthService as never);
  });

  it('루프백 프록시의 유효한 X-Real-IP를 인증 시작 요청에 전달한다', async () => {
    // Given
    const body = {
      clientName: 'mailhub-cli',
      deviceName: 'Work Mac',
      cliVersion: '0.1.0',
    };
    const request = {
      socket: { remoteAddress: '127.0.0.1' },
      get: jest.fn().mockReturnValue('203.0.113.7'),
    } as unknown as Request;

    // When
    await controller.startDeviceAuthorization(body, request);

    // Then
    expect(cliDeviceAuthService.startDeviceAuthorization.mock.calls).toContainEqual([
      body,
      '203.0.113.7',
    ]);
  });

  it('비루프백 peer에서는 X-Real-IP를 무시하고 socket IP를 전달한다', async () => {
    // Given
    const body = {
      clientName: 'mailhub-cli',
      deviceName: 'Work Mac',
      cliVersion: '0.1.0',
    };
    const request = {
      socket: { remoteAddress: '198.51.100.23' },
      get: jest.fn().mockReturnValue('203.0.113.7'),
    } as unknown as Request;

    // When
    await controller.startDeviceAuthorization(body, request);

    // Then
    expect(cliDeviceAuthService.startDeviceAuthorization.mock.calls).toContainEqual([
      body,
      '198.51.100.23',
    ]);
  });
});
