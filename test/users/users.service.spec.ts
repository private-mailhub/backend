import { UsersService } from '../../src/users/users.service';
import { ProtectionUtil } from '../../src/common/utils/protection.util';
import { UserStatus } from '../../src/users/user.enums';
import { UserActivityLogService } from '../../src/logs/user-activity-log.service';
import { CacheService } from '../../src/cache/cache.service';
import { SendMailService } from '../../src/mail/send-mail.service';

describe('UsersService', () => {
  let service: UsersService;
  let userRepository: {
    create: jest.Mock;
    findOne: jest.Mock;
    save: jest.Mock;
  };
  let oauthAccountRepository: Record<string, jest.Mock>;
  let protectionUtil: jest.Mocked<ProtectionUtil>;
  let cacheService: jest.Mocked<CacheService>;
  let sendMailService: jest.Mocked<SendMailService>;
  let userActivityLogService: jest.Mocked<UserActivityLogService>;

  beforeEach(() => {
    userRepository = {
      create: jest.fn((user) => user),
      findOne: jest.fn(),
      save: jest.fn((user) => user),
    };
    oauthAccountRepository = {
      findOne: jest.fn(),
      delete: jest.fn(),
      remove: jest.fn(),
    };
    protectionUtil = {
      encrypt: jest.fn((value: string) => `encrypted:${value}`),
      decrypt: jest.fn(),
      hash: jest.fn((value: string) => `hash:${value}`),
    } as unknown as jest.Mocked<ProtectionUtil>;
    cacheService = {
      setUsernameChangeData: jest.fn(),
    } as unknown as jest.Mocked<CacheService>;
    sendMailService = {
      sendVerificationCodeForReturningUser: jest.fn(),
    } as unknown as jest.Mocked<SendMailService>;
    userActivityLogService = {
      record: jest.fn(),
    } as unknown as jest.Mocked<UserActivityLogService>;
    service = new UsersService(
      userRepository as any,
      oauthAccountRepository as any,
      protectionUtil,
      cacheService,
      sendMailService,
      userActivityLogService,
    );
  });

  afterEach(() => {
    jest.restoreAllMocks();
  });

  describe('createEmailUser', () => {
    it('주어진 평문 username을 해시하고 서버에서 암호화하여 저장한다', async () => {
      // Given
      const username = 'person@example.com';
      userRepository.findOne.mockResolvedValue(null);

      // When
      await service.createEmailUser(username);

      // Then
      expect(protectionUtil.hash.mock.calls).toContainEqual([username]);
      expect(protectionUtil.encrypt.mock.calls).toContainEqual([username]);
      expect(userRepository.create).toHaveBeenCalledWith({
        username: `encrypted:${username}`,
        usernameHash: `hash:${username}`,
      });
      expect(protectionUtil.decrypt.mock.calls).toHaveLength(0);
      expect(userRepository.save).toHaveBeenCalled();
    });
  });

  describe('requestUsernameChange', () => {
    it('주어진 평문 newUsername을 서버에서 암호화하여 캐시에 저장하고 인증 메일을 보낸다', async () => {
      // Given
      const userId = 1n;
      const currentUsernameHash = 'hash:old@example.com';
      const newUsername = 'new@example.com';
      userRepository.findOne
        .mockResolvedValueOnce({ id: userId, usernameHash: currentUsernameHash })
        .mockResolvedValueOnce(null);
      jest.spyOn(Math, 'random').mockReturnValue(0.123456);

      // When
      await service.requestUsernameChange(userId, newUsername);

      // Then
      expect(protectionUtil.hash.mock.calls).toContainEqual([newUsername]);
      expect(protectionUtil.encrypt.mock.calls).toContainEqual([newUsername]);
      expect(cacheService.setUsernameChangeData.mock.calls).toContainEqual([
        userId,
        `encrypted:${newUsername}`,
        '211110',
      ]);
      expect(sendMailService.sendVerificationCodeForReturningUser.mock.calls).toContainEqual([
        newUsername,
        expect.stringMatching(/^\d{6}$/),
      ]);
      expect(protectionUtil.decrypt.mock.calls).toHaveLength(0);
    });

    it('legacy ciphertext를 복호화한 뒤 current key로 다시 암호화하여 캐시에 저장한다', async () => {
      const userId = 1n;
      const newUsername = 'legacy@example.com';
      userRepository.findOne
        .mockResolvedValueOnce({ id: userId, usernameHash: 'hash:old@example.com' })
        .mockResolvedValueOnce(null);
      protectionUtil.decrypt.mockReturnValue(newUsername);

      await service.requestUsernameChange(userId, {
        encryptedNewUsername: 'legacy-ciphertext',
      });

      expect(protectionUtil.decrypt.mock.calls).toContainEqual(['legacy-ciphertext']);
      expect(protectionUtil.encrypt.mock.calls).toContainEqual([newUsername]);
      expect(cacheService.setUsernameChangeData.mock.calls).toContainEqual([
        userId,
        `encrypted:${newUsername}`,
        expect.stringMatching(/^\d{6}$/),
      ]);
    });
  });

  describe('getUserInfo', () => {
    it('legacy 암호문 username도 ProtectionUtil fallback을 통해 평문으로 반환한다', async () => {
      // Given
      const userId = 2n;
      userRepository.findOne.mockResolvedValue({
        id: userId,
        username: 'legacy-ciphertext',
        subscriptionTier: 'FREE',
        createdAt: new Date('2026-01-01T00:00:00.000Z'),
        status: UserStatus.ACTIVE,
        githubOAuth: null,
        appleOAuth: null,
        googleOAuth: null,
      });
      protectionUtil.decrypt.mockReturnValue('legacy@example.com');

      // When
      const result = await service.getUserInfo(userId);

      // Then
      expect(result.username).toBe('legacy@example.com');
      expect(protectionUtil.decrypt.mock.calls).toContainEqual(['legacy-ciphertext']);
    });
  });
});
