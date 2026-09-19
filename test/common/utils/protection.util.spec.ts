import * as crypto from 'crypto';
import { ProtectionUtil } from 'src/common/utils/protection.util';
import { CustomEnvService } from 'src/config/custom-env.service';

describe('ProtectionUtil', () => {
  let protectionUtil: ProtectionUtil;
  let customEnvService: jest.Mocked<CustomEnvService>;

  // A valid test key encoded as base64 (32 bytes = 256 bits)
  const VALID_KEY = Buffer.alloc(32).toString('base64');

  beforeEach(() => {
    customEnvService = {
      get: jest.fn().mockReturnValue(VALID_KEY),
      getWithDefault: jest.fn(),
    } as unknown as jest.Mocked<CustomEnvService>;

    protectionUtil = new ProtectionUtil(customEnvService);
  });

  // ─────────────────────────────────────────────
  // encrypt
  // ─────────────────────────────────────────────
  describe('encrypt', () => {
    describe('Given valid plaintext and a 32-byte key', () => {
      it('When encrypt is called, Then returns string in "encrypted:iv:authTag" format', () => {
        // Given
        const plaintext = 'Hello, World!';

        // When
        const result = protectionUtil.encrypt(plaintext);

        // Then
        const parts = result.split(':');
        expect(parts).toHaveLength(3);
        parts.forEach((part) => expect(part.length).toBeGreaterThan(0));
      });

      it('When encrypt is called multiple times with the same input, Then produces different ciphertext (random IV)', () => {
        // Given
        const plaintext = 'Hello, World!';

        // When
        const result1 = protectionUtil.encrypt(plaintext);
        const result2 = protectionUtil.encrypt(plaintext);

        // Then
        expect(result1).not.toBe(result2);
      });
    });

    describe('Given a key that does not decode to 32 bytes', () => {
      it('When the utility is created, Then rejects the invalid key before serving traffic', () => {
        // Given
        customEnvService.get.mockReturnValue('not-a-valid-32byte-base64-key');

        // When / Then
        expect(() => new ProtectionUtil(customEnvService)).toThrow(
          'ENCRYPTION_KEY must be canonical base64',
        );
      });
    });
  });

  // ─────────────────────────────────────────────
  // decrypt
  // ─────────────────────────────────────────────
  describe('decrypt', () => {
    describe('Given properly encrypted data', () => {
      it('When decrypt is called, Then returns original plaintext', () => {
        // Given
        const plaintext = 'Hello, World!';
        const encrypted = protectionUtil.encrypt(plaintext);

        // When
        const result = protectionUtil.decrypt(encrypted);

        // Then
        expect(result).toBe(plaintext);
      });
    });

    describe('Given encrypted data that is missing parts (not "a:b:c" format)', () => {
      it('When decrypt is called, Then throws Error containing "Decryption failed" without logging the ciphertext', () => {
        // Given
        const invalidData = 'onlyonepart';
        const loggerError = jest.spyOn((protectionUtil as any).logger, 'error');

        // When / Then
        expect(() => protectionUtil.decrypt(invalidData)).toThrow(Error);
        expect(() => protectionUtil.decrypt(invalidData)).toThrow('Decryption failed');
        expect(loggerError.mock.calls.flat()).not.toContain(invalidData);
      });
    });

    describe('Given data with a tampered authTag', () => {
      it('When decrypt is called, Then throws Error containing "Decryption failed"', () => {
        // Given
        const plaintext = 'Hello, World!';
        const encrypted = protectionUtil.encrypt(plaintext);
        const [encPart, ivPart] = encrypted.split(':');
        const tamperedData = `${encPart}:${ivPart}:${Buffer.alloc(16).toString('base64')}`;

        // When / Then
        expect(() => protectionUtil.decrypt(tamperedData)).toThrow(Error);
        expect(() => protectionUtil.decrypt(tamperedData)).toThrow('Decryption failed');
      });
    });

    describe('Given a key that does not decode to 32 bytes', () => {
      it('When the utility is created, Then rejects the invalid key before serving traffic', () => {
        customEnvService.get.mockReturnValue('not-a-valid-32byte-base64-key');

        // When / Then
        expect(() => new ProtectionUtil(customEnvService)).toThrow(
          'ENCRYPTION_KEY must be canonical base64',
        );
      });
    });

    describe('Given a malformed legacy key', () => {
      it('When the utility is created, Then rejects it before serving traffic', () => {
        customEnvService.getWithDefault.mockReturnValue('not-base64');

        expect(() => new ProtectionUtil(customEnvService)).toThrow(
          'LEGACY_ENCRYPTION_KEYS must be canonical base64',
        );
      });
    });

    describe('Given ciphertext encrypted with the legacy key', () => {
      it('When decrypt is called, Then decrypts it with the legacy key without logging the ciphertext', () => {
        // Given
        const currentKey = Buffer.alloc(32, 1).toString('base64');
        const legacyKey = Buffer.alloc(32, 2).toString('base64');
        const legacyUtil = new ProtectionUtil({
          get: jest.fn((key: string) => (key === 'ENCRYPTION_KEY' ? legacyKey : undefined)),
          getWithDefault: jest.fn(),
        } as unknown as jest.Mocked<CustomEnvService>);
        const ciphertext = legacyUtil.encrypt('legacy@example.com');
        customEnvService.get.mockReturnValue(currentKey);
        customEnvService.getWithDefault.mockImplementation((key: string) =>
          key === 'LEGACY_ENCRYPTION_KEYS' ? legacyKey : '',
        );
        const utilWithFallback = new ProtectionUtil(customEnvService);
        const loggerError = jest.spyOn((utilWithFallback as any).logger, 'error');

        // When
        const plaintext = utilWithFallback.decrypt(ciphertext);

        // Then
        expect(plaintext).toBe('legacy@example.com');
        expect(loggerError).not.toHaveBeenCalledWith(
          expect.stringContaining(ciphertext),
          expect.anything(),
        );
        expect(loggerError.mock.calls.flat()).not.toContain(ciphertext);
      });
    });
  });

  // ─────────────────────────────────────────────
  // hash
  // ─────────────────────────────────────────────
  describe('hash', () => {
    describe('Given a plain text string', () => {
      it('When hash is called, Then returns a 64-character lowercase hex string (SHA-256 digest)', () => {
        // Given
        const plainText = 'test-password';

        // When
        const result = protectionUtil.hash(plainText);

        // Then
        expect(result).toHaveLength(64);
        expect(result).toMatch(/^[0-9a-f]+$/);
      });

      it('When hash is called twice with the same input, Then returns the same hash (deterministic)', () => {
        // Given
        const plainText = 'test-password';

        // When
        const hash1 = protectionUtil.hash(plainText);
        const hash2 = protectionUtil.hash(plainText);

        // Then
        expect(hash1).toBe(hash2);
      });

      it('When hash is called with different inputs, Then returns different hashes', () => {
        // Given
        const text1 = 'password1';
        const text2 = 'password2';

        // When
        const hash1 = protectionUtil.hash(text1);
        const hash2 = protectionUtil.hash(text2);

        // Then
        expect(hash1).not.toBe(hash2);
      });

      it('When hash is called with a known input, Then returns the expected SHA-256 digest', () => {
        // Given – SHA-256("abc") is a well-known value
        const plainText = 'abc';
        // Compute expected value using Node.js crypto directly to ensure environment parity
        const expectedHash = crypto.createHash('sha256').update('abc').digest('hex');

        // When
        const result = protectionUtil.hash(plainText);

        // Then
        expect(result).toBe(expectedHash);
        expect(result).toHaveLength(64);
      });
    });
  });

  // ─────────────────────────────────────────────
  // hashEmailAddress
  // ─────────────────────────────────────────────
  describe('hashEmailAddress', () => {
    describe('Given email addresses with different case and surrounding whitespace', () => {
      it('When hashEmailAddress is called, Then returns the same hash for the normalized address', () => {
        // Given
        const normalizedEmail = 'sender@example.com';
        const emailWithCaseAndWhitespace = '  Sender@Example.COM  ';
        const expectedHash = crypto.createHash('sha256').update(normalizedEmail).digest('hex');

        // When
        const result = protectionUtil.hashEmailAddress(emailWithCaseAndWhitespace);

        // Then
        expect(result).toBe(expectedHash);
        expect(result).toBe(protectionUtil.hashEmailAddress(normalizedEmail));
      });
    });
  });

  // ─────────────────────────────────────────────
  // generateKey
  // ─────────────────────────────────────────────
  describe('generateKey', () => {
    describe('Given no input', () => {
      it('When generateKey is called, Then returns a base64 string that decodes to exactly 32 bytes', () => {
        // Given (nothing)

        // When
        const key = protectionUtil.generateKey();

        // Then
        const decoded = Buffer.from(key, 'base64');
        expect(decoded.byteLength).toBe(32);
      });

      it('When generateKey is called twice, Then returns different keys (randomness)', () => {
        // Given (nothing)

        // When
        const key1 = protectionUtil.generateKey();
        const key2 = protectionUtil.generateKey();

        // Then
        expect(key1).not.toBe(key2);
      });

      it('When the generated key is used to create a new ProtectionUtil, Then encrypt/decrypt works correctly', () => {
        // Given
        const newKey = protectionUtil.generateKey();
        customEnvService.get.mockReturnValue(newKey);
        const utilWithNewKey = new ProtectionUtil(customEnvService);
        const plaintext = 'roundtrip test';

        // When
        const encrypted = utilWithNewKey.encrypt(plaintext);
        const decrypted = utilWithNewKey.decrypt(encrypted);

        // Then
        expect(decrypted).toBe(plaintext);
      });
    });
  });

  // ─────────────────────────────────────────────
  // encrypt ↔ decrypt roundtrip
  // ─────────────────────────────────────────────
  describe('encrypt + decrypt roundtrip', () => {
    describe('Given various plaintext inputs', () => {
      it.each([
        ['simple ASCII text', 'Hello, World!'],
        ['empty string', ''],
        ['special characters', '!@#$%^&*()_+[]{}|;:\'",.<>?/\\`~'],
        ['Korean (unicode) text', '한글 텍스트 테스트'],
        ['long text (1000 chars)', 'a'.repeat(1000)],
        ['JSON-serialised object', JSON.stringify({ key: 'value', number: 42 })],
      ])(
        'When "%s" is encrypted then decrypted, Then the result equals the original',
        (_, plaintext) => {
          // Given (plaintext from test.each)

          // When
          const encrypted = protectionUtil.encrypt(plaintext);
          const decrypted = protectionUtil.decrypt(encrypted);

          // Then
          expect(decrypted).toBe(plaintext);
        },
      );
    });
  });
});
