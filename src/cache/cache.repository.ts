import { Injectable, Inject } from '@nestjs/common';
import { CACHE_MANAGER } from '@nestjs/cache-manager';
import type { Cache } from 'cache-manager';
import type { RedisClientType } from '@keyv/redis';

type RedisBackedStore = {
  client?: RedisClientType;
};

type KeyvEnvelope<T> = {
  value: T;
  expires?: number;
};

const TRANSITION_JSON_SCRIPT = `
local raw = redis.call('GET', KEYS[1])
if not raw then return 0 end
local envelope = cjson.decode(raw)
if not envelope.value or envelope.value.status ~= ARGV[1] then return 0 end
local ttl = redis.call('PTTL', KEYS[1])
if ttl <= 0 then
  redis.call('DEL', KEYS[1])
  return 0
end
local nextValue = cjson.decode(ARGV[2])
envelope.value = nextValue
local serialized = cjson.encode(envelope)
redis.call('SET', KEYS[1], serialized, 'PX', ttl)
return 1
`;

const UPDATE_API_KEY_LAST_USED_SCRIPT = `
local raw = redis.call('GET', KEYS[1])
if not raw then return 0 end
local envelope = cjson.decode(raw)
local value = envelope.value
local ttl = redis.call('PTTL', KEYS[1])
if ttl <= 0 then
  redis.call('DEL', KEYS[1])
  return 0
end
if not value or value.secretHash ~= ARGV[1] or value.revokedAt ~= cjson.null then return 0 end
value.lastUsedAt = ARGV[2]
local serialized = cjson.encode(envelope)
redis.call('SET', KEYS[1], serialized, 'PX', ttl)
return 1
`;

const REVOKE_API_KEY_SCRIPT = `
local setType = redis.call('TYPE', KEYS[2]).ok
if setType ~= 'none' and setType ~= 'set' then
  return redis.error_reply('API key owner index has an invalid Redis type')
end

local function refreshOwnerIndexExpiry(ownerId)
  local maxTtl = 0
  local members = redis.call('SMEMBERS', KEYS[2])
  for _, existingMember in ipairs(members) do
    local existingKey = 'api-key:record:' .. existingMember
    local existingRaw = redis.call('GET', existingKey)
    local removeMember = false
    if not existingRaw then
      removeMember = true
    else
      local decodeOk, existingEnvelope = pcall(cjson.decode, existingRaw)
      if not decodeOk then
        removeMember = true
      elseif type(existingEnvelope) ~= 'table' then
        removeMember = true
      elseif type(existingEnvelope.value) ~= 'table' then
        removeMember = true
      else
        local existingTtl = redis.call('PTTL', existingKey)
        local existingValue = existingEnvelope.value
        if existingTtl <= 0 then
          redis.call('DEL', existingKey)
          removeMember = true
        elseif existingValue.publicId == existingMember and existingValue.userId == ownerId then
          if existingTtl > maxTtl then maxTtl = existingTtl end
        else
          removeMember = true
        end
      end
    end
    if removeMember then redis.call('SREM', KEYS[2], existingMember) end
  end
  if maxTtl > 0 then redis.call('PEXPIRE', KEYS[2], maxTtl) end
end

local raw = redis.call('GET', KEYS[1])
if not raw then
  redis.call('SREM', KEYS[2], ARGV[4])
  refreshOwnerIndexExpiry(ARGV[1])
  return 0
end
local decodeOk, envelope = pcall(cjson.decode, raw)
if not decodeOk then return -1 end
if type(envelope) ~= 'table' then return -1 end
local value = envelope.value
if type(value) ~= 'table' then return -1 end
if value.userId ~= ARGV[1] then
  redis.call('SREM', KEYS[2], ARGV[4])
  refreshOwnerIndexExpiry(ARGV[1])
  return -1
end
if value.publicId ~= ARGV[4] then
  redis.call('SREM', KEYS[2], ARGV[4])
  refreshOwnerIndexExpiry(ARGV[1])
  return -1
end
local ttl = redis.call('PTTL', KEYS[1])
if ttl == 0 or ttl == -2 then
  redis.call('DEL', KEYS[1])
  redis.call('SREM', KEYS[2], ARGV[4])
  refreshOwnerIndexExpiry(ARGV[1])
  return 0
end
local wasAlreadyRevoked = value.revokedAt ~= nil and value.revokedAt ~= cjson.null
if wasAlreadyRevoked and ttl > 0 then
  redis.call('SADD', KEYS[2], ARGV[4])
  refreshOwnerIndexExpiry(ARGV[1])
  return 2
end
if not wasAlreadyRevoked then value.revokedAt = ARGV[2] end
local nextTtl = tonumber(ARGV[3])
if ttl > 0 and ttl < nextTtl then nextTtl = ttl end
local now = redis.call('TIME')
local nowMs = (tonumber(now[1]) * 1000) + math.floor(tonumber(now[2]) / 1000)
envelope.expires = nowMs + nextTtl
local serialized = cjson.encode(envelope)
redis.call('SET', KEYS[1], serialized, 'PX', nextTtl)
redis.call('SADD', KEYS[2], ARGV[4])
refreshOwnerIndexExpiry(ARGV[1])
if wasAlreadyRevoked then return 2 end
return 1
`;

const INCREMENT_WITH_EXPIRY_SCRIPT = `
local count = redis.call('INCR', KEYS[1])
if count == 1 then redis.call('PEXPIRE', KEYS[1], ARGV[1]) end
return count
`;

const SET_MANY_IF_ABSENT_SCRIPT = `
for _, key in ipairs(KEYS) do
  if redis.call('EXISTS', key) == 1 then return 0 end
end
for index, key in ipairs(KEYS) do
  local argumentIndex = ((index - 1) * 2) + 1
  redis.call('SET', key, ARGV[argumentIndex], 'PX', ARGV[argumentIndex + 1])
end
return 1
`;

const SET_API_KEY_WITH_QUOTA_SCRIPT = `
local setType = redis.call('TYPE', KEYS[2]).ok
if setType ~= 'none' and setType ~= 'set' then
  return redis.error_reply('API key owner index has an invalid Redis type')
end
if redis.call('EXISTS', KEYS[1]) == 1 then return -1 end
local liveCount = 0
local members = redis.call('SMEMBERS', KEYS[2])
local maxTtl = tonumber(ARGV[2])
for _, existingMember in ipairs(members) do
  local existingKey = 'api-key:record:' .. existingMember
  local existingRaw = redis.call('GET', existingKey)
  local removeMember = false
  if not existingRaw then
    removeMember = true
  else
    local decodeOk, existingEnvelope = pcall(cjson.decode, existingRaw)
    if not decodeOk then
      removeMember = true
    elseif type(existingEnvelope) ~= 'table' then
      removeMember = true
    elseif type(existingEnvelope.value) ~= 'table' then
      removeMember = true
    else
      local existingTtl = redis.call('PTTL', existingKey)
      local existingValue = existingEnvelope.value
      if existingTtl <= 0 then
        redis.call('DEL', existingKey)
        removeMember = true
      elseif existingValue.publicId == existingMember and existingValue.userId == ARGV[4] then
        liveCount = liveCount + 1
        if existingTtl > maxTtl then maxTtl = existingTtl end
      else
        removeMember = true
      end
    end
  end
  if removeMember then redis.call('SREM', KEYS[2], existingMember) end
end
if liveCount >= tonumber(ARGV[5]) then return 0 end
redis.call('SET', KEYS[1], ARGV[1], 'PX', ARGV[2])
redis.call('SADD', KEYS[2], ARGV[3])
redis.call('PEXPIRE', KEYS[2], maxTtl)
return 1
`;

const REMOVE_FROM_SET_AND_DELETE_SCRIPT = `
local setType = redis.call('TYPE', KEYS[1]).ok
if setType ~= 'none' and setType ~= 'set' then
  return redis.error_reply('API key owner index has an invalid Redis type')
end
redis.call('SREM', KEYS[1], ARGV[1])
redis.call('DEL', KEYS[2])
return 1
`;

@Injectable()
export class CacheRepository {
  constructor(@Inject(CACHE_MANAGER) private cacheManager: Cache) {}

  // Generic cache operations
  async get<T>(key: string): Promise<T | null> {
    const value = await this.cacheManager.get<T>(key);
    return value ?? null;
  }

  async set(key: string, value: any, ttl?: number): Promise<void> {
    await this.cacheManager.set(key, value, ttl);
  }

  async del(key: string): Promise<void> {
    await this.cacheManager.del(key);
  }

  async exists(key: string): Promise<boolean> {
    const value = await this.get(key);
    return this.isPresent(value);
  }

  async getAndDelete<T>(key: string): Promise<T | null> {
    const raw = await this.getRedisClient().getDel(key);
    if (raw === null) {
      return null;
    }

    const envelope = JSON.parse(raw) as KeyvEnvelope<T>;
    if (this.isExpired(envelope)) {
      return null;
    }

    return envelope.value;
  }

  async addToSet(key: string, member: string): Promise<void> {
    await this.getRedisClient().sAdd(key, member);
  }

  async removeFromSet(key: string, member: string): Promise<void> {
    await this.getRedisClient().sRem(key, member);
  }

  async getSetMembers(key: string): Promise<string[]> {
    return await this.getRedisClient().sMembers(key);
  }

  async increment(key: string): Promise<number> {
    return await this.getRedisClient().incr(key);
  }

  async incrementWithExpiry(key: string, ttlMs: number): Promise<number> {
    const count = await this.getRedisClient().eval(INCREMENT_WITH_EXPIRY_SCRIPT, {
      keys: [key],
      arguments: [String(ttlMs)],
    });
    return Number(count);
  }

  async setApiKeyWithQuota(
    key: string,
    value: unknown,
    ttlMs: number,
    setKey: string,
    member: string,
    ownerId: string,
    maxKeys: number,
  ): Promise<'created' | 'limit' | 'collision'> {
    const expires = Date.now() + ttlMs;
    const serialized = JSON.stringify({ value, expires });
    const result = Number(
      await this.getRedisClient().eval(SET_API_KEY_WITH_QUOTA_SCRIPT, {
        keys: [key, setKey],
        arguments: [serialized, String(ttlMs), member, ownerId, String(maxKeys)],
      }),
    );
    if (result === 1) {
      return 'created';
    }
    if (result === 0) {
      return 'limit';
    }
    if (result === -1) {
      return 'collision';
    }
    throw new Error('Unexpected result while creating API key');
  }

  async transitionJson<T extends { status: string }>(
    key: string,
    expectedStatus: string,
    nextValue: T,
  ): Promise<boolean> {
    const changed = await this.getRedisClient().eval(TRANSITION_JSON_SCRIPT, {
      keys: [key],
      arguments: [expectedStatus, JSON.stringify(nextValue)],
    });
    return Number(changed) === 1;
  }

  async updateApiKeyLastUsed(
    key: string,
    expectedSecretHash: string,
    lastUsedAt: string,
  ): Promise<boolean> {
    const changed = await this.getRedisClient().eval(UPDATE_API_KEY_LAST_USED_SCRIPT, {
      keys: [key],
      arguments: [expectedSecretHash, lastUsedAt],
    });
    return Number(changed) === 1;
  }

  async revokeApiKey(
    key: string,
    ownerId: string,
    revokedAt: string,
    retentionTtlMs: number,
    ownerIndexKey: string,
    member: string,
  ): Promise<boolean> {
    const result = Number(
      await this.getRedisClient().eval(REVOKE_API_KEY_SCRIPT, {
        keys: [key, ownerIndexKey],
        arguments: [ownerId, revokedAt, String(retentionTtlMs), member],
      }),
    );
    if (result === -1) {
      return false;
    }
    return this.isSuccessfulRevocationResult(result);
  }

  async removeFromSetAndDelete(setKey: string, member: string, key: string): Promise<void> {
    await this.getRedisClient().eval(REMOVE_FROM_SET_AND_DELETE_SCRIPT, {
      keys: [setKey, key],
      arguments: [member],
    });
  }

  async setManyWithExpiry(
    entries: Array<{ key: string; value: unknown; ttlMs: number }>,
  ): Promise<void> {
    const multi = this.getRedisClient().multi();
    for (const entry of entries) {
      const expires = Date.now() + entry.ttlMs;
      const serialized = JSON.stringify({ value: entry.value, expires });
      multi.set(entry.key, serialized, { PX: entry.ttlMs });
    }
    await multi.exec();
  }

  async setManyIfAbsentWithExpiry(
    entries: Array<{ key: string; value: unknown; ttlMs: number }>,
  ): Promise<boolean> {
    const keys = entries.map((entry) => entry.key);
    const argumentsList: string[] = [];
    for (const entry of entries) {
      const expires = Date.now() + entry.ttlMs;
      argumentsList.push(JSON.stringify({ value: entry.value, expires }));
      argumentsList.push(String(entry.ttlMs));
    }
    const result = await this.getRedisClient().eval(SET_MANY_IF_ABSENT_SCRIPT, {
      keys,
      arguments: argumentsList,
    });
    return Number(result) === 1;
  }

  private getRedisClient(): RedisClientType {
    const store = this.cacheManager.stores[0]?.store as RedisBackedStore | undefined;
    if (!store?.client) {
      throw new Error('Redis cache store is not available');
    }
    return store.client;
  }

  private isExpired<T>(envelope: KeyvEnvelope<T>): boolean {
    return typeof envelope.expires === 'number' && envelope.expires <= Date.now();
  }

  private isPresent(value: unknown): boolean {
    if (value === null) {
      return false;
    }
    return value !== undefined;
  }

  private isSuccessfulRevocationResult(result: number): boolean {
    return result === 1 || result === 2;
  }
}
