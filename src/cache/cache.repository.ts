import { Injectable, Inject } from '@nestjs/common';
import { CACHE_MANAGER } from '@nestjs/cache-manager';
import type { Cache } from 'cache-manager';

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
    return value !== null && value !== undefined;
  }
}
