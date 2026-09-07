import { Injectable, Logger } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { ReplyMasking } from './entities/reply-masking.entity';
import { ProtectionUtil } from 'src/common/utils/protection.util';
import { CustomEnvService } from 'src/config/custom-env.service';

@Injectable()
export class ReplyEmailsService {
  private readonly logger = new Logger(ReplyEmailsService.name);

  constructor(
    @InjectRepository(ReplyMasking)
    private readonly replyMaskingRepository: Repository<ReplyMasking>,
    private readonly protectionUtil: ProtectionUtil,
    private readonly customEnvService: CustomEnvService,
  ) {}

  async findByReplyAddress(replyAddress: string): Promise<ReplyMasking | null> {
    return await this.replyMaskingRepository.findOne({
      where: { replyAddress },
    });
  }
  async create(sender: string, receiver: string): Promise<ReplyMasking> {
    const replyAddress = this.generateReplyMaskingEmail(sender, receiver);

    // check if its existing
    const existing = await this.replyMaskingRepository.findOne({ where: { replyAddress } });

    if (existing) {
      return existing;
    }

    // create
    const entity = this.replyMaskingRepository.create({
      replyAddress,
      senderAddress: this.protectionUtil.encrypt(sender),
      senderAddressHash: this.protectionUtil.hash(sender),
      receiverAddress: this.protectionUtil.encrypt(receiver),
      receiverAddressHash: this.protectionUtil.hash(receiver),
    });

    return this.replyMaskingRepository.save(entity);
  }

  private generateReplyMaskingEmail(sender: string, receiver: string): string {
    const domain = this.customEnvService.get<string>('APP_DOMAIN') || 'private-mailhub.com';
    return 'reply-'.concat(this.protectionUtil.hash(`${sender}:${receiver}`)).concat(`@${domain}`);
  }
}
