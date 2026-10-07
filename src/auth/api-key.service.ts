import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  Injectable,
  InternalServerErrorException,
  NotFoundException,
  Optional,
  UnauthorizedException,
} from '@nestjs/common';
import * as crypto from 'crypto';
import { CacheRepository } from '../cache/cache.repository';
import { CustomEnvService } from '../config/custom-env.service';
import { ProtectionUtil } from '../common/utils/protection.util';
import { UsersService } from '../users/users.service';
import { UserStatus } from '../users/user.enums';

export const API_KEY_SCOPES = ['relay:read', 'relay:write', 'keys:read', 'keys:revoke'] as const;

export type ApiKeyScope = (typeof API_KEY_SCOPES)[number];

export interface ApiKeyPrincipal {
  userId: bigint;
  username: string;
  keyId: number;
  scopes: ApiKeyScope[];
}

export interface CreateApiKeyInput {
  name: string;
  source: string;
  scopes: ApiKeyScope[];
}

export interface CreatedApiKey {
  apiKey: string;
  keyId: number;
  expiresAt: string;
  scopes: ApiKeyScope[];
}

interface ApiKeyRecord {
  id: number;
  publicId: string;
  userId: string;
  secretHash: string;
  name: string;
  source: string;
  scopes: ApiKeyScope[];
  createdAt: string;
  expiresAt: string;
  lastUsedAt: string | null;
  revokedAt: string | null;
}

interface ApiKeyMaterial {
  publicId: string;
  secret: string;
}

export interface ApiKeySummary {
  id: string;
  publicId: string;
  name: string;
  source: string;
  scopes: ApiKeyScope[];
  lastUsedAt: string | null;
  expiresAt: string;
  revokedAt: string | null;
  createdAt: string;
}

const API_KEY_PREFIX = 'mhk_';
const DAY_MS = 24 * 60 * 60 * 1000;
const DEFAULT_API_KEY_TTL_MS = 365 * DAY_MS;
const MAX_API_KEYS_PER_USER = 100;
const REVOKED_API_KEY_RETENTION_DAYS = 30;
export const REVOKED_API_KEY_RETENTION_MS = REVOKED_API_KEY_RETENTION_DAYS * DAY_MS;
const API_KEY_PATTERN = /^mhk_([A-Za-z0-9_-]{22})_([A-Za-z0-9_-]{43})$/;

@Injectable()
export class ApiKeyService {
  constructor(
    private readonly cacheRepository: CacheRepository,
    private readonly protectionUtil: ProtectionUtil,
    private readonly customEnvService: CustomEnvService,
    @Optional() private readonly usersService?: UsersService,
  ) {}

  async create(
    userId: bigint,
    input: CreateApiKeyInput,
    idempotencySeed?: string,
  ): Promise<CreatedApiKey> {
    await this.requireActiveUser(userId, false);
    this.validateScopes(input.scopes);
    if (input.source !== 'cli') {
      throw new BadRequestException('Unsupported API key source');
    }

    const ttlMs = this.getApiKeyTtl();
    const name = this.normalizeName(input.name);
    const keyMaterial = this.getIdempotentKeyMaterial(idempotencySeed);
    if (keyMaterial) {
      const existingKey = await this.findIdempotentKey(userId, input, name, keyMaterial);
      if (existingKey) {
        return existingKey;
      }
    }

    for (let attempt = 0; attempt < 5; attempt += 1) {
      const createdKey = await this.createOneKey(userId, input, name, ttlMs, keyMaterial);
      if (createdKey) {
        return createdKey;
      }
    }
    throw new InternalServerErrorException('Could not create API key');
  }

  private async createOneKey(
    userId: bigint,
    input: CreateApiKeyInput,
    name: string,
    ttlMs: number,
    keyMaterial: ApiKeyMaterial | null,
  ): Promise<CreatedApiKey | null> {
    const material = keyMaterial ?? this.createRandomKeyMaterial();
    const { publicId, secret } = material;
    const apiKey = `${API_KEY_PREFIX}${publicId}_${secret}`;
    const keyId = await this.cacheRepository.increment('api-key:sequence');
    if (this.isInvalidKeyId(keyId)) {
      throw new InternalServerErrorException('Could not allocate API key identifier');
    }

    const now = Date.now();
    const expiresAt = new Date(now + ttlMs).toISOString();
    const record: ApiKeyRecord = {
      id: keyId,
      publicId,
      userId: userId.toString(),
      secretHash: this.protectionUtil.hash(secret),
      name,
      source: input.source,
      scopes: [...input.scopes],
      createdAt: new Date(now).toISOString(),
      expiresAt,
      lastUsedAt: null,
      revokedAt: null,
    };

    let result: 'created' | 'limit' | 'collision';
    try {
      result = await this.cacheRepository.setApiKeyWithQuota(
        this.getRecordKey(publicId),
        record,
        ttlMs,
        this.getOwnerIndexKey(userId),
        publicId,
        userId.toString(),
        MAX_API_KEYS_PER_USER,
      );
    } catch (error) {
      if (keyMaterial) {
        const existingKey = await this.findIdempotentKey(userId, input, name, keyMaterial);
        if (existingKey) {
          return existingKey;
        }
      }
      throw error;
    }
    if (result === 'limit') {
      throw new ConflictException(
        `Maximum of ${MAX_API_KEYS_PER_USER} API key records may be retained per account; revoked records are removed after ${REVOKED_API_KEY_RETENTION_DAYS} days and expired keys are removed automatically.`,
      );
    }
    if (result === 'collision') {
      if (keyMaterial) {
        return this.findIdempotentKey(userId, input, name, keyMaterial);
      }
      return null;
    }

    return this.toCreatedApiKey(record, apiKey);
  }

  private getIdempotentKeyMaterial(idempotencySeed?: string): ApiKeyMaterial | null {
    if (idempotencySeed === undefined) {
      return null;
    }
    if (!this.isCanonicalBase64Url(idempotencySeed, 32)) {
      throw new BadRequestException('Invalid API key idempotency seed');
    }

    const seed = Buffer.from(idempotencySeed, 'base64url');
    const publicId = crypto
      .createHmac('sha256', seed)
      .update('mailhub:api-key:public-id', 'utf8')
      .digest()
      .subarray(0, 16)
      .toString('base64url');
    const apiKeySecret = crypto
      .createHmac('sha256', seed)
      .update('mailhub:api-key:secret', 'utf8')
      .digest('base64url');
    return { publicId, secret: apiKeySecret };
  }

  private createRandomKeyMaterial(): ApiKeyMaterial {
    return {
      publicId: crypto.randomBytes(16).toString('base64url'),
      secret: crypto.randomBytes(32).toString('base64url'),
    };
  }

  private async findIdempotentKey(
    userId: bigint,
    input: CreateApiKeyInput,
    name: string,
    keyMaterial: ApiKeyMaterial,
  ): Promise<CreatedApiKey | null> {
    const record = await this.cacheRepository.get<ApiKeyRecord>(
      this.getRecordKey(keyMaterial.publicId),
    );
    if (record === null) {
      return null;
    }
    if (!this.isValidRecord(record, keyMaterial.publicId)) {
      throw new InternalServerErrorException('API key idempotency record is invalid');
    }
    if (!this.isMatchingIdempotentRecord(record, userId, input, name, keyMaterial.secret)) {
      throw new InternalServerErrorException('API key idempotency record does not match');
    }
    if (this.isExpiredOrRevoked(record)) {
      throw new ConflictException('API key issuance is no longer available');
    }
    const apiKey = `${API_KEY_PREFIX}${keyMaterial.publicId}_${keyMaterial.secret}`;
    return this.toCreatedApiKey(record, apiKey);
  }

  private isMatchingIdempotentRecord(
    record: ApiKeyRecord,
    userId: bigint,
    input: CreateApiKeyInput,
    name: string,
    secret: string,
  ): boolean {
    if (record.userId !== userId.toString()) {
      return false;
    }
    if (record.secretHash !== this.protectionUtil.hash(secret)) {
      return false;
    }
    if (record.name !== name) {
      return false;
    }
    if (record.source !== input.source) {
      return false;
    }
    return this.hasSameScopes(record.scopes, input.scopes);
  }

  private hasSameScopes(first: ApiKeyScope[], second: ApiKeyScope[]): boolean {
    if (first.length !== second.length) {
      return false;
    }
    for (let index = 0; index < first.length; index += 1) {
      if (first[index] !== second[index]) {
        return false;
      }
    }
    return true;
  }

  private toCreatedApiKey(record: ApiKeyRecord, apiKey: string): CreatedApiKey {
    return {
      apiKey,
      keyId: record.id,
      expiresAt: record.expiresAt,
      scopes: [...record.scopes],
    };
  }

  async validate(apiKey: string): Promise<ApiKeyPrincipal> {
    const parsedKey = this.parseApiKey(apiKey);
    if (!parsedKey) {
      throw new UnauthorizedException('Invalid API key');
    }

    const record = await this.cacheRepository.get<ApiKeyRecord>(
      this.getRecordKey(parsedKey.publicId),
    );
    if (!this.isValidRecord(record, parsedKey.publicId)) {
      throw new UnauthorizedException('Invalid API key');
    }
    if (!this.isValidSecret(parsedKey.secret, record.secretHash)) {
      throw new UnauthorizedException('Invalid API key');
    }
    if (this.isExpiredOrRevoked(record)) {
      throw new UnauthorizedException('API_KEY_REVOKED');
    }

    const user = await this.requireActiveUser(BigInt(record.userId), true);
    const lastUsedAt = new Date().toISOString();
    const updated = await this.cacheRepository.updateApiKeyLastUsed(
      this.getRecordKey(parsedKey.publicId),
      record.secretHash,
      lastUsedAt,
    );
    if (!updated) {
      throw new UnauthorizedException('API_KEY_REVOKED');
    }

    return {
      userId: BigInt(record.userId),
      username: user.username,
      keyId: record.id,
      scopes: [...record.scopes],
    };
  }

  async list(userId: bigint): Promise<ApiKeySummary[]> {
    await this.requireActiveUser(userId, false);
    const ownerIndexKey = this.getOwnerIndexKey(userId);
    const publicIds = await this.cacheRepository.getSetMembers(ownerIndexKey);
    const summaries: ApiKeySummary[] = [];

    for (const publicId of publicIds) {
      const recordKey = this.getRecordKey(publicId);
      const record = await this.cacheRepository.get<ApiKeyRecord>(recordKey);
      if (!this.isValidRecord(record, publicId)) {
        await this.cacheRepository.removeFromSetAndDelete(ownerIndexKey, publicId, recordKey);
        continue;
      }
      if (record.userId !== userId.toString()) {
        await this.cacheRepository.removeFromSet(ownerIndexKey, publicId);
        continue;
      }
      summaries.push(this.toSummary(record));
    }

    summaries.sort((first, second) => second.createdAt.localeCompare(first.createdAt));
    return summaries;
  }

  async revoke(userId: bigint, keyId: string | number): Promise<void> {
    await this.requireActiveUser(userId, false);
    const numericKeyId = this.parseKeyId(keyId);
    const record = await this.findOwnedKey(userId, numericKeyId);
    await this.revokeRecord(userId, record);
  }

  async revokeCurrent(userId: bigint, keyId: number): Promise<void> {
    await this.requireActiveUser(userId, false);
    const numericKeyId = this.parseKeyId(keyId);
    const record = await this.findOwnedKey(userId, numericKeyId);
    await this.revokeRecord(userId, record);
  }

  private async revokeRecord(userId: bigint, record: ApiKeyRecord): Promise<void> {
    const wasRevoked = await this.cacheRepository.revokeApiKey(
      this.getRecordKey(record.publicId),
      userId.toString(),
      new Date().toISOString(),
      REVOKED_API_KEY_RETENTION_MS,
      this.getOwnerIndexKey(userId),
      record.publicId,
    );
    if (!wasRevoked) {
      const latest = await this.cacheRepository.get<ApiKeyRecord>(
        this.getRecordKey(record.publicId),
      );
      if (!latest) {
        throw new NotFoundException('API key not found');
      }
      if (latest.userId !== userId.toString()) {
        throw new NotFoundException('API key not found');
      }
      if (!latest.revokedAt) {
        throw new NotFoundException('API key not found');
      }
    }
  }

  private async findOwnedKey(userId: bigint, keyId: number): Promise<ApiKeyRecord> {
    const publicIds = await this.cacheRepository.getSetMembers(this.getOwnerIndexKey(userId));
    for (const publicId of publicIds) {
      const record = await this.cacheRepository.get<ApiKeyRecord>(this.getRecordKey(publicId));
      if (!record) {
        await this.cacheRepository.removeFromSetAndDelete(
          this.getOwnerIndexKey(userId),
          publicId,
          this.getRecordKey(publicId),
        );
        continue;
      }
      if (!this.isValidRecord(record, publicId)) {
        await this.cacheRepository.removeFromSetAndDelete(
          this.getOwnerIndexKey(userId),
          publicId,
          this.getRecordKey(publicId),
        );
        continue;
      }
      if (record.userId === userId.toString() && record.id === keyId) {
        return record;
      }
    }
    throw new NotFoundException('API key not found');
  }

  private async requireActiveUser(userId: bigint, unauthorized: boolean) {
    if (!this.usersService) {
      throw new InternalServerErrorException('User validation is unavailable');
    }
    const user = await this.usersService.findById(userId);
    if (!user) {
      if (unauthorized) {
        throw new UnauthorizedException('Invalid API key');
      }
      throw new ForbiddenException('Account is not active');
    }
    if (user.status !== UserStatus.ACTIVE) {
      if (unauthorized) {
        throw new UnauthorizedException('Invalid API key');
      }
      throw new ForbiddenException('Account is not active');
    }
    return user;
  }

  private parseApiKey(apiKey: string): { publicId: string; secret: string } | null {
    const match = API_KEY_PATTERN.exec(apiKey);
    if (!match) {
      return null;
    }
    const [, publicId, secret] = match;
    if (this.isInvalidKeyEncoding(publicId, secret)) {
      return null;
    }
    return { publicId, secret };
  }

  private isCanonicalBase64Url(value: string, expectedBytes: number): boolean {
    const decoded = Buffer.from(value, 'base64url');
    return decoded.length === expectedBytes && decoded.toString('base64url') === value;
  }

  private isInvalidKeyEncoding(publicId: string, secret: string): boolean {
    const isPublicIdInvalid = !this.isCanonicalBase64Url(publicId, 16);
    const isSecretInvalid = !this.isCanonicalBase64Url(secret, 32);
    return isPublicIdInvalid || isSecretInvalid;
  }

  private isValidSecret(secret: string, expectedHash: string): boolean {
    const actualHash = this.protectionUtil.hash(secret);
    const actual = Buffer.from(actualHash, 'utf8');
    const expected = Buffer.from(expectedHash, 'utf8');
    if (actual.length !== expected.length) {
      return false;
    }
    return crypto.timingSafeEqual(actual, expected);
  }

  private isExpiredOrRevoked(record: ApiKeyRecord): boolean {
    return Boolean(record.revokedAt) || Date.parse(record.expiresAt) <= Date.now();
  }

  private isValidRecord(record: unknown, expectedPublicId: string): record is ApiKeyRecord {
    if (record === null || typeof record !== 'object') {
      return false;
    }
    const candidate = record as Partial<ApiKeyRecord>;
    if (candidate.publicId !== expectedPublicId) {
      return false;
    }
    if (!Number.isSafeInteger(candidate.id)) {
      return false;
    }
    if (typeof candidate.id !== 'number' || candidate.id <= 0) {
      return false;
    }
    if (typeof candidate.userId !== 'string') {
      return false;
    }
    if (!/^\d+$/.test(candidate.userId)) {
      return false;
    }
    if (typeof candidate.secretHash !== 'string' || candidate.secretHash.length === 0) {
      return false;
    }
    if (!Array.isArray(candidate.scopes)) {
      return false;
    }
    for (const scope of candidate.scopes) {
      if (!API_KEY_SCOPES.includes(scope)) {
        return false;
      }
    }
    if (typeof candidate.expiresAt !== 'string') {
      return false;
    }
    const expiresAt = Date.parse(candidate.expiresAt);
    return Number.isFinite(expiresAt);
  }

  private validateScopes(scopes: ApiKeyScope[]): void {
    if (this.isInvalidScopes(scopes)) {
      throw new BadRequestException('At least one API key scope is required');
    }
    for (const scope of scopes) {
      if (!API_KEY_SCOPES.includes(scope)) {
        throw new BadRequestException('Invalid API key scope');
      }
    }
  }

  private parseKeyId(keyId: string | number): number {
    let parsed: number;
    if (typeof keyId === 'number') {
      parsed = keyId;
    } else {
      parsed = Number(keyId);
    }
    if (this.isInvalidKeyId(parsed)) {
      throw new BadRequestException('Invalid API key identifier');
    }
    return parsed;
  }

  private normalizeName(name: string): string {
    const normalized = name.trim();
    if (this.isInvalidName(normalized)) {
      throw new BadRequestException('API key name must contain 1 to 100 characters');
    }
    return normalized;
  }

  private getApiKeyTtl(): number {
    const ttlMs = this.customEnvService.getWithDefault<number>(
      'CLI_API_KEY_TTL',
      DEFAULT_API_KEY_TTL_MS,
    );
    if (this.isInvalidTtl(ttlMs)) {
      throw new InternalServerErrorException('API key expiration is not configured correctly');
    }
    return ttlMs;
  }

  private getRecordKey(publicId: string): string {
    return `api-key:record:${publicId}`;
  }

  private isInvalidScopes(scopes: ApiKeyScope[]): boolean {
    if (!Array.isArray(scopes)) {
      return true;
    }
    return scopes.length === 0;
  }

  private isInvalidKeyId(keyId: number): boolean {
    const isNotSafeInteger = !Number.isSafeInteger(keyId);
    const isNotPositive = keyId <= 0;
    return isNotSafeInteger || isNotPositive;
  }

  private isInvalidName(name: string): boolean {
    const isEmpty = name.length === 0;
    const isTooLong = name.length > 100;
    return isEmpty || isTooLong;
  }

  private isInvalidTtl(ttlMs: number): boolean {
    const isNotSafeInteger = !Number.isSafeInteger(ttlMs);
    const isNotPositive = ttlMs <= 0;
    return isNotSafeInteger || isNotPositive;
  }

  private getOwnerIndexKey(userId: bigint): string {
    return `api-key:owner:${userId.toString()}`;
  }

  private toSummary(record: ApiKeyRecord): ApiKeySummary {
    return {
      id: String(record.id),
      publicId: record.publicId,
      name: record.name,
      source: record.source,
      scopes: [...record.scopes],
      lastUsedAt: record.lastUsedAt,
      expiresAt: record.expiresAt,
      revokedAt: record.revokedAt,
      createdAt: record.createdAt,
    };
  }
}
