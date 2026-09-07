import { Module } from '@nestjs/common';
import { CacheModule as NestCacheModule } from '@nestjs/cache-manager';
import { createKeyv } from '@keyv/redis';
import { CacheRepository } from './cache.repository';
import { CacheService } from './cache.service';
import { CustomEnvService } from '../config/custom-env.service';

@Module({
  imports: [
    NestCacheModule.registerAsync({
      useFactory: (customEnvService: CustomEnvService) => ({
        stores: [
          createKeyv(
            `redis://${customEnvService.get<string>('REDIS_HOST')}:${customEnvService.get<string>('REDIS_PORT')}`,
          ),
        ],
        isGlobal: true,
      }),
      inject: [CustomEnvService],
    }),
  ],
  providers: [CacheRepository, CacheService],
  exports: [CacheService],
})
export class CacheModule {}
