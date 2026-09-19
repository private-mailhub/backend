import { Injectable, InternalServerErrorException, Logger } from '@nestjs/common';
import * as crypto from 'crypto';
import { CustomEnvService } from 'src/config/custom-env.service';

interface EncryptedParts {
  ciphertext: Buffer;
  iv: Buffer;
  authTag: Buffer;
}

@Injectable()
export class ProtectionUtil {
  private readonly logger = new Logger(ProtectionUtil.name);
  private readonly ENCRYPT_ALGORITHM = 'aes-256-gcm';
  private readonly HASH_ALGORITHM = 'sha256';
  private readonly ENCODE_ALGORITHM = 'base64';
  private readonly DIGEST = 'hex';
  private readonly IV_LENGTH = 16;
  private readonly AUTH_TAG_LENGTH = 16;
  private readonly MAX_ENCRYPTED_DATA_LENGTH = 16384;
  private readonly MAX_LEGACY_KEYS = 5;
  private readonly encryptionKeys: Buffer[];

  constructor(customEnvService: CustomEnvService) {
    const currentKey = customEnvService.get<string>('ENCRYPTION_KEY');
    const legacyKeys = customEnvService.getWithDefault<string>('LEGACY_ENCRYPTION_KEYS', '') ?? '';
    this.encryptionKeys = this.buildEncryptionKeys(currentKey, legacyKeys);
  }

  /**
   * Encrypt plaintext using AES-256-GCM and only the current key.
   * @returns Encrypted data in format: encrypted:iv:authTag (all base64)
   */
  encrypt(plaintext: string): string {
    try {
      const keyBuffer = this.encryptionKeys[0];
      const iv = crypto.randomBytes(this.IV_LENGTH);
      const cipher = crypto.createCipheriv(this.ENCRYPT_ALGORITHM, keyBuffer, iv);

      let encrypted = cipher.update(plaintext, 'utf8', this.ENCODE_ALGORITHM);
      encrypted += cipher.final(this.ENCODE_ALGORITHM);
      const authTag = cipher.getAuthTag();

      return `${encrypted}:${iv.toString(this.ENCODE_ALGORITHM)}:${authTag.toString(this.ENCODE_ALGORITHM)}`;
    } catch {
      throw new InternalServerErrorException('Encryption failed');
    }
  }

  /**
   * Decrypt encrypted data using the current key and then configured legacy keys.
   * @param encryptedData Encrypted data in format: encrypted:iv:authTag (all base64)
   */
  decrypt(encryptedData: string): string {
    try {
      const encryptedParts = this.parseEncryptedData(encryptedData);
      for (const keyBuffer of this.encryptionKeys) {
        try {
          return this.decryptWithKey(encryptedParts, keyBuffer);
        } catch {
          continue;
        }
      }

      throw new Error('No encryption key matched');
    } catch {
      this.logger.error('Decryption failed');
      throw new Error('Decryption failed');
    }
  }

  /**
   * Hash data by SHA-256.
   * @param plain text to hash
   */
  hash(plain: string): string {
    return crypto.createHash(this.HASH_ALGORITHM).update(plain).digest(this.DIGEST);
  }

  /**
   * Hash email address by SHA-256 after applying email-specific normalization.
   * @param emailAddress email address to hash
   */
  hashEmailAddress(emailAddress: string): string {
    return this.hash(emailAddress.trim().toLowerCase());
  }

  /**
   * Generate a new random encryption key.
   * @returns Base64 encoded 32-byte key
   */
  generateKey(): string {
    return crypto.randomBytes(32).toString(this.ENCODE_ALGORITHM);
  }

  private buildEncryptionKeys(currentValue: string, legacyValues: string): Buffer[] {
    const currentKey = this.decodeEncryptionKey(currentValue, 'ENCRYPTION_KEY');
    const keys = [currentKey];
    const legacyKeyValues = legacyValues.split(',');

    for (const rawLegacyValue of legacyKeyValues) {
      const legacyValue = rawLegacyValue.trim();
      if (legacyValue.length === 0) {
        continue;
      }

      const legacyKey = this.decodeEncryptionKey(legacyValue, 'LEGACY_ENCRYPTION_KEYS');
      if (legacyKey.equals(currentKey)) {
        continue;
      }

      if (this.hasKey(keys, legacyKey)) {
        continue;
      }

      const legacyKeyCount = keys.length - 1;
      if (legacyKeyCount >= this.MAX_LEGACY_KEYS) {
        throw new Error('Too many legacy encryption keys');
      }

      keys.push(legacyKey);
    }

    return keys;
  }

  private decodeEncryptionKey(value: string, variableName: string): Buffer {
    const keyBuffer = this.decodeBase64(value, variableName, false);
    if (keyBuffer.length !== 32) {
      throw new Error(`${variableName} must decode to 32 bytes`);
    }

    return keyBuffer;
  }

  private decodeBase64(value: string, fieldName: string, allowEmpty: boolean): Buffer {
    if (allowEmpty) {
      const isEmpty = value.length === 0;
      if (isEmpty) {
        return Buffer.alloc(0);
      }
    }

    if (!this.isCanonicalBase64(value)) {
      throw new Error(`${fieldName} must be canonical base64`);
    }

    return Buffer.from(value, this.ENCODE_ALGORITHM);
  }

  private isCanonicalBase64(value: string): boolean {
    const hasValidLength = value.length > 0 && value.length % 4 === 0;
    if (!hasValidLength) {
      return false;
    }

    const hasValidCharacters = /^[A-Za-z0-9+/]*={0,2}$/.test(value);
    if (!hasValidCharacters) {
      return false;
    }

    const decodedValue = Buffer.from(value, this.ENCODE_ALGORITHM);
    return decodedValue.toString(this.ENCODE_ALGORITHM) === value;
  }

  private parseEncryptedData(encryptedData: string): EncryptedParts {
    if (encryptedData.length === 0 || encryptedData.length > this.MAX_ENCRYPTED_DATA_LENGTH) {
      throw new Error('Invalid encrypted data length');
    }

    const parts = encryptedData.split(':');
    if (parts.length !== 3) {
      throw new Error('Invalid encrypted data format');
    }

    const [ciphertextBase64, ivBase64, authTagBase64] = parts;
    const ciphertext = this.decodeBase64(ciphertextBase64, 'ciphertext', true);
    const iv = this.decodeBase64(ivBase64, 'iv', false);
    const authTag = this.decodeBase64(authTagBase64, 'authTag', false);

    if (iv.length !== this.IV_LENGTH) {
      throw new Error('Invalid IV length');
    }
    if (authTag.length !== this.AUTH_TAG_LENGTH) {
      throw new Error('Invalid auth tag length');
    }

    return { ciphertext, iv, authTag };
  }

  private decryptWithKey(parts: EncryptedParts, keyBuffer: Buffer): string {
    const decipher = crypto.createDecipheriv(this.ENCRYPT_ALGORITHM, keyBuffer, parts.iv);
    decipher.setAuthTag(parts.authTag);

    let decrypted = decipher.update(parts.ciphertext, undefined, 'utf8');
    decrypted += decipher.final('utf8');
    return decrypted;
  }

  private hasKey(keys: Buffer[], candidate: Buffer): boolean {
    for (const key of keys) {
      if (key.equals(candidate)) {
        return true;
      }
    }

    return false;
  }
}
