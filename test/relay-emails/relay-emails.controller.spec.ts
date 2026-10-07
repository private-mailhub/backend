import { RelayEmailsController } from '../../src/relay-emails/relay-emails.controller';

describe('POST /api/relay-emails/create', () => {
  let controller: RelayEmailsController;
  let relayEmailsService: {
    generateRelayEmailAddress: jest.Mock;
  };
  let usersService: {
    findById: jest.Mock;
  };

  beforeEach(() => {
    relayEmailsService = {
      generateRelayEmailAddress: jest.fn(),
    };
    usersService = {
      findById: jest.fn(),
    };
    controller = new RelayEmailsController(relayEmailsService as never, usersService as never);
  });

  it('optional description을 저장하고 CLI에서 사용할 ID와 주소를 반환한다', async () => {
    // Given
    const owner = { userId: 17n, username: 'owner@example.com' };
    const userEntity = { id: 17n, username: 'owner@example.com' };
    usersService.findById.mockResolvedValue(userEntity);
    relayEmailsService.generateRelayEmailAddress.mockResolvedValue({
      id: 91n,
      userId: 17n,
      relayEmail: 'random@private-mailhub.com',
      isActive: true,
      description: 'Work receipts',
      createdAt: new Date('2026-10-07T00:00:00.000Z'),
    });

    // When
    const createRelayEmail = controller.createRelayEmail.bind(controller) as unknown as (
      ...args: unknown[]
    ) => Promise<unknown>;
    const result = await createRelayEmail(owner, { description: 'Work receipts' });

    // Then
    expect(relayEmailsService.generateRelayEmailAddress).toHaveBeenCalledWith(
      userEntity,
      'Work receipts',
    );
    expect(result).toEqual({
      id: '91',
      relayEmail: 'random@private-mailhub.com',
      isActive: true,
      description: 'Work receipts',
      createdAt: new Date('2026-10-07T00:00:00.000Z'),
    });
  });

  it('description이 생략되어도 relay 생성이 가능하다', async () => {
    // Given
    const owner = { userId: 17n, username: 'owner@example.com' };
    const userEntity = { id: 17n, username: 'owner@example.com' };
    usersService.findById.mockResolvedValue(userEntity);
    relayEmailsService.generateRelayEmailAddress.mockResolvedValue({
      id: 92n,
      userId: 17n,
      relayEmail: 'random2@private-mailhub.com',
      isActive: true,
      description: null,
      createdAt: new Date('2026-10-07T00:00:00.000Z'),
    });

    // When
    const createRelayEmail = controller.createRelayEmail.bind(controller) as unknown as (
      ...args: unknown[]
    ) => Promise<unknown>;
    const result = await createRelayEmail(owner, undefined);

    // Then
    expect(relayEmailsService.generateRelayEmailAddress).toHaveBeenCalledWith(
      userEntity,
      undefined,
    );
    expect(result).toMatchObject({
      id: '92',
      relayEmail: 'random2@private-mailhub.com',
      description: null,
    });
  });
});
