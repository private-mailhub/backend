import {
  BadRequestException,
  ForbiddenException,
  HttpException,
  HttpStatus,
  Injectable,
  InternalServerErrorException,
  NotFoundException,
  Optional,
} from '@nestjs/common';
import * as crypto from 'crypto';
import { ApiKeyService, API_KEY_SCOPES, type ApiKeyScope } from './api-key.service';
import { CacheRepository } from '../cache/cache.repository';
import { ProtectionUtil } from '../common/utils/protection.util';
import { CustomEnvService } from '../config/custom-env.service';
import { UsersService } from '../users/users.service';
import { UserStatus } from '../users/user.enums';
import type { StartCliDeviceAuthorizationDto } from './dto/cli-device.dto';

type DeviceAuthorizationStatus = 'pending' | 'approved' | 'denied' | 'issuing' | 'consumed';

interface DeviceAuthorizationRecord {
  clientName: string;
  deviceName: string;
  cliVersion: string;
  status: DeviceAuthorizationStatus;
  userId: string | null;
  pollSecretHash: string;
  createdAt: string;
  expiresAt: string;
  decidedAt: string | null;
  scopes: ApiKeyScope[];
  consumedAt?: string | null;
  encryptedIdempotencySeed?: string | null;
}

export interface PublicDeviceAuthorization {
  clientName: string;
  deviceName: string;
  cliVersion: string;
  status: 'pending' | 'approved' | 'denied';
  expiresAt: string;
  scopes: ApiKeyScope[];
}

export interface DeviceTokenResponse {
  apiKey: string;
  keyId: string;
  expiresAt: string;
  scopes: ApiKeyScope[];
}

const DEVICE_AUTHORIZATION_TTL_MS = 10 * 60 * 1000;
const DEVICE_CONSUMED_RETRY_GRACE_MS = 60 * 1000;
const DEVICE_POLL_INTERVAL_SECONDS = 5;
const RATE_LIMIT_WINDOW_MS = 60 * 1000;
const DEVICE_START_LIMIT = 10;
const DEVICE_POLL_LIMIT = 20;
const USER_CODE_ATTEMPT_LIMIT = 10;
const USER_CODE_ALPHABET = '23456789ABCDEFGHJKLMNPQRSTUVWXYZ';
const DEFAULT_VERIFICATION_URI = 'https://private-mailhub.com/cli/authorize';

@Injectable()
export class CliDeviceAuthService {
  constructor(
    private readonly cacheRepository: CacheRepository,
    private readonly apiKeyService: ApiKeyService,
    private readonly protectionUtil: ProtectionUtil,
    private readonly customEnvService: CustomEnvService,
    @Optional() private readonly usersService?: UsersService,
  ) {}

  async startDeviceAuthorization(
    input: StartCliDeviceAuthorizationDto,
    clientIp = 'unknown',
  ): Promise<{
    deviceCode: string;
    userCode: string;
    verificationUri: string;
    expiresIn: number;
    interval: number;
  }> {
    await this.enforceRateLimit('start', clientIp, DEVICE_START_LIMIT, false);
    this.validateStartInput(input);
    const verificationUri = this.getVerificationUri();

    for (let attempt = 0; attempt < 5; attempt += 1) {
      const deviceCode = crypto.randomBytes(32).toString('base64url');
      const userCode = this.generateUserCode();
      const deviceCodeHash = this.hash(deviceCode);
      const userCodeHash = this.hashUserInput(this.normalizeUserCode(userCode));
      const now = Date.now();
      const state: DeviceAuthorizationRecord = {
        clientName: input.clientName,
        deviceName: input.deviceName.trim(),
        cliVersion: input.cliVersion.trim(),
        status: 'pending',
        userId: null,
        pollSecretHash: input.pollSecretHash,
        createdAt: new Date(now).toISOString(),
        expiresAt: new Date(now + DEVICE_AUTHORIZATION_TTL_MS).toISOString(),
        decidedAt: null,
        scopes: [...API_KEY_SCOPES],
        consumedAt: null,
        encryptedIdempotencySeed: null,
      };
      const created = await this.cacheRepository.setManyIfAbsentWithExpiry([
        {
          key: this.getDeviceStateKey(deviceCodeHash),
          value: state,
          ttlMs: DEVICE_AUTHORIZATION_TTL_MS,
        },
        {
          key: this.getUserCodeKey(userCodeHash),
          value: deviceCodeHash,
          ttlMs: DEVICE_AUTHORIZATION_TTL_MS,
        },
      ]);
      if (!created) {
        continue;
      }

      return {
        deviceCode,
        userCode,
        verificationUri,
        expiresIn: Math.floor(DEVICE_AUTHORIZATION_TTL_MS / 1000),
        interval: DEVICE_POLL_INTERVAL_SECONDS,
      };
    }

    throw new InternalServerErrorException('Could not create device authorization');
  }

  async getAuthorization(
    userCode: string,
    clientIp = 'unknown',
  ): Promise<PublicDeviceAuthorization> {
    await this.enforceRateLimit('user-code', clientIp, USER_CODE_ATTEMPT_LIMIT, false);
    const state = await this.getStateByUserCode(userCode);
    this.ensureNotExpired(state);
    return this.toPublicAuthorization(state);
  }

  async decideAuthorization(
    userId: bigint,
    userCode: string,
    approve: boolean,
    clientIp = 'unknown',
  ): Promise<{ status: 'approved' | 'denied' }> {
    await this.enforceRateLimit('user-code', clientIp, USER_CODE_ATTEMPT_LIMIT, false);
    await this.requireActiveUser(userId);
    const { deviceCodeHash, state } = await this.getStateAndDeviceHashByUserCode(userCode);
    this.ensureNotExpired(state);

    if (state.status !== 'pending') {
      return this.resolveRepeatedDecision(state, userId);
    }

    let nextStatus: 'approved' | 'denied';
    if (approve) {
      nextStatus = 'approved';
    } else {
      nextStatus = 'denied';
    }
    const nextState: DeviceAuthorizationRecord = {
      ...state,
      status: nextStatus,
      userId: userId.toString(),
      decidedAt: new Date().toISOString(),
    };
    const changed = await this.cacheRepository.transitionJson(
      this.getDeviceStateKey(deviceCodeHash),
      'pending',
      nextState,
    );
    if (changed) {
      return { status: nextStatus };
    }

    const latest = await this.getStateByDeviceHash(deviceCodeHash);
    return this.resolveRepeatedDecision(latest, userId);
  }

  async pollDeviceToken(
    deviceCode: string,
    pollSecret: string,
    clientIp = 'unknown',
  ): Promise<DeviceTokenResponse> {
    await this.enforceRateLimit('poll', clientIp, DEVICE_POLL_LIMIT, true);
    const normalizedDeviceCode = this.validateDeviceCode(deviceCode);
    const normalizedPollSecret = this.validatePollSecret(pollSecret);
    const deviceCodeHash = this.hash(normalizedDeviceCode);
    const state = await this.getStateByDeviceHash(deviceCodeHash);
    if (!this.isPollSecretMatch(normalizedPollSecret, state.pollSecretHash)) {
      throw new BadRequestException('expired_token');
    }
    this.ensureNotExpired(state);
    if (state.status === 'consumed') {
      if (!this.isConsumedRetryWithinGracePeriod(state)) {
        throw new BadRequestException('expired_token');
      }
    }

    if (state.status === 'pending') {
      throw new BadRequestException('authorization_pending');
    }
    if (state.status === 'denied') {
      throw new BadRequestException('access_denied');
    }
    if (!this.isRecoverableTokenStatus(state.status)) {
      throw new BadRequestException('expired_token');
    }
    if (state.userId === null) {
      throw new BadRequestException('expired_token');
    }

    const approvedUserId = BigInt(state.userId);
    await this.requireActiveUser(approvedUserId);
    let issuingState = state;
    if (state.status === 'approved') {
      const idempotencySeed = crypto.randomBytes(32).toString('base64url');
      issuingState = {
        ...state,
        status: 'issuing',
        encryptedIdempotencySeed: this.protectionUtil.encrypt(idempotencySeed),
      };
      const claimed = await this.cacheRepository.transitionJson(
        this.getDeviceStateKey(deviceCodeHash),
        'approved',
        issuingState,
      );
      if (!claimed) {
        const latest = await this.getStateByDeviceHash(deviceCodeHash);
        if (!this.isRecoverableClaimState(latest, approvedUserId)) {
          throw new BadRequestException('expired_token');
        }
        issuingState = latest;
      }
    }

    const idempotencySeed = this.getIdempotencySeed(issuingState);
    const issuedKey = await this.apiKeyService.create(
      approvedUserId,
      {
        name: state.deviceName,
        source: 'cli',
        scopes: [...state.scopes],
      },
      idempotencySeed,
    );
    const consumedState: DeviceAuthorizationRecord = {
      ...issuingState,
      status: 'consumed',
      consumedAt: new Date().toISOString(),
    };
    const consumed = await this.cacheRepository.transitionJson(
      this.getDeviceStateKey(deviceCodeHash),
      'issuing',
      consumedState,
    );
    if (!consumed) {
      const latest = await this.getStateByDeviceHash(deviceCodeHash);
      if (latest.status !== 'consumed' || latest.userId !== approvedUserId.toString()) {
        throw new InternalServerErrorException('Could not complete device authorization');
      }
    }

    return {
      ...issuedKey,
      keyId: String(issuedKey.keyId),
    };
  }

  private isRecoverableTokenStatus(status: DeviceAuthorizationStatus): boolean {
    if (status === 'approved') {
      return true;
    }
    if (status === 'issuing') {
      return true;
    }
    return status === 'consumed';
  }

  private isRecoverableClaimState(
    state: DeviceAuthorizationRecord,
    approvedUserId: bigint,
  ): boolean {
    if (state.userId !== approvedUserId.toString()) {
      return false;
    }
    if (state.status === 'issuing') {
      return true;
    }
    return state.status === 'consumed';
  }

  private isConsumedRetryWithinGracePeriod(state: DeviceAuthorizationRecord): boolean {
    if (typeof state.consumedAt !== 'string') {
      return false;
    }
    const consumedAt = Date.parse(state.consumedAt);
    if (!Number.isFinite(consumedAt)) {
      return false;
    }
    const age = Date.now() - consumedAt;
    if (age < 0) {
      return false;
    }
    return age <= DEVICE_CONSUMED_RETRY_GRACE_MS;
  }

  private getIdempotencySeed(state: DeviceAuthorizationRecord): string {
    const encryptedSeed = state.encryptedIdempotencySeed;
    if (typeof encryptedSeed !== 'string' || encryptedSeed.length === 0) {
      throw new InternalServerErrorException('Could not recover device authorization');
    }

    let seed: string;
    try {
      seed = this.protectionUtil.decrypt(encryptedSeed);
    } catch {
      throw new InternalServerErrorException('Could not recover device authorization');
    }
    if (!this.isValidIdempotencySeed(seed)) {
      throw new InternalServerErrorException('Could not recover device authorization');
    }
    return seed;
  }

  private isValidIdempotencySeed(seed: string): boolean {
    if (!/^[A-Za-z0-9_-]{43}$/.test(seed)) {
      return false;
    }
    const decoded = Buffer.from(seed, 'base64url');
    if (decoded.length !== 32) {
      return false;
    }
    return decoded.toString('base64url') === seed;
  }

  private validatePollSecret(pollSecret: string): string {
    if (!this.isValidPollSecret(pollSecret)) {
      throw new BadRequestException('expired_token');
    }
    return pollSecret;
  }

  private isValidPollSecret(pollSecret: string): boolean {
    if (!/^[A-Za-z0-9_-]{43}$/.test(pollSecret)) {
      return false;
    }
    const decoded = Buffer.from(pollSecret, 'base64url');
    if (decoded.length !== 32) {
      return false;
    }
    return decoded.toString('base64url') === pollSecret;
  }

  private isPollSecretMatch(pollSecret: string, expectedHash: string): boolean {
    const actual = Buffer.from(this.hash(pollSecret), 'hex');
    const expected = Buffer.from(expectedHash, 'hex');
    if (actual.length !== expected.length) {
      return false;
    }
    return crypto.timingSafeEqual(actual, expected);
  }

  private async getStateAndDeviceHashByUserCode(
    userCode: string,
  ): Promise<{ deviceCodeHash: string; state: DeviceAuthorizationRecord }> {
    const normalizedUserCode = this.validateUserCode(userCode);
    const userCodeHash = this.hashUserInput(normalizedUserCode);
    const deviceCodeHash = await this.cacheRepository.get<string>(
      this.getUserCodeKey(userCodeHash),
    );
    if (!deviceCodeHash) {
      throw new NotFoundException('Device authorization not found');
    }
    const state = await this.getStateByDeviceHash(deviceCodeHash);
    return { deviceCodeHash, state };
  }

  private async getStateByUserCode(userCode: string): Promise<DeviceAuthorizationRecord> {
    const { state } = await this.getStateAndDeviceHashByUserCode(userCode);
    return state;
  }

  private async getStateByDeviceHash(deviceCodeHash: string): Promise<DeviceAuthorizationRecord> {
    const state = await this.cacheRepository.get<DeviceAuthorizationRecord>(
      this.getDeviceStateKey(deviceCodeHash),
    );
    if (!state) {
      throw new BadRequestException('expired_token');
    }
    if (!this.isValidAuthorizationRecord(state)) {
      throw new BadRequestException('expired_token');
    }
    return state;
  }

  private resolveRepeatedDecision(
    state: DeviceAuthorizationRecord,
    userId: bigint,
  ): { status: 'approved' | 'denied' } {
    if (state.userId !== userId.toString()) {
      throw new BadRequestException('Device authorization has already been decided');
    }
    if (this.isApprovedStatus(state.status)) {
      return { status: 'approved' };
    }
    if (state.status === 'denied') {
      return { status: 'denied' };
    }
    throw new BadRequestException('Device authorization is no longer available');
  }

  private async enforceRateLimit(
    operation: 'start' | 'poll' | 'user-code',
    clientIp: string,
    limit: number,
    isPolling: boolean,
  ): Promise<void> {
    const ipHash = this.hashUserInput(clientIp || 'unknown');
    const key = `cli:rate:${operation}:${ipHash}`;
    const count = await this.cacheRepository.incrementWithExpiry(key, RATE_LIMIT_WINDOW_MS);
    if (count <= limit) {
      return;
    }
    if (isPolling) {
      throw new BadRequestException('slow_down');
    }
    throw new HttpException('Too many authorization attempts', HttpStatus.TOO_MANY_REQUESTS);
  }

  private async requireActiveUser(userId: bigint): Promise<void> {
    if (!this.usersService) {
      throw new InternalServerErrorException('User validation is unavailable');
    }
    const user = await this.usersService.findById(userId);
    if (!user) {
      throw new ForbiddenException('Account is not active');
    }
    if (user.status !== UserStatus.ACTIVE) {
      throw new ForbiddenException('Account is not active');
    }
  }

  private validateStartInput(input: StartCliDeviceAuthorizationDto): void {
    if (input.clientName !== 'mailhub-cli') {
      throw new BadRequestException('Unsupported client');
    }
    if (this.isInvalidStartValue(input.deviceName, 100)) {
      throw new BadRequestException('Device name must contain 1 to 100 characters');
    }
    if (this.isInvalidStartValue(input.cliVersion, 50)) {
      throw new BadRequestException('CLI version must contain 1 to 50 characters');
    }
    if (!/^[a-f0-9]{64}$/.test(input.pollSecretHash)) {
      throw new BadRequestException('Invalid device authorization request');
    }
  }

  private isInvalidStartValue(value: string, maximumLength: number): boolean {
    const normalized = value.trim();
    const isEmpty = normalized.length === 0;
    const isTooLong = normalized.length > maximumLength;
    return isEmpty || isTooLong;
  }

  private isApprovedStatus(status: DeviceAuthorizationStatus): boolean {
    if (status === 'approved') {
      return true;
    }
    if (status === 'issuing') {
      return true;
    }
    return status === 'consumed';
  }

  private validateDeviceCode(deviceCode: string): string {
    const isValid = /^[A-Za-z0-9_-]{43}$/.test(deviceCode);
    if (!isValid) {
      throw new BadRequestException('expired_token');
    }
    return deviceCode;
  }

  private validateUserCode(userCode: string): string {
    const normalized = this.normalizeUserCode(userCode);
    const isValid = /^[A-Z0-9]{8}$/.test(normalized);
    if (!isValid) {
      throw new NotFoundException('Device authorization not found');
    }
    return normalized;
  }

  private normalizeUserCode(userCode: string): string {
    return userCode.replace(/-/g, '').toUpperCase();
  }

  private generateUserCode(): string {
    const characters: string[] = [];
    for (let index = 0; index < 8; index += 1) {
      characters.push(USER_CODE_ALPHABET[crypto.randomInt(USER_CODE_ALPHABET.length)]);
    }
    return `${characters.slice(0, 4).join('')}-${characters.slice(4).join('')}`;
  }

  private ensureNotExpired(state: DeviceAuthorizationRecord): void {
    if (Date.parse(state.expiresAt) <= Date.now()) {
      throw new BadRequestException('expired_token');
    }
  }

  private isValidAuthorizationRecord(state: unknown): state is DeviceAuthorizationRecord {
    if (state === null || typeof state !== 'object') {
      return false;
    }
    const candidate = state as Partial<DeviceAuthorizationRecord>;
    if (candidate.clientName !== 'mailhub-cli') {
      return false;
    }
    if (typeof candidate.deviceName !== 'string' || candidate.deviceName.length === 0) {
      return false;
    }
    if (typeof candidate.cliVersion !== 'string' || candidate.cliVersion.length === 0) {
      return false;
    }
    if (!this.isDeviceAuthorizationStatus(candidate.status)) {
      return false;
    }
    if (candidate.userId !== null) {
      if (typeof candidate.userId !== 'string') {
        return false;
      }
    }
    if (candidate.userId === undefined) {
      return false;
    }
    if (typeof candidate.userId === 'string') {
      if (!/^\d{1,20}$/.test(candidate.userId)) {
        return false;
      }
    }
    if (typeof candidate.pollSecretHash !== 'string') {
      return false;
    }
    if (!/^[a-f0-9]{64}$/.test(candidate.pollSecretHash)) {
      return false;
    }
    if (typeof candidate.createdAt !== 'string') {
      return false;
    }
    if (candidate.status === 'pending' && candidate.userId !== null) {
      return false;
    }
    if (candidate.status !== 'pending' && candidate.userId === null) {
      return false;
    }
    if (!Number.isFinite(Date.parse(candidate.createdAt))) {
      return false;
    }
    if (typeof candidate.expiresAt !== 'string') {
      return false;
    }
    if (!Number.isFinite(Date.parse(candidate.expiresAt))) {
      return false;
    }
    if (candidate.consumedAt !== undefined && candidate.consumedAt !== null) {
      if (typeof candidate.consumedAt !== 'string') {
        return false;
      }
      if (!Number.isFinite(Date.parse(candidate.consumedAt))) {
        return false;
      }
    }
    if (
      candidate.encryptedIdempotencySeed !== undefined &&
      candidate.encryptedIdempotencySeed !== null
    ) {
      if (typeof candidate.encryptedIdempotencySeed !== 'string') {
        return false;
      }
      if (candidate.encryptedIdempotencySeed.length > 512) {
        return false;
      }
    }
    if (!Array.isArray(candidate.scopes)) {
      return false;
    }
    if (candidate.scopes.length === 0) {
      return false;
    }
    for (const scope of candidate.scopes) {
      if (!API_KEY_SCOPES.includes(scope)) {
        return false;
      }
    }
    return true;
  }

  private isDeviceAuthorizationStatus(status: unknown): status is DeviceAuthorizationStatus {
    if (status === 'pending') {
      return true;
    }
    if (status === 'approved') {
      return true;
    }
    if (status === 'denied') {
      return true;
    }
    if (status === 'issuing') {
      return true;
    }
    return status === 'consumed';
  }

  private toPublicAuthorization(state: DeviceAuthorizationRecord): PublicDeviceAuthorization {
    let status: PublicDeviceAuthorization['status'];
    if (this.isApprovedStatus(state.status)) {
      status = 'approved';
    } else if (state.status === 'denied') {
      status = 'denied';
    } else {
      status = 'pending';
    }
    return {
      clientName: state.clientName,
      deviceName: state.deviceName,
      cliVersion: state.cliVersion,
      status,
      expiresAt: state.expiresAt,
      scopes: [...state.scopes],
    };
  }

  private getVerificationUri(): string {
    const verificationUri = this.customEnvService.getWithDefault<string>(
      'CLI_DEVICE_VERIFICATION_URI',
      DEFAULT_VERIFICATION_URI,
    );
    let parsedUri: URL;
    try {
      parsedUri = new URL(verificationUri);
    } catch {
      throw new InternalServerErrorException('CLI verification URL is not configured correctly');
    }
    const nodeEnvironment = this.customEnvService.getWithDefault<string>('NODE_ENV', 'production');
    if (parsedUri.protocol !== 'https:' && nodeEnvironment === 'production') {
      throw new InternalServerErrorException('CLI verification URL must use HTTPS');
    }
    if (this.isInvalidVerificationUri(parsedUri)) {
      throw new InternalServerErrorException('CLI verification URL is not configured correctly');
    }
    return verificationUri;
  }

  private isInvalidVerificationUri(uri: URL): boolean {
    const hasCredentials = Boolean(uri.username) || Boolean(uri.password);
    const hasQueryOrFragment = Boolean(uri.search) || Boolean(uri.hash);
    return hasCredentials || hasQueryOrFragment;
  }

  private hash(value: string): string {
    return crypto.createHash('sha256').update(value, 'utf8').digest('hex');
  }

  private hashUserInput(value: string): string {
    const secret = this.customEnvService.get<string>('JWT_SECRET');
    return crypto.createHmac('sha256', secret).update(value, 'utf8').digest('hex');
  }

  private getDeviceStateKey(deviceCodeHash: string): string {
    return `cli:device:state:${deviceCodeHash}`;
  }

  private getUserCodeKey(userCodeHash: string): string {
    return `cli:device:user-code:${userCodeHash}`;
  }
}
