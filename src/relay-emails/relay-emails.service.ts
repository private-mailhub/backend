import {
  Injectable,
  NotFoundException,
  Logger,
  BadRequestException,
  ForbiddenException,
} from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { CacheService } from '../cache/cache.service';
import { RelayEmail } from './entities/relay-email.entity';
import { CustomEnvService } from 'src/config/custom-env.service';
import { ProtectionUtil } from 'src/common/utils/protection.util';
import { generateRelayUsername } from 'src/common/utils/relay-email.util';
import { User } from 'src/users/entities/user.entity';
import { isProTier } from 'src/common/utils/permission.util';

@Injectable()
export class RelayEmailsService {
  private readonly logger = new Logger(RelayEmailsService.name);
  private readonly FREE_LIMIT = 20;

  constructor(
    @InjectRepository(RelayEmail)
    private readonly relayEmailRepository: Repository<RelayEmail>,
    private readonly customEnvService: CustomEnvService,
    private readonly cacheService: CacheService,
    private readonly encryptionUtil: ProtectionUtil,
  ) {}

  async generateRelayEmailAddress(user: User, description?: string): Promise<RelayEmail> {
    if (!isProTier(user)) {
      const count = await this.countByUser(user.id);
      if (count >= this.FREE_LIMIT) {
        throw new ForbiddenException(
          `FREE tier users can only create up to ${this.FREE_LIMIT}relay emails`,
        );
      }
    }

    // Generate a unique relay address
    let relayEmail: string = '';
    let exists = true;

    while (exists) {
      const username = generateRelayUsername();
      relayEmail = `${username}@${this.customEnvService.get<string>('APP_DOMAIN')}`;

      // Check if this relay address already exists
      const existing = await this.relayEmailRepository.findOne({
        where: { relayEmail },
      });

      exists = !!existing;
    }

    // Create the relay email record
    const relayEmailEntity = this.relayEmailRepository.create({
      userId: user.id,
      primaryEmail: user.username,
      relayEmail,
      description: description?.trim() || null,
    });

    const savedRelayEmail = await this.relayEmailRepository.save(relayEmailEntity);

    // Cache the mapping (store encrypted email in cache too)
    await this.cacheService.setRelayMailCache({
      encryptedPrimaryEmail: user.username,
      relayEmail,
    });

    return savedRelayEmail;
  }

  async generateCustomRelayEmailAddress(user: User, customUsername: string): Promise<RelayEmail> {
    // Check permission
    if (!isProTier(user)) {
      throw new ForbiddenException('User can not create custom email address');
    }
    // Build custom relay address
    const customRelayEmail = `${customUsername}@${this.customEnvService.get<string>('APP_DOMAIN')}`;

    // Check if this relay address already exists
    const existing = await this.relayEmailRepository.findOne({
      where: { relayEmail: customRelayEmail },
    });

    if (existing) {
      throw new BadRequestException('Duplicated email address');
    }

    // Create the relay email record
    const relayEmail = this.relayEmailRepository.create({
      userId: user.id,
      primaryEmail: user.username,
      relayEmail: customRelayEmail,
    });

    const savedRelayEmail = await this.relayEmailRepository.save(relayEmail);

    // Cache the mapping (store encrypted email in cache too)
    await this.cacheService.setRelayMailCache({
      encryptedPrimaryEmail: user.username,
      relayEmail: customRelayEmail,
    });

    return savedRelayEmail;
  }

  async findPrimaryEmailByRelayEmail(relayEmail: string): Promise<string | null> {
    // Try cache first
    const cachedEncryptedEmail = await this.cacheService.findPrimaryMailFromCache(relayEmail);

    if (cachedEncryptedEmail) {
      // Decrypt before returning
      return this.encryptionUtil.decrypt(cachedEncryptedEmail);
    }

    // If not in cache, query database
    const relayEmailEntity = await this.relayEmailRepository.findOne({
      where: { relayEmail },
    });

    if (!relayEmailEntity) {
      return null;
    }

    // Cache for future requests (store encrypted)
    await this.cacheService.setRelayMailCache({
      relayEmail,
      encryptedPrimaryEmail: relayEmailEntity.primaryEmail,
    });

    // Decrypt before returning
    return this.encryptionUtil.decrypt(relayEmailEntity.primaryEmail);
  }
  async findRelayEmailWithUserId(relayEmail: string): Promise<RelayEmail | null> {
    return await this.relayEmailRepository.findOne({
      where: { relayEmail },
    });
  }

  async findByUser(userId: bigint): Promise<RelayEmail[]> {
    return await this.relayEmailRepository.find({
      where: { userId },
      order: { createdAt: 'DESC' },
    });
  }

  async findById(id: bigint, userId: bigint): Promise<RelayEmail | null> {
    return await this.relayEmailRepository.findOne({
      where: { id, userId },
    });
  }

  async deleteRelayEmail(id: bigint, userId: bigint): Promise<void> {
    const relayEmailEntity = await this.findById(id, userId);

    if (!relayEmailEntity) {
      throw new NotFoundException('Relay email not found');
    }

    // Delete from database (soft delete via TypeORM)
    await this.relayEmailRepository.softRemove(relayEmailEntity);

    // Remove from cache
    await this.cacheService.deleteRelayMailMappingCache(relayEmailEntity.relayEmail);
  }

  async countByUser(userId: bigint): Promise<number> {
    return await this.relayEmailRepository.count({
      where: { userId },
    });
  }

  async updateDescription(id: bigint, userId: bigint, description: string): Promise<RelayEmail> {
    const relayEmail = await this.findById(id, userId);

    if (!relayEmail) {
      throw new NotFoundException('Relay email not found');
    }

    relayEmail.description = description;
    return await this.relayEmailRepository.save(relayEmail).then((res) => {
      this.logger.log(`Updated description for relay email ${id}`);
      return res;
    });
  }

  async updateActiveStatus(id: bigint, userId: bigint, isActive: boolean): Promise<RelayEmail> {
    const relayEmailEntity = await this.findById(id, userId);

    if (!relayEmailEntity) {
      throw new NotFoundException('Relay email not found');
    }

    // get primary email from cache
    const cached = await this.cacheService.findPrimaryMailFromCache(relayEmailEntity.relayEmail);

    if (!!cached && !isActive) {
      // If exists cache and pause status
      await this.cacheService.deleteRelayMailMappingCache(relayEmailEntity.relayEmail);
    } else if (!cached && isActive) {
      // If no exists cache and live status
      await this.cacheService.setRelayMailCache({
        relayEmail: relayEmailEntity.relayEmail,
        encryptedPrimaryEmail: relayEmailEntity.primaryEmail,
      });
    }

    relayEmailEntity.isActive = isActive;
    return await this.relayEmailRepository.save(relayEmailEntity).then((res) => {
      this.logger.log(`Updated active status for relay email ${id}`);
      return res;
    });
  }
}
